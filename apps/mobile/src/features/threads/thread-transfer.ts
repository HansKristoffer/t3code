import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  abortThreadTransfer,
  completeThreadTransfer,
  createThreadTransferEnvironmentAtoms,
  finishThreadTransfer,
  importedTransferThreadId,
  prepareThreadTransfer,
  ThreadTransferFailure,
  type ThreadTransferDeps,
} from "@t3tools/client-runtime/state/threadTransfer";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentSession } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import { waitForThreadShellReady } from "./threadForkNavigation";

const threadTransferEnvironment = createThreadTransferEnvironmentAtoms(connectionAtomRuntime);

/** Downloads to the cache directory and uploads from the file, so the bundle never sits in JS memory. */
const mobileThreadTransferDeps: ThreadTransferDeps = {
  registry: appAtomRegistry,
  atoms: threadTransferEnvironment,
  resolveUrl: (environmentId, relativeUrl) => {
    const connection = appAtomRegistry.get(
      environmentSession.preparedConnectionValueAtom(environmentId),
    );
    return Option.isNone(connection)
      ? null
      : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
  },
  moveBundle: async ({ downloadUrl, uploadUrl, onProgress }) => {
    const { File, Paths, UploadType } = await import("expo-file-system");
    const file = new File(Paths.cache, `t3-thread-transfer-${uuidv4()}.bundle`);
    try {
      await File.downloadFileAsync(downloadUrl, file, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (totalBytes > 0) onProgress(bytesWritten / totalBytes / 2);
        },
      });
      const result = await file.upload(uploadUrl, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers: { "Content-Type": "application/gzip" },
        onProgress: ({ bytesSent, totalBytes }) => {
          if (totalBytes > 0) onProgress(0.5 + bytesSent / totalBytes / 2);
        },
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`The transfer was refused (${result.status}).`);
      }
    } finally {
      if (file.exists) file.delete();
    }
  },
};

function transferTargets(sourceEnvironmentId: EnvironmentId) {
  return [...appAtomRegistry.get(environmentServerConfigsAtom).values()]
    .filter(
      (config) =>
        config.environment.environmentId !== sourceEnvironmentId &&
        config.environment.capabilities.threadTransfer !== undefined,
    )
    .map((config) => ({
      environmentId: config.environment.environmentId,
      label: config.environment.label,
    }));
}

/** This and another connected environment accept transferred threads. */
export function canTransferThreadFrom(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTransfer !== undefined && transferTargets(environmentId).length > 0
  );
}

function ask<T>(
  title: string,
  message: string,
  choices: ReadonlyArray<{
    readonly text: string;
    readonly value: T;
    readonly style?: "cancel" | "destructive";
  }>,
): Promise<T | null> {
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      choices.map((choice) => ({
        text: choice.text,
        ...(choice.style ? { style: choice.style } : {}),
        onPress: () => resolve(choice.value),
      })),
      { cancelable: true, onDismiss: () => resolve(null) },
    ),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The transfer failed.";
}

/**
 * Moves a thread and its agent session to another connected environment,
 * asking with native alerts. With `transferId` it finishes a transfer that
 * left the source locked.
 */
export async function transferThreadFromMobile(input: {
  readonly source: ScopedThreadRef;
  readonly transferId?: string;
  readonly openThread: (ref: ScopedThreadRef) => void;
}): Promise<void> {
  const { source } = input;
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const sourceLabel = configs.get(source.environmentId)?.environment.label ?? "this environment";
  const targets = transferTargets(source.environmentId);
  if (targets.length === 0) {
    Alert.alert(
      "Transfer thread",
      "Connect another environment running a recent T3 Code to transfer threads.",
    );
    return;
  }
  const target = await ask(
    "Transfer thread",
    "Move this thread and its agent session to another environment. If the agent is working, it pauses here and picks up again there. This copy becomes read-only.",
    [
      ...targets.map((entry) => ({ text: entry.label, value: entry })),
      { text: "Cancel", value: null, style: "cancel" as const },
    ],
  );
  if (target === null) return;
  const transferId = input.transferId ?? uuidv4();
  const deps = mobileThreadTransferDeps;
  try {
    let threadId: ThreadId;
    const imported = {
      environmentId: target.environmentId,
      threadId: importedTransferThreadId(transferId),
    };
    if (appAtomRegistry.get(environmentThreadShells.threadShellAtom(imported)) !== null) {
      // The destination already shows the copy: only the source still needs marking.
      threadId = await completeThreadTransfer(deps, {
        source,
        targetEnvironmentId: target.environmentId,
        transferId,
        destinationLabel: target.label,
      });
    } else {
      const prepared = await prepareThreadTransfer(deps, {
        source,
        targetEnvironmentId: target.environmentId,
        transferId,
      });
      const { blockers, warnings } = prepared.preflight;
      if (blockers.length > 0) {
        Alert.alert(
          `${target.label} can't take the thread yet`,
          blockers.map((blocker) => blocker.message).join("\n\n"),
        );
        return;
      }
      const choice = await ask(
        `Transfer to ${target.label}?`,
        [
          ...(prepared.preflight.newProject === null
            ? []
            : [
                `${target.label} doesn't have the repository yet. It will clone ${prepared.preflight.newProject.remoteUrl} and add it as a project.`,
              ]),
          ...warnings.map((warning) => warning.message),
          `Diffs and rewinds for earlier turns and running background tasks stay on ${sourceLabel}.`,
        ].join("\n\n"),
        [
          { text: "Cancel", value: null, style: "cancel" as const },
          {
            text: warnings.length > 0 ? "Transfer anyway" : "Transfer",
            value: "transfer" as const,
          },
        ],
      );
      if (choice === null) {
        await abortThreadTransfer(deps, { source, transferId }).catch(() => undefined);
        return;
      }
      threadId = await finishThreadTransfer(deps, prepared, {
        destinationLabel: target.label,
        onStep: () => undefined,
      });
    }
    const destination = { environmentId: target.environmentId, threadId };
    await waitForThreadShellReady({
      read: () =>
        appAtomRegistry.get(environmentThreadShells.threadShellAtom(destination)) !== null,
      timeoutMs: 5_000,
    });
    input.openThread(destination);
  } catch (error) {
    Alert.alert(
      "Transfer failed",
      error instanceof ThreadTransferFailure && error.sourceLocked
        ? `${message(error)} The thread on ${sourceLabel} stays locked because ${target.label} may already have its copy. Finish or unlock it from the thread.`
        : message(error),
    );
  }
}

/** Unlocks a source a transfer left locked, after warning that a copy may exist. */
export async function unlockTransferredThread(input: {
  readonly source: ScopedThreadRef;
  readonly transferId: string;
}): Promise<void> {
  const confirmed = await ask(
    "Unlock this thread?",
    "If the other environment already has its copy, continuing here splits the conversation in two.",
    [
      { text: "Cancel", value: false, style: "cancel" as const },
      { text: "Unlock", value: true, style: "destructive" as const },
    ],
  );
  if (confirmed !== true) return;
  await abortThreadTransfer(mobileThreadTransferDeps, input).catch((error: unknown) =>
    Alert.alert("Could not unlock the thread", message(error)),
  );
}
