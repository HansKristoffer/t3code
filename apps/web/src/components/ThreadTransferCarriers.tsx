import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  carryThreadTransfer,
  createThreadTransferCarrierAtom,
} from "@t3tools/client-runtime/state/threadTransfer";
import type { EnvironmentId } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import { waitForThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useThreadTransferTargets, webThreadTransferDeps } from "../state/threadTransfer";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { toastManager } from "./ui/toast";

const threadTransferCarrier = createThreadTransferCarrierAtom(connectionAtomRuntime);

/**
 * Carries the transfers agents ask for through the T3 Code MCP. Environments
 * cannot reach each other, so this client offers to carry for every
 * environment it can connect to another one, and runs a claimed request the
 * same way the transfer dialog does.
 */
export function ThreadTransferCarriers() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const [clientId] = useState(randomUUID);
  return [...configs.values()]
    .filter((config) => config.environment.capabilities.threadTransfer !== undefined)
    .map((config) => (
      <EnvironmentCarrier
        key={config.environment.environmentId}
        environmentId={config.environment.environmentId}
        clientId={clientId}
      />
    ));
}

function EnvironmentCarrier(props: {
  readonly environmentId: EnvironmentId;
  readonly clientId: string;
}) {
  const targets = useThreadTransferTargets(props.environmentId);
  return targets.length === 0 ? null : <Carrier {...props} targets={targets} />;
}

function Carrier(props: {
  readonly environmentId: EnvironmentId;
  readonly clientId: string;
  readonly targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const { environmentId, clientId, targets } = props;
  const registry = useContext(RegistryContext);
  const router = useRouter();
  const viewing = resolveThreadRouteRef(useParams({ strict: false }));
  // Read when a transfer finishes, so following the thread uses the current route.
  const viewingRef = useRef(viewing);
  useEffect(() => {
    viewingRef.current = viewing;
  });
  const carriedTargets = useMemo(
    () =>
      targets.map((target) => ({
        environmentId: target.environmentId,
        label: target.label.trim() || target.environmentId,
      })),
    [targets],
  );
  const requestsAtom = threadTransferCarrier({
    environmentId,
    input: { clientId, targets: carriedTargets },
  });

  useEffect(() => {
    const handled = new Set<string>();
    return registry.subscribe(
      requestsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result) || handled.has(result.value.requestId)) return;
        const request = result.value;
        handled.add(request.requestId);
        const label =
          carriedTargets.find((target) => target.environmentId === request.targetEnvironmentId)
            ?.label ?? "another environment";
        let progress: ReturnType<typeof toastManager.add> | null = null;
        void carryThreadTransfer(webThreadTransferDeps, {
          sourceEnvironmentId: environmentId,
          clientId,
          request,
          destinationLabel: label,
          onClaimed: () => {
            progress = toastManager.add({
              type: "loading",
              title: `An agent is moving a thread to ${label}…`,
            });
          },
        }).then(
          async (threadId) => {
            if (threadId === null) return;
            const done = { type: "success" as const, title: `Thread moved to ${label}` };
            if (progress) toastManager.update(progress, done);
            else toastManager.add(done);
            const viewed = viewingRef.current;
            if (viewed?.environmentId !== environmentId || viewed.threadId !== request.threadId) {
              return;
            }
            // The user was watching the thread, so follow it.
            const destination = { environmentId: request.targetEnvironmentId, threadId };
            await waitForThreadShell(destination);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(destination),
            });
          },
          (error: unknown) => {
            const failed = {
              type: "error" as const,
              title: `An agent could not move a thread to ${label}`,
              description: error instanceof Error ? error.message : "The transfer failed.",
            };
            if (progress) toastManager.update(progress, failed);
            else toastManager.add(failed);
          },
        );
      },
      { immediate: true },
    );
  }, [carriedTargets, clientId, environmentId, registry, requestsAtom, router]);

  return null;
}
