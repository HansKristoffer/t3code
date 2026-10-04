import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createThreadTransferEnvironmentAtoms,
  type ThreadTransferDeps,
} from "@t3tools/client-runtime/state/threadTransfer";
import type { EnvironmentId, OrchestrationV2ThreadTransferPeer } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "./session";
import { environmentServerConfigsAtom } from "./server";

export const threadTransferEnvironment =
  createThreadTransferEnvironmentAtoms(connectionAtomRuntime);

function send(
  method: "GET" | "POST",
  url: string,
  options: { readonly body?: Blob; readonly onProgress: (fraction: number) => void },
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    if (method === "GET") request.responseType = "blob";
    (method === "GET" ? request : request.upload).addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () =>
      request.status >= 200 && request.status < 300
        ? resolve(request)
        : reject(new Error(`The transfer was refused (${request.status}).`)),
    );
    request.addEventListener("error", () => reject(new Error("The transfer was interrupted.")));
    request.send(options.body ?? null);
  });
}

/** XHR for progress events; the browser spills a large blob to disk instead of holding it in memory. */
export const webThreadTransferDeps: ThreadTransferDeps = {
  registry: appAtomRegistry,
  atoms: threadTransferEnvironment,
  resolveUrl: (environmentId, relativeUrl) => {
    const connection = readPreparedConnection(environmentId);
    return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
  },
  moveBundle: async ({ downloadUrl, uploadUrl, onProgress }) => {
    const download = await send("GET", downloadUrl, {
      onProgress: (fraction) => onProgress(fraction / 2),
    });
    await send("POST", uploadUrl, {
      body: download.response as Blob,
      onProgress: (fraction) => onProgress(0.5 + fraction / 2),
    });
  },
};

export function readEnvironmentSupportsThreadTransfer(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTransfer !== undefined
  );
}

/** Connected environments other than `sourceEnvironmentId` that accept transferred threads. */
export function useThreadTransferTargets(
  sourceEnvironmentId: EnvironmentId,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }> {
  const configs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(
    () =>
      [...configs.values()]
        .filter(
          (config) =>
            config.environment.environmentId !== sourceEnvironmentId &&
            config.environment.capabilities.threadTransfer !== undefined,
        )
        .map((config) => ({
          environmentId: config.environment.environmentId,
          label: config.environment.label,
        })),
    [configs, sourceEnvironmentId],
  );
}

/** Whether this environment and another connected one accept transferred threads. */
export function useCanTransferFrom(environmentId: EnvironmentId): boolean {
  const configs = useAtomValue(environmentServerConfigsAtom);
  if (configs.get(environmentId)?.environment.capabilities.threadTransfer === undefined) {
    return false;
  }
  for (const config of configs.values()) {
    if (
      config.environment.environmentId !== environmentId &&
      config.environment.capabilities.threadTransfer !== undefined
    ) {
      return true;
    }
  }
  return false;
}

/** The other side of a transfer: its current name when connected, else the name it had. */
export function useTransferPeer(peer: OrchestrationV2ThreadTransferPeer | null): {
  readonly label: string;
  readonly connected: boolean;
} {
  const config = useAtomValue(environmentServerConfigsAtom).get(
    peer?.environmentId ?? ("" as EnvironmentId),
  );
  return {
    label: config?.environment.label ?? peer?.environmentLabel ?? "another environment",
    connected: config !== undefined,
  };
}

/** Whether a menu should offer "Transfer to environment…" for a thread on `environmentId`. */
export function readCanTransferThreadFrom(environmentId: EnvironmentId): boolean {
  if (!readEnvironmentSupportsThreadTransfer(environmentId)) return false;
  for (const config of appAtomRegistry.get(environmentServerConfigsAtom).values()) {
    if (
      config.environment.environmentId !== environmentId &&
      config.environment.capabilities.threadTransfer !== undefined
    ) {
      return true;
    }
  }
  return false;
}
