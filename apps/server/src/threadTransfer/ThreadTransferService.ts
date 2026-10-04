import {
  CommandId,
  EventId,
  MessageId,
  THREAD_TRANSFER_MAX_BUNDLE_BYTES,
  ThreadId,
  ThreadTransferError,
  ThreadTransferManifest,
  TurnItemId,
  NonNegativeInt,
  ProjectId,
  type ChatAttachment,
  type ProjectScript,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ThreadTransferAbortInput,
  type ThreadTransferCheck,
  type ThreadTransferCompleteInput,
  type ThreadTransferCreateUploadUrlInput,
  type ThreadTransferCreateUploadUrlResult,
  type ThreadTransferExportInput,
  type ThreadTransferExportResult,
  type ThreadTransferId,
  type ThreadTransferImportInput,
  type ThreadTransferImportResult,
  type ThreadTransferPreflightInput,
  type ThreadTransferPreflightResult,
  type ThreadTransferWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { issueThreadTransferBundleUrl } from "../assets/AssetAccess.ts";
import {
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as RepositoryProjects from "../project/RepositoryProjects.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  describeFiles,
  readBundle,
  writeBundle,
  type BundleSourceFile,
} from "./ThreadTransferBundle.ts";
import {
  moveToSourceCode,
  fetchCodeSnapshot,
  pushCodeSnapshot,
  stashTransferredCode,
} from "./ThreadTransferCode.ts";
import { issueThreadTransferUploadUrl, threadTransferPaths } from "./ThreadTransferFiles.ts";
import { attachmentsOf, exportableTurnItems, importedHistory } from "./ThreadTransferHistory.ts";

export interface ThreadTransferServiceShape {
  readonly exportThread: (
    input: ThreadTransferExportInput,
  ) => Effect.Effect<ThreadTransferExportResult, ThreadTransferError>;
  readonly preflight: (
    input: ThreadTransferPreflightInput,
  ) => Effect.Effect<ThreadTransferPreflightResult, ThreadTransferError>;
  readonly createUploadUrl: (
    input: ThreadTransferCreateUploadUrlInput,
  ) => Effect.Effect<ThreadTransferCreateUploadUrlResult, ThreadTransferError>;
  readonly importThread: (
    input: ThreadTransferImportInput,
  ) => Effect.Effect<ThreadTransferImportResult, ThreadTransferError>;
  readonly complete: (
    input: ThreadTransferCompleteInput,
  ) => Effect.Effect<void, ThreadTransferError>;
  readonly abort: (input: ThreadTransferAbortInput) => Effect.Effect<void, ThreadTransferError>;
}

/**
 * Moves a thread and its native provider session to another environment.
 * Environments never talk to each other: a client connected to both calls
 * `exportThread` on the source, carries the bundle to the destination, and
 * finishes with `importThread` there and `complete` back on the source.
 */
export class ThreadTransferService extends Context.Service<
  ThreadTransferService,
  ThreadTransferServiceShape
>()("t3/threadTransfer/ThreadTransferService") {}

const CachedExport = Schema.fromJsonString(
  Schema.Struct({ manifest: ThreadTransferManifest, bundleBytes: NonNegativeInt }),
);
const encodeCachedExport = Schema.encodeSync(CachedExport);
const decodeCachedExport = Schema.decodeUnknownOption(CachedExport);

const fail = (message: string, cause?: unknown) =>
  new ThreadTransferError({ message, ...(cause === undefined ? {} : { cause }) });
const orFail =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => fail(message, cause)));

/** The thread id an import creates, so a retried import finds its own thread. */
export const importedThreadId = (transferId: ThreadTransferId) =>
  ThreadId.make(`transfer-${transferId}`);

