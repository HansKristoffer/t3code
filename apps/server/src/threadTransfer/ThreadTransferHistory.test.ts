import type {
  ChatAttachment,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadTransferId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { exportableTurnItems, importedHistory } from "./ThreadTransferHistory.ts";
import { compareVersions, parseWorktreeList } from "./ThreadTransferService.ts";

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const base = (id: string, ordinal: number) => ({
  id,
  threadId: "source",
  runId: "run-1",
  nodeId: "node-1",
  providerThreadId: "pt-1",
  providerTurnId: "turn-1",
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const image = {
  type: "image",
  id: "source-11111111-1111-4111-8111-111111111111",
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as ChatAttachment;
const items = [
  {
    ...base("u1", 1),
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: "m1",
    inputIntent: "turn_start",
    text: "hi",
    attachments: [image],
    scheduledTaskId: "task-1",
  },
  { ...base("c1", 2), type: "command_execution", input: "ls", output: "a" },
  { ...base("c2", 3), parentItemId: "c1", type: "command_execution", input: "pwd" },
  { ...base("k1", 4), type: "checkpoint", checkpointId: "cp", scopeId: "scope", files: [] },
  { ...base("a1", 5), type: "assistant_message", messageId: "m2", text: "hello", streaming: true },
] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;
const visible = (
  visibility: OrchestrationV2ProjectedTurnItem["visibility"],
  item: OrchestrationV2TurnItem,
) =>
  ({
    position: 0,
    visibility,
    sourceThreadId: "source",
    sourceItemId: item.id,
    item,
  }) as OrchestrationV2ProjectedTurnItem;

describe("thread transfer history", () => {
  it("keeps inherited history and drops fork markers and state that stays on the source", () => {
    const rows = [
      visible("inherited", items[0]!),
      visible("synthetic", items[1]!),
      ...items.slice(1).map((item) => visible("local", item)),
    ];
    expect(exportableTurnItems(rows).map((item) => item.id)).toEqual(["u1", "c1", "c2", "a1"]);
  });

  it("rebinds items to the imported thread as runless history with stable ids", () => {
    const portable = exportableTurnItems(items.map((item) => visible("local", item)));
    const moved = {
      ...image,
      id: "transfer-1-22222222-2222-4222-8222-222222222222",
    } as ChatAttachment;
    const history = importedHistory({
      threadId: "transfer-t1" as ThreadId,
      transferId: "t1" as ThreadTransferId,
      items: portable,
      remapAttachment: (attachment) => (attachment.id === image.id ? moved : null),
    });

    expect(
      history.turnItems.map((item) => [
        item.id,
        item.ordinal,
        item.runId,
        item.nodeId,
        item.parentItemId,
      ]),
    ).toEqual([
      ["transfer:t1:item:000000", 1, null, null, null],
      ["transfer:t1:item:000001", 2, null, null, null],
      ["transfer:t1:item:000002", 3, null, null, "transfer:t1:item:000001"],
      ["transfer:t1:item:000003", 4, null, null, null],
    ]);
    const user = history.turnItems[0]!;
    expect(user.type === "user_message" && user.attachments).toEqual([moved]);
    expect("scheduledTaskId" in user).toBe(false);
    expect(
      history.turnItems[3]!.type === "assistant_message" && history.turnItems[3]!.streaming,
    ).toBe(false);
    expect(history.messages.map((message) => [message.id, message.role, message.text])).toEqual([
      ["transfer-t1:transfer:000000", "user", "hi"],
      ["transfer-t1:transfer:000003", "assistant", "hello"],
    ]);
    expect(history.turnItems.every((item) => item.threadId === "transfer-t1")).toBe(true);
  });
});

describe("thread transfer repository checks", () => {
  it("orders provider versions numerically and ignores unknown ones", () => {
    expect(compareVersions("0.160.0", "0.99.1")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions(null, "1.0.0")).toBe(0);
  });

  it("reads worktree branches from porcelain output", () => {
    const output = [
      "worktree /repo\nHEAD abc\nbranch refs/heads/main",
      "worktree /repo/.t3/wt/feature\nHEAD def\nbranch refs/heads/feature/x",
      "worktree /tmp/detached\nHEAD 123\ndetached",
    ].join("\n\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.t3/wt/feature", branch: "feature/x" },
      { path: "/tmp/detached", branch: null },
    ]);
  });
});
