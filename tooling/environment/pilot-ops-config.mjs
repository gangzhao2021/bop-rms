// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the operations monitor's configuration, `<runtime>/ops.json`.
// Outbound channels and the off-site target are OFF unless the Owner configures them with real
// accounts; secrets live in separate private files (never in ops.json, logs or messages).
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { OPS_CONFIG_FILE, readPrivateJson } from "./pilot-ops-files.mjs";

const fail = (reason) => {
  throw Object.assign(Error("PILOT_OPS_CONFIG_INVALID"), { reason });
};
const exactKeys = (value, required, optional, reason) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(reason);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail(reason);
  return value;
};
const FILE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const fileName = (value, reason) =>
  typeof value === "string" && FILE_NAME.test(value) && !value.includes("..")
    ? value
    : fail(reason);
const plain = (value, max, reason) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  /^[^\p{Cc}<>]+$/u.test(value)
    ? value
    : fail(reason);
const httpsUrl = (value, reason) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return fail(reason);
    return url.href;
  } catch {
    return fail(reason);
  }
};
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/u;
const email = (value, reason) =>
  typeof value === "string" && EMAIL.test(value) ? value : fail(reason);
const PHONE = /^\+[1-9][0-9]{6,14}$/u;
const phone = (value, reason) =>
  typeof value === "string" && PHONE.test(value) ? value : fail(reason);
const integer = (value, min, max, reason) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(reason);
const RUNTIME_PATH = /^\.local\/[a-z0-9][a-z0-9_-]{0,63}$/u;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/u;
export const DEFAULT_RUNBOOK = "docs/runbooks/single-store-pilot.md";
const timeZone = (value, reason) => {
  try {
    if (typeof value !== "string") return fail(reason);
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return value;
  } catch {
    return fail(reason);
  }
};

/**
 * Parses ops.json. `runtimeDirectory` is the relative runtime path (`.local/pilot-v15`). Absent
 * file → monitor and local alerts only (no outbound channels, no scheduled backup), which the
 * monitor itself reports as "no recent backup" until the operator configures it.
 */
