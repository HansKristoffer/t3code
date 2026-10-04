// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyCodeSnapshot,
  fetchCodeSnapshot,
  pushCodeSnapshot,
  stashTransferredCode,
  type GitRun,
} from "./ThreadTransferCode.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const git: GitRun = (cwd, args, env) =>
  Effect.sync(() => {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return result.status === 0 ? result.stdout.trim() : null;
  });
const run = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A bare origin with one pushed commit, and two clones of it: the source and the destination. */
function repos() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transfer-code-"));
  directories.push(root);
  const origin = NodePath.join(root, "origin.git");
  run(root, "init", "--bare", "--initial-branch=main", origin);
  const clone = (name: string) => {
    const dir = NodePath.join(root, name);
    run(root, "clone", "--quiet", origin, dir);
    run(dir, "config", "user.name", "Test");
    run(dir, "config", "user.email", "test@example.com");
    return dir;
  };
  const source = clone("source");
  NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "kept\n");
  NodeFS.writeFileSync(NodePath.join(source, "removed.txt"), "removed\n");
  run(source, "add", "--all");
  run(source, "commit", "--quiet", "-m", "base");
  run(source, "push", "--quiet", "origin", "main");
  return { source, destination: clone("destination") };
}

describe("ThreadTransferCode", () => {
  it.effect("carries unpushed commits and uncommitted files without touching the source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, destination } = repos();
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "local commit\n");
      run(source, "commit", "--quiet", "-am", "unpushed");
      const headSha = run(source, "rev-parse", "HEAD");
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "edited\n");
      NodeFS.rmSync(NodePath.join(source, "removed.txt"));
      NodeFS.writeFileSync(NodePath.join(source, "new.txt"), "untracked\n");
      run(source, "add", "new.txt");
      const statusBefore = run(source, "status", "--porcelain");

      const snapshot = yield* pushCodeSnapshot({
        git,
        fileSystem,
        path,
        cwd: source,
        transferId: "t-1",
        headSha,
        dirty: true,
      });
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.ref, "refs/t3-transfer/t-1");
      assert.isTrue(snapshot!.uncommitted);
      // The source's branch, index, and files are as they were.
      assert.equal(run(source, "rev-parse", "HEAD"), headSha);
      assert.equal(run(source, "status", "--porcelain"), statusBefore);
      assert.equal(run(source, "rev-parse", "origin/main"), run(destination, "rev-parse", "HEAD"));

      assert.isTrue(yield* fetchCodeSnapshot(git, destination, snapshot!));
      yield* applyCodeSnapshot(git, destination, headSha, snapshot!);
      assert.equal(run(destination, "rev-parse", "HEAD"), headSha);
      assert.equal(NodeFS.readFileSync(NodePath.join(destination, "kept.txt"), "utf8"), "edited\n");
      assert.isFalse(NodeFS.existsSync(NodePath.join(destination, "removed.txt")));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(destination, "new.txt"), "utf8"),
        "untracked\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pushes nothing when origin already has the source's clean checkout", () =>
    Effect.gen(function* () {
      const { source } = repos();
      const snapshot = yield* pushCodeSnapshot({
        git,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        cwd: source,
        transferId: "t-2",
        headSha: run(source, "rev-parse", "HEAD"),
        dirty: false,
      });
      assert.isNull(snapshot);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves the code A to B to A to B, each side left clean for the next trip", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source, destination } = repos();
      const send = (from: string, transferId: string) =>
        pushCodeSnapshot({
          git,
          fileSystem,
          path,
          cwd: from,
          transferId,
          headSha: run(from, "rev-parse", "HEAD"),
          dirty: run(from, "status", "--porcelain") !== "",
        });

      // A to B: A's edit moves, and A parks it.
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "started on A\n");
      const outbound = (yield* send(source, "t-out"))!;
      assert.isTrue(yield* fetchCodeSnapshot(git, destination, outbound));
      yield* applyCodeSnapshot(git, destination, run(source, "rev-parse", "HEAD"), outbound);
      assert.isTrue(
        yield* stashTransferredCode({
          git,
          fileSystem,
          path,
          cwd: source,
          snapshot: outbound,
          message: "T3 Code: transferred to B (t-out)",
        }),
      );
      assert.equal(run(source, "status", "--porcelain"), "");
      assert.include(run(source, "stash", "list"), "T3 Code: transferred to B (t-out)");

      // B finishes the work and sends it back; A's clean checkout takes it.
      NodeFS.writeFileSync(NodePath.join(destination, "kept.txt"), "finished on B\n");
      run(destination, "commit", "--quiet", "-am", "finish on B");
      NodeFS.writeFileSync(NodePath.join(destination, "notes.txt"), "uncommitted on B\n");
      const inbound = (yield* send(destination, "t-back"))!;
      assert.isTrue(yield* fetchCodeSnapshot(git, source, inbound));
      yield* applyCodeSnapshot(git, source, run(destination, "rev-parse", "HEAD"), inbound);
      assert.equal(run(source, "rev-parse", "HEAD"), run(destination, "rev-parse", "HEAD"));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(source, "kept.txt"), "utf8"),
        "finished on B\n",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(source, "notes.txt"), "utf8"),
        "uncommitted on B\n",
      );

      // B parks what it sent, so it can take the thread again.
      assert.isTrue(
        yield* stashTransferredCode({
          git,
          fileSystem,
          path,
          cwd: destination,
          snapshot: inbound,
          message: "T3 Code: transferred to A (t-back)",
        }),
      );
      assert.equal(run(destination, "status", "--porcelain"), "");

      // A adjusts the work and hands it to B once more.
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "adjusted on A\n");
      run(source, "commit", "--quiet", "-am", "adjust on A");
      const again = (yield* send(source, "t-again"))!;
      assert.isTrue(yield* fetchCodeSnapshot(git, destination, again));
      yield* applyCodeSnapshot(git, destination, run(source, "rev-parse", "HEAD"), again);
      assert.equal(run(destination, "rev-parse", "HEAD"), run(source, "rev-parse", "HEAD"));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(destination, "kept.txt"), "utf8"),
        "adjusted on A\n",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(destination, "notes.txt"), "utf8"),
        "uncommitted on B\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps edits made on the source after the snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { source } = repos();
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "sent\n");
      const snapshot = (yield* pushCodeSnapshot({
        git,
        fileSystem,
        path,
        cwd: source,
        transferId: "t-3",
        headSha: run(source, "rev-parse", "HEAD"),
        dirty: true,
      }))!;
      // This edit exists only here, so nothing is stashed.
      NodeFS.writeFileSync(NodePath.join(source, "kept.txt"), "edited after sending\n");
      assert.isFalse(
        yield* stashTransferredCode({ git, fileSystem, path, cwd: source, snapshot, message: "x" }),
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(source, "kept.txt"), "utf8"),
        "edited after sending\n",
      );
      assert.equal(run(source, "stash", "list"), "");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
