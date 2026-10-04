// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectKey,
  makeClaudeNativeSessionTransfer,
  makeCodexNativeSessionTransfer,
} from "./NativeSessionTransfer.ts";

const write = (file: string, body = "{}\n") => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, body);
};
const tempDir = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-")));

describe("claudeProjectKey", () => {
  it("matches the Claude Code directory encoding, hashing paths past 200 characters", () => {
    expect(claudeProjectKey("/Users/me/My Repo.git")).toBe("-Users-me-My-Repo-git");
    const long = `/${"a".repeat(250)}`;
    const key = claudeProjectKey(long);
    expect(key.startsWith(`-${"a".repeat(199)}-`)).toBe(true);
    expect(key).not.toBe(claudeProjectKey(`/${"a".repeat(251)}`));
  });
});

describe("Claude native session transfer", () => {
  it.effect("finds a session started in another directory with its subagent transcripts", () =>
    Effect.gen(function* () {
      const home = tempDir();
      const cwd = tempDir();
      const sessionId = "44957c3e-2fd8-41d9-a055-4301c88e0d7e";
      const elsewhere = NodePath.join(home, "projects", "-somewhere-else");
      write(NodePath.join(elsewhere, `${sessionId}.jsonl`));
      write(NodePath.join(elsewhere, sessionId, "subagents", "agent-1.jsonl"));
      write(NodePath.join(elsewhere, "other-session.jsonl"));
      const transfer = makeClaudeNativeSessionTransfer({
        homePath: home,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      });

      expect(yield* transfer.locate({ nativeThreadId: sessionId, cwd })).toEqual({
        root: elsewhere,
        relativePaths: [`${sessionId}.jsonl`, `${sessionId}/subagents/agent-1.jsonl`],
      });
      expect(yield* transfer.locate({ nativeThreadId: "../escape", cwd })).toBeNull();
      expect(yield* transfer.importRoot({ cwd })).toBe(
        NodePath.join(home, "projects", claudeProjectKey(cwd)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Codex native session transfer", () => {
  it.effect("finds a rollout by thread id in live or archived sessions", () =>
    Effect.gen(function* () {
      const home = tempDir();
      const live = "019b8052-938c-76f2-9d65-2a38e8ba0f09";
      const archived = "019b8051-a0f2-7e51-b87e-f6bcf17210cd";
      write(
        NodePath.join(
          home,
          "sessions",
          "2026",
          "01",
          "02",
          `rollout-2026-01-02T21-07-34-${live}.jsonl`,
        ),
      );
      write(
        NodePath.join(home, "archived_sessions", `rollout-2026-01-02T21-06-31-${archived}.jsonl`),
      );
      const transfer = makeCodexNativeSessionTransfer({
        homePath: home,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      });

      expect(yield* transfer.locate({ nativeThreadId: live, cwd: home })).toEqual({
        root: home,
        relativePaths: [`sessions/2026/01/02/rollout-2026-01-02T21-07-34-${live}.jsonl`],
      });
      expect(
        (yield* transfer.locate({ nativeThreadId: archived, cwd: home }))?.relativePaths,
      ).toEqual([`archived_sessions/rollout-2026-01-02T21-06-31-${archived}.jsonl`]);
      expect(yield* transfer.locate({ nativeThreadId: "missing", cwd: home })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("native session imports", () => {
  it.effect("accept only the session's own files", () =>
    Effect.gen(function* () {
      const options = {
        homePath: "/home",
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      };
      const claude = makeClaudeNativeSessionTransfer(options);
      const codex = makeCodexNativeSessionTransfer(options);
      const id = "019b8052-938c-76f2-9d65-2a38e8ba0f09";

      expect(claude.accepts({ nativeThreadId: id, relativePath: `${id}.jsonl` })).toBe(true);
      expect(claude.accepts({ nativeThreadId: id, relativePath: `${id}/subagents/a.jsonl` })).toBe(
        true,
      );
      expect(claude.accepts({ nativeThreadId: id, relativePath: "../settings.json" })).toBe(false);
      expect(
        codex.accepts({
          nativeThreadId: id,
          relativePath: `sessions/2026/01/02/rollout-2026-01-02T21-07-34-${id}.jsonl`,
        }),
      ).toBe(true);
      expect(codex.accepts({ nativeThreadId: id, relativePath: "auth.json" })).toBe(false);
      expect(
        codex.accepts({ nativeThreadId: id, relativePath: `sessions/../rollout-x-${id}.jsonl` }),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
