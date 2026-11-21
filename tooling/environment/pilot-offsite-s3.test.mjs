// DEC-PILOT-OFFSITE-S3 against an in-process S3-compatible fake (path-style HTTP, no AWS account):
// the real pinned AWS SDK client talks to it, so request shapes, checksums, pagination and errors
// are exercised as they would be against a bucket.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createS3OffsiteTarget } from "./pilot-offsite-s3.mjs";
import { decryptFile, emptyBackupStatus, runBackupCycle } from "./pilot-ops-backup.mjs";
import { parsePilotOpsConfig } from "./pilot-ops-config.mjs";

/** Decodes an aws-chunked body (signed or unsigned chunks, optional trailers). */
function decodeChunked(raw) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const end = raw.indexOf("\r\n", offset);
    const size = parseInt(raw.subarray(offset, end).toString("latin1").split(";")[0], 16);
    offset = end + 2;
    if (size === 0) break;
    parts.push(raw.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(parts);
}
function createFakeS3() {
  const objects = new Map(),
    requests = [];
  let corruptReads = false;
  const xml = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    requests.push({ method: req.method, key, headers: req.headers });
    if (bucket !== "store-backups")
      return xml(res, 404, "<Error><Code>NoSuchBucket</Code></Error>");
    if (req.method === "PUT") {
      if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked"))
        body = decodeChunked(body);
      const declared = req.headers["x-amz-checksum-sha256"];
      if (declared && createHash("sha256").update(body).digest("base64") !== declared)
        return xml(res, 400, "<Error><Code>BadDigest</Code></Error>");
      objects.set(key, body);
      res.writeHead(200, { etag: '"e"' });
      return res.end();
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2);
      const truncated = start + 2 < all.length;
      return xml(
        res,
        200,
        `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join("")}</ListBucketResult>`,
      );
    }
    if (req.method === "GET") {
      const object = objects.get(key);
      if (!object) return xml(res, 404, "<Error><Code>NoSuchKey</Code></Error>");
      const sent = corruptReads
        ? Buffer.concat([object.subarray(0, -1), Buffer.from("x")])
        : object;
      res.writeHead(200, {
        "content-length": sent.length,
        "content-type": "application/octet-stream",
      });
      return res.end(sent);
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
  return {
    objects,
    requests,
    corrupt: (value) => (corruptReads = value),
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let fake, port, root, dumps;
const key = Buffer.alloc(32, 7);
const file = "bop_rms_pilot_v15-20261015T083100Z.dump";
beforeEach(async () => {
  fake = createFakeS3();
  port = await fake.listen();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "offsite-s3-")));
  dumps = path.join(root, "backups");
  await fs.mkdir(dumps, { mode: 0o700 });
});
afterEach(async () => {
  await fake.close();
  await fs.rm(root, { recursive: true, force: true });
});
const offsite = (extra = {}) => ({
  kind: "s3",
  bucket: "store-backups",
  region: "ca-central-1",
  prefix: "store-1/",
  endpoint: null,
  forcePathStyle: true,
  sseKmsKeyId: null,
  accessKeyIdFile: null,
  secretAccessKeyFile: null,
  keyFile: "offsite-key",
  keep: 2,
  path: null,
  ...extra,
});
const target = (config = offsite(), options = {}) =>
  createS3OffsiteTarget(config, {
    staging: dumps,
    runtimeDirectory: root,
    clientOptions: {
      endpoint: `http://127.0.0.1:${port}`,
      credentials: { accessKeyId: "SYNTHETIC", secretAccessKey: "synthetic-secret" },
      maxAttempts: 1,
    },
    ...options,
  });

