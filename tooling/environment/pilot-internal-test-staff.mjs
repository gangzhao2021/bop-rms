#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import console from "node:console";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * WP-2423 batch 38, TEST-ONLY (a test-environment-only shortcut): one more DEMO staff member at the
 * installation's own Store, so a real store role can be tried live — e.g. a cook with the Kitchen
 * role, who must be refused Orders (v15 b37 finding 4b: every DEMO identity held Orders). It adds a
 * synthetic person (the next free `…-0000-7000-8000-000000000N00` block of the DEMO staff) with an
 * Active Membership, a place at the Store and a name starting "TEST", all ending at the
 * installation's common expiry like the other DEMO staff, and lists them in the installation's
 * internal-test sign-in as `<selector>`. No role is granted here: the Owner asks for the role on
 * the Staff page and someone else who approves roles approves it, as in any store.
 *
 *   node --import ./tooling/environment/register-workspace-typescript.mjs \
 *     tooling/environment/pilot-internal-test-staff.mjs add <runtime directory> \
 *     --database <name> --migration-env <file> --selector cook --name "TEST Cook" \
 *     --approver <actor> --reason "<why>" --approved-by <who> --approval "<text>"
 *
 * InternalTest installations only; refuses outside development mode. A rerun for the same selector
 * finds the same person and changes nothing. Prints references and fixed codes, never a secret.
 */
const fail = (reason) => {
  throw Object.assign(new Error("PILOT_INTERNAL_TEST_STAFF_UNAVAILABLE"), { reason });
};
const SELECTOR = /^[a-z][a-z0-9-]{0,39}$/u;
const SYNTHETIC = /^([0-9a-f]{8}-0000-7000-8000-)([0-9a-f]{12})$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const flags = {
  "--database": "database",
  "--migration-env": "envFile",
  "--selector": "selector",
  "--name": "name",
  "--approver": "approverActorReference",
  "--reason": "reason",
  "--approved-by": "approvedBy",
  "--approval": "approval",
};
export function parseStaffArguments(args) {
  const [command, directory, ...rest] = args;
  if (command !== "add" || typeof directory !== "string" || directory.startsWith("--"))
    fail("arguments-invalid");
  const options = { command, directory };
  for (let i = 0; i < rest.length; i += 2) {
    const name = flags[rest[i]];
    if (!name || typeof rest[i + 1] !== "string" || Object.hasOwn(options, name))
      fail("arguments-invalid");
    options[name] = rest[i + 1];
  }
  for (const name of Object.values(flags)) if (!options[name]?.trim()) fail("arguments-invalid");
  if (
    !SELECTOR.test(options.selector) ||
    // owner-<name> and support-<n> are other tools' selectors (the renewal proves each kind).
    /^(?:owner|support|staff)(?:-|$)/u.test(options.selector)
  )
    fail("selector-invalid");
  if (!/^TEST \S/u.test(options.name) || options.name.length > 60) fail("name-must-say-test");
  if (!UUID_V7.test(options.approverActorReference)) fail("arguments-invalid");
  return Object.freeze(options);
}

/**
 * The next DEMO staff member's references: the synthetic base of the roster's identities, one
 * hundred past the highest DEMO person the Brand has ever had (an ended one keeps their block).
 */
export function nextDemoStaffReferences(roster, knownActors) {
  const demo = roster.actors
    .map((entry) => SYNTHETIC.exec(entry.actorReference))
    .filter((match) => match !== null);
  if (demo.length === 0) fail("no-demo-staff");
  const base = demo[0][1];
  const highest = Math.max(
    ...[...roster.actors.map((entry) => entry.actorReference), ...knownActors]
      .map((value) => (typeof value === "string" ? SYNTHETIC.exec(value) : null))
      .filter((match) => match !== null && match[1] === base)
      .map((match) => Math.floor(parseInt(match[2], 16) / 0x100)),
  );
  const block = (highest + 1) * 0x100;
  if (block > 0xff00) fail("no-free-block");
  return blockReferences(base, block);
}
function blockReferences(base, block) {
  const of = (offset) => base + (block + offset).toString(16).padStart(12, "0");
  return Object.freeze({
    actorReference: of(0),
    membershipReference: of(1),
    relationshipReference: of(2),
    storeAssignmentReference: of(3),
  });
}

/** The roster with the new person last, at the installation's common expiry. */
export function withStaffEntry(roster, entry) {
  if (roster?.schemaVersion !== 2 || !Array.isArray(roster.actors))
    fail("session-file-not-multiple");
  if (roster.actors.length >= 16) fail("roster-full");
  if (roster.actors.some((item) => item.selector === entry.selector)) fail("selector-taken");
  if (roster.actors.some((item) => item.actorReference === entry.actorReference))
    fail("person-taken");
  return {
    ...roster,
    actors: [
      ...roster.actors,
      {
        selector: entry.selector,
        actorReference: entry.actorReference,
        validUntil: entry.validUntil,
      },
    ],
  };
}

/**
 * In one transaction: the person's authenticator status as the DEMO staff have it (Identity's own
 * row, copied from the first DEMO person, as `pilot-internal-test-store-open.mjs merchant` does),
 * then — as the services' own restricted role — Membership's TEST member and their name, read back
 * as a current member of the Store before COMMIT.
 */