export function parsePilotOpsConfig(value, runtimeDirectory) {
  if (value === null)
    return Object.freeze({
      siteLabel: "Pilot store",
      runbookBase: DEFAULT_RUNBOOK,
      homeUrl: null,
      email: null,
      webhooks: Object.freeze([]),
      heartbeat: null,
      backup: null,
    });
  const config = exactKeys(
    value,
    ["schemaVersion"],
    ["siteLabel", "runbookUrl", "homeUrl", "email", "webhooks", "heartbeat", "backup"],
    "keys",
  );
  if (config.schemaVersion !== 1) fail("schemaVersion");
  let mail = null;
  if (config.email !== undefined && config.email !== null) {
    const e = exactKeys(
      config.email,
      ["host", "port", "security", "from", "to"],
      ["username", "passwordFile"],
      "email",
    );
    if (!["tls", "starttls"].includes(e.security)) fail("email.security");
    if ((e.username === undefined) !== (e.passwordFile === undefined)) fail("email.auth");
    if (!Array.isArray(e.to) || e.to.length < 1 || e.to.length > 5) fail("email.to");
    mail = Object.freeze({
      host: /^[A-Za-z0-9.-]{1,253}$/u.test(e.host) ? e.host : fail("email.host"),
      port: integer(e.port, 1, 65535, "email.port"),
      security: e.security,
      from: email(e.from, "email.from"),
      to: Object.freeze(e.to.map((to) => email(to, "email.to"))),
      username: e.username === undefined ? null : plain(e.username, 254, "email.username"),
      passwordFile:
        e.passwordFile === undefined ? null : fileName(e.passwordFile, "email.passwordFile"),
    });
  }
  const webhooks = (config.webhooks ?? []).map((hook, index) => {
    const reason = `webhooks.${index}`;
    if (!hook || typeof hook !== "object") return fail(reason);
    switch (hook.format) {
      case "json":
      case "slack": {
        const h = exactKeys(hook, ["format", "urlFile"], [], reason);
        return Object.freeze({ format: h.format, urlFile: fileName(h.urlFile, reason) });
      }
      case "pushover": {
        const h = exactKeys(hook, ["format", "tokenFile", "userKeyFile"], [], reason);
        return Object.freeze({
          format: "pushover",
          tokenFile: fileName(h.tokenFile, reason),
          userKeyFile: fileName(h.userKeyFile, reason),
        });
      }
      case "twilio-sms": {
        const h = exactKeys(
          hook,
          ["format", "accountSid", "authTokenFile", "from", "to"],
          [],
          reason,
        );
        if (!/^AC[0-9a-f]{32}$/u.test(h.accountSid)) fail(reason);
        if (!Array.isArray(h.to) || h.to.length < 1 || h.to.length > 3) fail(reason);
        return Object.freeze({
          format: "twilio-sms",
          accountSid: h.accountSid,
          authTokenFile: fileName(h.authTokenFile, reason),
          from: phone(h.from, reason),
          to: Object.freeze(h.to.map((to) => phone(to, reason))),
        });
      }
      default:
        return fail(reason);
    }
  });
  if (webhooks.length > 5) fail("webhooks");
  let heartbeat = null;
  if (config.heartbeat !== undefined && config.heartbeat !== null) {
    const h = exactKeys(config.heartbeat, ["urlFile"], ["everyMinutes"], "heartbeat");
    heartbeat = Object.freeze({
      urlFile: fileName(h.urlFile, "heartbeat.urlFile"),
      everyMinutes: integer(h.everyMinutes ?? 5, 1, 60, "heartbeat.everyMinutes"),
    });
  }
  let backup = null;
  if (config.backup !== undefined && config.backup !== null) {
    const b = exactKeys(
      config.backup,
      ["role", "passwordFile", "timeZone", "localTime"],
      ["keep", "directory", "restoreCheck", "offsite"],
      "backup",
    );
    const directory = b.directory ?? `${runtimeDirectory}-backups`;
    if (!RUNTIME_PATH.test(directory) || directory === runtimeDirectory) fail("backup.directory");
    if (typeof b.localTime !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(b.localTime))
      fail("backup.localTime");
    let offsite = null;
    if (b.offsite?.kind === "s3") offsite = parseS3Offsite(b.offsite);
    else if (b.offsite !== undefined && b.offsite !== null) {
      const o = exactKeys(b.offsite, ["kind", "keyFile"], ["path", "keep"], "backup.offsite");
      if (o.kind !== "directory") fail("backup.offsite.kind");
      const target = o.path ?? "/offsite";
      if (
        typeof target !== "string" ||
        !path.isAbsolute(target) ||
        path.normalize(target) !== target
      )
        fail("backup.offsite.path");
      offsite = Object.freeze({
        kind: "directory",
        path: target,
        keyFile: fileName(o.keyFile, "backup.offsite.keyFile"),
        keep: integer(o.keep ?? 30, 1, 365, "backup.offsite.keep"),
      });
    }
    backup = Object.freeze({
      role: typeof b.role === "string" && IDENTIFIER.test(b.role) ? b.role : fail("backup.role"),
      passwordFile: fileName(b.passwordFile, "backup.passwordFile"),
      timeZone: timeZone(b.timeZone, "backup.timeZone"),
      localTime: b.localTime,
      keep: integer(b.keep ?? 14, 1, 365, "backup.keep"),
      directory,
      restoreCheck: b.restoreCheck === undefined ? true : b.restoreCheck === true,
      offsite,
    });
  }
  return Object.freeze({
    siteLabel:
      config.siteLabel === undefined ? "Pilot store" : plain(config.siteLabel, 60, "siteLabel"),
    runbookBase:
      config.runbookUrl === undefined || config.runbookUrl === null
        ? DEFAULT_RUNBOOK
        : httpsUrl(config.runbookUrl, "runbookUrl"),
    homeUrl:
      config.homeUrl === undefined || config.homeUrl === null
        ? null
        : httpsUrl(config.homeUrl, "homeUrl"),
    email: mail,
    webhooks: Object.freeze(webhooks),
    heartbeat,
    backup,
  });
}
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/){0,4}$/u;
const REGION = /^[a-z]{2}(?:-[a-z]+){1,2}-[0-9]$/u;
const KMS_KEY =
  /^(?:arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:(?:key|alias)\/[A-Za-z0-9/_-]{1,256}|alias\/[A-Za-z0-9/_-]{1,256}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
/**
 * DEC-PILOT-OFFSITE-S3: an S3 (or S3-compatible, `endpoint`) bucket. Copies stay AES-256-GCM
 * encrypted on this host first; `sseKmsKeyId` adds server-side SSE-KMS. Credentials come from the
 * standard AWS chain (instance/task role, environment) unless both key files are named (runtime
 * secret files, 0600). The bucket, prefix and region are not secret; nothing here is.
 */
function parseS3Offsite(value) {
  const o = exactKeys(
    value,
    ["kind", "keyFile", "bucket", "region"],
    [
      "prefix",
      "keep",
      "endpoint",
      "forcePathStyle",
      "sseKmsKeyId",
      "accessKeyIdFile",
      "secretAccessKeyFile",
    ],
    "backup.offsite",
  );
  if (typeof o.bucket !== "string" || !BUCKET.test(o.bucket) || o.bucket.includes(".."))
    fail("backup.offsite.bucket");
  if (typeof o.region !== "string" || !REGION.test(o.region)) fail("backup.offsite.region");
  const prefix = o.prefix ?? "";
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) fail("backup.offsite.prefix");
  if (o.forcePathStyle !== undefined && typeof o.forcePathStyle !== "boolean")
    fail("backup.offsite.forcePathStyle");
  if (
    o.sseKmsKeyId !== undefined &&
    (typeof o.sseKmsKeyId !== "string" || !KMS_KEY.test(o.sseKmsKeyId))
  )
    fail("backup.offsite.sseKmsKeyId");
  if ((o.accessKeyIdFile === undefined) !== (o.secretAccessKeyFile === undefined))
    fail("backup.offsite.credentials");
  return Object.freeze({
    kind: "s3",
    bucket: o.bucket,
    region: o.region,
    prefix,
    endpoint: o.endpoint === undefined ? null : httpsUrl(o.endpoint, "backup.offsite.endpoint"),
    forcePathStyle: o.forcePathStyle === true,
    sseKmsKeyId: o.sseKmsKeyId ?? null,
    accessKeyIdFile:
      o.accessKeyIdFile === undefined
        ? null
        : fileName(o.accessKeyIdFile, "backup.offsite.credentials"),
    secretAccessKeyFile:
      o.secretAccessKeyFile === undefined
        ? null
        : fileName(o.secretAccessKeyFile, "backup.offsite.credentials"),
    keyFile: fileName(o.keyFile, "backup.offsite.keyFile"),
    keep: integer(o.keep ?? 30, 1, 365, "backup.offsite.keep"),
    path: null,
  });
}
export async function loadPilotOpsConfig(runtimeDirectory) {
  return parsePilotOpsConfig(
    await readPrivateJson(path.join(runtimeDirectory, OPS_CONFIG_FILE)),
    runtimeDirectory,
  );
}
/** A secret from a private file in the runtime directory (0600, own, not a link, ≤ 4 KB). */
export async function readPilotSecret(runtimeDirectory, name) {
  const file = path.join(runtimeDirectory, fileName(name, "secret"));
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > 4096
    )
      throw Error("PILOT_OPS_SECRET_INVALID");
    const value = (await handle.readFile("utf8")).trim();
    if (value.length === 0 || /[\r\n\0]/u.test(value)) throw Error("PILOT_OPS_SECRET_INVALID");
    return value;
  } finally {
    await handle.close();
  }
}