it("DEC-PILOT-OFFSITE-S3: a scheduled backup uploads encrypted copies, verifies them by reading back and keeps the newest", async () => {
  for (const name of ["db-20261001T083100Z.dump", "db-20261002T083100Z.dump"])
    for (const suffix of ["", ".manifest.json", ".media.tar"])
      fake.objects.set(`store-1/${name}${suffix}.enc`, Buffer.from("old"));
  fake.objects.set("other-store/db-20261001T083100Z.dump.enc", Buffer.from("not ours"));
  await fs.writeFile(path.join(dumps, file), "dump bytes");
  await fs.writeFile(path.join(dumps, `${file}.manifest.json`), "{}");
  await fs.writeFile(path.join(dumps, `${file}.media.tar`), "photos");
  const log = vi.fn();
  const next = await runBackupCycle({
    now: Date.parse("2026-10-15T08:31:00.000Z"),
    runtimeDirectory: root,
    installation: { port: 55435, database: "bop_rms_pilot_v15" },
    backup: {
      role: "bop_rms_admin",
      passwordFile: "p",
      timeZone: "America/Toronto",
      localTime: "04:30",
      keep: 14,
      directory: dumps,
      restoreCheck: false,
      offsite: offsite(),
    },
    status: emptyBackupStatus(),
    script: async () => ({
      ok: true,
      line: `PILOT_BACKUP_CREATED ${file} tables=1 rows=1 bytes=1`,
      reason: null,
    }),
    readKey: async () => key,
    createTarget: (config, options) => target(config, options),
    log,
  });
  expect(next.offsite).toMatchObject({ result: "Copied", file });
  // The newest two dumps (with their manifest and photos) remain; the other store is untouched.
  expect([...fake.objects.keys()].sort()).toEqual(
    [
      "other-store/db-20261001T083100Z.dump.enc",
      "store-1/db-20261002T083100Z.dump.enc",
      "store-1/db-20261002T083100Z.dump.manifest.json.enc",
      "store-1/db-20261002T083100Z.dump.media.tar.enc",
      `store-1/${file}.enc`,
      `store-1/${file}.manifest.json.enc`,
      `store-1/${file}.media.tar.enc`,
    ].sort(),
  );
  // Encrypted before upload: the bucket never holds the plaintext.
  expect(fake.objects.get(`store-1/${file}.enc`).includes(Buffer.from("dump bytes"))).toBe(false);
  // Every upload was read back; nothing is left in the staging folder.
  const puts = fake.requests.filter((r) => r.method === "PUT");
  expect(puts).toHaveLength(3);
  expect(puts.every((r) => typeof r.headers["x-amz-checksum-sha256"] === "string")).toBe(true);
  expect(
    fake.requests.filter((r) => r.method === "GET" && r.key === `store-1/${file}.enc`),
  ).toHaveLength(1);
  expect((await fs.readdir(dumps)).filter((name) => name.startsWith(".offsite"))).toEqual([]);
  // Restore path: fetch from the bucket and decrypt.
  const s3 = await target();
  const fetched = path.join(root, "fetched.enc");
  await s3.fetch(`${file}.enc`, fetched);
  await decryptFile(fetched, path.join(root, "restored.dump"), key, file);
  expect(await fs.readFile(path.join(root, "restored.dump"), "utf8")).toBe("dump bytes");
  expect(JSON.stringify(log.mock.calls)).not.toContain("store-backups");
});

it("DEC-PILOT-OFFSITE-S3: a copy that does not read back identically is a failed off-site copy", async () => {
  await fs.writeFile(path.join(dumps, "source"), "content");
  fake.corrupt(true);
  const s3 = await target();
  await expect(
    s3.put("db-20261015T083100Z.dump.enc", (destination) =>
      fs.copyFile(path.join(dumps, "source"), destination),
    ),
  ).rejects.toThrow("PILOT_OFFSITE_VERIFY_FAILED");
  expect((await fs.readdir(dumps)).sort()).toEqual(["source"]);
});