/** -1 when `left` is an older version than `right`; 0 when either is unknown. */
export function compareVersions(left: string | null, right: string | null): number {
  if (left === null || right === null) return 0;
  const parse = (value: string) => (value.match(/\d+/g) ?? []).map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** `git worktree list --porcelain` as path and branch pairs. */
export function parseWorktreeList(
  output: string,
): ReadonlyArray<{ readonly path: string; readonly branch: string | null }> {
  return output
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      return path === undefined
        ? null
        : { path, branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : null };
    })
    .filter((entry) => entry !== null);
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentity = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const repositoryProjects = yield* RepositoryProjects.RepositoryProjects;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signed = <A, E>(
    effect: Effect.Effect<A, E, ServerSecretStore.ServerSecretStore | ServerConfig.ServerConfig>,
  ) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );

  const pathsFor = (transferId: ThreadTransferId) =>
    threadTransferPaths(config.stateDir, path, transferId);

  /** A git command's trimmed stdout, or null when it failed. Transfers read repos best effort. */
  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    git
      .execute({
        operation: "ThreadTransferService",
        cwd,
        args,
        allowNonZeroExit: true,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
      .pipe(
        Effect.map((result) => (Number(result.exitCode) === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );

  const getProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => fail("Could not read the project.", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("The project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const dispatch = (command: Parameters<Orchestrator.OrchestratorV2Shape["dispatch"]>[0]) =>
    orchestrator
      .dispatch(command)
      .pipe(
        Effect.mapError((cause) =>
          fail(
            "cause" in cause && typeof cause.cause === "string"
              ? cause.cause
              : "The thread could not be updated.",
            cause,
          ),
        ),
      );

  const removeExport = (transferId: ThreadTransferId) =>
    Effect.forEach(
      [pathsFor(transferId).outBundle, pathsFor(transferId).outResult],
      (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

  /**
   * Cleans up the code snapshot the export pushed, once the destination has
   * fetched it or never will. With `stashMessage`, the destination took the
   * uncommitted files, so a thread in its own worktree parks them in a stash
   * and leaves the worktree clean for the thread's return.
   */
  const settleSnapshot = (input: {
    readonly threadId: ThreadId;
    readonly transferId: ThreadTransferId;
    readonly stashMessage?: string;
  }) =>
    Effect.gen(function* () {
      const cached = yield* fileSystem.readFileString(pathsFor(input.transferId).outResult).pipe(
        Effect.map(decodeCachedExport),
        Effect.orElseSucceed(() => Option.none()),
      );
      const snapshot = Option.isSome(cached) ? cached.value.manifest.repo.snapshot : null;
      if (snapshot == null) return;
      const thread = yield* orchestrator.getThreadShell(input.threadId);
      if (thread === null) return;
      // The project checkout is shared with other threads, so only a thread's own worktree is stashed.
      if (input.stashMessage !== undefined && thread.worktreePath !== null) {
        yield* stashTransferredCode({
          git: gitOutput,
          fileSystem,
          path,
          cwd: thread.worktreePath,
          snapshot,
          message: input.stashMessage,
        });
      }
      const cwd = thread.worktreePath ?? (yield* getProject(thread.projectId)).workspaceRoot;
      yield* gitOutput(cwd, ["push", "--no-verify", "origin", "--delete", snapshot.ref]);
    }).pipe(Effect.ignore);

  const abort: ThreadTransferServiceShape["abort"] = Effect.fn("ThreadTransferService.abort")(
    function* (input) {
      yield* settleSnapshot(input);
      yield* dispatch({
        type: "thread.transfer-out.abort",
        commandId: CommandId.make(`thread-transfer:${input.transferId}:abort`),
        threadId: input.threadId,
        transferId: input.transferId,
      });
      yield* removeExport(input.transferId);
    },
  );

  const complete: ThreadTransferServiceShape["complete"] = Effect.fn(
    "ThreadTransferService.complete",
  )(function* (input) {
    yield* dispatch({
      type: "thread.transfer-out.complete",
      commandId: CommandId.make(`thread-transfer:${input.transferId}:complete`),
      threadId: input.threadId,
      transferId: input.transferId,
      destination: input.destination,
    });
    const label = input.destination.environmentLabel ?? "another environment";
    yield* settleSnapshot({
      threadId: input.threadId,
      transferId: input.transferId,
      ...(input.sourceCodeApplied === true
        ? { stashMessage: `T3 Code: transferred to ${label} (${input.transferId})` }
        : {}),
    });
    yield* removeExport(input.transferId);
  });

  /**
   * Cancels queued messages and interrupts the running turn, so the thread
   * can be locked. True when it stopped a turn the destination should continue.
   */
  const stopWork = Effect.fn("ThreadTransferService.stopWork")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly transferId: ThreadTransferId;
  }) {
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(orFail("The thread was not found."));
    // A queued message would start the moment the running turn ends.
    for (const run of records.runs.filter((candidate) => candidate.status === "queued")) {
      yield* dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`thread-transfer:${input.transferId}:cancel:${run.id}`),
        threadId: input.threadId,
        runId: run.id,
      });
    }
    const interrupted = yield* threads
      .interruptThread({
        projectId: input.projectId,
        commandId: CommandId.make(`thread-transfer:${input.transferId}:interrupt`),
        threadId: input.threadId,
        reason: "Transferring the thread to another environment.",
      })
      .pipe(orFail("Could not stop the thread."));
    if (interrupted.type !== "interrupt_requested") return false;
    const waited = yield* threads
      .waitForThread({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: interrupted.run.id,
        timeoutMs: 30_000,
      })
      .pipe(orFail("Could not stop the thread."));
    if (waited.timedOut) {
      return yield* fail("The thread did not stop in time. Try again.");
    }
    return true;
  });

  const readRepoState = Effect.fn("ThreadTransferService.readRepoState")(function* (
    cwd: string,
    worktree: boolean,
    projectTitle: string,
  ) {
    const branch = yield* gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = yield* gitOutput(cwd, ["status", "--porcelain"]);
    return {
      canonicalKey: (yield* repositoryIdentity.resolve(cwd))?.canonicalKey ?? null,
      branch: branch === null || branch === "HEAD" || branch === "" ? null : branch,
      headSha: (yield* gitOutput(cwd, ["rev-parse", "HEAD"])) || null,
      dirtyFileCount: status === null || status === "" ? 0 : status.split("\n").length,
      worktree,
      remoteUrl: (yield* gitOutput(cwd, ["remote", "get-url", "origin"])) || null,
      projectTitle,
    };
  });

  const exportThread: ThreadTransferServiceShape["exportThread"] = Effect.fn(
    "ThreadTransferService.exportThread",
  )(function* (input) {
    const paths = pathsFor(input.transferId);
    const issueUrl = signed(issueThreadTransferBundleUrl(input.transferId)).pipe(
      orFail("Could not sign the bundle download."),
    );
    // A retried export returns the bundle it already wrote.
    const cached = yield* fileSystem.readFileString(paths.outResult).pipe(
      Effect.map(decodeCachedExport),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (
      Option.isSome(cached) &&
      (yield* fileSystem.exists(paths.outBundle).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return { ...cached.value, ...(yield* issueUrl) };
    }

    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads", "providerSessions"])
      .pipe(orFail("The thread was not found."));
    const thread = records.thread;
    if (thread.transfer?.status === "completed") {
      return yield* fail("The thread was already transferred.");
    }
    if (thread.transfer != null && thread.transfer.transferId !== input.transferId) {
      return yield* fail("The thread is already part of another transfer.");
    }
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId ?? null;
    if (
      providerThread === undefined ||
      nativeThreadId === null ||
      providerThread.nativeThreadRef?.strength !== "strong"
    ) {
      return yield* fail("This thread has no provider session to transfer yet.");
    }
    const adapter = yield* adapters
      .get(providerThread.providerInstanceId)
      .pipe(orFail("The thread's provider is not available on this environment."));
    const nativeTransfer = adapter.nativeSessionTransfer;
    if (nativeTransfer === undefined) {
      return yield* fail(`Threads using ${adapter.driver} cannot be transferred yet.`);
    }
    const project = yield* getProject(thread.projectId);
    const cwd = thread.worktreePath ?? project.workspaceRoot;

    const wasWorking =
      thread.transfer == null &&
      (yield* stopWork({
        projectId: thread.projectId,
        threadId: input.threadId,
        transferId: input.transferId,
      }));
    yield* dispatch({
      type: "thread.transfer-out.begin",
      commandId: CommandId.make(`thread-transfer:${input.transferId}:begin`),
      threadId: input.threadId,
      transferId: input.transferId,
    });
    return yield* Effect.gen(function* () {
      // The provider must stop writing its files before they are read. The
      // detach effect the begin command queued does the same; the second is a no-op.
      yield* Effect.forEach(
        records.providerSessions,
        (session) =>
          providerSessions
            .detach({
              providerSessionId: session.id,
              threadId: input.threadId,
              detail: "Thread is being transferred.",
            })
            .pipe(Effect.ignore),
        { discard: true },
      );
      const located = yield* nativeTransfer
        .locate({ nativeThreadId, cwd })
        .pipe(orFail("Could not read the provider session files."));
      if (located === null) {
        return yield* fail("The provider session files for this thread were not found.");
      }
      const projection = yield* orchestrator
        .getThreadProjection(input.threadId)
        .pipe(orFail("Could not read the thread history."));
      const items = exportableTurnItems(projection.visibleTurnItems);
      const attachmentFiles = new Map<string, BundleSourceFile>();
      for (const attachment of attachmentsOf(items)) {
        const absolutePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        if (absolutePath === null || attachmentFiles.has(attachment.id)) continue;
        if (!(yield* fileSystem.exists(absolutePath).pipe(Effect.orElseSucceed(() => false)))) {
          continue;
        }
        attachmentFiles.set(attachment.id, {
          kind: "attachment",
          relativePath: attachment.id,
          absolutePath,
        });
      }
      const files: ReadonlyArray<BundleSourceFile> = [
        ...located.relativePaths.map((relativePath) => ({
          kind: "native" as const,
          relativePath,
          absolutePath: path.join(located.root, relativePath),
        })),
        ...attachmentFiles.values(),
      ];
      const descriptor = yield* serverEnvironment.getDescriptor;
      const provider = (yield* providerRegistry.getProviders).find(
        (candidate) => candidate.instanceId === providerThread.providerInstanceId,
      );
      const repoState = yield* readRepoState(cwd, thread.worktreePath !== null, project.title);
      const repo = {
        ...repoState,
        snapshot: yield* pushCodeSnapshot({
          git: gitOutput,
          fileSystem,
          path,
          cwd,
          transferId: input.transferId,
          headSha: repoState.headSha,
          dirty: repoState.dirtyFileCount > 0,
        }),
      };
      const manifest: ThreadTransferManifest = {
        version: 1,
        transferId: input.transferId,
        source: {
          environmentId: descriptor.environmentId,
          ...(descriptor.label.trim() === "" ? {} : { environmentLabel: descriptor.label }),
          threadId: input.threadId,
          title: thread.title,
          driver: providerThread.driver,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          providerVersion: provider?.version ?? null,
          nativeThreadRef: providerThread.nativeThreadRef!,
          nativeConversationHeadRef: providerThread.nativeConversationHeadRef,
          wasWorking,
        },
        repo,
        itemCount: items.length,
        files: yield* Effect.tryPromise({
          try: () => describeFiles(files),
          catch: (cause) => fail("Could not read the files to transfer.", cause),
        }),
      };
      const bundleBytes = yield* Effect.tryPromise({
        try: () => writeBundle({ path: paths.outBundle, manifest, items, files }),
        catch: (cause) => fail("Could not write the transfer bundle.", cause),
      });
      yield* fileSystem
        .writeFileString(paths.outResult, encodeCachedExport({ manifest, bundleBytes }))
        .pipe(orFail("Could not record the transfer bundle."));
      return { manifest, bundleBytes, ...(yield* issueUrl) };
    }).pipe(
      // Nothing exists on the destination yet, so a failed export just unlocks the thread.
      Effect.tapError(() =>
        abort({ threadId: input.threadId, transferId: input.transferId }).pipe(Effect.ignore),
      ),
    );
  });

  const findWorktree = (root: string, branch: string) =>
    gitOutput(root, ["worktree", "list", "--porcelain"]).pipe(
      Effect.map(
        (output) =>
          parseWorktreeList(output ?? "").find((worktree) => worktree.branch === branch) ?? null,
      ),
    );

  const preflight: ThreadTransferServiceShape["preflight"] = Effect.fn(
    "ThreadTransferService.preflight",
  )(function* ({ manifest, bundleBytes }) {
    const blockers: Array<ThreadTransferCheck> = [];
    const warnings: Array<ThreadTransferCheck> = [];
    if (bundleBytes > THREAD_TRANSFER_MAX_BUNDLE_BYTES) {
      blockers.push({
        code: "bundle_too_large",
        message: `The thread is ${Math.ceil(bundleBytes / 1024 / 1024)} MB; this environment accepts up to ${THREAD_TRANSFER_MAX_BUNDLE_BYTES / 1024 / 1024} MB.`,
      });
    }

    const candidates = (yield* providerRegistry.getProviders).filter(
      (provider) => provider.driver === manifest.source.driver && provider.enabled,
    );
    const provider =
      candidates.find(
        (candidate) => candidate.instanceId === manifest.source.modelSelection.instanceId,
      ) ?? candidates[0];
    if (provider === undefined) {
      blockers.push({
        code: "provider_missing",
        message: `No ${manifest.source.driver} provider is set up on this environment.`,
      });
    } else {
      const adapter = yield* Effect.option(adapters.get(provider.instanceId));
      if (Option.isNone(adapter) || adapter.value.nativeSessionTransfer === undefined) {
        blockers.push({
          code: "native_unsupported",
          message: `${provider.displayName ?? provider.driver} on this environment cannot resume transferred sessions.`,
        });
      }
      if (provider.auth.status === "unauthenticated") {
        blockers.push({
          code: "provider_unauthenticated",
          message: `Sign in to ${provider.displayName ?? provider.driver} on this environment first.`,
        });
      }
      if (compareVersions(provider.version, manifest.source.providerVersion) < 0) {
        warnings.push({
          code: "provider_older",
          message: `This environment runs ${provider.driver} ${provider.version}, older than the source's ${manifest.source.providerVersion}. Resuming may fail.`,
        });
      }
    }

    const project =
      manifest.repo.canonicalKey === null
        ? null
        : yield* repositoryProjects
            .find(manifest.repo.canonicalKey)
            .pipe(orFail("Could not read the projects."));
    if (project === null) {
      // Same git account on both sides: clone the source's origin and make it a project.
      const remoteUrl = manifest.repo.canonicalKey === null ? null : manifest.repo.remoteUrl;
      if (remoteUrl === null) {
        blockers.push({
          code: "project_missing",
          message:
            manifest.repo.canonicalKey === null
              ? "Only threads in a Git repository can be transferred."
              : "The repository has no origin remote to clone. Add it as a project on this environment first.",
        });
      }
      // A snapshot goes onto the fresh clone; the import plans that after cloning.
      if (manifest.repo.dirtyFileCount > 0 && manifest.repo.snapshot == null) {
        const count = manifest.repo.dirtyFileCount;
        warnings.push({
          code: "source_dirty",
          message: `The source has ${count} uncommitted ${count === 1 ? "file" : "files"}, which are not transferred.`,
        });
      }
      return {
        blockers,
        warnings,
        projectId: null,
        newProject: remoteUrl === null ? null : { title: manifest.repo.projectTitle, remoteUrl },
        instanceId: provider?.instanceId ?? null,
        workspace: null,
        carriesSourceCode: false,
      };
    }

    const root = project.workspaceRoot;
    const branch = manifest.repo.branch;
    const sourceSha = manifest.repo.headSha;
    const snapshot = manifest.repo.snapshot ?? null;
    const hasCommit = (sha: string) =>
      gitOutput(root, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
        Effect.map((output) => output !== null),
      );
    // The snapshot's ancestry holds the source's commits, pushed or not.
    const snapshotHere = snapshot !== null && (yield* fetchCodeSnapshot(gitOutput, root, snapshot));
    let workspace: ThreadTransferWorkspace = { type: "root" };
    let compareRef = "HEAD";
    let checkoutDiffers = false;
    if (branch !== null && manifest.repo.worktree) {
      const existing = yield* findWorktree(root, branch);
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (existing !== null) {
        workspace =
          existing.path === root || existing.path === realRoot
            ? { type: "root" }
            : { type: "existing_worktree", worktreePath: existing.path, branch };
        compareRef = `refs/heads/${branch}`;
      } else if (
        (yield* gitOutput(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !==
        null
      ) {
        workspace = { type: "worktree", branch, startRef: branch };
        compareRef = `refs/heads/${branch}`;
      } else {
        yield* gitOutput(root, ["fetch", "origin", branch]);
        if (
          (yield* gitOutput(root, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/remotes/origin/${branch}`,
          ])) !== null
        ) {
          workspace = { type: "worktree", branch, startRef: `origin/${branch}` };
          compareRef = `refs/remotes/origin/${branch}`;
        } else if (snapshotHere && sourceSha !== null) {
          // The branch was never pushed; the snapshot brought its commits.
          workspace = { type: "worktree", branch, startRef: sourceSha };
          compareRef = sourceSha;
        } else {
          blockers.push({
            code: "branch_missing",
            message: `Branch '${branch}' is not on this environment or its remote. Push it from the source first.`,
          });
        }
      }
    } else if (branch !== null) {
      const rootBranch = yield* gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (rootBranch !== branch) {
        checkoutDiffers = true;
        warnings.push({
          code: "checkout_differs",
          message: `This environment's checkout is on '${rootBranch ?? "a detached HEAD"}'; the thread ran on '${branch}'.`,
        });
      }
    }

    // Where the destination stands relative to the source commit.
    let relation: "same" | "behind" | "ahead" | "diverged" | "unknown" = "unknown";
    let distance = 0;
    const targetSha = yield* gitOutput(root, ["rev-parse", "--verify", "--quiet", compareRef]);
    if (sourceSha !== null && targetSha !== null) {
      if (targetSha === sourceSha) {
        relation = "same";
      } else {
        if (!(yield* hasCommit(sourceSha)) && branch !== null) {
          yield* gitOutput(root, ["fetch", "origin", branch]);
        }
        const isAncestor = (ancestor: string, descendant: string) =>
          gitOutput(root, ["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
            Effect.map((output) => output !== null),
          );
        const count = (from: string, to: string) =>
          gitOutput(root, ["rev-list", "--count", `${from}..${to}`]).pipe(
            Effect.map((output) => Number(output ?? 0)),
          );
        if (!(yield* hasCommit(sourceSha))) {
          relation = "unknown";
        } else if (yield* isAncestor(targetSha, sourceSha)) {
          relation = "behind";
          distance = yield* count(targetSha, sourceSha);
        } else if (yield* isAncestor(sourceSha, targetSha)) {
          relation = "ahead";
          distance = yield* count(sourceSha, targetSha);
        } else {
          relation = "diverged";
        }
      }
    }

    // The destination takes the source's code only when that loses nothing
    // here: same branch, not ahead or apart, and no uncommitted changes.
    const checkoutCwd =
      workspace.type === "root"
        ? root
        : workspace.type === "existing_worktree"
          ? workspace.worktreePath
          : null;
    const checkoutClean =
      checkoutCwd === null || (yield* gitOutput(checkoutCwd, ["status", "--porcelain"])) === "";
    const carriesSourceCode =
      blockers.length === 0 &&
      !checkoutDiffers &&
      (relation === "same" || relation === "behind") &&
      checkoutClean;
    if (!checkoutClean && !checkoutDiffers && (snapshotHere || relation === "behind")) {
      warnings.push({
        code: "checkout_differs",
        message:
          "This environment's checkout has uncommitted changes, so the source's code is not applied.",
      });
    }

    const plural = (n: number) => (n === 1 ? "commit" : "commits");
    if (manifest.repo.dirtyFileCount > 0 && !(carriesSourceCode && snapshotHere)) {
      const count = manifest.repo.dirtyFileCount;
      warnings.push({
        code: "source_dirty",
        message: `The source has ${count} uncommitted ${count === 1 ? "file" : "files"}, which are not transferred.`,
      });
    }
    if (!carriesSourceCode) {
      if (relation === "behind") {
        warnings.push({
          code: "head_differs",
          message: `This environment is ${distance} ${plural(distance)} behind the source.`,
        });
      } else if (relation === "ahead") {
        warnings.push({
          code: "head_differs",
          message: `This environment is ${distance} ${plural(distance)} ahead of the source.`,
        });
      } else if (relation === "diverged") {
        warnings.push({
          code: "head_differs",
          message: "This environment's checkout has diverged from the source.",
        });
      } else if (relation === "unknown" && sourceSha !== null && targetSha !== null) {
        warnings.push({
          code: "head_differs",
          message:
            "The source's latest commit is not on this environment. Push it from the source to match.",
        });
      }
    }
    return {
      blockers,
      warnings,
      projectId: project.id,
      newProject: null,
      instanceId: provider?.instanceId ?? null,
      workspace,
      carriesSourceCode,
    };
  });

  const createUploadUrl: ThreadTransferServiceShape["createUploadUrl"] = (input) =>
    signed(issueThreadTransferUploadUrl(input));

  /** Where the imported thread works; reuses a worktree a failed attempt already made. */
  const realizeWorkspace = Effect.fn("ThreadTransferService.realizeWorkspace")(function* (
    root: string,
    workspace: ThreadTransferWorkspace,
  ) {
    switch (workspace.type) {
      case "root":
        return {
          cwd: root,
          worktreePath: null,
          branch: (yield* gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || null,
        };
      case "existing_worktree":
        if (
          !(yield* fileSystem
            .exists(workspace.worktreePath)
            .pipe(Effect.orElseSucceed(() => false)))
        ) {
          return yield* fail("The worktree for this branch no longer exists. Try again.");
        }
        return {
          cwd: workspace.worktreePath,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
        };
      case "worktree": {
        const existing = yield* findWorktree(root, workspace.branch);
        const worktreePath =
          existing?.path ??
          (yield* git
            .createWorktree({
              cwd: root,
              refName: workspace.startRef,
              ...(workspace.startRef === workspace.branch ? {} : { newRefName: workspace.branch }),
              path: null,
            })
            .pipe(
              Effect.map((result) => result.worktree.path),
              orFail(`Could not create a worktree for '${workspace.branch}'.`),
            ));
        return { cwd: worktreePath, worktreePath, branch: workspace.branch };
      }
    }
  });

  const copyInto = (from: string, root: string, relativePath: string) =>
    Effect.gen(function* () {
      const destination = path.resolve(root, relativePath);
      if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) {
        return yield* fail(`Bundle path '${relativePath}' leaves its directory.`);
      }
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fileSystem.copyFile(from, destination);
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ThreadTransferError"
          ? cause
          : fail("Could not write a transferred file.", cause),
      ),
    );

  /**
   * Gets the imported thread going on its own: a new worktree or clone first
   * runs the project's setup script, as a normal worktree launch does, then a
   * turn the transfer stopped on the source restarts. Waiting for setup happens
   * in the background so the import returns. Best effort, because the thread
   * has already moved.
   */
  const resumeImportedThread = (input: {
    readonly threadId: ThreadId;
    readonly transferId: ThreadTransferId;
    readonly manifest: ThreadTransferManifest;
    readonly project: {
      readonly id: ProjectId;
      readonly workspaceRoot: string;
      readonly scripts: ReadonlyArray<ProjectScript>;
    };
    readonly cwd: string;
    readonly freshWorkspace: boolean;
  }) => {
    const logFailure = Effect.catchCause((cause) =>
      Effect.logWarning("Could not resume the transferred thread.", cause),
    );
    const continueWork =
      input.manifest.source.wasWorking !== true
        ? Effect.void
        : threads
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`thread-transfer:${input.transferId}:continue`),
              threadId: input.threadId,
              messageId: MessageId.make(`message:thread-transfer-continuation:${input.transferId}`),
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(Effect.asVoid);
    return Effect.gen(function* () {
      const setup = input.freshWorkspace
        ? yield* setupScripts.runForThread({
            threadId: input.threadId,
            projectId: input.project.id,
            projectCwd: input.project.workspaceRoot,
            worktreePath: input.cwd,
            project: input.project,
            observeCompletion: {},
          })
        : null;
      if (setup?.status === "started" && !setup.async && setup.completion !== undefined) {
        // The agent continues even if setup fails; it can see and fix that itself.
        yield* Effect.forkDetach(setup.completion.pipe(Effect.andThen(continueWork), logFailure));
        return;
      }
      yield* continueWork;
    }).pipe(logFailure);
  };

  const importThread: ThreadTransferServiceShape["importThread"] = Effect.fn(
    "ThreadTransferService.importThread",
  )(function* (input) {
    const threadId = importedThreadId(input.transferId);
    const existing = yield* orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) return { threadId };

    const paths = pathsFor(input.transferId);
    if (!(yield* fileSystem.exists(paths.inBundle).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* fail("The transfer bundle has not been uploaded yet.");
    }
    const bundle = yield* Effect.tryPromise({
      try: () => readBundle(paths.inBundle, paths.staging),
      catch: (cause) => fail("The transfer bundle is damaged. Start the transfer again.", cause),
    });
    const { manifest } = bundle;
    if (manifest.transferId !== input.transferId) {
      return yield* fail("The uploaded bundle belongs to another transfer.");
    }
    const bundleBytes = (yield* fileSystem
      .stat(paths.inBundle)
      .pipe(orFail("Could not read the bundle."))).size;
    let checks = yield* preflight({ manifest, bundleBytes: Number(bundleBytes) });
    let cloned = false;
    if (checks.blockers.length === 0 && checks.newProject !== null) {
      cloned = true;
      yield* repositoryProjects
        .ensure({ canonicalKey: manifest.repo.canonicalKey!, ...checks.newProject })
        .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
      // The workspace can only be planned against the fresh clone.
      checks = yield* preflight({ manifest, bundleBytes: Number(bundleBytes) });
    }
    if (checks.blockers.length > 0) {
      return yield* fail(checks.blockers.map((blocker) => blocker.message).join(" "));
    }
    const projectId = input.projectId ?? checks.projectId;
    const workspacePlan = input.projectId === null ? checks.workspace : input.workspace;
    if (projectId === null || workspacePlan === null) {
      return yield* fail("This environment has no project for the repository.");
    }
    const project = yield* getProject(projectId);
    const adapter = yield* adapters
      .get(input.instanceId)
      .pipe(orFail("The selected provider is not available."));
    const nativeThreadId = manifest.source.nativeThreadRef.nativeId;
    if (nativeThreadId === null) {
      return yield* fail("The bundle has no provider session to resume.");
    }
    if (adapter.driver !== manifest.source.driver || adapter.nativeSessionTransfer === undefined) {
      return yield* fail(
        `The selected provider cannot resume a ${manifest.source.driver} session.`,
      );
    }

    const workspace = yield* realizeWorkspace(project.workspaceRoot, workspacePlan);
    const snapshot = manifest.repo.snapshot ?? null;
    const sourceHead = manifest.repo.headSha;
    // Whether the source's uncommitted files arrived, so the source can park its copy.
    let sourceCodeApplied = false;
    if (checks.carriesSourceCode && sourceHead !== null) {
      const arrived =
        snapshot !== null && (yield* fetchCodeSnapshot(gitOutput, workspace.cwd, snapshot))
          ? snapshot
          : null;
      yield* moveToSourceCode(gitOutput, workspace.cwd, sourceHead, arrived);
      sourceCodeApplied = arrived?.uncommitted === true;
    }

    const nativeRoot = yield* adapter.nativeSessionTransfer
      .importRoot({ cwd: workspace.cwd })
      .pipe(orFail("Could not find where the provider keeps its sessions."));
    const attachmentsById = new Map(
      attachmentsOf(bundle.items).map((attachment) => [attachment.id, attachment] as const),
    );
    const remapped = new Map<string, ChatAttachment>();
    for (const [index, file] of manifest.files.entries()) {
      const staged = bundle.stagedPaths[index]!;
      if (file.kind === "native") {
        if (
          !adapter.nativeSessionTransfer.accepts({
            nativeThreadId,
            relativePath: file.relativePath,
          })
        ) {
          return yield* fail(
            `The bundle holds a file that is not part of the session: '${file.relativePath}'.`,
          );
        }
        yield* copyInto(staged, nativeRoot, file.relativePath);
        continue;
      }
      const attachment = attachmentsById.get(file.relativePath);
      if (attachment === undefined) continue;
      const extension = parseAttachmentFileExtension(attachment.id);
      const baseId = createDeterministicAttachmentId(
        threadId,
        `${input.transferId}:${attachment.id}`,
      );
      if (baseId === null) continue;
      const moved = { ...attachment, id: extension === null ? baseId : `${baseId}-${extension}` };
      const destination = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: moved,
      });
      if (destination === null) continue;
      yield* copyInto(staged, path.dirname(destination), path.basename(destination));
      remapped.set(attachment.id, moved);
    }

    const history = importedHistory({
      threadId,
      transferId: input.transferId,
      items: bundle.items,
      remapAttachment: (attachment) => remapped.get(attachment.id) ?? null,
    });
    const now = yield* DateTime.now;
    const here = (yield* serverEnvironment.getDescriptor).label.trim();
    const transferMessage = `Transferred from ${
      manifest.source.environmentLabel ?? "another environment"
    } to ${here === "" ? "this environment" : here}`;
    // Marks where the conversation changed machines; later trips carry it along like any note.
    const transferNotice: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`transfer:${input.transferId}:notice`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: history.turnItems.length + 1,
      type: "system_notice",
      status: "completed",
      title: transferMessage,
      message: transferMessage,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const driver = manifest.source.driver;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: input.instanceId,
      nativeThreadId,
    });
    const appThread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: threadId,
      projectId: project.id,
      title: manifest.source.title,
      providerInstanceId: input.instanceId,
      modelSelection: { ...manifest.source.modelSelection, instanceId: input.instanceId },
      runtimeMode: manifest.source.runtimeMode,
      interactionMode: manifest.source.interactionMode,
      branch: workspace.branch,
      worktreePath: workspace.worktreePath,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "transfer",
      transferredFrom: {
        transferId: input.transferId,
        environmentId: manifest.source.environmentId,
        threadId: manifest.source.threadId,
        ...(manifest.source.environmentLabel === undefined
          ? {}
          : { environmentLabel: manifest.source.environmentLabel }),
      },
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: input.instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: manifest.source.nativeThreadRef,
      nativeConversationHeadRef: manifest.source.nativeConversationHeadRef,
      status: "not_loaded",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const eventId = (suffix: string) =>
      EventId.make(`thread-transfer:${input.transferId}:${suffix}`);
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        id: eventId("thread"),
        type: "thread.created",
        threadId,
        providerInstanceId: input.instanceId,
        occurredAt: now,
        payload: appThread,
      },
      ...history.messages.map((message): OrchestrationV2DomainEvent => ({
        id: eventId(`message:${message.id}`),
        type: "message.updated",
        threadId,
        occurredAt: message.updatedAt,
        payload: message,
      })),
      ...[...history.turnItems, transferNotice].map((item): OrchestrationV2DomainEvent => ({
        id: eventId(`item:${item.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: item.updatedAt,
        payload: item,
      })),
      {
        id: eventId("provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId: input.instanceId,
        occurredAt: now,
        payload: providerThread,
      },
    ];
    yield* eventSink.write({ events }).pipe(orFail("Could not save the imported thread."));
    yield* resumeImportedThread({
      threadId,
      transferId: input.transferId,
      manifest,
      project,
      cwd: workspace.cwd,
      freshWorkspace: cloned || workspacePlan.type === "worktree",
    });
    yield* Effect.forEach(
      [paths.staging, paths.inBundle],
      (file) => fileSystem.remove(file, { recursive: true, force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    return { threadId, sourceCodeApplied };
  });

  return ThreadTransferService.of({
    exportThread,
    preflight,
    createUploadUrl,
    importThread,
    complete,
    abort,
  });
});

export const layer = Layer.effect(ThreadTransferService, make);
