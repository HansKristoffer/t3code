import * as NodeCrypto from "node:crypto";

import {
  THREAD_TRANSFER_MAX_BUNDLE_BYTES,
  THREAD_TRANSFER_URL_TTL_MS,
  ThreadTransferError,
  type ThreadTransferId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

export const THREAD_TRANSFER_UPLOAD_ROUTE_PREFIX = "/api/thread-transfers/upload";

// Shared with asset and attachment tokens; the claim kind keeps them apart.
const SIGNING_SECRET_NAME = "asset-access-signing-key";

/** Bundles this environment exported (`out`) and received (`in`), keyed by transfer id. */
export const threadTransferPaths = (stateDir: string, path: Path.Path, transferId: string) => {
  const root = path.join(stateDir, "thread-transfers");
  return {
    outBundle: path.join(root, "out", `${transferId}.bundle`),
    outResult: path.join(root, "out", `${transferId}.json`),
    inBundle: path.join(root, "in", `${transferId}.bundle`),
    staging: path.join(root, "in", `${transferId}.staging`),
  };
};

const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("thread-transfer-upload"),
  transferId: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
type UploadClaims = typeof UploadClaims.Type;
const UploadClaimsJson = Schema.fromJsonString(UploadClaims);
const encodeClaims = Schema.encodeSync(UploadClaimsJson);
const decodeClaims = Schema.decodeUnknownOption(UploadClaimsJson);

function decodeToken(payload: string): UploadClaims | null {
  try {
    return Option.getOrNull(decodeClaims(base64UrlDecodeUtf8(payload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueThreadTransferUploadUrl = Effect.fn("ThreadTransferFiles.issueUploadUrl")(
  function* (input: { readonly transferId: ThreadTransferId; readonly sizeBytes: number }) {
    if (input.sizeBytes > THREAD_TRANSFER_MAX_BUNDLE_BYTES) {
      return yield* new ThreadTransferError({
        message: "The thread is too large to transfer to this environment.",
      });
    }
    const secret = yield* loadSigningSecret.pipe(
      Effect.mapError(
        (cause) => new ThreadTransferError({ message: "Could not sign the upload.", cause }),
      ),
    );
    const expiresAt = (yield* Clock.currentTimeMillis) + THREAD_TRANSFER_URL_TTL_MS;
    const payload = base64UrlEncode(
      encodeClaims({
        version: 1,
        kind: "thread-transfer-upload",
        transferId: input.transferId,
        sizeBytes: input.sizeBytes,
        expiresAt,
      }),
    );
    return {
      relativeUrl: `${THREAD_TRANSFER_UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
      expiresAt,
    };
  },
);

export const validateThreadTransferUploadToken = Effect.fn(
  "ThreadTransferFiles.validateUploadToken",
)(function* (token: string) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;
  const claims = decodeToken(payload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});

/** Streams the body to disk; a retried upload replaces the previous one whole. */
export const storeThreadTransferUpload = Effect.fn("ThreadTransferFiles.storeUpload")(function* (
  claims: UploadClaims,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const finalPath = threadTransferPaths(config.stateDir, path, claims.transferId).inBundle;
  const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
  let receivedBytes = 0;
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
    yield* Stream.run(
      body.pipe(
        Stream.takeWhile((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    );
    if (receivedBytes !== claims.sizeBytes) {
      return { ok: false as const, status: 400, detail: "Upload size did not match." };
    }
    yield* fileSystem.rename(partPath, finalPath);
    return { ok: true as const };
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to store a thread transfer upload.", { cause }).pipe(
        Effect.as({ ok: false as const, status: 500, detail: "Failed to store upload." }),
      ),
    ),
    Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)),
  );
});
