// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ExecutionEnvironmentDescriptor,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexNativeSessionTransfer } from "../orchestration-v2/Adapters/NativeSessionTransfer.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryProjects from "../project/RepositoryProjects.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadTransferService from "./ThreadTransferService.ts";

const codexHome = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transfer-codex-")),
);
const workspaceRoot = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transfer-repo-")),
);
const projectId = ProjectId.make("transfer-project");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const nativeId = "019b8052-938c-76f2-9d65-2a38e8ba0f09";
const rollout = `sessions/2026/01/02/rollout-2026-01-02T21-07-34-${nativeId}.jsonl`;

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by transfer tests"),
} as ProviderAdapterV2Shape;

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:transfer-test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: adapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const ConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-transfer-" });
const PlatformLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const CheckpointStoreLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ConfigLayer),
  Layer.provide(PlatformLayer),
);

const OrchestrationLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreLayer),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
    }),
  ),
  Layer.provide(ConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
);

const project = {
  id: projectId,
  title: "Repo",
  workspaceRoot,
  repositoryIdentity: { canonicalKey: "github.com/acme/repo" },
};
const projects: Array<typeof project> = [project];
const projectsRoot = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transfer-projects-")),
);
const clones: Array<{ readonly remoteUrl: string; readonly destinationPath: string }> = [];
const gitResult = (exitCode: number, stdout: string) =>
  Effect.succeed({
    exitCode,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  } as never);

