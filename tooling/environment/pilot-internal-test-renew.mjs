import process from "node:process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, readdir, mkdir, open, link, rename, rm, rmdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * WP-2423: Owner-approved renewal of an InternalTest installation's validity window.
 *
 * Moves the common `validUntil`/`effectiveUntil` of the synthetic installation files (profile
 * binding, DEMO staff roster, DEMO dining tables, InternalTest task queue) to a new instant at
 * most 30 days ahead. It refuses unless every file it reads is InternalTest, matches the expected
 * database and Store binding, and carries only synthetic (DEMO) identities; it never changes any
 * other value. The previous files are kept as hard links in a new owner-only
 * `internal-test-renewal-<time>` directory with a `renewal.json` record (who approved, why,
 * from → to, before/after SHA-256), and each completed renewal appends one line to
 * `internal-test-renewal-log.jsonl`. Historical copies are never rewritten. Database facts with
 * the same expiry have no product renewal path and are listed, never written.
 */
const unavailable = (reason = "unspecified", details = {}) => {
  const error = new Error("PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE");
  error.reason = reason;
  Object.assign(error, details);
  throw error;
};
const keepReason = (reason) => (error) =>
  unavailable(typeof error?.reason === "string" ? error.reason : reason);

const DAY = 86400000;
export const MAX_RENEWAL_DAYS = 30;
/** Synthetic fixture identities used by the InternalTest installation (`xxxxxxxx-0000-7000-8000-…`). */
const SYNTHETIC_REFERENCE = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DINING_TABLE = /^internal-test-dining-table(?:-[0-9]{2})?\.json$/u;
const HISTORICAL_COPY =
  /^(?:internal-test-|cancellation-workflow-).*(?:\.v\d+-backup|\.before-[a-z0-9-]+)\.json$/u;
const LOG = "internal-test-renewal-log.jsonl";
const LOCK = ".internal-test-renew-lock";
const SCOPE_KEYS = ["tenantReference", "brandReference", "storeReference"];

/**
 * Same-expiry facts in the database. None has a product command that extends it; renewing them
 * needs the listed product path first (never direct SQL).
 */
export const databaseArtefactsNotRenewed = Object.freeze([
  Object.freeze({
    artefact:
      "DEMO staff roster: bop_membership.membership/store_assignment, bop_permission.role/role_assignment/permission_grant",
    missing: "no product command extends effective_until (membership and roles can only be ended)",
  }),
  Object.freeze({
    artefact:
      "launch gate requirement SYNTHETIC_STORE_READY (bop_publishing.live_gate_requirement)",
    missing: "the Publishing domain only reads gate requirements; no evidence renewal command",
  }),
  Object.freeze({
    artefact:
      "tax registration and professional review evidence (rms_pricing.tax_configuration_version)",
    missing:
      "a new tax version needs the tax publication path with registration and professional review sources, unavailable in the pilot",
  }),
  Object.freeze({
    artefact: "Pickup capacity slots (rms_fulfillment.capacity_slot)",
    missing: "no product command creates capacity slots",
  }),
]);

const isInstant = (value) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  new Date(Date.parse(value)).toISOString() === value;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plainText = (value, min, max) =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= min &&
  value.length <= max &&
  // Single-line, printable text only.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/u.test(value);

async function privateDirectory(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory))
    return unavailable("directory-not-absolute");
  const state = await lstat(directory).catch(keepReason("directory-missing"));
  if (!state.isDirectory() || state.isSymbolicLink()) return unavailable("directory-not-directory");
  if (state.uid !== process.getuid()) return unavailable("directory-not-owned");
  if ((state.mode & 0o777) !== 0o700) return unavailable("directory-not-0700");
  if ((await realpath(directory)) !== directory) return unavailable("directory-path-not-canonical");
}
async function readPrivateFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unavailable("file-unreadable");
  }
  try {
    const state = await handle.stat();
    if (!state.isFile()) return unavailable("file-not-regular");
    if (state.uid !== process.getuid()) return unavailable("file-not-owned");
    if ((state.mode & 0o777) !== 0o600) return unavailable("file-not-0600");
    if (state.size < 2 || state.size > 65536) return unavailable("file-size-unexpected");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
/** Accepts only files whose bytes are exactly the compact or 2-space form, so rewriting keeps them. */
function parseExact(bytes) {
  let value;
  const text = bytes.toString("utf8");
  try {
    value = JSON.parse(text);
  } catch {
    return unavailable("file-not-json");
  }
  for (const indent of [0, 2])
    for (const newline of ["", "\n"])
      if (JSON.stringify(value, null, indent) + newline === text)
        return { value, style: { indent, newline } };
  return unavailable("file-format-unrecognised");
}
const serialise = (value, style) =>
  Buffer.from(JSON.stringify(value, null, style.indent) + style.newline, "utf8");
const getPath = (value, path) => path.reduce((node, key) => node?.[key], value);
function setPath(value, path, next) {
  const last = path[path.length - 1];
  getPath(value, path.slice(0, -1))[last] = next;
}
const pathText = (path) =>
  path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : (index ? "." : "") + key))
    .join("");

