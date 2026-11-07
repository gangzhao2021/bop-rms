// WP-2423 (DEC-PILOT-OFFSITE-S3): the S3 off-site target for scheduled backups. Same interface as
// the directory target (`put/list/remove`, plus `fetch` for restores); content is already
// AES-256-GCM encrypted on this host before it is uploaded. Every upload carries its SHA-256 (S3
// rejects a damaged upload) and is then read back from the bucket and compared, so "Copied" means
// the copy in the bucket is complete and readable. Errors are fixed codes only: no bucket names,
// keys, credentials or SDK messages reach the status file, the alert log or the console.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import { readPilotSecret } from "./pilot-ops-config.mjs";

/** Single PUT limit of S3; a larger copy is refused with an alert rather than half-sent. */
export const S3_MAX_OBJECT_BYTES = 5 * 1024 ** 3;
// The SDK version already pinned for @bop/media (no new dependency or version).
const loadS3Sdk = () =>
  createRequire(new URL("../../packages/bop/media/package.json", import.meta.url))(
    "@aws-sdk/client-s3",
  );
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.)){0,200}$/u;
const fail = (code) => {
  throw Error(code);
};

async function sha256(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("base64");
}

/**
 * `offsite` is the parsed `backup.offsite` of ops.json (kind "s3"). `staging` is a private folder
 * on this host (the backup directory) for the encrypted file while it is uploaded.
 */
export async function createS3OffsiteTarget(
  offsite,
  {
    staging,
    runtimeDirectory,
    sdk = loadS3Sdk(),
    readSecret = readPilotSecret,
    clientOptions = {},
  } = {},
) {
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
  } = sdk;
  let credentials;
  if (offsite.accessKeyIdFile !== null)
    try {
      credentials = {
        accessKeyId: await readSecret(runtimeDirectory, offsite.accessKeyIdFile),
        secretAccessKey: await readSecret(runtimeDirectory, offsite.secretAccessKeyFile),
      };
    } catch {
      fail("PILOT_OFFSITE_CREDENTIALS_UNAVAILABLE");
    }
  const client = new S3Client({
    region: offsite.region,
    ...(offsite.endpoint === null ? {} : { endpoint: offsite.endpoint }),
    forcePathStyle: offsite.forcePathStyle,
    ...(credentials ? { credentials } : {}),
    maxAttempts: 4,
    ...clientOptions,
  });
  const key = (name) => {
    if (!NAME.test(name)) fail("PILOT_OFFSITE_FILE_INVALID");
    return offsite.prefix + name;
  };
  const send = async (command, code) => {
    try {
      return await client.send(command);
    } catch {
      return fail(code);
    }
  };
  async function readBack(name) {
    const object = await send(
      new GetObjectCommand({ Bucket: offsite.bucket, Key: key(name) }),
      "PILOT_OFFSITE_VERIFY_FAILED",
    );
    try {
      return await sha256(object.Body);
    } catch {
      return fail("PILOT_OFFSITE_VERIFY_FAILED");
    }
  }
  return Object.freeze({
    kind: "s3",
    async put(name, write) {
      const temporary = path.join(staging, `.offsite-upload-${process.pid}-${name}`);
      await fs.rm(temporary, { force: true });
      try {
        await write(temporary);
        const { size } = await fs.stat(temporary);
        if (size > S3_MAX_OBJECT_BYTES) fail("PILOT_OFFSITE_OBJECT_TOO_LARGE");
        const checksum = await sha256(createReadStream(temporary));
        await send(
          new PutObjectCommand({
            Bucket: offsite.bucket,
            Key: key(name),
            Body: createReadStream(temporary),
            ContentLength: size,
            ContentType: "application/octet-stream",
            ChecksumSHA256: checksum,
            ...(offsite.sseKmsKeyId === null
              ? {}
              : { ServerSideEncryption: "aws:kms", SSEKMSKeyId: offsite.sseKmsKeyId }),
          }),
          "PILOT_OFFSITE_UPLOAD_FAILED",
        );
        // Restore check of the copy itself: what the bucket returns is what was sent.
        if ((await readBack(name)) !== checksum) fail("PILOT_OFFSITE_VERIFY_FAILED");
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async list() {
      const names = [];
      let token;
      do {
        const page = await send(
          new ListObjectsV2Command({
            Bucket: offsite.bucket,
            Prefix: offsite.prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
          "PILOT_OFFSITE_LIST_FAILED",
        );
        for (const item of page.Contents ?? []) {
          const name = String(item.Key ?? "").slice(offsite.prefix.length);
          if (NAME.test(name)) names.push(name);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return names.sort();
    },
    async remove(name) {
      await send(
        new DeleteObjectCommand({ Bucket: offsite.bucket, Key: key(name) }),
        "PILOT_OFFSITE_REMOVE_FAILED",
      );
    },
    /** Downloads one copy to a new private file (for restore); never overwrites. */
    async fetch(name, destination) {
      const object = await send(
        new GetObjectCommand({ Bucket: offsite.bucket, Key: key(name) }),
        "PILOT_OFFSITE_FETCH_FAILED",
      );
      const partial = destination + ".partial";
      try {
        await pipeline(object.Body, createWriteStream(partial, { mode: 0o600, flags: "wx" }));
        await fs.rename(partial, destination);
      } catch {
        await fs.rm(partial, { force: true });
        fail("PILOT_OFFSITE_FETCH_FAILED");
      }
    },
  });
}
