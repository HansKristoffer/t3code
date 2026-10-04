import { EnvironmentId, ThreadId, type ThreadTransferPreflightResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import type { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "@effect/vitest";

import type { AtomCommand } from "./runtime.ts";
import {
  finishThreadTransfer,
  prepareThreadTransfer,
  type ThreadTransferAtoms,
  type ThreadTransferDeps,
} from "./threadTransfer.ts";

const source = { environmentId: EnvironmentId.make("a"), threadId: ThreadId.make("t") };
const target = EnvironmentId.make("b");
const ready: ThreadTransferPreflightResult = {
  blockers: [],
  warnings: [],
  projectId: "p" as never,
  newProject: null,
  instanceId: "codex" as never,
  workspace: { type: "root" },
  canFastForward: false,
};

function harness(failing: ReadonlyArray<keyof ThreadTransferAtoms | "move">, preflight = ready) {
  const calls: Array<string> = [];
  // Each fake stands in for one typed RPC command; only the call order matters here.
  const command = (name: keyof ThreadTransferAtoms, value: unknown): never => {
    const fake: AtomCommand<{ readonly environmentId: EnvironmentId }, unknown, unknown> = {
      label: name,
      run: async (_registry, input) => {
        calls.push(`${name}@${input.environmentId}`);
        return failing.includes(name)
          ? AsyncResult.failure(Cause.fail({ message: `${name} failed` }))
          : AsyncResult.success(value);
      },
    };
    return fake as never;
  };
  const deps: ThreadTransferDeps = {
    registry: {} as AtomRegistry.AtomRegistry,
    atoms: {
      exportThread: command("exportThread", {
        manifest: {},
        bundleBytes: 10,
        relativeUrl: "/d",
        expiresAt: 0,
      }),
      preflight: command("preflight", preflight),
      createUploadUrl: command("createUploadUrl", { relativeUrl: "/u", expiresAt: 0 }),
      importThread: command("importThread", { threadId: "transfer-x" }),
      complete: command("complete", undefined),
      abort: command("abort", undefined),
    },
    resolveUrl: (environmentId, url) => `${environmentId}${url}`,
    moveBundle: async () => {
      calls.push("move");
      if (failing.includes("move")) throw new Error("network");
    },
  };
  return { deps, calls };
}

const run = async (failing: ReadonlyArray<keyof ThreadTransferAtoms | "move">) => {
  const { deps, calls } = harness(failing);
  const prepared = await prepareThreadTransfer(deps, {
    source,
    targetEnvironmentId: target,
    transferId: "x",
  });
  const outcome = await finishThreadTransfer(deps, prepared, {
    fastForwardToSource: false,
    onStep: () => undefined,
  }).catch((error: { message: string; sourceLocked: boolean }) => error);
  return { outcome, calls };
};

describe("thread transfer flow", () => {
  it("moves, imports, then completes on the source", async () => {
    const { outcome, calls } = await run([]);
    expect(outcome).toBe("transfer-x");
    expect(calls).toEqual([
      "exportThread@a",
      "preflight@b",
      "createUploadUrl@b",
      "move",
      "importThread@b",
      "complete@a",
    ]);
  });

  it("unlocks the source when the bundle never reaches the destination", async () => {
    const { outcome, calls } = await run(["move"]);
    expect(outcome).toMatchObject({ message: "network", sourceLocked: false });
    expect(calls.at(-1)).toBe("abort@a");
  });

  it("keeps the source locked once the import may have run", async () => {
    const { outcome, calls } = await run(["importThread"]);
    expect(outcome).toMatchObject({ message: "importThread failed", sourceLocked: true });
    expect(calls).not.toContain("abort@a");
  });

  it("unlocks the source when the destination refuses the thread", async () => {
    const { deps, calls } = harness([], {
      ...ready,
      blockers: [{ code: "project_missing", message: "no" }],
    });
    await prepareThreadTransfer(deps, { source, targetEnvironmentId: target, transferId: "x" });
    expect(calls).toEqual(["exportThread@a", "preflight@b", "abort@a"]);
  });
});