function requireInternalTest(value, database) {
  if (value?.environment !== "InternalTest") return unavailable("not-internal-test");
  if (value.database !== database) return unavailable("database-mismatch");
}
function requireSynthetic(...references) {
  if (
    references.some(
      (reference) => typeof reference !== "string" || !SYNTHETIC_REFERENCE.test(reference),
    )
  )
    return unavailable("identity-not-synthetic");
}
function requireScope(scope, binding) {
  if (SCOPE_KEYS.some((key) => typeof scope?.[key] !== "string" || scope[key] !== binding[key]))
    return unavailable("scope-mismatch");
}

/** Validates labels and identities; returns the window paths the renewal may move. */
const artefactRules = {
  profile(value, database) {
    requireInternalTest(value, database);
    if (
      typeof value.warning !== "string" ||
      !value.warning.includes("DEMO ONLY") ||
      !/synthetic/iu.test(value.warning)
    )
      return unavailable("profile-not-labelled-demo");
    const binding = value.binding;
    requireSynthetic(
      ...SCOPE_KEYS.map((key) => binding?.[key]),
      binding?.publicStoreReference,
      binding?.lookupEvidenceReference,
    );
    if (value.selection !== undefined) requireSynthetic(value.selection?.profileReference);
    if (!isInstant(binding.validFrom) || !isInstant(binding.validUntil))
      return unavailable("profile-window-invalid");
    const codes = value.operating?.liveGateRequirementCodes;
    if (
      codes !== undefined &&
      (!Array.isArray(codes) || codes.some((code) => !/^SYNTHETIC_[A-Z0-9_]+$/u.test(code)))
    )
      return unavailable("launch-gate-not-synthetic");
    return [["binding", "validUntil"]];
  },
  roster(value, database, binding) {
    requireInternalTest(value, database);
    requireScope(value.scope, binding);
    if (value.schemaVersion === 2) {
      if (!Array.isArray(value.actors) || value.actors.length < 1 || value.actors.length > 16)
        return unavailable("roster-invalid");
      requireSynthetic(...value.actors.map((actor) => actor?.actorReference));
      return value.actors.map((_, index) => ["actors", index, "validUntil"]);
    }
    if (value.schemaVersion !== undefined) return unavailable("roster-invalid");
    if (typeof value.warning !== "string" || !value.warning.includes("DEMO"))
      return unavailable("roster-not-labelled-demo");
    requireSynthetic(value.actorReference);
    return [["validUntil"]];
  },
  table(value, database, binding) {
    requireInternalTest(value, database);
    requireScope(value.scope, binding);
    if (
      typeof value.label !== "string" ||
      !value.label.startsWith("DEMO-") ||
      typeof value.warning !== "string" ||
      !value.warning.includes("DEMO")
    )
      return unavailable("table-not-labelled-demo");
    requireSynthetic(value.tableReference, value.publicTableReference);
    return [["validUntil"]];
  },
  queue(value, database, binding) {
    requireInternalTest(value, database);
    requireScope(value, binding);
    if (!isInstant(value.effectiveFrom)) return unavailable("queue-window-invalid");
    if (value.exceptionTaskPolicy === undefined) return [["effectiveUntil"]];
    const policy = value.exceptionTaskPolicy;
    if (
      ["brandReference", "storeReference"].some((key) => policy?.[key] !== binding[key]) ||
      policy.managerQueueReference !== value.queueReference ||
      !isInstant(policy.effectiveFrom)
    )
      return unavailable("scope-mismatch");
    return [["effectiveUntil"], ["exceptionTaskPolicy", "effectiveUntil"]];
  },
};

