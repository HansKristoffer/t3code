// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import type { OrchestrationV2TurnItem, ThreadTransferManifest } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { describeFiles, readBundle, writeBundle } from "./ThreadTransferBundle.ts";

const directories: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transfer-bundle-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const item = {
  id: "item-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "assistant_message",
  messageId: "message-1",
  text: "done",
  streaming: false,
} as unknown as OrchestrationV2TurnItem;

const manifest = (files: ThreadTransferManifest["files"]): ThreadTransferManifest =>
  ({
    version: 1,
    transferId: "transfer-1",
    source: {
      environmentId: "env-a",
      threadId: "thread-1",
      title: "Fix the thing",
      driver: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      providerVersion: "0.160.0",
      nativeThreadRef: { driver: "codex", nativeId: "native-1", strength: "strong" },
      nativeConversationHeadRef: null,
    },
    repo: {
      canonicalKey: null,
      remoteUrl: null,
      projectTitle: "Repo",
      branch: null,
      headSha: null,
      dirtyFileCount: 0,
      worktree: false,
    },
    itemCount: 1,
    files,
  }) as unknown as ThreadTransferManifest;

describe("thread transfer bundle", () => {
  it("round-trips history and file bodies, including empty and multi-chunk files", async () => {
    const dir = tempDir();
    const big = NodePath.join(dir, "big.jsonl");
    const empty = NodePath.join(dir, "empty");
    const bigBody = Buffer.alloc(3 * 1024 * 1024 + 7, "x");
    NodeFS.writeFileSync(big, bigBody);
    NodeFS.writeFileSync(empty, "");
    const sources = [
      { kind: "native" as const, relativePath: "sessions/big.jsonl", absolutePath: big },
      { kind: "attachment" as const, relativePath: "thread-1-a", absolutePath: empty },
    ];
    const files = await describeFiles(sources);
    const bundlePath = NodePath.join(dir, "out.bundle");
    const size = await writeBundle({
      path: bundlePath,
      manifest: manifest(files),
      items: [item],
      files: sources,
    });
    expect(size).toBe(NodeFS.statSync(bundlePath).size);

    const read = await readBundle(bundlePath, NodePath.join(dir, "staging"));
    expect(read.manifest.files).toEqual(files);
    expect(read.items).toEqual([item]);
    expect(NodeFS.readFileSync(read.stagedPaths[0]!).equals(bigBody)).toBe(true);
    expect(NodeFS.readFileSync(read.stagedPaths[1]!).byteLength).toBe(0);
  });

  it("rejects a body that does not match its checksum", async () => {
    const dir = tempDir();
    const source = NodePath.join(dir, "a");
    NodeFS.writeFileSync(source, "original");
    const sources = [{ kind: "native" as const, relativePath: "a", absolutePath: source }];
    const files = await describeFiles(sources);
    NodeFS.writeFileSync(source, "tampered");
    const bundlePath = NodePath.join(dir, "out.bundle");
    await writeBundle({ path: bundlePath, manifest: manifest(files), items: [], files: sources });
    await expect(readBundle(bundlePath, NodePath.join(dir, "staging"))).rejects.toThrow(/checksum/);
  });

  it("rejects a bundle that ends before its last file", async () => {
    const dir = tempDir();
    const bundlePath = NodePath.join(dir, "short.bundle");
    const header = JSON.stringify({
      format: "t3-thread-transfer",
      manifest: manifest([{ kind: "native", relativePath: "a", bytes: 4, sha256: "0".repeat(64) }]),
      items: [],
    });
    NodeFS.writeFileSync(bundlePath, NodeZlib.gzipSync(`${header}\nab`));
    await expect(readBundle(bundlePath, NodePath.join(dir, "staging"))).rejects.toThrow(
      /ended early/,
    );
  });
});
