import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import {
  createCognitoWorkforceInvitation,
  hasStoreStaffAccount,
  listStoreStaffInvitations,
  maskStaffEmail,
  recordStoreStaffInvitation,
} from "../../packages/bop/identity/src/index.ts";
import { loadStoreMember } from "../../packages/bop/membership/src/index.ts";
import {
  listRoleAdministration,
  listStoreRoleAssignments,
  requestRoleAssignment,
} from "../../packages/bop/permission/src/index.ts";
import {
  dispatchStaffInvitation,
  normalizeStaffEmail,
  recordStaffInvitation,
  recordStaffInvitationDelivery,
} from "../../apps/api/src/merchant-staff-invitation.ts";
import { uuidV7 } from "./permission-catalog-install.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { loadPilotStaffSignIn } from "./pilot-staff-sign-in.mjs";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF — operator tool for a Store whose staff sign in with Cognito.
 *
 *   invite-first-owner   --directory <runtime> --env-file <file> --confirm-target <env>:<db>
 *                        --operator <platform actor> --name <full name> --email <work email>
 *       A new Store (no active Owner) invites its first Owner: a waiting Membership with the name,
 *       the invitation (Cognito sends the email) and an Owner role request made by the operator.
 *       The Owner role takes effect only through the existing two-person platform approval
 *       (store-role-provisioning prepare-assignment → sign-assignment → apply-assignment) after
 *       the Owner's first sign-in. Refused when the Store already has an active Owner: from then
 *       on staff are invited in the app.
 *   link-existing-member --directory --env-file --confirm-target --operator --actor <member>
 *                        --email <work email>
 *       A Store switching from the TEST-ONLY sign-in gives an existing Active member (with their
 *       roles and history) their own Cognito sign-in. Refused for someone who already has one.
 *   status               --directory --env-file
 *       Lists the Store's invitations (masked email hint, never the address).
 *
 * Run with `node --import ./tooling/environment/register-workspace-typescript.mjs`. Needs the
 * installation's staff-sign-in.json in Cognito mode and AWS credentials allowed to call
 * cognito-idp:AdminCreateUser/AdminGetUser on the pool (none for the TEST-ONLY stand-in).
 * Prints references, statuses and masked hints only.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const commands = {
  "invite-first-owner": [
    "--directory",
    "--env-file",
    "--confirm-target",
    "--operator",
    "--name",
    "--email",
  ],
  "link-existing-member": [
    "--directory",
    "--env-file",
    "--confirm-target",
    "--operator",
    "--actor",
    "--email",
  ],
  status: ["--directory", "--env-file"],
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
export function parseCommand(args) {
  const [command, ...rest] = args;
  const flags = commands[command];
  if (!flags)
    throw new Error("usage: store-staff-sign-in invite-first-owner|link-existing-member|status …");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      !flags.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw new Error(`usage: store-staff-sign-in ${command} ${flags.join(" ")}`);
    values.set(flag, value);
  }
  if (flags.some((flag) => !values.has(flag)))
    throw new Error(`usage: store-staff-sign-in ${command} ${flags.join(" ")}`);
  for (const flag of ["--operator", "--actor"])
    if (values.has(flag) && !reference.test(values.get(flag)))
      fail("STORE_STAFF_REFERENCE_INVALID");
  return { command, get: (flag) => values.get(flag) };
}

/**
 * The invitation itself, on an open transaction of `client` (BEGIN/COMMIT by the caller): the
 * first Owner of a Store with no active Owner, or an existing Active member's own sign-in.
 */
export async function recordOperatorInvitation(client, input) {
  const { kind, scope, pool, provider, operatorReference, email, at, next } = input;
  if (kind === "FirstOwner") {
    const { assignments, pending } = await listStoreRoleAssignments(client, scope, at);
    if (assignments.some((item) => item.roleCode === "store_owner")) fail("STORE_HAS_OWNER");
    if (pending.some((item) => item.roleCode === "store_owner")) fail("STORE_OWNER_REQUEST_OPEN");
    const ownerRole = (await listRoleAdministration(client, scope, at)).find(
      (item) => item.record.code === "store_owner" && item.record.lifecycle === "Active",
    );
    if (ownerRole === undefined) fail("STORE_ROLES_NOT_PROVISIONED");
    const invitationReference = next();
    const invitation = await recordStaffInvitation(client, {
      owner: scope,
      pool,
      provider,
      invitationReference,
      actorReference: next(),
      membershipReference: next(),
      storeAssignmentReference: next(),
      nameOperationReference: next(),
      displayName: input.displayName,
      email,
      invitedBy: operatorReference,
      kind: "FirstOwner",
      at,
      nextReference: next,
    });
    if (invitation === "AlreadyInvited") fail("STORE_STAFF_ALREADY_INVITED");
    const change = next();
    await requestRoleAssignment(client, {
      ...scope,
      changeReference: change,
      assignmentReference: next(),
      roleReference: ownerRole.record.roleReference,
      actorReference: invitation.actorReference,
      membershipReference: invitation.membershipReference,
      storeAssignmentReference: invitation.storeAssignmentReference,
      requestedBy: operatorReference,
      at,
      auditReference: next(),
    });
    return { invitation, ownerRoleChange: change };
  }
  if (kind !== "ExistingMember") fail("STORE_STAFF_KIND_INVALID");
  const member = await loadStoreMember(client, scope, input.actorReference);
  if (member.membershipLifecycle !== "Active" || member.assignmentLifecycle !== "Active")
    fail("STORE_MEMBER_NOT_ACTIVE");
  if (await hasStoreStaffAccount(client, { pool, actorReference: member.actorReference }))
    fail("STORE_MEMBER_HAS_SIGN_IN");
  const emailDigest = provider.digestCorporateEmail(email);
  if (
    (await listStoreStaffInvitations(client, scope)).some(
      (item) => item.status === "Pending" && item.emailDigest === emailDigest,
    )
  )
    fail("STORE_STAFF_ALREADY_INVITED");
  const invitation = await recordStoreStaffInvitation(client, {
    ...scope,
    invitationReference: next(),
    actorReference: member.actorReference,
    membershipReference: member.membershipReference,
    storeAssignmentReference: member.storeAssignmentReference,
    invitedBy: operatorReference,
    kind: "ExistingMember",
    pool,
    emailDigest,
    emailHint: maskStaffEmail(email),
    at,
    auditReference: next(),
  });
  return { invitation, ownerRoleChange: null };
}

