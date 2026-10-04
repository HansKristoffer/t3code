import {
  MessageId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type ThreadTransferId,
} from "@t3tools/contracts";

/**
 * Items that read the same without their run. The rest point at state that
 * stays behind on the source: pending requests, checkpoints, handoffs, fork
 * markers, and child threads.
 */
const PORTABLE_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "notification",
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "run_interrupt_result",
  "system_notice",
  "error",
  "compaction",
  "dynamic_tool",
]);

/** The visible history, forked ancestry included, as the destination will show it. */
export function exportableTurnItems(
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  return visible
    .filter((row) => row.visibility !== "synthetic" && PORTABLE_ITEM_TYPES.has(row.item.type))
    .map((row) => row.item);
}

export function attachmentsOf(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<ChatAttachment> {
  return items.flatMap((item) =>
    item.type === "user_message" || item.type === "assistant_message"
      ? (item.attachments ?? [])
      : [],
  );
}

/**
 * Rebinds exported items to the imported thread as runless history. Ids derive
 * from the transfer, so a retried import writes the same records.
 */
export function importedHistory(input: {
  readonly threadId: ThreadId;
  readonly transferId: ThreadTransferId;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly remapAttachment: (attachment: ChatAttachment) => ChatAttachment | null;
}): {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
} {
  const suffix = (index: number) => String(index).padStart(6, "0");
  const itemIds = new Map(
    input.items.map(
      (item, index) =>
        [item.id, TurnItemId.make(`transfer:${input.transferId}:item:${suffix(index)}`)] as const,
    ),
  );
  const remapAttachments = (attachments: ReadonlyArray<ChatAttachment>) =>
    attachments.flatMap((attachment) => input.remapAttachment(attachment) ?? []);
  const turnItems: Array<OrchestrationV2TurnItem> = [];
  const messages: Array<OrchestrationV2ConversationMessage> = [];
  input.items.forEach((item, index) => {
    const common = {
      id: itemIds.get(item.id)!,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: item.parentItemId === null ? null : (itemIds.get(item.parentItemId) ?? null),
      ordinal: index + 1,
    };
    const rebase = <T extends OrchestrationV2TurnItem>(value: T): T => ({ ...value, ...common });
    if (item.type !== "user_message" && item.type !== "assistant_message") {
      turnItems.push(rebase(item));
      return;
    }
    const messageId = MessageId.make(`${input.threadId}:transfer:${suffix(index)}`);
    const attachments = remapAttachments(item.attachments ?? []);
    const at = item.startedAt ?? item.updatedAt;
    if (item.type === "user_message") {
      // The scheduled task and sending thread belong to the source environment.
      const { scheduledTaskId: _task, senderThreadId: _sender, ...rest } = item;
      turnItems.push({ ...rebase(rest), messageId, attachments });
    } else {
      turnItems.push({ ...rebase(item), messageId, attachments, streaming: false });
    }
    messages.push({
      createdBy: item.type === "user_message" ? item.createdBy : "agent",
      creationSource: item.type === "user_message" ? item.creationSource : "provider",
      id: messageId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      role: item.type === "user_message" ? "user" : "assistant",
      text: item.text,
      ...(item.type === "user_message" && item.context !== undefined
        ? { context: item.context }
        : {}),
      attachments,
      streaming: false,
      createdAt: at,
      updatedAt: item.updatedAt,
    });
  });
  return { turnItems, messages };
}
