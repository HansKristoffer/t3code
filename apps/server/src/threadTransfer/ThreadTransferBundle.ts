// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import {
  OrchestrationV2TurnItemJson,
  ThreadTransferManifest,
  type OrchestrationV2TurnItem,
  type ThreadTransferFile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A transfer bundle is one gzip stream: a JSON header line (the manifest and
 * the thread's flattened history), then every file body in manifest order.
 * The header comes first so a reader can stream bodies straight to disk.
 */
const BundleHeader = Schema.Struct({
  format: Schema.Literal("t3-thread-transfer"),
  manifest: ThreadTransferManifest,
  items: Schema.Array(OrchestrationV2TurnItemJson),
});
const BundleHeaderJson = Schema.fromJsonString(BundleHeader);
const encodeHeader = Schema.encodeSync(BundleHeaderJson);
const decodeHeader = Schema.decodeUnknownSync(BundleHeaderJson);

// The header holds the whole visible history; anything past this is not a bundle we wrote.
const MAX_HEADER_BYTES = 256 * 1024 * 1024;

export interface BundleSourceFile extends Omit<ThreadTransferFile, "bytes" | "sha256"> {
  readonly absolutePath: string;
}

export async function hashFile(
  absolutePath: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of NodeFS.createReadStream(absolutePath)) {
    bytes += (chunk as Buffer).byteLength;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Hashes the files first, because the header that names them is written before their bodies. */
export async function describeFiles(
  files: ReadonlyArray<BundleSourceFile>,
): Promise<ReadonlyArray<ThreadTransferFile>> {
  const described: Array<ThreadTransferFile> = [];
  for (const file of files) {
    described.push({
      kind: file.kind,
      relativePath: file.relativePath,
      ...(await hashFile(file.absolutePath)),
    });
  }
  return described;
}

export async function writeBundle(input: {
  readonly path: string;
  readonly manifest: ThreadTransferManifest;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly files: ReadonlyArray<BundleSourceFile>;
}): Promise<number> {
  await NodeFSP.mkdir(NodePath.dirname(input.path), { recursive: true });
  const partPath = `${input.path}.${NodeCrypto.randomUUID()}.part`;
  try {
    const gzip = NodeZlib.createGzip();
    const written = NodeStreamPromises.pipeline(gzip, NodeFS.createWriteStream(partPath));
    gzip.write(
      `${encodeHeader({ format: "t3-thread-transfer", manifest: input.manifest, items: input.items })}\n`,
    );
    for (const file of input.files) {
      await NodeStreamPromises.pipeline(NodeFS.createReadStream(file.absolutePath), gzip, {
        end: false,
      });
    }
    gzip.end();
    await written;
    await NodeFSP.rename(partPath, input.path);
    return (await NodeFSP.stat(input.path)).size;
  } finally {
    await NodeFSP.rm(partPath, { force: true });
  }
}

export interface ReadBundle {
  readonly manifest: ThreadTransferManifest;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Staged bodies, parallel to `manifest.files`, each verified against its sha256. */
  readonly stagedPaths: ReadonlyArray<string>;
}

/** Streams a bundle's bodies into `stagingDir`, failing on any size or checksum mismatch. */
export async function readBundle(bundlePath: string, stagingDir: string): Promise<ReadBundle> {
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true });

  const headerChunks: Array<Buffer> = [];
  let headerBytes = 0;
  let header: {
    manifest: ThreadTransferManifest;
    items: ReadonlyArray<OrchestrationV2TurnItem>;
  } | null = null;
  const stagedPaths: Array<string> = [];
  let fileIndex = 0;
  let remaining = 0;
  let hash: NodeCrypto.Hash | null = null;
  let out: NodeFS.WriteStream | null = null;

  const openNext = async () => {
    const files = header!.manifest.files;
    while (fileIndex < files.length) {
      const stagedPath = NodePath.join(stagingDir, String(fileIndex));
      stagedPaths.push(stagedPath);
      remaining = files[fileIndex]!.bytes;
      hash = NodeCrypto.createHash("sha256");
      out = NodeFS.createWriteStream(stagedPath);
      if (remaining > 0) return;
      await closeCurrent();
    }
  };
  const closeCurrent = async () => {
    const file = header!.manifest.files[fileIndex]!;
    const stream = out!;
    await new Promise<void>((resolve, reject) =>
      stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    if (hash!.digest("hex") !== file.sha256) {
      throw new Error(`Bundle file '${file.relativePath}' failed its checksum.`);
    }
    out = null;
    hash = null;
    fileIndex += 1;
  };
  const writeBody = async (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (out === null) throw new Error("Bundle has more data than its manifest describes.");
      const piece = chunk.subarray(offset, offset + remaining);
      hash!.update(piece);
      if (!out.write(piece))
        await new Promise<void>((resolve) => out!.once("drain", () => resolve()));
      offset += piece.byteLength;
      remaining -= piece.byteLength;
      if (remaining === 0) {
        await closeCurrent();
        await openNext();
      }
    }
  };

  try {
    for await (const raw of NodeFS.createReadStream(bundlePath).pipe(NodeZlib.createGunzip())) {
      const chunk = raw as Buffer;
      if (header !== null) {
        await writeBody(chunk);
        continue;
      }
      const newline = chunk.indexOf(0x0a);
      headerBytes += newline === -1 ? chunk.byteLength : newline;
      if (headerBytes > MAX_HEADER_BYTES) throw new Error("Bundle header is too large.");
      if (newline === -1) {
        headerChunks.push(chunk);
        continue;
      }
      headerChunks.push(chunk.subarray(0, newline));
      const decoded = decodeHeader(Buffer.concat(headerChunks).toString("utf8"));
      header = { manifest: decoded.manifest, items: decoded.items };
      await openNext();
      await writeBody(chunk.subarray(newline + 1));
    }
    if (header === null) throw new Error("Bundle has no header.");
    if (fileIndex < header.manifest.files.length) throw new Error("Bundle ended early.");
    return { manifest: header.manifest, items: header.items, stagedPaths };
  } finally {
    (out as NodeFS.WriteStream | null)?.destroy();
  }
}
