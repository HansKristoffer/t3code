import { abortThreadTransfer } from "@t3tools/client-runtime/state/threadTransfer";
import type { OrchestrationV2ThreadTransferOut, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowRightLeftIcon, ArrowUpRightIcon } from "lucide-react";

import { readLocalApi } from "../../localApi";
import { useTransferPeer, webThreadTransferDeps } from "../../state/threadTransfer";
import { buildThreadRouteParams } from "../../threadRoutes";
import { requestThreadTransfer } from "../ThreadTransferDialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Stands in for the composer on a thread that moved, or is moving, to another
 * environment. Its copy there owns the conversation, so nothing is sent here.
 */
export function ThreadTransferBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly transfer: OrchestrationV2ThreadTransferOut;
}) {
  const router = useRouter();
  const { transfer, threadRef } = props;
  const destination = useTransferPeer(transfer.destination ?? null);

  const unlock = async () => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        "Unlock this thread?",
        "If the other environment already has its copy, continuing here splits the conversation in two.",
      ].join("\n"),
    );
    if (confirmed !== true) return;
    await abortThreadTransfer(webThreadTransferDeps, {
      source: threadRef,
      transferId: transfer.transferId,
    }).catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not unlock the thread",
          description: error instanceof Error ? error.message : undefined,
        }),
      ),
    );
  };

  const target = transfer.destination;
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <ArrowRightLeftIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span role="status" className="min-w-0 truncate text-foreground">
        {transfer.status === "completed"
          ? `Transferred to ${destination.label}`
          : "Transfer to another environment did not finish"}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {transfer.status === "exporting" ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void unlock()}>
              Unlock
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => requestThreadTransfer(threadRef, transfer.transferId)}
            >
              Finish transfer
            </Button>
          </>
        ) : target !== undefined && destination.connected ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(target),
              })
            }
          >
            <ArrowUpRightIcon />
            Open
          </Button>
        ) : null}
      </span>
    </div>
  );
}
