import { ThreadTransferError, type ThreadTransferManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/** A git command's trimmed stdout, or null when it failed. */
export type GitRun = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) => Effect.Effect<string | null>;

export type CodeSnapshot = NonNullable<ThreadTransferManifest["repo"]["snapshot"]>;

// A throwaway commit; a fixed identity keeps it from failing where git has none configured.
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@localhost",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@localhost",
};

/**
 * The tree of everything in the checkout, uncommitted and untracked files
 * included, as `git add --all` sees it. Built in a scratch index so the
 * real index stays as it is. Null when git fails.
 */
const worktreeTree = (input: {
  readonly git: GitRun;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { git, fileSystem, path, cwd } = input;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const env = { GIT_INDEX_FILE: path.join(directory, "index") };
      // Starting from a copy of the real index skips rehashing every file.
      const index = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const copied =
        index !== null &&
        (yield* fileSystem.copyFile(path.resolve(cwd, index), env.GIT_INDEX_FILE).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
      if (!copied && (yield* git(cwd, ["read-tree", "HEAD"], env)) === null) return null;
      if ((yield* git(cwd, ["add", "--all"], env)) === null) return null;
      return (yield* git(cwd, ["write-tree"], env)) || null;
    }),
  ).pipe(Effect.orElseSucceed(() => null));

/**
 * Pushes the source's code to `refs/t3-transfer/<id>` on `origin`: its local
 * commits, plus a child commit with the uncommitted and untracked files when
 * the checkout is dirty. The source's branch, index, and files stay as they
 * are. Null when the remote already has everything or the push fails; the
 * destination then warns instead.
 */
export const pushCodeSnapshot = Effect.fn("ThreadTransferCode.pushCodeSnapshot")(function* (input: {
  readonly git: GitRun;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
  readonly transferId: string;
  readonly headSha: string | null;
  readonly dirty: boolean;
}) {
  const { git, cwd, headSha } = input;
  if (headSha === null) return null;
  const unpushed = yield* git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (!input.dirty && unpushed === "0") return null;
  let sha: string | null = headSha;
  if (input.dirty) {
    const tree = yield* worktreeTree(input);
    sha =
      tree === null
        ? null
        : yield* git(
            cwd,
            ["commit-tree", tree, "-p", headSha, "-m", `T3 Code transfer ${input.transferId}`],
            SNAPSHOT_IDENTITY,
          );
  }
  if (!sha) return null;
  const ref = `refs/t3-transfer/${input.transferId}`;
  // A hidden ref, not a published branch, so the source's pre-push hooks do not apply.
  const pushed = yield* git(cwd, ["push", "--no-verify", "origin", `${sha}:${ref}`]);
  return pushed === null ? null : { ref, sha, uncommitted: sha !== headSha };
});

/**
 * Once the destination holds the source's uncommitted files, parks them in a
 * stash so the source's worktree is clean when the thread transfers back and
 * can take the returning code. Only when the checkout is still exactly what
 * was sent, so nothing that exists only here is moved. True when it stashed.
 */
export const stashTransferredCode = Effect.fn("ThreadTransferCode.stashTransferredCode")(
  function* (input: {
    readonly git: GitRun;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd: string;
    readonly snapshot: CodeSnapshot;
    readonly message: string;
  }) {
    const { git, cwd, snapshot } = input;
    if (!snapshot.uncommitted) return false;
    if (
      (yield* git(cwd, ["rev-parse", "HEAD"])) !==
      (yield* git(cwd, ["rev-parse", `${snapshot.sha}^`]))
    ) {
      return false;
    }
    const sent = yield* git(cwd, ["rev-parse", `${snapshot.sha}^{tree}`]);
    if (sent === null || (yield* worktreeTree(input)) !== sent) return false;
    return (
      (yield* git(
        cwd,
        ["stash", "push", "--include-untracked", "--message", input.message],
        SNAPSHOT_IDENTITY,
      )) !== null
    );
  },
);

/** Fetches the snapshot from `origin` unless its commit is already here. */
export const fetchCodeSnapshot = Effect.fn("ThreadTransferCode.fetchCodeSnapshot")(function* (
  git: GitRun,
  cwd: string,
  snapshot: CodeSnapshot,
) {
  const present = git(cwd, ["cat-file", "-e", `${snapshot.sha}^{commit}`]).pipe(
    Effect.map((output) => output !== null),
  );
  if (yield* present) return true;
  if ((yield* git(cwd, ["fetch", "origin", snapshot.ref])) === null) return false;
  return yield* present;
});

/**
 * Moves a clean checkout at or behind the source commit onto it, then
 * restores the snapshot's tree over it so the source's uncommitted changes,
 * deletions included, come back uncommitted.
 */
export const applyCodeSnapshot = Effect.fn("ThreadTransferCode.applyCodeSnapshot")(function* (
  git: GitRun,
  cwd: string,
  headSha: string,
  snapshot: CodeSnapshot,
) {
  if (
    (yield* git(cwd, ["rev-parse", "HEAD"])) !== headSha &&
    (yield* git(cwd, ["merge", "--ff-only", headSha])) === null
  ) {
    return yield* new ThreadTransferError({
      message: "Could not move this environment's checkout to the source's commit.",
    });
  }
  if (
    snapshot.uncommitted &&
    (yield* git(cwd, ["restore", `--source=${snapshot.sha}`, "--worktree", "--", "."])) === null
  ) {
    return yield* new ThreadTransferError({
      message: "Could not apply the source's uncommitted changes.",
    });
  }
});
