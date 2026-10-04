import {
  abortThreadTransfer,
  completeThreadTransfer,
  finishThreadTransfer,
  importedTransferThreadId,
  prepareThreadTransfer,
  ThreadTransferFailure,
  type PreparedThreadTransfer,
  type ThreadTransferStep,
} from "@t3tools/client-runtime/state/threadTransfer";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { create } from "zustand";

import {
  readThreadShell,
  useServerConfigs,
  useThreadShell,
  waitForThreadShell,
} from "../state/entities";
import { useThreadTransferTargets, webThreadTransferDeps } from "../state/threadTransfer";
import { randomUUID } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

type Request = {
  readonly source: ScopedThreadRef;
  /** Set when finishing a transfer that left the source locked. */
  readonly transferId: string | null;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens the transfer dialog; with a transfer id it finishes that transfer instead of starting one. */
export function requestThreadTransfer(source: ScopedThreadRef, transferId: string | null = null) {
  useRequest.setState({ request: { source, transferId } });
}

function close() {
  useRequest.setState({ request: null });
}

export function ThreadTransferDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => close, []);
  return request ? (
    <ThreadTransferDialog
      key={`${request.source.environmentId}:${request.source.threadId}:${request.transferId}`}
      request={request}
    />
  ) : null;
}

type Phase =
  | { readonly kind: "choose" }
  | { readonly kind: "preparing" }
  | { readonly kind: "review"; readonly prepared: PreparedThreadTransfer }
  | { readonly kind: "running"; readonly step: ThreadTransferStep; readonly percent: number | null }
  | { readonly kind: "failed"; readonly message: string; readonly sourceLocked: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The transfer failed.";
}

/**
 * Brokers a transfer between two connected environments: the source exports,
 * the destination checks and imports, and the source is marked transferred.
 */
