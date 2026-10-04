import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShell } from "../../state/entities";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/** Workspace panel row that opens a new draft on this thread's worktree, or its branch. */
export function ThreadNewInWorkspacePanelRow(props: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(props.threadRef);
  const handleNewThread = useNewThreadHandler();
  if (thread === null || !thread.branch) return null;
  const { branch, worktreePath } = thread;

  const startThread = async () => {
    // Same carry-over as the thread menu's "New thread on <branch>".
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(props.threadRef.environmentId, thread.projectId), {
        branch,
        worktreePath,
        envMode: worktreePath ? "worktree" : "local",
        startFromOrigin: false,
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <ThreadDetailsControl size="xs" variant="ghost" part="row" onClick={() => void startThread()}>
      <MessageSquarePlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className="truncate">
        {worktreePath ? "New thread in this worktree" : `New thread on ${branch}`}
      </span>
    </ThreadDetailsControl>
  );
}