const TestLayer = ThreadTransferService.layer.pipe(
  Layer.provideMerge(RepositoryProjects.layer),
  Layer.provideMerge(OrchestrationLayer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: () =>
        Effect.gen(function* () {
          return {
            ...adapter,
            nativeSessionTransfer: makeCodexNativeSessionTransfer({
              homePath: codexHome,
              fileSystem: yield* FileSystem.FileSystem,
              path: yield* Path.Path,
            }),
          };
        }).pipe(Effect.provide(PlatformLayer)),
    }),
  ),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId,
          driver,
          enabled: true,
          version: "0.160.0",
          auth: { status: "authenticated" },
        } as unknown as ServerProvider,
      ]),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(Option.fromNullishOr(projects.find((entry) => entry.id === id) as never)),
      listShells: () => Effect.succeed([...projects] as never),
      create: (input) =>
        Effect.sync(() => {
          const created = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: { canonicalKey: "github.com/acme/repo" },
          };
          projects.push(created);
          return created as never;
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed({ canonicalKey: "github.com/acme/repo" } as never),
    }),
  ),
  // The test repos only have an origin: transfers read repository state best effort.
  Layer.provide(
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: ({ args }) =>
        args[0] === "remote" ? gitResult(0, "git@github.com:acme/repo.git\n") : gitResult(128, ""),
    }),
  ),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: projectsRoot }),
  ),
  Layer.provide(
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: ({ remoteUrl, destinationPath }) =>
        Effect.sync(() => {
          NodeFS.mkdirSync(destinationPath, { recursive: true });
          clones.push({ remoteUrl: remoteUrl!, destinationPath });
          return { cwd: destinationPath, remoteUrl: remoteUrl!, repository: null };
        }),
      discardClone: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-a")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("env-a"),
        label: "Laptop",
      } as ExecutionEnvironmentDescriptor),
    }),
  ),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ConfigLayer),
  Layer.provideMerge(PlatformLayer),
);

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const historyEvents = (threadId: ThreadId): ReadonlyArray<OrchestrationV2DomainEvent> =>
  (["user", "assistant"] as const).flatMap((role, index) => {
    const messageId = MessageId.make(`source-message-${index}`);
    const common = {
      id: TurnItemId.make(`source-item-${index}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    return [
      {
        id: EventId.make(`source-message-event-${index}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "web",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role,
          text: `${role} text`,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        id: EventId.make(`source-item-event-${index}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload:
          role === "user"
            ? {
                ...common,
                createdBy: "user",
                creationSource: "web",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text: "user text",
                attachments: [],
              }
            : {
                ...common,
                type: "assistant_message",
                messageId,
                text: "assistant text",
                streaming: false,
              },
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
  });

it.layer(TestLayer)("ThreadTransferService", (it) => {
  it.effect("exports a thread with its native session and imports it as a resumable copy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const transfers = yield* ThreadTransferService.ThreadTransferService;
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 0,
        eventId: EventId.make("seed:transfer-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-10-01T09:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Repo",
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-01T09:00:00.000Z",
          updatedAt: "2026-10-01T09:00:00.000Z",
        },
      });
      const sourceThreadId = ThreadId.make("transfer-source");
      const rolloutPath = NodePath.join(codexHome, rollout);
      NodeFS.mkdirSync(NodePath.dirname(rolloutPath), { recursive: true });
      NodeFS.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("transfer-source-create"),
        threadId: sourceThreadId,
        projectId,
        title: "Fix the flaky test",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        importedNativeThread: { ref: { driver, nativeId, strength: "strong" } },
      });
      yield* eventSink.write({ events: historyEvents(sourceThreadId) });
      // A thread that is still working is stopped before it is locked.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("transfer-source-busy"),
        threadId: sourceThreadId,
        messageId: MessageId.make("transfer-source-busy"),
        text: "Keep working.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const exported = yield* transfers.exportThread({
        threadId: sourceThreadId,
        transferId: "t-1",
      });
      assert.deepEqual(
        exported.manifest.files.map((file) => [file.kind, file.relativePath]),
        [["native", rollout]],
      );
      assert.equal(exported.manifest.itemCount, 4);
      assert.isTrue(exported.manifest.source.wasWorking);
      const sourceRuns = (yield* orchestrator.getThreadProjection(sourceThreadId)).runs;
      assert.deepEqual(
        sourceRuns.map((run) => run.status),
        ["interrupted"],
      );
      assert.equal(
        (yield* orchestrator.getThreadShell(sourceThreadId))?.transfer?.status,
        "exporting",
      );
      // A retried export returns the bundle it already wrote.
      assert.deepEqual(
        (yield* transfers.exportThread({ threadId: sourceThreadId, transferId: "t-1" })).manifest,
        exported.manifest,
      );

      const preflight = yield* transfers.preflight({
        manifest: exported.manifest,
        bundleBytes: exported.bundleBytes,
      });
      assert.deepEqual(preflight.blockers, []);
      assert.equal(preflight.projectId, projectId);
      assert.deepEqual(preflight.workspace, { type: "root" });

      // This test environment plays both sides: carry the bundle to the destination's inbox.
      const config = yield* ServerConfig.ServerConfig;
      const root = NodePath.join(config.stateDir, "thread-transfers");
      NodeFS.mkdirSync(NodePath.join(root, "in"), { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(root, "out", "t-1.bundle"),
        NodePath.join(root, "in", "t-1.bundle"),
      );
      NodeFS.rmSync(rolloutPath);

      const importInput = {
        transferId: "t-1",
        projectId: preflight.projectId,
        instanceId,
        workspace: { type: "root" as const },
        fastForwardToSource: false,
      };
      const { threadId } = yield* transfers.importThread(importInput);
      assert.isTrue(NodeFS.existsSync(rolloutPath));
      const imported = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(imported.thread.historyOrigin, "transfer");
      assert.deepEqual(imported.thread.transferredFrom, {
        transferId: "t-1",
        environmentId: EnvironmentId.make("env-a"),
        threadId: sourceThreadId,
        environmentLabel: "Laptop",
      });
      assert.deepEqual(
        imported.visibleTurnItems
          .filter(({ item }) => item.runId === null)
          .map(({ item }) => item.type),
        ["user_message", "assistant_message", "user_message", "run_interrupt_result"],
      );
      // The source was working, so its copy picks the turn back up.
      assert.deepEqual(
        imported.messages
          .filter((message) => message.id === "message:thread-transfer-continuation:t-1")
          .map((message) => message.text),
        ["Continue where you left off."],
      );
      const providerThread = imported.providerThreads.find(
        (thread) => thread.id === imported.thread.activeProviderThreadId,
      );
      assert.deepEqual(providerThread?.nativeThreadRef, { driver, nativeId, strength: "strong" });
      assert.equal(providerThread?.status, "not_loaded");
      // A retried import returns the thread the first one made.
      assert.deepEqual(yield* transfers.importThread(importInput), { threadId });

      const destination = { environmentId: EnvironmentId.make("env-b"), threadId };
      yield* transfers.complete({ threadId: sourceThreadId, transferId: "t-1", destination });
      const source = yield* orchestrator.getThreadShell(sourceThreadId);
      assert.deepEqual(source?.transfer, { transferId: "t-1", status: "completed", destination });
      assert.isNotNull(source?.archivedAt);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "out", "t-1.bundle")));
    }),
  );
  it.effect("clones the repository when the destination has no project for it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const transfers = yield* ThreadTransferService.ThreadTransferService;
      const config = yield* ServerConfig.ServerConfig;
      // The only project here belongs to another repository.
      project.repositoryIdentity = { canonicalKey: "github.com/acme/other" };
      const nativeThreadId = "019b8051-a0f2-7e51-b87e-f6bcf17210cd";
      const rolloutPath = NodePath.join(
        codexHome,
        `sessions/2026/01/02/rollout-2026-01-02T21-06-31-${nativeThreadId}.jsonl`,
      );
      NodeFS.mkdirSync(NodePath.dirname(rolloutPath), { recursive: true });
      NodeFS.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
      const sourceThreadId = ThreadId.make("transfer-clone-source");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("transfer-clone-source-create"),
        threadId: sourceThreadId,
        projectId,
        title: "Clone me",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        importedNativeThread: { ref: { driver, nativeId: nativeThreadId, strength: "strong" } },
      });

      const exported = yield* transfers.exportThread({
        threadId: sourceThreadId,
        transferId: "t-2",
      });
      const preflight = yield* transfers.preflight({
        manifest: exported.manifest,
        bundleBytes: exported.bundleBytes,
      });
      assert.deepEqual(preflight.blockers, []);
      assert.isNull(preflight.projectId);
      assert.deepEqual(preflight.newProject, {
        title: "Repo",
        remoteUrl: "git@github.com:acme/repo.git",
      });

      const root = NodePath.join(config.stateDir, "thread-transfers");
      NodeFS.copyFileSync(
        NodePath.join(root, "out", "t-2.bundle"),
        NodePath.join(root, "in", "t-2.bundle"),
      );
      const { threadId } = yield* transfers.importThread({
        transferId: "t-2",
        projectId: null,
        instanceId,
        workspace: null,
        fastForwardToSource: false,
      });
      assert.deepEqual(clones, [
        {
          remoteUrl: "git@github.com:acme/repo.git",
          destinationPath: NodePath.join(projectsRoot, "repo"),
        },
      ]);
      const imported = yield* orchestrator.getThreadProjection(threadId);
      const clonedProject = projects.find(
        (entry) => entry.workspaceRoot === NodePath.join(projectsRoot, "repo"),
      );
      assert.equal(imported.thread.projectId, clonedProject?.id);
      assert.isNull(imported.thread.worktreePath);
    }),
  );
});