export async function addInternalTestStaffMember(
  client,
  { apiRole, binding, references, copyMfaFrom, name, approverActorReference, until, at, next },
) {
  const { addInternalTestStoreMember, setStoreMemberDisplayName, isActiveStoreMember } =
    await import("../../packages/bop/membership/src/index.ts");
  const { appendAuditRecordInTransaction } = await import("../../packages/bop/audit/src/index.ts");
  const appendAudit = (tx, record) => appendAuditRecordInTransaction(tx, record);
  const quoted = /^[a-z_][a-z0-9_]{0,62}$/u.test(apiRole)
    ? '"' + apiRole + '"'
    : fail("role-invalid");
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) SELECT $1,status,NULL,NULL,NULL,1 FROM bop_identity.workforce_mfa_status WHERE actor_id=$2 ON CONFLICT (actor_id) DO NOTHING",
      [references.actorReference, copyMfaFrom],
    );
    await client.query("SET LOCAL ROLE " + quoted);
    const operationReference = next();
    const status = await addInternalTestStoreMember(
      client,
      {
        brandReference: binding.brandReference,
        storeReference: binding.storeReference,
        ...references,
        effectiveUntil: until,
        approverReference: approverActorReference,
        operationReference,
        auditReference: next(),
        at,
      },
      appendAudit,
    );
    if (status === "Added")
      await setStoreMemberDisplayName(
        client,
        {
          brandReference: binding.brandReference,
          storeReference: binding.storeReference,
          actorReference: references.actorReference,
          expectedProfileVersion: 0,
          displayName: name,
          operationReference: next(),
          changedBy: approverActorReference,
          changedAt: at,
          auditReference: next(),
        },
        appendAudit,
      );
    const member = await isActiveStoreMember(client, {
      brandReference: binding.brandReference,
      storeReference: binding.storeReference,
      actorReference: references.actorReference,
      at,
    });
    if (member !== true) fail("read-check-failed");
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error?.code === "MEMBER_DIRECTORY_IDEMPOTENCY_CONFLICT") fail("person-conflict");
    if (error?.code === "MEMBER_DIRECTORY_INPUT_INVALID") fail("not-synthetic");
    throw error;
  }
}

/** v7-shaped reference for operations and audit rows, as the other TEST tools make them. */
const uuidV7 = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rest = randomUUID().replace(/-/gu, "");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${rest.slice(0, 3)}-8${rest.slice(3, 6)}-${rest.slice(6, 18)}`;
};

async function run(options) {
  const read = async (file) =>
    JSON.parse(await readFile(path.join(options.directory, file), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json"),
    roster = await read("internal-test-merchant.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    fail("not-internal-test");
  if (installation.database !== options.database || roster.database !== options.database)
    fail("database-mismatch");
  const binding = profile.binding ?? {};
  if (
    roster.scope?.brandReference !== binding.brandReference ||
    roster.scope?.storeReference !== binding.storeReference
  )
    fail("scope-mismatch");
  const until = binding.validUntil;
  if (typeof until !== "string" || !(Date.parse(until) > Date.now())) fail("installation-expired");
  const listed = roster.actors?.find((entry) => entry.selector === options.selector);
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const client = await database.connectRenewalDatabase(options.envFile, options.database);
  try {
    const known = (
      await client.query(
        "SELECT actor_id::text actor FROM bop_membership.membership WHERE brand_id=$1",
        [binding.brandReference],
      )
    ).rows.map((row) => row.actor);
    const references =
      listed === undefined
        ? nextDemoStaffReferences(roster, known)
        : derivedFrom(listed.actorReference);
    const status = await addInternalTestStaffMember(client, {
      apiRole: installation.roles.api,
      binding,
      references,
      copyMfaFrom: roster.actors[0].actorReference,
      name: options.name,
      approverActorReference: options.approverActorReference,
      until,
      at: new Date().toISOString(),
      next: uuidV7,
    });
    if (listed === undefined) {
      const file = path.join(options.directory, "internal-test-merchant.json");
      const next = withStaffEntry(roster, {
        selector: options.selector,
        actorReference: references.actorReference,
        validUntil: until,
      });
      await writeFile(file + ".next", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await chmod(file + ".next", 0o600);
      await rename(file + ".next", file);
    }
    return {
      status: listed === undefined ? status : "AlreadyPresent",
      selector: options.selector,
      actorReference: references.actorReference,
      membershipReference: references.membershipReference,
      storeAssignmentReference: references.storeAssignmentReference,
      validUntil: until,
      approvedBy: options.approvedBy,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
/** A listed person's other references, from their own block. */
function derivedFrom(actorReference) {
  const match = SYNTHETIC.exec(actorReference);
  if (match === null || parseInt(match[2], 16) % 0x100 !== 0) fail("person-not-demo");
  return blockReferences(match[1], parseInt(match[2], 16));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.NODE_ENV !== "development") fail("not-development-mode");
    console.log(JSON.stringify(await run(parseStaffArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error(
      "PILOT_INTERNAL_TEST_STAFF_UNAVAILABLE (" + (error?.reason ?? "unexpected-error") + ")",
    );
    process.exitCode = 1;
  }
}
