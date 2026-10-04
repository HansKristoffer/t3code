import {
  ThreadId,
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadTransferExportResult,
  type ThreadTransferId,
  type ThreadTransferCarryRequest,
  type ThreadTransferPreflightResult,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "./runtime.ts";

/**
 * RPC commands for moving a thread between environments. Each client
 * instantiates it with its own connection runtime, like the attachment atoms.
 */
export function createThreadTransferEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    exportThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:export",
      tag: WS_METHODS.threadTransferExport,
    }),
    preflight: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:preflight",
      tag: WS_METHODS.threadTransferPreflight,
    }),
    createUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:create-upload-url",
      tag: WS_METHODS.threadTransferCreateUploadUrl,
    }),
    importThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:import",
      tag: WS_METHODS.threadTransferImport,
    }),
    complete: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:complete",
      tag: WS_METHODS.threadTransferComplete,
    }),
    abort: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:abort",
      tag: WS_METHODS.threadTransferAbort,
    }),
    claim: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:claim",
      tag: WS_METHODS.threadTransferClaim,
    }),
    report: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:thread-transfer:report",
      tag: WS_METHODS.threadTransferReport,
    }),
  };
}

/**
 * Transfers agents ask an environment for, delivered to this client as a
 * carrier. Requests are commands, not cached data, so the stream goes away
 * with its owner and a remount never replays one.
 */
export function createThreadTransferCarrierAtom<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:thread-transfer:carry",
    tag: WS_METHODS.threadTransferCarry,
    idleTtlMs: 0,
  });
}

type TransferCommand<I, A> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  unknown
>;
type AtomsOf<T> = {
  [K in keyof T]: T[K] extends AtomCommand<infer W, infer A, unknown>
    ? AtomCommand<W, A, unknown>
    : never;
};
export type ThreadTransferAtoms = AtomsOf<ReturnType<typeof createThreadTransferEnvironmentAtoms>>;

/** The thread an import creates on the destination; the server derives it the same way. */
export function importedTransferThreadId(transferId: ThreadTransferId): ThreadId {
  return ThreadId.make(`transfer-${transferId}`);
}

export interface ThreadTransferDeps {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atoms: ThreadTransferAtoms;
  readonly resolveUrl: (environmentId: EnvironmentId, relativeUrl: string) => string | null;
  /**
   * Carries the bundle from the source's download URL to the destination's
   * upload URL. Clients stream through disk, never JS memory: web lets the
   * browser spill the blob, mobile goes through the cache directory.
   */
  readonly moveBundle: (input: {
    readonly downloadUrl: string;
    readonly uploadUrl: string;
    readonly sizeBytes: number;
    readonly onProgress: (fraction: number) => void;
  }) => Promise<void>;
}

export class ThreadTransferFailure extends Error {
  /** True once the source is locked and may hold a copy elsewhere; the user decides what happens. */
  readonly sourceLocked: boolean;
  constructor(message: string, sourceLocked: boolean) {
    super(message);
    this.sourceLocked = sourceLocked;
  }
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() !== ""
    ? error.message
    : "The environment could not be reached.";
}