async function readArtefacts(directory, database) {
  const names = (await readdir(directory)).sort();
  const read = async (name) => ({
    name,
    ...parseExact(await readPrivateFile(join(directory, name))),
  });
  for (const required of [
    "installation.json",
    "internal-test-profile.json",
    "internal-test-merchant.json",
    "internal-test-task-queue.json",
  ])
    if (!names.includes(required)) return unavailable("required-file-missing");
  const installation = await read("installation.json");
  requireInternalTest(installation.value, database);
  const tables = names.filter((name) => DINING_TABLE.test(name));
  if (names.includes("customer-runtime.json")) {
    const listed = (await read("customer-runtime.json")).value.diningTableFiles;
    if (!Array.isArray(listed) || listed.some((name) => !tables.includes(name)))
      return unavailable("dining-table-missing");
  }
  const profile = await read("internal-test-profile.json");
  const binding = profile.value.binding ?? {};
  const artefacts = [];
  // The profile is replaced last so an interrupted renewal is resumed by running it again.
  for (const [name, rule] of [
    ["internal-test-merchant.json", "roster"],
    ...tables.map((name) => [name, "table"]),
    ["internal-test-task-queue.json", "queue"],
  ]) {
    const artefact = await read(name);
    artefacts.push({ ...artefact, paths: artefactRules[rule](artefact.value, database, binding) });
  }
  artefacts.push({ ...profile, paths: artefactRules.profile(profile.value, database) });
  return {
    artefacts,
    current: binding.validUntil,
    historicalCopies: names.filter((name) => HISTORICAL_COPY.test(name)),
  };
}

/** Pure plan: only the listed window values change, each from the current expiry to `until`. */
export function planRenewal({ artefacts, current, until, now }) {
  if (!isInstant(until)) return unavailable("until-invalid");
  if (Date.parse(until) <= now) return unavailable("until-not-in-future");
  if (Date.parse(until) > now + MAX_RENEWAL_DAYS * DAY) return unavailable("until-beyond-30-days");
  if (until < current) return unavailable("until-shortens-window");
  const changes = [],
    files = [];
  for (const artefact of artefacts) {
    const next = JSON.parse(JSON.stringify(artefact.value));
    const moved = [];
    for (const path of artefact.paths) {
      const value = getPath(artefact.value, path);
      if (value === until) continue;
      // Only the installation's common expiry moves; anything else was changed individually.
      if (value !== current || !isInstant(value)) return unavailable("window-mismatch");
      setPath(next, path, until);
      moved.push(path);
    }
    if (moved.length === 0) continue;
    const restored = JSON.parse(JSON.stringify(next));
    for (const path of moved) setPath(restored, path, current);
    if (JSON.stringify(restored) !== JSON.stringify(artefact.value))
      return unavailable("non-window-change");
    const before = serialise(artefact.value, artefact.style),
      after = serialise(next, artefact.style);
    for (const path of moved)
      changes.push({ file: artefact.name, path: pathText(path), from: current, to: until });
    files.push({
      file: artefact.name,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      after,
    });
  }
  return { changes, files };
}

async function writeNew(file, bytes) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function appendLog(file, line) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600)
      return unavailable("log-not-private");
    await handle.writeFile(line + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function renewInternalTestInstallation({
  directory,
  expectedDatabaseName,
  until,
  reason,
  approvedBy,
  approval,
  dryRun = false,
  now = Date.now(),
}) {
  if (process.env.NODE_ENV !== "development") return unavailable("not-development-mode");
  if (
    typeof expectedDatabaseName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(expectedDatabaseName)
  )
    return unavailable("expected-database-invalid");
  if (!Number.isFinite(now)) return unavailable("renew-time-invalid");
  if (!plainText(reason, 10, 300)) return unavailable("reason-invalid");
  if (!plainText(approvedBy, 2, 80)) return unavailable("approved-by-invalid");
  if (!plainText(approval, 10, 500)) return unavailable("approval-wording-invalid");
  await privateDirectory(directory);
  const lock = join(directory, LOCK);
  if (!dryRun)
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      return unavailable("renewal-lock-held");
    }
  let stage,
    replaced = 0,
    recordName;
  try {
    const { artefacts, current, historicalCopies } = await readArtefacts(
      directory,
      expectedDatabaseName,
    );
    const { changes, files } = planRenewal({ artefacts, current, until, now });
    const summary = {
      environment: "InternalTest",
      database: expectedDatabaseName,
      previousValidUntil: current,
      validUntil: until,
      changes,
      files: files.map(({ file, beforeSha256, afterSha256 }) => ({
        file,
        beforeSha256,
        afterSha256,
      })),
      historicalCopiesUnchanged: historicalCopies,
      databaseArtefactsNotRenewed,
    };
    if (changes.length === 0) return { status: "AlreadyRenewed", dryRun, ...summary };
    if (dryRun) return { status: "Planned", dryRun: true, ...summary };
    recordName = "internal-test-renewal-" + new Date(now).toISOString().replace(/[-:.]/gu, "");
    const record = join(directory, recordName);
    try {
      await mkdir(record, { mode: 0o700 });
    } catch {
      return unavailable("record-already-exists");
    }
    stage = join(directory, ".internal-test-renew-stage-" + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    for (const { file, after } of files) await writeNew(join(stage, file), after);
    const evidence = {
      schemaVersion: 1,
      kind: "InternalTestRenewal",
      performedAt: new Date(now).toISOString(),
      operatorAccount: userInfo().username,
      approvedBy,
      approval,
      reason,
      ...summary,
    };
    const evidenceBytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n", "utf8");
    await writeNew(join(record, "renewal.json"), evidenceBytes);
    for (const { file, afterSha256 } of files) {
      const target = join(directory, file);
      // The backup link keeps the previous bytes; the same-directory rename replaces atomically.
      await link(target, join(record, file));
      await rename(join(stage, file), target);
      replaced += 1;
      if (sha256(await readPrivateFile(target)) !== afterSha256)
        return unavailable("verify-failed");
    }
    await appendLog(
      join(directory, LOG),
      JSON.stringify({
        performedAt: evidence.performedAt,
        status: "Completed",
        record: recordName,
        recordSha256: sha256(evidenceBytes),
        database: expectedDatabaseName,
        from: current,
        to: until,
        approvedBy,
        files: summary.files.map(({ file }) => file),
      }),
    );
    return { status: "Renewed", dryRun: false, record: recordName, ...summary };
  } catch (error) {
    if (replaced > 0 && typeof error === "object" && error !== null) {
      error.replaced = replaced;
      error.record = recordName;
    }
    throw error;
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      if (!dryRun) await rmdir(lock);
    }
  }
}

