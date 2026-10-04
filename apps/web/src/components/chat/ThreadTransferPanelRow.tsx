import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowRightLeftIcon } from "lucide-react";

import { useThreadShell } from "../../state/entities";
import { useCanTransferFrom } from "../../state/threadTransfer";
import { requestThreadTransfer } from "../ThreadTransferDialog";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/** Workspace panel row that opens the transfer dialog for this thread. */
export function ThreadTransferPanelRow(props: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(props.threadRef);
  const canTransfer = useCanTransferFrom(props.threadRef.environmentId);
  // A thread already moving or moved shows its own bar in place of the composer.
  if (!canTransfer || thread === null || thread.source.transfer != null) return null;
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      onClick={() => requestThreadTransfer(props.threadRef)}
    >
      <ArrowRightLeftIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className="truncate">Transfer thread</span>
    </ThreadDetailsControl>
  );
}