async function call<I, A>(
  deps: ThreadTransferDeps,
  command: TransferCommand<I, A>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> {
  const result = await runAtomCommand(
    deps.registry,
    command,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  throw new Error(failureMessage(squashAtomCommandFailure(result)));
}

export interface PreparedThreadTransfer {
  readonly transferId: ThreadTransferId;
  readonly source: ScopedThreadRef;
  readonly targetEnvironmentId: EnvironmentId;
  readonly exported: ThreadTransferExportResult;
  readonly preflight: ThreadTransferPreflightResult;
}

export function abortThreadTransfer(
  deps: ThreadTransferDeps,
  input: { readonly source: ScopedThreadRef; readonly transferId: ThreadTransferId },
): Promise<void> {
  return call(deps, deps.atoms.abort, input.source.environmentId, {
    threadId: input.source.threadId,
    transferId: input.transferId,
  });
}

/**
 * Locks and exports the source, then asks the destination what stands in
 * the way. A blocked transfer unlocks the source again before returning.
 */
export async function prepareThreadTransfer(
  deps: ThreadTransferDeps,
  input: {
    readonly source: ScopedThreadRef;
    readonly targetEnvironmentId: EnvironmentId;
    readonly transferId: ThreadTransferId;
  },
): Promise<PreparedThreadTransfer> {
  const exported = await call(deps, deps.atoms.exportThread, input.source.environmentId, {
    threadId: input.source.threadId,
    transferId: input.transferId,
  });
  try {
    const preflight = await call(deps, deps.atoms.preflight, input.targetEnvironmentId, {
      manifest: exported.manifest,
      bundleBytes: exported.bundleBytes,
    });
    if (preflight.blockers.length > 0) await abortThreadTransfer(deps, input);
    return { ...input, exported, preflight };
  } catch (error) {
    await abortThreadTransfer(deps, input).catch(() => undefined);
    throw error;
  }
}

export type ThreadTransferStep = "moving" | "importing" | "completing";

/**
 * Marks the source transferred and archives it. Retried a few times: by now
 * the destination holds the live copy, so the source must not stay unlocked.
 */
export async function completeThreadTransfer(
  deps: ThreadTransferDeps,
  input: {
    readonly source: ScopedThreadRef;
    readonly targetEnvironmentId: EnvironmentId;
    readonly transferId: ThreadTransferId;
    readonly destinationLabel?: string | undefined;
    readonly sourceCodeApplied?: boolean | undefined;
  },
): Promise<ThreadId> {
  const threadId = importedTransferThreadId(input.transferId);
  const label = input.destinationLabel?.trim();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await call(deps, deps.atoms.complete, input.source.environmentId, {
        threadId: input.source.threadId,
        transferId: input.transferId,
        destination: {
          environmentId: input.targetEnvironmentId,
          threadId,
          ...(label ? { environmentLabel: label } : {}),
        },
        ...(input.sourceCodeApplied === undefined
          ? {}
          : { sourceCodeApplied: input.sourceCodeApplied }),
      });
      return threadId;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ThreadTransferFailure(failureMessage(lastError), true);
}

/**
 * Moves the bundle, imports it, and completes the transfer. Every step is
 * idempotent by transfer id. A failure before the import unlocks the source;
 * once the import starts the source stays locked, because the destination
 * may already hold a live copy and unlocking would split the session.
 */
export async function finishThreadTransfer(
  deps: ThreadTransferDeps,
  prepared: PreparedThreadTransfer,
  options: {
    readonly fastForwardToSource: boolean;
    readonly destinationLabel?: string | undefined;
    readonly onStep: (step: ThreadTransferStep, fraction?: number) => void;
  },
): Promise<ThreadId> {
  const { preflight, source, targetEnvironmentId, transferId } = prepared;
  // Without a project the destination clones the repository during the import.
  const clones = preflight.newProject !== null;
  if (
    preflight.instanceId === null ||
    (!clones && (preflight.projectId === null || preflight.workspace === null))
  ) {
    throw new ThreadTransferFailure("This environment cannot take the thread.", false);
  }
  try {
    options.onStep("moving", 0);
    const upload = await call(deps, deps.atoms.createUploadUrl, targetEnvironmentId, {
      transferId,
      sizeBytes: prepared.exported.bundleBytes,
    });
    const downloadUrl = deps.resolveUrl(source.environmentId, prepared.exported.relativeUrl);
    const uploadUrl = deps.resolveUrl(targetEnvironmentId, upload.relativeUrl);
    if (downloadUrl === null || uploadUrl === null) {
      throw new Error("Both environments must stay connected during the transfer.");
    }
    await deps.moveBundle({
      downloadUrl,
      uploadUrl,
      sizeBytes: prepared.exported.bundleBytes,
      onProgress: (fraction) => options.onStep("moving", fraction),
    });
  } catch (error) {
    await abortThreadTransfer(deps, prepared).catch(() => undefined);
    throw new ThreadTransferFailure(failureMessage(error), false);
  }
  options.onStep("importing");
  let sourceCodeApplied: boolean | undefined;
  try {
    ({ sourceCodeApplied } = await call(deps, deps.atoms.importThread, targetEnvironmentId, {
      transferId,
      projectId: preflight.projectId,
      instanceId: preflight.instanceId,
      workspace: preflight.workspace,
      fastForwardToSource: options.fastForwardToSource,
    }));
  } catch (error) {
    throw new ThreadTransferFailure(failureMessage(error), true);
  }
  options.onStep("completing");
  return completeThreadTransfer(deps, {
    source,
    targetEnvironmentId,
    transferId,
    destinationLabel: options.destinationLabel,
    sourceCodeApplied,
  });
}

/**
 * Runs a whole transfer without asking anyone, as a carrier does for an
 * agent: warnings are accepted and blockers fail it, with the source unlocked.
 */
export async function runThreadTransfer(
  deps: ThreadTransferDeps,
  input: {
    readonly source: ScopedThreadRef;
    readonly targetEnvironmentId: EnvironmentId;
    readonly transferId: ThreadTransferId;
    readonly destinationLabel?: string | undefined;
  },
): Promise<ThreadId> {
  const prepared = await prepareThreadTransfer(deps, input);
  const { blockers, canFastForward } = prepared.preflight;
  if (blockers.length > 0) {
    throw new ThreadTransferFailure(blockers.map((blocker) => blocker.message).join(" "), false);
  }
  return finishThreadTransfer(deps, prepared, {
    fastForwardToSource: canFastForward,
    destinationLabel: input.destinationLabel,
    onStep: () => undefined,
  });
}

/**
 * Claims a transfer an agent asked `sourceEnvironmentId` for, runs it, and
 * reports how it ended. Null when another client claimed it first.
 */
export async function carryThreadTransfer(
  deps: ThreadTransferDeps,
  input: {
    readonly sourceEnvironmentId: EnvironmentId;
    readonly clientId: string;
    readonly request: ThreadTransferCarryRequest;
    readonly destinationLabel?: string | undefined;
    readonly onClaimed?: () => void;
  },
): Promise<ThreadId | null> {
  const { request } = input;
  const { granted } = await call(deps, deps.atoms.claim, input.sourceEnvironmentId, {
    requestId: request.requestId,
    clientId: input.clientId,
  });
  if (!granted) return null;
  input.onClaimed?.();
  const report = (threadId: ThreadId | null, error: string | null) =>
    call(deps, deps.atoms.report, input.sourceEnvironmentId, {
      requestId: request.requestId,
      clientId: input.clientId,
      threadId,
      error,
    }).catch(() => undefined);
  try {
    const threadId = await runThreadTransfer(deps, {
      source: { environmentId: input.sourceEnvironmentId, threadId: request.threadId },
      targetEnvironmentId: request.targetEnvironmentId,
      transferId: request.transferId,
      destinationLabel: input.destinationLabel,
    });
    await report(threadId, null);
    return threadId;
  } catch (error) {
    await report(null, failureMessage(error));
    throw error;
  }
}