const flags = {
  "--database": "expectedDatabaseName",
  "--until": "until",
  "--reason": "reason",
  "--approved-by": "approvedBy",
  "--approval": "approval",
};
export function parseRenewalArguments(args) {
  const [directory, ...rest] = args;
  if (typeof directory !== "string" || directory.startsWith("--"))
    return unavailable("arguments-invalid");
  const options = { directory, dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--dry-run" && !options.dryRunSeen) {
      options.dryRun = options.dryRunSeen = true;
      continue;
    }
    const name = flags[flag],
      value = rest[index + 1];
    if (
      !name ||
      Object.hasOwn(options, name) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      return unavailable("arguments-invalid");
    options[name] = value;
    index += 1;
  }
  if (Object.values(flags).some((name) => !Object.hasOwn(options, name)))
    return unavailable("arguments-invalid");
  delete options.dryRunSeen;
  return options;
}

export function formatRenewal(result) {
  const lines = [
    `Internal test renewal for ${result.database}: ${result.status}` +
      (result.dryRun ? " (DRY RUN, nothing written)" : ""),
  ];
  for (const change of result.changes)
    lines.push(`  ${change.file}  ${change.path}  ${change.from} -> ${change.to}`);
  for (const file of result.files)
    lines.push(`  sha256 ${file.file}  ${file.beforeSha256} -> ${file.afterSha256}`);
  if (result.record) lines.push(`  previous files and record: ${result.record}/`);
  if (result.historicalCopiesUnchanged.length)
    lines.push(
      "  historical copies left unchanged: " + result.historicalCopiesUnchanged.join(", "),
    );
  lines.push(
    "  NOT renewed (database, no product renewal path; the Store cannot take orders after the old expiry until these are renewed):",
  );
  for (const item of result.databaseArtefactsNotRenewed)
    lines.push(`    - ${item.artefact}: ${item.missing}`);
  if (result.status === "Renewed")
    lines.push(
      "  Restart the pilot services (planned update window) so they read the renewed files.",
    );
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await renewInternalTestInstallation(
      parseRenewalArguments(process.argv.slice(2)),
    );
    console.log(formatRenewal(result));
    console.log(JSON.stringify({ ...result, databaseArtefactsNotRenewed: undefined }));
  } catch (error) {
    const reason = typeof error?.reason === "string" ? error.reason : "unexpected-error";
    console.error(
      "PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE (" +
        reason +
        "): requires development mode, an owner-only InternalTest runtime with the expected database, synthetic DEMO identities only, a common expiry and --until at most 30 days ahead." +
        (error?.replaced > 0
          ? ` ${error.replaced} file(s) were already renewed (previous copies in ${error.record}/); run the same command again to finish.`
          : " Nothing was replaced."),
    );
    process.exitCode = 1;
  }
}