function ThreadTransferDialog({ request }: { readonly request: Request }) {
  const router = useRouter();
  const { source } = request;
  const thread = useThreadShell(source);
  const configs = useServerConfigs();
  const sourceLabel = configs.get(source.environmentId)?.environment.label ?? "this environment";
  const targets = useThreadTransferTargets(source.environmentId);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(targets[0]?.environmentId ?? null);
  const target = targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  const [transferId] = useState(() => request.transferId ?? randomUUID());
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [fastForward, setFastForward] = useState(false);
  // The destination clones this repository when it has no project for it yet.
  const [preparedClone, setPreparedClone] = useState<string | null>(null);
  const busy = phase.kind === "preparing" || phase.kind === "running";

  const finish = async (work: () => Promise<ThreadId>, targetEnvironmentId: EnvironmentId) => {
    try {
      const threadId = await work();
      const destination = { environmentId: targetEnvironmentId, threadId };
      close();
      toastManager.add({ type: "success", title: "Thread transferred" });
      await waitForThreadShell(destination);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(destination),
      });
    } catch (error) {
      setPhase({
        kind: "failed",
        message: errorMessage(error),
        sourceLocked: error instanceof ThreadTransferFailure && error.sourceLocked,
      });
    }
  };

  const transfer = (prepared: PreparedThreadTransfer) => {
    setPhase({ kind: "running", step: "moving", percent: 0 });
    void finish(
      () =>
        finishThreadTransfer(webThreadTransferDeps, prepared, {
          fastForwardToSource: fastForward,
          destinationLabel: target?.label,
          onStep: (step, fraction) => {
            const percent = fraction === undefined ? null : Math.round(fraction * 100);
            // Progress events arrive per chunk; re-render only when the label changes.
            setPhase((current) =>
              current.kind === "running" && current.step === step && current.percent === percent
                ? current
                : { kind: "running", step, percent },
            );
          },
        }),
      prepared.targetEnvironmentId,
    );
  };

  const start = async () => {
    if (target === null) return;
    const imported = {
      environmentId: target.environmentId,
      threadId: importedTransferThreadId(transferId),
    };
    // The destination already shows the copy: only the source still needs marking.
    if (readThreadShell(imported) !== null) {
      setPhase({ kind: "running", step: "completing", percent: null });
      await finish(
        () =>
          completeThreadTransfer(webThreadTransferDeps, {
            source,
            targetEnvironmentId: target.environmentId,
            transferId,
            destinationLabel: target.label,
          }),
        target.environmentId,
      );
      return;
    }
    setPhase({ kind: "preparing" });
    try {
      const prepared = await prepareThreadTransfer(webThreadTransferDeps, {
        source,
        targetEnvironmentId: target.environmentId,
        transferId,
      });
      setFastForward(false);
      setPreparedClone(prepared.preflight.newProject?.title ?? null);
      // Only blockers and warnings need a second look; otherwise OK means go.
      if (prepared.preflight.blockers.length === 0 && prepared.preflight.warnings.length === 0) {
        transfer(prepared);
        return;
      }
      setPhase({ kind: "review", prepared });
    } catch (error) {
      setPhase({ kind: "failed", message: errorMessage(error), sourceLocked: false });
    }
  };

  const unlock = () => {
    void abortThreadTransfer(webThreadTransferDeps, { source, transferId }).catch(() => undefined);
    close();
  };

  const dismiss = () => {
    if (busy) return;
    // Leaving review abandons a transfer nothing has copied yet.
    if (phase.kind === "review" && phase.prepared.preflight.blockers.length === 0) unlock();
    else close();
  };

  const targetLabel = target?.label ?? "the other environment";
  const runningLabel =
    phase.kind !== "running"
      ? ""
      : phase.step === "moving"
        ? `Copying the thread${phase.percent === null ? "" : ` (${phase.percent}%)`}…`
        : phase.step === "importing"
          ? preparedClone === null
            ? `Setting it up on ${targetLabel}…`
            : `Cloning ${preparedClone} and setting it up on ${targetLabel}…`
          : `Finishing on ${sourceLabel}…`;

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogPopup className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Transfer thread</DialogTitle>
          <DialogDescription>
            {`Move “${thread?.title ?? "this thread"}” and its agent session to another environment. If the agent is working, it stops first. The thread continues there, and this copy becomes read-only.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {phase.kind === "choose" ? (
              targets.length === 0 ? (
                <p className="text-muted-foreground">
                  Connect another environment running a recent T3 Code to transfer threads.
                </p>
              ) : (
                <Label className="flex flex-col items-stretch">
                  Environment
                  <Select
                    value={targetId}
                    items={Object.fromEntries(
                      targets.map((entry) => [entry.environmentId, entry.label]),
                    )}
                    onValueChange={(value) => setTargetId(value as EnvironmentId)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((entry) => (
                        <SelectItem key={entry.environmentId} value={entry.environmentId}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Label>
              )
            ) : null}
            {phase.kind === "preparing" || phase.kind === "running" ? (
              <p className="flex items-center gap-2 text-muted-foreground" role="status">
                <Spinner size="md" />
                {phase.kind === "preparing" ? "Stopping and preparing the thread…" : runningLabel}
              </p>
            ) : null}
            {phase.kind === "review" ? (
              <TransferReview
                prepared={phase.prepared}
                sourceLabel={sourceLabel}
                fastForward={fastForward}
                onFastForwardChange={setFastForward}
              />
            ) : null}
            {phase.kind === "failed" ? (
              <Alert variant="error">
                <AlertTitle>Transfer failed</AlertTitle>
                <AlertDescription>
                  {phase.message}
                  {phase.sourceLocked
                    ? ` The thread on ${sourceLabel} stays locked because ${targetLabel} may already have its copy. Finish to try again, or unlock it to keep working here.`
                    : ""}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {phase.kind === "choose" ? (
            <>
              <Button variant="outline" onClick={dismiss}>
                Cancel
              </Button>
              <Button disabled={target === null} onClick={() => void start()}>
                OK
              </Button>
            </>
          ) : null}
          {phase.kind === "review" ? (
            <>
              <Button variant="outline" onClick={dismiss}>
                {phase.prepared.preflight.blockers.length > 0 ? "Close" : "Cancel"}
              </Button>
              {phase.prepared.preflight.blockers.length > 0 ? (
                <Button onClick={() => void start()}>Check again</Button>
              ) : (
                <Button onClick={() => transfer(phase.prepared)}>
                  {phase.prepared.preflight.warnings.length > 0 ? "Transfer anyway" : "Transfer"}
                </Button>
              )}
            </>
          ) : null}
          {phase.kind === "failed" ? (
            phase.sourceLocked ? (
              <>
                <Button variant="destructive-outline" onClick={unlock}>
                  Unlock thread
                </Button>
                <Button onClick={() => void start()}>Finish transfer</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={dismiss}>
                  Close
                </Button>
                <Button onClick={() => void start()}>Try again</Button>
              </>
            )
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TransferReview(props: {
  readonly prepared: PreparedThreadTransfer;
  readonly sourceLabel: string;
  readonly fastForward: boolean;
  readonly onFastForwardChange: (value: boolean) => void;
}) {
  const { preflight } = props.prepared;
  return (
    <>
      {preflight.blockers.length > 0 ? (
        <Alert variant="error">
          <AlertTitle>This environment can't take the thread yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ps-4">
              {preflight.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {preflight.warnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Check before transferring</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ps-4">
              {preflight.warnings.map((warning) => (
                <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {preflight.newProject !== null && preflight.blockers.length === 0 ? (
        <p className="text-muted-foreground">
          {`This environment doesn't have the repository yet. It will clone ${preflight.newProject.remoteUrl} and add it as a project.`}
        </p>
      ) : null}
      {preflight.canFastForward ? (
        <label className="flex items-center gap-2">
          <Checkbox
            checked={props.fastForward}
            onCheckedChange={(checked) => props.onFastForwardChange(checked === true)}
          />
          Fast-forward to the source commit first
        </label>
      ) : null}
      {preflight.blockers.length === 0 ? (
        <p className="text-muted-foreground">
          {`Diffs and rewinds for earlier turns and running background tasks stay on ${props.sourceLabel}.`}
        </p>
      ) : null}
    </>
  );
}