/** Records the invitation, asks Cognito to send it, then records what Cognito answered. */
export async function inviteThroughOperator(client, input) {
  const email = normalizeStaffEmail(input.email);
  if (email === null) fail("STORE_STAFF_EMAIL_INVALID");
  await client.query("BEGIN");
  let written;
  try {
    written = await recordOperatorInvitation(client, { ...input, email });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const delivery = await dispatchStaffInvitation(input.provider, written.invitation, email);
  await client.query("BEGIN");
  try {
    const recorded = await recordStaffInvitationDelivery(client, {
      invitation: written.invitation,
      delivery,
      recordedBy: input.operatorReference,
      at: new Date().toISOString(),
      auditReference: input.next(),
    });
    await client.query("COMMIT");
    return {
      kind: input.kind,
      actorReference: recorded.actorReference,
      invitationReference: recorded.invitationReference,
      emailHint: recorded.emailHint,
      delivery: recorded.delivery,
      expiresAt: recorded.expiresAt,
      ownerRoleChange: written.ownerRoleChange,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function context(get) {
  const directory = path.resolve(get("--directory"));
  const installation = await loadPilotInstallation(directory);
  const signIn = await loadPilotStaffSignIn(directory);
  if (signIn.mode !== "cognito") fail("STORE_STAFF_SIGN_IN_NOT_COGNITO");
  const profile = await installation.loadProfile();
  const scope = {
    brandReference: profile.binding.brandReference,
    storeReference: profile.binding.storeReference,
  };
  const pool = {
    environment: signIn.cognito.environment,
    issuer: signIn.cognito.issuer,
    clientId: signIn.cognito.clientId,
  };
  // The same keyed email digest the server computes (internal key file until "Secrets" closes).
  const crypto = await createInternalCredentialLoaders({
    file: path.join(directory, "internal-test-keys.json"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName: installation.database,
  }).createInternalMerchantCredentials();
  const provider = createCognitoWorkforceInvitation({
    configuration: { ...pool },
    clock: { now: () => new Date().toISOString() },
    hasher: crypto.hasher,
    markEmailVerified: true,
    ...(signIn.testProvider === null
      ? {}
      : {
          providerEndpoint: {
            url: signIn.testProvider.origin + "/",
            credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
          },
        }),
  });
  return { scope, pool, provider };
}
async function withClient(get, work, confirm = true) {
  const config = await loadMigrationConnectionConfig(root, get("--env-file"));
  if (confirm && get("--confirm-target") !== `${config.environment}:${config.database}`)
    fail("STORE_STAFF_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-store-staff-sign-in",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function run(args) {
  const { command, get } = parseCommand(args);
  const { scope, pool, provider } = await context(get);
  if (command === "status")
    return withClient(
      get,
      async (client) => {
        await client.query("BEGIN READ ONLY");
        try {
          return (await listStoreStaffInvitations(client, scope)).map((item) => ({
            actorReference: item.actorReference,
            kind: item.kind,
            status: item.status,
            delivery: item.delivery,
            emailHint: item.emailHint,
            lastSentAt: item.lastSentAt,
            expiresAt: item.expiresAt,
          }));
        } finally {
          await client.query("ROLLBACK");
        }
      },
      false,
    );
  return withClient(get, (client) =>
    inviteThroughOperator(client, {
      kind: command === "invite-first-owner" ? "FirstOwner" : "ExistingMember",
      scope,
      pool,
      provider,
      operatorReference: get("--operator"),
      email: get("--email"),
      ...(command === "invite-first-owner"
        ? { displayName: get("--name") }
        : { actorReference: get("--actor") }),
      at: new Date().toISOString(),
      next: () => uuidV7(),
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    (error) => {
      process.stderr.write(
        (typeof error?.code === "string" ? error.code : error?.message || "FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
