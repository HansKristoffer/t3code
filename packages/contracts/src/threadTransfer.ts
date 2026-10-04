import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2ProviderRef,
  OrchestrationV2ThreadTransferPeer,
  ThreadTransferId,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Bundles hold the native session, which for long sessions is tens of MB
 * gzipped. The attachment cap (50 MiB) is a provider policy, not a transport
 * limit, so transfers advertise their own.
 */
export const THREAD_TRANSFER_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
export const THREAD_TRANSFER_URL_TTL_MS = 60 * 60_000;

/** One file in a bundle, in body order. Attachment paths are their source attachment ids. */
export const ThreadTransferFile = Schema.Struct({
  kind: Schema.Literals(["native", "attachment"]),
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  bytes: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type ThreadTransferFile = typeof ThreadTransferFile.Type;

export const ThreadTransferManifest = Schema.Struct({
  version: Schema.Literal(1),
  transferId: ThreadTransferId,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    environmentLabel: Schema.optional(TrimmedNonEmptyString),
    threadId: ThreadId,
    title: TrimmedNonEmptyString,
    driver: ProviderDriverKind,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    providerVersion: Schema.NullOr(TrimmedNonEmptyString),
    nativeThreadRef: OrchestrationV2ProviderRef,
    nativeConversationHeadRef: Schema.NullOr(OrchestrationV2ProviderRef),
  }),
  repo: Schema.Struct({
    canonicalKey: Schema.NullOr(TrimmedNonEmptyString),
    /** The source's `origin`, which a destination without the repository clones. */
    remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
    projectTitle: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    headSha: Schema.NullOr(TrimmedNonEmptyString),
    dirtyFileCount: NonNegativeInt,
    /** The source thread ran in its own worktree rather than the project checkout. */
    worktree: Schema.Boolean,
  }),
  itemCount: NonNegativeInt,
  files: Schema.Array(ThreadTransferFile),
});
export type ThreadTransferManifest = typeof ThreadTransferManifest.Type;

/** Where the imported thread works on the destination. */
export const ThreadTransferWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: TrimmedNonEmptyString,
  }),
  /** A new worktree on `branch`, created from `startRef` when the branch is not local yet. */
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: TrimmedNonEmptyString,
    startRef: TrimmedNonEmptyString,
  }),
]);
export type ThreadTransferWorkspace = typeof ThreadTransferWorkspace.Type;

export const ThreadTransferCheck = Schema.Struct({
  code: Schema.Literals([
    "provider_missing",
    "provider_unauthenticated",
    "provider_older",
    "project_missing",
    "branch_missing",
    "head_differs",
    "source_dirty",
    "checkout_differs",
    "bundle_too_large",
    "native_unsupported",
  ]),
  message: Schema.String,
});
export type ThreadTransferCheck = typeof ThreadTransferCheck.Type;

export const ThreadTransferExportInput = Schema.Struct({
  threadId: ThreadId,
  transferId: ThreadTransferId,
});
export type ThreadTransferExportInput = typeof ThreadTransferExportInput.Type;

export const ThreadTransferExportResult = Schema.Struct({
  manifest: ThreadTransferManifest,
  /** Size of the gzipped bundle, so the destination can refuse it before the download starts. */
  bundleBytes: NonNegativeInt,
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type ThreadTransferExportResult = typeof ThreadTransferExportResult.Type;

export const ThreadTransferPreflightInput = Schema.Struct({
  manifest: ThreadTransferManifest,
  bundleBytes: NonNegativeInt,
});
export type ThreadTransferPreflightInput = typeof ThreadTransferPreflightInput.Type;

export const ThreadTransferPreflightResult = Schema.Struct({
  blockers: Schema.Array(ThreadTransferCheck),
  /** Each needs the user's confirmation before import. */
  warnings: Schema.Array(ThreadTransferCheck),
  projectId: Schema.NullOr(ProjectId),
  /** No project here has the repository yet; the import clones it and creates one. */
  newProject: Schema.NullOr(
    Schema.Struct({ title: TrimmedNonEmptyString, remoteUrl: TrimmedNonEmptyString }),
  ),
  instanceId: Schema.NullOr(ProviderInstanceId),
  /** Null when the import clones the repository first and plans the workspace there. */
  workspace: Schema.NullOr(ThreadTransferWorkspace),
  /** The destination checkout is merely behind the source commit and can fast-forward to it. */
  canFastForward: Schema.Boolean,
});
export type ThreadTransferPreflightResult = typeof ThreadTransferPreflightResult.Type;

export const ThreadTransferCreateUploadUrlInput = Schema.Struct({
  transferId: ThreadTransferId,
  sizeBytes: NonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ThreadTransferCreateUploadUrlInput = typeof ThreadTransferCreateUploadUrlInput.Type;

export const ThreadTransferCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type ThreadTransferCreateUploadUrlResult = typeof ThreadTransferCreateUploadUrlResult.Type;

export const ThreadTransferImportInput = Schema.Struct({
  transferId: ThreadTransferId,
  /** Null when preflight found no project and the import clones the repository. */
  projectId: Schema.NullOr(ProjectId),
  instanceId: ProviderInstanceId,
  workspace: Schema.NullOr(ThreadTransferWorkspace),
  fastForwardToSource: Schema.Boolean,
});
export type ThreadTransferImportInput = typeof ThreadTransferImportInput.Type;

export const ThreadTransferImportResult = Schema.Struct({ threadId: ThreadId });
export type ThreadTransferImportResult = typeof ThreadTransferImportResult.Type;

export const ThreadTransferCompleteInput = Schema.Struct({
  threadId: ThreadId,
  transferId: ThreadTransferId,
  destination: OrchestrationV2ThreadTransferPeer,
});
export type ThreadTransferCompleteInput = typeof ThreadTransferCompleteInput.Type;

export const ThreadTransferAbortInput = Schema.Struct({
  threadId: ThreadId,
  transferId: ThreadTransferId,
});
export type ThreadTransferAbortInput = typeof ThreadTransferAbortInput.Type;

export class ThreadTransferError extends Schema.TaggedError<ThreadTransferError>()(
  "ThreadTransferError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