it("DEC-PILOT-OFFSITE-S3: SSE-KMS is requested when configured; errors carry fixed codes only", async () => {
  await fs.writeFile(path.join(dumps, "source"), "content");
  const kms = "arn:aws:kms:ca-central-1:111122223333:key/synthetic";
  const s3 = await target(offsite({ sseKmsKeyId: kms }));
  await s3.put("db-20261015T083100Z.dump.enc", (destination) =>
    fs.copyFile(path.join(dumps, "source"), destination),
  );
  const put = fake.requests.find((r) => r.method === "PUT");
  expect(put.headers["x-amz-server-side-encryption"]).toBe("aws:kms");
  expect(put.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(kms);
  const missing = await target(offsite({ bucket: "absent-bucket" }));
  const error = await missing.list().catch((e) => e);
  expect(error.message).toBe("PILOT_OFFSITE_LIST_FAILED");
  await expect(missing.fetch("x.dump.enc", path.join(root, "x"))).rejects.toThrow(
    "PILOT_OFFSITE_FETCH_FAILED",
  );
  await expect(s3.remove("../escape")).rejects.toThrow("PILOT_OFFSITE_FILE_INVALID");
});

it("DEC-PILOT-OFFSITE-S3: credentials come from runtime secret files when named, else the standard AWS chain", async () => {
  const readSecret = vi.fn(async (_dir, name) => (name === "aws-key-id" ? "AKIASYNTHETIC" : "s"));
  await target(offsite({ accessKeyIdFile: "aws-key-id", secretAccessKeyFile: "aws-secret" }), {
    readSecret,
  });
  expect(readSecret.mock.calls.map((call) => call[1])).toEqual(["aws-key-id", "aws-secret"]);
  await expect(
    target(offsite({ accessKeyIdFile: "aws-key-id", secretAccessKeyFile: "aws-secret" }), {
      readSecret: async () => {
        throw Error("ENOENT /secret/path");
      },
    }),
  ).rejects.toThrow(/^PILOT_OFFSITE_CREDENTIALS_UNAVAILABLE$/u);
});

it("DEC-PILOT-OFFSITE-S3: ops.json accepts an S3 target with bucket, region and optional prefix/KMS/endpoint", () => {
  const base = {
    schemaVersion: 1,
    backup: {
      role: "bop_rms_admin",
      passwordFile: "migration-admin-password",
      timeZone: "America/Toronto",
      localTime: "04:30",
      offsite: {
        kind: "s3",
        keyFile: "offsite-key",
        bucket: "store-backups",
        region: "ca-central-1",
        prefix: "store-1/",
        sseKmsKeyId: "alias/bop-rms-backups",
      },
    },
  };
  expect(parsePilotOpsConfig(base, ".local/pilot-v15").backup.offsite).toMatchObject({
    kind: "s3",
    bucket: "store-backups",
    region: "ca-central-1",
    prefix: "store-1/",
    sseKmsKeyId: "alias/bop-rms-backups",
    endpoint: null,
    accessKeyIdFile: null,
    keep: 30,
    path: null,
  });
  const offsiteWith = (extra) => ({
    ...base,
    backup: { ...base.backup, offsite: { ...base.backup.offsite, ...extra } },
  });
  for (const bad of [
    { bucket: "Bad_Bucket" },
    { region: "canada" },
    { prefix: "/abs/" },
    { prefix: "no-slash" },
    { endpoint: "http://minio.local:9000" },
    { accessKeyIdFile: "aws-key-id" },
    { sseKmsKeyId: "not a key" },
    { path: "/offsite" },
    { bucket: undefined },
  ])
    expect(() => parsePilotOpsConfig(offsiteWith(bad), ".local/pilot-v15")).toThrow(
      "PILOT_OPS_CONFIG_INVALID",
    );
  expect(
    parsePilotOpsConfig(
      offsiteWith({ endpoint: "https://s3.ca-east.example-storage.ca", forcePathStyle: true }),
      ".local/pilot-v15",
    ).backup.offsite,
  ).toMatchObject({ endpoint: "https://s3.ca-east.example-storage.ca/", forcePathStyle: true });
});
