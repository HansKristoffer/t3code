import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { ProviderAdapterV2NativeSessionTransfer } from "../ProviderAdapter.ts";

// Native ids become file names; anything else could escape the session root.
const SAFE_NATIVE_ID = /^[A-Za-z0-9_-]+$/;
const CLAUDE_PROJECT_KEY_MAX_LENGTH = 200;

/**
 * The directory name Claude Code keeps a cwd's sessions under
 * (`<config>/projects/<key>`). Mirrors the SDK: non-alphanumerics become `-`,
 * and long paths are cut and suffixed with a hash so they stay unique.
 */
export function claudeProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= CLAUDE_PROJECT_KEY_MAX_LENGTH) return sanitized;
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  }
  return `${sanitized.slice(0, CLAUDE_PROJECT_KEY_MAX_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

const listFiles = (fileSystem: FileSystem.FileSystem, path: Path.Path, directory: string) =>
  Effect.gen(function* () {
    if (!(yield* fileSystem.exists(directory))) return [];
    const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
    const files: Array<string> = [];
    for (const entry of entries.toSorted()) {
      const info = yield* fileSystem.stat(path.join(directory, entry));
      if (info.type === "File") files.push(entry.split(path.sep).join("/"));
    }
    return files;
  });

// The CLI resolves its cwd before deriving the key (macOS reports /tmp as /private/tmp).
const realPathOr = (fileSystem: FileSystem.FileSystem, cwd: string) =>
  fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

/**
 * Claude Code finds a session only below the project key of the cwd it
 * resumes in, so an import writes there. A session's subagent transcripts
 * live in a sibling `<sessionId>/` directory and move with it.
 */
export function makeClaudeNativeSessionTransfer(input: {
  readonly homePath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): ProviderAdapterV2NativeSessionTransfer {
  const { fileSystem, path } = input;
  const projectsDir = path.join(input.homePath, "projects");
  return {
    locate: ({ nativeThreadId, cwd }) =>
      Effect.gen(function* () {
        if (!SAFE_NATIVE_ID.test(nativeThreadId)) return null;
        const transcript = `${nativeThreadId}.jsonl`;
        const realCwd = yield* realPathOr(fileSystem, cwd);
        const preferred = [claudeProjectKey(realCwd), claudeProjectKey(cwd)];
        // The session may have started in another directory of this home.
        const others = (yield* fileSystem.exists(projectsDir))
          ? yield* fileSystem.readDirectory(projectsDir)
          : [];
        for (const key of [...preferred, ...others]) {
          const root = path.join(projectsDir, key);
          if (!(yield* fileSystem.exists(path.join(root, transcript)))) continue;
          const sidecar = yield* listFiles(fileSystem, path, path.join(root, nativeThreadId));
          return {
            root,
            relativePaths: [transcript, ...sidecar.map((file) => `${nativeThreadId}/${file}`)],
          };
        }
        return null;
      }),
    importRoot: ({ cwd }) =>
      realPathOr(fileSystem, cwd).pipe(
        Effect.map((realCwd) => path.join(projectsDir, claudeProjectKey(realCwd))),
      ),
    accepts: ({ nativeThreadId, relativePath }) =>
      SAFE_NATIVE_ID.test(nativeThreadId) &&
      (relativePath === `${nativeThreadId}.jsonl` || relativePath.startsWith(`${nativeThreadId}/`)),
  };
}

/**
 * Codex finds a rollout by thread id anywhere below `sessions/`, so the
 * rollout keeps its relative path. An archived rollout stays archived; resume
 * already unarchives it.
 */
export function makeCodexNativeSessionTransfer(input: {
  readonly homePath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): ProviderAdapterV2NativeSessionTransfer {
  const { fileSystem, path } = input;
  return {
    locate: ({ nativeThreadId }) =>
      Effect.gen(function* () {
        if (!SAFE_NATIVE_ID.test(nativeThreadId)) return null;
        const suffix = `-${nativeThreadId}.jsonl`;
        for (const directory of ["sessions", "archived_sessions"]) {
          const root = path.join(input.homePath, directory);
          if (!(yield* fileSystem.exists(root))) continue;
          // Thousands of rollouts: match names first instead of stat-ing each.
          const match = (yield* fileSystem.readDirectory(root, { recursive: true }))
            .map((entry) => entry.split(path.sep).join("/"))
            .find((entry) => {
              const name = entry.split("/").at(-1)!;
              return name.startsWith("rollout-") && name.endsWith(suffix);
            });
          if (match !== undefined) {
            return { root: input.homePath, relativePaths: [`${directory}/${match}`] };
          }
        }
        return null;
      }),
    importRoot: () => Effect.succeed(input.homePath),
    // The import root is the whole Codex home; only rollouts may land in it.
    accepts: ({ nativeThreadId, relativePath }) =>
      SAFE_NATIVE_ID.test(nativeThreadId) &&
      /^(sessions|archived_sessions)\/([\w-]+\/)*rollout-[\w-]+\.jsonl$/.test(relativePath) &&
      relativePath.endsWith(`-${nativeThreadId}.jsonl`),
  };
}
