import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  pbkdf2Sync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../packages/bop/audit/src/index.ts";
import {
  parseStoreRoleProvisioningTrust,
  readStoreTemplateRoles,
} from "../../packages/bop/permission/src/index.ts";
import { createPostgresCurrentLiveGateSource } from "../../packages/bop/publishing/src/index.ts";
import { createPostgresCurrentMenuReleaseStore } from "../../packages/rms/catalog/src/index.ts";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDateSource,
} from "../../packages/rms/store/src/index.ts";
import { isPilotStore } from "./pilot-environment.mjs";
import { createBindingAuthorization, readStoreOperatingFacts } from "./pilot-operating-source.mjs";
import { renderPilotAclSql } from "./pilot-acl-render.mjs";
import { standardRefundRoleMapping } from "./pilot-refund-role-mapping.mjs";
import { createInternalSettlementDays } from "./pilot-settlement-window.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "./pilot-store-publication-codes.mjs";
import { keygen } from "./store-role-provisioning.mjs";
import { uuidV7 } from "./permission-catalog-install.mjs";
import { derivedReference } from "./workflow-release-install.mjs";

/**
 * WP-2423 DEC-PILOT-INSTALLATION: issues a Pilot Store's runtime directory from the database's
 * published facts, and renews its validity window. Two Platform people, as for Store role
 * provisioning (prepare → sign → apply):
 *
 *   keygen          (approver, once) --private-key <out.pem>  (publish the key with purpose
 *                   PILOT_INSTALLATION in the trust file)
 *   prepare         (operator) --env-file --directory <absolute runtime> --environment <uuid>
 *                   --operator <uuid> --tenant --brand --store --valid-until <ISO>
 *                   --api-role <name> --worker-role <name> --database-port <n>
 *                   --owner-approved-by <text> --owner-approval <text> --reason <text> --out <plan>
 *                   [--menu <uuid>] [--stock-site <uuid>]
 *   prepare-renewal (operator) --env-file --directory --environment --operator --valid-until
 *                   --owner-approved-by --owner-approval --reason --out
 *   sign            (approver) --plan --private-key --approved-by <uuid> --approval-evidence <uuid>
 *                   --key <uuid> --valid-hours <1..72> --out <approval>
 *   apply           (operator) --env-file --plan --approval --trust [--confirm-target <env>:<db>]
 *
 * `prepare` reads, in one transaction that is rolled back, what the services will read: the Store
 * record and its roles (store-role-provisioning), the current published Store configuration with
 * its approved launch gate (the requirement codes the profile names), the one current published
 * menu for customer ordering, the Store's stock site and the last closed business day (the first
 * day-end settlement window). It refuses unless every one of them is in force; nothing is taken
 * from a fixture. Installation identities that have no owning table (public Store reference,
 * Provider account, cart policy, task queue, pickup counter, service actors) are derived from the
 * operation reference, so a rerun of the same plan replays it exactly.
 *
 * `apply` is a dry run unless `--confirm-target <environment>:<database>` names the migration
 * target. It verifies the signed approval (trust file, purpose PILOT_INSTALLATION, approver not the
 * operator), re-reads the facts (they must be unchanged), then in one transaction creates or
 * re-restricts the services' LOGIN NOSUPERUSER NOBYPASSRLS roles (a new role gets a random password
 * written only to `<runtime>/<service>-password`, 0600; the server receives only its SCRAM verifier),
 * applies the rendered pilot ACL and appends a Platform audit record (purpose PILOT_INSTALLATION),
 * commits, and writes every file atomically (0600, the profile last) with a record directory and a
 * log line. Rerunning the same plan reports AlreadyApplied or finishes an interrupted run. A
 * renewal moves only the validity window (profile `binding.validUntil`, task queue windows) with the
 * Owner's approval wording recorded in the plan, the record and the audit intent.
 *
 * The workflow binding files come from `workflow-release-install` (order and cancellation
 * Workflows); staff, Stripe, hosting and secrets from their own tools. Output: references, digests,
 * file names and counts only — never a password, key or personal data.
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const PILOT_INSTALLATION_PURPOSE = "PILOT_INSTALLATION";
export const PLAN_PROFILE = "PilotInstallationPlanV1";
export const APPROVAL_PROFILE = "PilotInstallationApprovalV1";
/** The longest validity window one approval may grant (a quarter; renew before it ends). */
export const MAX_WINDOW_DAYS = 92;
const DAY = 86_400_000;
const LOG = "pilot-installation-log.jsonl";
const LOCK = ".pilot-installation-lock";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const SCOPE_KEYS = ["tenantReference", "brandReference", "storeReference"];
/** Cart lifetime of the customer app (as v15): idle one hour, at most one day. */
export const CART_TIMEOUTS = Object.freeze({
  idleTimeoutSeconds: 3600,
  absoluteTimeoutSeconds: 86400,
});
/** Unsettled table follow-ups go to the Store manager's queue, due within one hour (as v15). */
export const DINING_EXCEPTION_DUE_MS = 3_600_000;

/** Every installation file the issue writes; workflow bindings come from workflow-release-install. */
export const INSTALLATION_FILES = Object.freeze([
  "installation.json",
  "internal-test-menu.json",
  "internal-test-inventory.json",
  "internal-test-task-queue.json",
  "internal-test-receipt-template.json",
  "customer-runtime.json",
  "merchant-runtime.json",
  "business-worker.json",
  "kitchen-queue-worker.json",
  "dining-exception-worker.json",
  "daily-settlement-coverage.json",
  // Written last: services refuse to start until the profile exists.
  "internal-test-profile.json",
]);
/** InternalTest-only files a Pilot runtime directory must never contain. */
export const INTERNAL_TEST_ONLY_FILES = Object.freeze([
  "internal-test-keys.json",
  "internal-test-merchant.json",
  "internal-test-staff-totp.json",
  "internal-test-qr-key.pem",
  "internal-test-dining-key",
  "simulated-provider.sqlite",
]);

export class PilotInstallationError extends Error {
  constructor(reason, cause) {
    // `cause` stays in the process (never printed by the CLI): it names the owner's refusal.
    super("PILOT_INSTALLATION_ISSUE_UNAVAILABLE", cause === undefined ? undefined : { cause });
    this.name = "PilotInstallationError";
    this.reason = reason;
  }
}
const refuse = (reason, cause) => {
  throw new PilotInstallationError(reason, cause);
};
const isInstant = (value) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  new Date(Date.parse(value)).toISOString() === value;
const plainText = (value, min, max) =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= min &&
  value.length <= max &&
  // Single-line, printable text only.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/u.test(value);
const digestOf = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const bytesOf = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── Arguments ───────────────────────────────────────────────────────────────────────────────
const commands = Object.freeze({
  keygen: { required: ["--private-key"], optional: [] },
  prepare: {
    required: [
      "--env-file",
      "--directory",
      "--environment",
      "--operator",
      "--tenant",
      "--brand",
      "--store",
      "--valid-until",
      "--api-role",
      "--worker-role",
      "--database-port",
      "--owner-approved-by",
      "--owner-approval",
      "--reason",
      "--out",
    ],
    optional: ["--menu", "--stock-site"],
  },
  "prepare-renewal": {
    required: [
      "--env-file",
      "--directory",
      "--environment",
      "--operator",
      "--valid-until",
      "--owner-approved-by",
      "--owner-approval",
      "--reason",
      "--out",
    ],
    optional: [],
  },
  sign: {
    required: [
      "--plan",
      "--private-key",
      "--approved-by",
      "--approval-evidence",
      "--key",
      "--valid-hours",
      "--out",
    ],
    optional: [],
  },
  apply: {
    required: ["--env-file", "--plan", "--approval", "--trust"],
    optional: ["--confirm-target"],
  },
});
export function parseCommand(args) {
  const [command, ...rest] = args;
  const spec = commands[command];
  const usage = () =>
    new Error(
      "usage: pilot-installation-issue " +
        (spec
          ? command +
            " " +
            [...spec.required, ...spec.optional.map((flag) => `[${flag}]`)].join(" ")
          : Object.keys(commands).join("|")),
    );
  if (!spec) throw usage();
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      ![...spec.required, ...spec.optional].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw usage();
    values.set(flag, value);
  }
  if (spec.required.some((flag) => !values.has(flag))) throw usage();
  for (const flag of [
    "--environment",
    "--operator",
    "--tenant",
    "--brand",
    "--store",
    "--approved-by",
    "--approval-evidence",
    "--key",
    "--menu",
    "--stock-site",
  ])
    if (values.has(flag) && !UUID.test(values.get(flag))) throw usage();
  for (const flag of ["--api-role", "--worker-role"])
    if (values.has(flag) && !IDENTIFIER.test(values.get(flag))) throw usage();
  if (values.has("--api-role") && values.get("--api-role") === values.get("--worker-role"))
    throw usage();
  if (values.has("--database-port")) {
    const port = Number(values.get("--database-port"));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usage();
  }
  if (values.has("--valid-until") && !isInstant(values.get("--valid-until"))) throw usage();
  if (values.has("--directory") && !path.isAbsolute(values.get("--directory"))) throw usage();
  if (values.has("--owner-approved-by") && !plainText(values.get("--owner-approved-by"), 2, 80))
    throw usage();
  if (values.has("--owner-approval") && !plainText(values.get("--owner-approval"), 10, 500))
    throw usage();
  if (values.has("--reason") && !plainText(values.get("--reason"), 10, 300)) throw usage();
  return { command, get: (flag) => values.get(flag) };
}

// ── Database facts ──────────────────────────────────────────────────────────────────────────
/** One transaction on the migration authority, always rolled back unless `commit` is returned. */
async function withMigrationClient(envFile, work) {
  const config = await loadMigrationConnectionConfig(root, envFile);
  const client = new pg.Client({
    application_name: "bop-rms-pilot-installation",
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
    return await work(client, config);
  } finally {
    await client.end().catch(() => undefined);
  }
}
const rowsOf = (result) => (Array.isArray(result?.rows) ? result.rows : refuse("database-read"));

/**
 * The Store's published facts the services will read, through their owning sources where one
 * exists. `at` is the read instant; `binding` the planned validity window (operating authority), or
 * null while preparing.
 */
export async function readInstallationFacts(client, input) {
  const { tenantReference, brandReference, storeReference, at, binding } = input;
  const scope = { brandReference, storeReference };
  const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
  const transactions = { run: async (work) => work(tx) };
  // Store roles: opened through store-role-provisioning for exactly this Tenant (identity owner).
  const provisioned = rowsOf(
    await tx.query(
      "SELECT DISTINCT tenant_id::text AS tenant FROM bop_permission.store_role_provisioning WHERE brand_id=$1 AND store_id=$2",
      [brandReference, storeReference],
    ),
  );
  if (provisioned.length !== 1 || provisioned[0].tenant !== tenantReference)
    return refuse("store-roles-not-provisioned");
  const roles = await readStoreTemplateRoles(tx, {
    tenantReference,
    brandReference,
    storeReference,
  });
  if (roles.latestCatalogVersion === null || roles.roles.owner === undefined)
    return refuse("store-roles-not-provisioned");
  // Store record (Tenant domain owner source): lifecycle and its own IANA time zone.
  let store;
  try {
    store = await readStoreOperatingFacts(transactions, scope, () => at);
  } catch {
    return refuse("store-record-unavailable");
  }
  // The configuration in force names its approved launch gate; its applicable requirement codes are
  // the ones the profile insists on (no SYNTHETIC_ code in a Pilot Store).
  const configured = rowsOf(
    await tx.query(
      "SELECT configuration_id::text AS configuration, live_gate_evidence_reference::text AS gate FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND effective_from<=$3::timestamptz AND (effective_until IS NULL OR effective_until>$3::timestamptz) ORDER BY configuration_version DESC LIMIT 1",
      [brandReference, storeReference, at],
    ),
  )[0];
  if (!configured || configured.gate === null) return refuse("store-configuration-not-published");
  const gateRows = rowsOf(
    await tx.query(
      "SELECT r.requirement_code AS code FROM bop_publishing.live_gate_requirement r JOIN (SELECT gate_reference,gate_version FROM bop_publishing.live_gate_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND decision_evidence_reference=$4 AND changed_at<=$5::timestamptz ORDER BY gate_version DESC LIMIT 1) g ON g.gate_reference=r.gate_reference AND g.gate_version=r.gate_version WHERE r.brand_id=$2 AND r.store_id=$3 AND r.applicable ORDER BY r.requirement_code",
      [tenantReference, brandReference, storeReference, configured.gate, at],
    ),
  );
  const liveGateRequirementCodes = gateRows.map((row) => String(row.code));
  if (liveGateRequirementCodes.length === 0) return refuse("launch-gate-missing");
  if (liveGateRequirementCodes.some((code) => code.startsWith("SYNTHETIC_")))
    return refuse("launch-gate-synthetic");
  // While preparing, the window is not known yet (it starts with the first settlement day): the
  // Platform operator reads as the owner. Applying re-reads under the plan's own binding window,
  // exactly as the services will authorize every read.
  const authorize =
    binding === null ? async () => true : createBindingAuthorization(binding, () => at);
  try {
    await createPostgresCurrentLiveGateSource({
      tenantReference,
      brandReference,
      storeReference,
      decisionEvidenceReference: configured.gate,
      requiredRequirementCodes: liveGateRequirementCodes,
      authorize: async () => true,
    })(tx, at);
  } catch {
    return refuse("launch-gate-not-approved");
  }
  const operating = Object.freeze({
    ...scope,
    tenantReference,
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: liveGateRequirementCodes,
    requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
    setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
    authorize,
    hashContent: storeConfigurationContentHash,
    timeZone: store.timeZone,
  });
  // The current publication proof the services verify (publication, approvals, digest, gate).
  let proof;
  try {
    await createPostgresStoreBusinessDateSource({
      ...scope,
      timeZone: store.timeZone,
      authorize: async () => true,
      publicationProof: async (transaction, candidate, observedAt) => {
        proof = await createPostgresCurrentStorePublicationProof({
          ...operating,
          configurationReference: candidate.configurationReference,
          authorize: async () => true,
        })(transaction, observedAt);
        return {
          contentDigest: proof.contentDigest,
          businessDayStartSource: proof.businessDayStartSource,
        };
      },
    })(tx, at);
  } catch {
    return refuse("store-configuration-not-published");
  }
  if (!proof || String(proof.configuration.configurationReference) !== configured.configuration)
    return refuse("store-configuration-not-published");
  // The first day-end settlement window: the last fully closed business day, read exactly as the
  // daily settlement worker reads it (every governing configuration verified as published).
  const days = createInternalSettlementDays({
    resources: { scope, operating, transactions, now: () => at },
    active: async () => true,
  });
  let firstWindow;
  try {
    const window = input.firstWindowEndsAt
      ? await days.window({ endingAt: input.firstWindowEndsAt })
      : await days.window();
    firstWindow = {
      businessDate: window.businessDate,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      configurationReference: String(window.configurationReference),
      configurationVersion: window.configurationVersion,
      contentDigest: window.contentDigest,
    };
  } catch (error) {
    return refuse("no-closed-business-day", error);
  }
  // The one menu customers order from (current release for the customer app, Pickup).
  const menuCandidates = rowsOf(
    await tx.query(
      "SELECT DISTINCT menu_id::text AS menu FROM rms_catalog.menu_version_store WHERE brand_id=$1 AND store_id=$2 ORDER BY 1 LIMIT 100",
      [brandReference, storeReference],
    ),
  ).map((row) => row.menu);
  const releases = createPostgresCurrentMenuReleaseStore(transactions, scope);
  const current = [];
  for (const menu of menuCandidates) {
    if (input.menuReference !== undefined && menu !== input.menuReference) continue;
    let release;
    try {
      release = await releases.load({
        menuReference: menu,
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
        observedAt: at,
      });
    } catch {
      release = null;
    }
    if (release !== null) current.push(menu);
  }
  if (current.length === 0) return refuse("menu-not-published");
  if (current.length > 1) return refuse("menu-ambiguous");
  // The Store's active stock site (the default one when there are several).
  const sites = rowsOf(
    await tx.query(
      "SELECT s.stock_site_id::text AS site, s.is_default AS preferred FROM rms_inventory.stock_site s WHERE s.tenant_id=$1 AND s.brand_id=$2 AND s.store_id=$3 AND s.site_kind='Store' AND (SELECT v.lifecycle FROM rms_inventory.stock_site_version v WHERE v.tenant_id=s.tenant_id AND v.brand_id=s.brand_id AND v.store_id=s.store_id AND v.stock_site_id=s.stock_site_id ORDER BY v.version DESC LIMIT 1)='Active' ORDER BY 1",
      [tenantReference, brandReference, storeReference],
    ),
  ).filter(
    (row) => input.stockSiteReference === undefined || row.site === input.stockSiteReference,
  );
  const preferred = sites.filter((row) => row.preferred === true);
  const stockSite =
    sites.length === 1 ? sites[0].site : preferred.length === 1 ? preferred[0].site : null;
  if (stockSite === null)
    return refuse(sites.length === 0 ? "stock-site-missing" : "stock-site-ambiguous");
  return Object.freeze({
    timeZone: store.timeZone,
    catalogVersion: roles.latestCatalogVersion,
    configuration: Object.freeze({
      configurationReference: configured.configuration,
      contentDigest: proof.contentDigest,
      receiptReference: String(proof.configuration.receiptReference),
    }),
    liveGateRequirementCodes: Object.freeze(liveGateRequirementCodes),
    menuReference: current[0],
    stockSiteReference: stockSite,
    firstWindow: Object.freeze(firstWindow),
  });
}

/** Database roles of the services: exists, its restrictions, and whether it can log in. */
async function readServiceRole(client, name) {
  const row = rowsOf(
    await client.query(
      "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=$1",
      [name],
    ),
  )[0];
  return row === undefined ? null : row;
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────
/** Pure: every installation file of one plan, from the facts and the plan's identities. */
export function buildInstallationFiles({
  database,
  databasePort,
  roles,
  scope,
  window,
  createdAt,
  operationReference,
  facts,
}) {
  const ref = (label) => derivedReference(operationReference, label);
  const environment = "Pilot";
  const base = { environment, database };
  const providerAccountReference = ref("provider-account");
  const kitchenQueue = ref("actor-kitchen-queue");
  const queueReference = ref("store-manager-queue");
  return Object.freeze({
    "installation.json": {
      schemaVersion: 1,
      environment,
      database,
      port: databasePort,
      roles: { api: roles.api, worker: roles.worker },
    },
    "internal-test-profile.json": {
      ...base,
      createdAt,
      binding: {
        tenantReference: scope.tenantReference,
        publicStoreReference: ref("public-store"),
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        lookupEvidenceReference: ref("public-store-lookup"),
        validFrom: window.validFrom,
        validUntil: window.validUntil,
      },
      operating: { liveGateRequirementCodes: [...facts.liveGateRequirementCodes] },
    },
    "internal-test-menu.json": { ...base, menuReference: facts.menuReference },
    "internal-test-inventory.json": {
      ...base,
      scope: { ...scope, stockSiteReference: facts.stockSiteReference },
    },
    "internal-test-task-queue.json": {
      ...base,
      ...scope,
      queueReference,
      effectiveFrom: window.validFrom,
      effectiveUntil: window.validUntil,
      exceptionTaskPolicy: {
        policyReference: ref("dining-exception-policy"),
        version: 1,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        managerQueueReference: queueReference,
        escalationPolicyReference: ref("dining-exception-escalation"),
        dueAfterMilliseconds: DINING_EXCEPTION_DUE_MS,
        effectiveFrom: window.validFrom,
        effectiveUntil: window.validUntil,
      },
    },
    // Issuance gate only: the template a receipt uses is the one the published configuration names
    // (DEC-STORE-SETUP-PUBLICATION); family and version are installation identities nothing reads.
    "internal-test-receipt-template.json": {
      environment,
      templateReference: facts.configuration.receiptReference,
      familyReference: ref("receipt-template-family"),
      versionReference: ref("receipt-template-version"),
    },
    "customer-runtime.json": {
      schemaVersion: 1,
      ...base,
      providerAccountReference,
      controlReference: ref("payment-admission-control"),
      cart: { policyVersionReference: ref("cart-policy"), ...CART_TIMEOUTS },
      scope: { ...scope },
      // DEC-PILOT-RUNTIME-ENVIRONMENT: no DEMO table launcher; guests scan printed table codes.
      diningTableFiles: [],
    },
    "merchant-runtime.json": {
      schemaVersion: 1,
      ...base,
      scope: { ...scope },
      roleMapping: JSON.parse(JSON.stringify(standardRefundRoleMapping)),
      workstation: {
        deviceReference: ref("pickup-counter-device"),
        pickupLocationReference: ref("pickup-counter"),
      },
    },
    "business-worker.json": {
      schemaVersion: 1,
      ...base,
      providerAccountReference,
      actors: {
        paidOutcome: ref("actor-paid-outcome"),
        orderCompletion: ref("actor-order-completion"),
        kitchenQueue,
      },
      scope: { ...scope },
      workloads: { batchCancellation: true, compensation: true },
    },
    "kitchen-queue-worker.json": {
      schemaVersion: 1,
      ...base,
      actorReference: kitchenQueue,
      scope: { ...scope },
    },
    "dining-exception-worker.json": {
      schemaVersion: 1,
      ...base,
      providerAccountReference,
      scope: { ...scope },
    },
    "daily-settlement-coverage.json": {
      schemaVersion: 1,
      ...base,
      scope: { ...scope },
      firstWindow: { ...facts.firstWindow },
    },
  });
}

const fileEntries = (files) =>
  INSTALLATION_FILES.filter((name) => Object.hasOwn(files, name)).map((name) => ({
    name,
    sha256: sha256(bytesOf(files[name])),
    content: files[name],
  }));

export function planDigest(plan) {
  return digestOf(plan);
}
function summary(plan) {
  return {
    kind: plan.kind,
    planDigest: planDigest(plan),
    operationReference: plan.operationReference,
    database: plan.database,
    storeReference: plan.scope.storeReference,
    validFrom: plan.window.validFrom,
    validUntil: plan.window.validUntil,
    files: plan.files.map((file) => ({ name: file.name, sha256: file.sha256 })),
  };
}

/** Pure: an install plan from read facts. */
export function buildInstallPlan(input) {
  const { at, validUntil } = input;
  if (!isInstant(validUntil) || validUntil <= at) return refuse("valid-until-not-in-future");
  if (Date.parse(validUntil) > Date.parse(at) + MAX_WINDOW_DAYS * DAY)
    return refuse("valid-until-beyond-limit");
  // The installation covers the Store from the start of its first day-end settlement window (the
  // last closed business day), so the daily settlement worker may read that day under the binding.
  const validFrom = input.facts.firstWindow.startsAt;
  if (!isInstant(validFrom) || validFrom > at) return refuse("first-window-invalid");
  const window = { validFrom, validUntil };
  const files = buildInstallationFiles({ ...input, window, createdAt: at });
  return Object.freeze({
    profile: PLAN_PROFILE,
    kind: "Install",
    environmentReference: input.environmentReference,
    runtimeEnvironment: "Pilot",
    database: input.database,
    directory: input.directory,
    operationReference: input.operationReference,
    operatorReference: input.operatorReference,
    preparedAt: at,
    scope: { ...input.scope },
    roles: { api: input.roles.api, worker: input.roles.worker },
    window,
    ownerApproval: { ...input.ownerApproval },
    facts: JSON.parse(JSON.stringify(input.facts)),
    aclDigest: input.aclDigest,
    files: fileEntries(files),
  });
}

// ── Private directory I/O ───────────────────────────────────────────────────────────────────
async function privateDirectory(directory) {
  let state;
  try {
    state = await lstat(directory);
  } catch {
    return refuse("directory-missing");
  }
  if (!state.isDirectory() || state.isSymbolicLink()) return refuse("directory-not-directory");
  if (state.uid !== process.getuid()) return refuse("directory-not-owned");
  if ((state.mode & 0o777) !== 0o700) return refuse("directory-not-0700");
  if ((await realpath(directory)) !== directory) return refuse("directory-path-not-canonical");
}
/** The file's bytes, or null when absent; only owner-only regular files are accepted. */
async function readPrivate(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return refuse("file-unreadable");
  }
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600)
      return refuse("file-not-private");
    if (state.size > 1_048_576) return refuse("file-too-large");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function writeAtomically(file, bytes) {
  const staging = file + ".staging-" + randomBytes(6).toString("hex");
  const handle = await open(staging, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(staging, file);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
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
      return refuse("log-not-private");
    await handle.writeFile(line + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function operatorAccountName() {
  try {
    const name = userInfo().username;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // No passwd entry (container uid).
  }
  return "uid:" + process.getuid();
}
const writeNewPublic = (file, text) =>
  open(file, "wx", 0o644).then(async (handle) => {
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  });

// ── Renewal ─────────────────────────────────────────────────────────────────────────────────
/** Pure: moves the validity window of an issued Pilot installation (profile and task queue). */
export function buildRenewalPlan({ current, until, at, ...input }) {
  const profile = current["internal-test-profile.json"],
    queue = current["internal-test-task-queue.json"];
  if (profile?.environment !== "Pilot" || queue?.environment !== "Pilot")
    return refuse("not-pilot-installation");
  if (profile.database !== input.database || queue.database !== input.database)
    return refuse("database-mismatch");
  const binding = profile.binding ?? {};
  if (SCOPE_KEYS.some((key) => queue[key] !== binding[key])) return refuse("scope-mismatch");
  const from = binding.validUntil;
  if (!isInstant(from) || !isInstant(until)) return refuse("window-invalid");
  if (until <= from) return refuse("until-shortens-window");
  if (until <= at) return refuse("until-not-in-future");
  if (Date.parse(until) > Date.parse(at) + MAX_WINDOW_DAYS * DAY)
    return refuse("valid-until-beyond-limit");
  const policy = queue.exceptionTaskPolicy;
  if (queue.effectiveUntil !== from || (policy !== undefined && policy.effectiveUntil !== from))
    return refuse("window-mismatch");
  const nextProfile = { ...profile, binding: { ...binding, validUntil: until } };
  const nextQueue = {
    ...queue,
    effectiveUntil: until,
    ...(policy === undefined ? {} : { exceptionTaskPolicy: { ...policy, effectiveUntil: until } }),
  };
  const scope = Object.fromEntries(SCOPE_KEYS.map((key) => [key, binding[key]]));
  return Object.freeze({
    profile: PLAN_PROFILE,
    kind: "Renew",
    environmentReference: input.environmentReference,
    runtimeEnvironment: "Pilot",
    database: input.database,
    directory: input.directory,
    operationReference: input.operationReference,
    operatorReference: input.operatorReference,
    preparedAt: at,
    scope,
    window: { validFrom: binding.validFrom, validUntil: until, previousValidUntil: from },
    ownerApproval: { ...input.ownerApproval },
    facts: JSON.parse(JSON.stringify(input.facts)),
    previous: [
      {
        name: "internal-test-task-queue.json",
        sha256: sha256(input.bytes["internal-test-task-queue.json"]),
      },
      {
        name: "internal-test-profile.json",
        sha256: sha256(input.bytes["internal-test-profile.json"]),
      },
    ],
    files: fileEntries({
      "internal-test-task-queue.json": nextQueue,
      "internal-test-profile.json": nextProfile,
    }),
  });
}

// ── Approval ────────────────────────────────────────────────────────────────────────────────
export function approvalSigningBytes(approval) {
  const unsigned = { ...approval };
  delete unsigned.signature;
  return Buffer.from("BOP-RMS:" + APPROVAL_PROFILE + "\n" + canonicalizeRfc8785(unsigned), "utf8");
}
export function signInstallationPlan({
  plan,
  privateKey,
  approvedByReference,
  approvalEvidenceReference,
  keyReference,
  validHours,
  now,
}) {
  if (!Number.isInteger(validHours) || validHours < 1 || validHours > 72)
    return refuse("valid-hours-invalid");
  if (approvedByReference === plan.operatorReference) return refuse("approver-is-operator");
  const start = Math.floor(now / 1000) * 1000;
  const unsigned = {
    profile: APPROVAL_PROFILE,
    purposeCode: PILOT_INSTALLATION_PURPOSE,
    kind: plan.kind,
    environmentReference: plan.environmentReference,
    operationReference: plan.operationReference,
    database: plan.database,
    storeReference: plan.scope.storeReference,
    planDigest: planDigest(plan),
    operatorReference: plan.operatorReference,
    approvedByReference,
    approvalEvidenceReference,
    notBefore: new Date(start).toISOString(),
    validUntil: new Date(start + validHours * 3_600_000).toISOString(),
    keyReference,
  };
  const signature = sign(null, approvalSigningBytes(unsigned), privateKey).toString("base64url");
  return Object.freeze({ ...unsigned, signature });
}
/** Verifies the Platform approval of exactly this plan against the trust file at `now`. */
export function verifyInstallationApproval({ plan, approval, trust, now }) {
  let parsedTrust;
  try {
    parsedTrust = parseStoreRoleProvisioningTrust(trust, PILOT_INSTALLATION_PURPOSE);
  } catch {
    return refuse("trust-invalid");
  }
  const at = new Date(now).toISOString();
  if (
    approval?.profile !== APPROVAL_PROFILE ||
    approval.purposeCode !== PILOT_INSTALLATION_PURPOSE ||
    approval.kind !== plan.kind ||
    approval.environmentReference !== plan.environmentReference ||
    approval.operationReference !== plan.operationReference ||
    approval.database !== plan.database ||
    approval.storeReference !== plan.scope.storeReference ||
    approval.planDigest !== planDigest(plan) ||
    approval.operatorReference !== plan.operatorReference ||
    approval.approvedByReference === plan.operatorReference
  )
    return refuse("approval-not-for-plan");
  if (
    !isInstant(approval.notBefore) ||
    !isInstant(approval.validUntil) ||
    approval.notBefore > at ||
    approval.validUntil <= at
  )
    return refuse("approval-not-in-force");
  if (parsedTrust.revokedApprovalEvidenceReferences.includes(approval.approvalEvidenceReference))
    return refuse("approval-revoked");
  const key = parsedTrust.keys.find((item) => item.keyReference === approval.keyReference);
  if (
    !key ||
    key.approvedByReference !== approval.approvedByReference ||
    key.environmentReference !== approval.environmentReference ||
    key.notBefore > at ||
    key.validUntil <= at
  )
    return refuse("approval-key-not-trusted");
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpki, "base64url"),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    typeof approval.signature !== "string" ||
    !verify(
      null,
      approvalSigningBytes(approval),
      publicKey,
      Buffer.from(approval.signature, "base64url"),
    )
  )
    return refuse("approval-signature-invalid");
  return approval;
}

// ── Roles ───────────────────────────────────────────────────────────────────────────────────
/** SCRAM-SHA-256 verifier (RFC 5802/7677): the server never receives the password itself. */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
const quoteIdentifier = (name) =>
  IDENTIFIER.test(name) ? '"' + name + '"' : refuse("role-invalid");
const RESTRICTIONS = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION";
/**
 * Creates the service role (new random password, file staged before the commit) or re-restricts an
 * existing one whose password file the installation already holds. Returns the staged file action.
 */
async function ensureServiceRole(client, directory, service, name) {
  const file = path.join(directory, service + "-password");
  const existing = await readServiceRole(client, name);
  const saved = await readPrivate(file);
  if (saved !== null && !/^[0-9a-f]{64}\n?$/u.test(saved.toString("utf8")))
    return refuse("password-file-invalid");
  if (existing !== null) {
    if (saved === null) return refuse("role-exists-without-password-file");
    if (existing.rolsuper === true) return refuse("role-is-superuser");
    await client.query(`ALTER ROLE ${quoteIdentifier(name)} ${RESTRICTIONS}`);
    return { service, role: name, action: "Restricted" };
  }
  // A password file without its role is an interrupted earlier run: create the role for it.
  const password = saved === null ? randomBytes(32).toString("hex") : saved.toString("utf8").trim();
  const verifier = scramVerifier(password);
  await client.query(`CREATE ROLE ${quoteIdentifier(name)} ${RESTRICTIONS} PASSWORD '${verifier}'`);
  if (saved === null) {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(password);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { service, role: name, action: "Created", stagedFile: file };
  }
  return { service, role: name, action: "Created" };
}
export async function renderInstallationAcl(roles) {
  const docs = new URL("../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, docs), "utf8")),
    ),
  );
  // Run inside the installation's own transaction: the rendered script's BEGIN/COMMIT are removed.
  const script = renderPilotAclSql(matrices, roles);
  if (!script.startsWith("BEGIN;\n") || !script.endsWith("\nCOMMIT;\n"))
    return refuse("acl-render");
  return script.slice("BEGIN;\n".length, -"COMMIT;\n".length);
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────
function requirePilot() {
  if (!isPilotStore()) return refuse("not-pilot-process");
}
export async function prepare(get, { now = () => Date.now(), operation = () => uuidV7() } = {}) {
  requirePilot();
  const directory = get("--directory");
  await privateDirectory(directory);
  for (const name of [...INSTALLATION_FILES, ...INTERNAL_TEST_ONLY_FILES])
    if ((await readPrivate(path.join(directory, name)).catch(() => Buffer.alloc(0))) !== null)
      return refuse("installation-exists");
  const at = new Date(now()).toISOString();
  const scope = {
    tenantReference: get("--tenant"),
    brandReference: get("--brand"),
    storeReference: get("--store"),
  };
  const roles = { api: get("--api-role"), worker: get("--worker-role") };
  const validUntil = get("--valid-until");
  const plan = await withMigrationClient(get("--env-file"), async (client, config) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      const facts = await readInstallationFacts(client, {
        ...scope,
        at,
        binding: null,
        menuReference: get("--menu"),
        stockSiteReference: get("--stock-site"),
      });
      return buildInstallPlan({
        at,
        validUntil,
        database: config.database,
        databasePort: Number(get("--database-port")),
        roles,
        scope,
        directory,
        environmentReference: get("--environment"),
        operatorReference: get("--operator"),
        operationReference: operation(),
        ownerApproval: {
          approvedBy: get("--owner-approved-by"),
          approval: get("--owner-approval"),
          reason: get("--reason"),
        },
        facts,
        aclDigest: digestOf(await renderInstallationAcl(roles)),
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  });
  await writeNewPublic(get("--out"), JSON.stringify(plan, null, 2) + "\n");
  return summary(plan);
}
async function readIssuedFiles(directory, names) {
  const bytes = {},
    values = {};
  for (const name of names) {
    const value = await readPrivate(path.join(directory, name));
    if (value === null) return refuse("installation-file-missing");
    bytes[name] = value;
    try {
      values[name] = JSON.parse(value.toString("utf8"));
    } catch {
      return refuse("installation-file-invalid");
    }
  }
  return { bytes, values };
}
export async function prepareRenewal(
  get,
  { now = () => Date.now(), operation = () => uuidV7() } = {},
) {
  requirePilot();
  const directory = get("--directory");
  await privateDirectory(directory);
  const { bytes, values } = await readIssuedFiles(directory, [
    "installation.json",
    "internal-test-profile.json",
    "internal-test-task-queue.json",
  ]);
  const at = new Date(now()).toISOString();
  const profile = values["internal-test-profile.json"];
  const plan = await withMigrationClient(get("--env-file"), async (client, config) => {
    if (values["installation.json"].database !== config.database)
      return refuse("database-mismatch");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      // The Store must still be operable as installed: same launch gate codes, published
      // configuration, menu and stock site are re-read through their owners at the new end.
      const facts = await readInstallationFacts(client, {
        ...Object.fromEntries(SCOPE_KEYS.map((key) => [key, profile.binding?.[key]])),
        at,
        binding: { validFrom: profile.binding?.validFrom ?? at, validUntil: get("--valid-until") },
      });
      if (
        JSON.stringify(facts.liveGateRequirementCodes) !==
        JSON.stringify(profile.operating?.liveGateRequirementCodes ?? [])
      )
        return refuse("launch-gate-changed");
      return buildRenewalPlan({
        current: values,
        bytes,
        until: get("--valid-until"),
        at,
        database: config.database,
        directory,
        environmentReference: get("--environment"),
        operatorReference: get("--operator"),
        operationReference: operation(),
        ownerApproval: {
          approvedBy: get("--owner-approved-by"),
          approval: get("--owner-approval"),
          reason: get("--reason"),
        },
        facts: {
          liveGateRequirementCodes: facts.liveGateRequirementCodes,
          configuration: facts.configuration,
          menuReference: facts.menuReference,
          stockSiteReference: facts.stockSiteReference,
        },
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  });
  await writeNewPublic(get("--out"), JSON.stringify(plan, null, 2) + "\n");
  return summary(plan);
}
export async function signPlanCommand(get, now = () => Date.now()) {
  const plan = JSON.parse(await readFile(get("--plan"), "utf8"));
  if (plan?.profile !== PLAN_PROFILE) return refuse("not-a-plan");
  const approval = signInstallationPlan({
    plan,
    privateKey: createPrivateKey(await readFile(get("--private-key"))),
    approvedByReference: get("--approved-by"),
    approvalEvidenceReference: get("--approval-evidence"),
    keyReference: get("--key"),
    validHours: Number(get("--valid-hours")),
    now: now(),
  });
  await writeNewPublic(get("--out"), JSON.stringify(approval, null, 2) + "\n");
  return {
    ...summary(plan),
    approvedBy: approval.approvedByReference,
    validUntil: approval.validUntil,
  };
}

const auditDone = async (client, plan) =>
  rowsOf(
    await client.query(
      "SELECT 1 FROM platform_audit.platform_actor_audit_record WHERE operation_id=$1 AND purpose_code=$2 AND actor_id=$3",
      [plan.operationReference, PILOT_INSTALLATION_PURPOSE, plan.operatorReference],
    ),
  ).length > 0;

/**
 * Applies a signed plan (dry run without `--confirm-target`). Exported for the acceptance test with
 * an explicit clock.
 */
export async function applyPlan({
  envFile,
  plan,
  approval,
  readTrust,
  confirmTarget,
  now = () => Date.now(),
}) {
  requirePilot();
  if (plan?.profile !== PLAN_PROFILE || !["Install", "Renew"].includes(plan.kind))
    return refuse("not-a-plan");
  verifyInstallationApproval({ plan, approval, trust: await readTrust(), now: now() });
  const directory = plan.directory;
  await privateDirectory(directory);
  for (const file of plan.files)
    if (sha256(bytesOf(file.content)) !== file.sha256 || !INSTALLATION_FILES.includes(file.name))
      return refuse("plan-file-invalid");
  for (const name of INTERNAL_TEST_ONLY_FILES)
    if ((await readPrivate(path.join(directory, name)).catch(() => Buffer.alloc(0))) !== null)
      return refuse("internal-test-file-present");
  // Which files still differ; a different existing file is refused (renew, never overwrite).
  const pending = [];
  for (const file of plan.files) {
    const existing = await readPrivate(path.join(directory, file.name));
    if (existing !== null && sha256(existing) === file.sha256) continue;
    if (plan.kind === "Install" && existing !== null) return refuse("installation-exists");
    if (plan.kind === "Renew") {
      const before = plan.previous.find((entry) => entry.name === file.name);
      if (existing === null || sha256(existing) !== before?.sha256)
        return refuse("installation-changed-since-prepare");
    }
    pending.push(file);
  }
  const dryRun = confirmTarget === undefined;
  const lock = path.join(directory, LOCK);
  if (!dryRun)
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      return refuse("installation-lock-held");
    }
  const staged = [];
  try {
    const database = await withMigrationClient(envFile, async (client, config) => {
      if (!dryRun && confirmTarget !== `${config.environment}:${config.database}`)
        return refuse("target-not-confirmed");
      if (config.database !== plan.database) return refuse("database-mismatch");
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        const at = new Date(now()).toISOString();
        const already = await auditDone(client, plan);
        // The facts the plan was built from must still hold (read again through their owners).
        const facts = await readInstallationFacts(client, {
          ...plan.scope,
          at,
          binding: { validFrom: plan.window.validFrom, validUntil: plan.window.validUntil },
          firstWindowEndsAt: plan.kind === "Install" ? plan.facts.firstWindow.endsAt : undefined,
          menuReference: plan.facts.menuReference,
          stockSiteReference: plan.facts.stockSiteReference,
        });
        const compared =
          plan.kind === "Install"
            ? facts
            : {
                liveGateRequirementCodes: facts.liveGateRequirementCodes,
                configuration: facts.configuration,
                menuReference: facts.menuReference,
                stockSiteReference: facts.stockSiteReference,
              };
        if (canonicalizeRfc8785(compared) !== canonicalizeRfc8785(plan.facts))
          return refuse("facts-changed-since-prepare");
        const roles = [];
        if (plan.kind === "Install") {
          const acl = await renderInstallationAcl(plan.roles);
          if (digestOf(acl) !== plan.aclDigest) return refuse("acl-changed-since-prepare");
          if (!dryRun) {
            for (const [service, name] of Object.entries(plan.roles)) {
              const role = await ensureServiceRole(client, directory, service, name);
              if (role.stagedFile) staged.push(role.stagedFile);
              roles.push({ service, role: name, action: role.action });
            }
            await client.query(acl);
          } else
            for (const [service, name] of Object.entries(plan.roles)) {
              const existing = await readServiceRole(client, name);
              roles.push({
                service,
                role: name,
                action: existing === null ? "WouldCreate" : "WouldRestrict",
              });
            }
        }
        if (!dryRun && !already) {
          await client.query(
            "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
            [plan.operatorReference, PILOT_INSTALLATION_PURPOSE],
          );
          await appendPlatformAuditRecordInTransaction(client, {
            auditReference: derivedReference(plan.operationReference, "audit"),
            actorReference: plan.operatorReference,
            purposeCode: PILOT_INSTALLATION_PURPOSE,
            actionCode:
              plan.kind === "Install" ? "PILOT_INSTALLATION_ISSUED" : "PILOT_INSTALLATION_RENEWED",
            targetType: "PilotInstallation",
            targetReference: plan.scope.storeReference,
            operationReference: plan.operationReference,
            intentDigest: planDigest(plan),
            occurredAt: at,
            reasonCode:
              plan.kind === "Install" ? "PILOT_STORE_INSTALLATION" : "PILOT_INSTALLATION_RENEWAL",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
        }
        if (dryRun) await client.query("ROLLBACK");
        else await client.query("COMMIT");
        return { already, roles };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    const result = {
      ...summary(plan),
      status: dryRun
        ? "DryRun"
        : database.already && pending.length === 0
          ? "AlreadyApplied"
          : "Applied",
      roles: database.roles,
      pendingFiles: pending.map((file) => file.name),
    };
    if (dryRun) return result;
    staged.length = 0; // committed: the password files belong to the roles now
    if (pending.length > 0) {
      const record = path.join(
        directory,
        "pilot-installation-" +
          plan.kind.toLowerCase() +
          "-" +
          new Date(now()).toISOString().replace(/[-:.]/gu, ""),
      );
      await mkdir(record, { mode: 0o700 });
      for (const file of pending) {
        const target = path.join(directory, file.name);
        if ((await readPrivate(target)) !== null) await link(target, path.join(record, file.name));
      }
      await writeAtomically(
        path.join(record, "record.json"),
        bytesOf({
          schemaVersion: 1,
          kind: plan.kind,
          performedAt: new Date(now()).toISOString(),
          operatorAccount: operatorAccountName(),
          operatorReference: plan.operatorReference,
          approvedByReference: approval.approvedByReference,
          approvalEvidenceReference: approval.approvalEvidenceReference,
          ownerApproval: plan.ownerApproval,
          operationReference: plan.operationReference,
          planDigest: planDigest(plan),
          window: plan.window,
          files: pending.map((file) => ({ name: file.name, sha256: file.sha256 })),
        }),
      );
      // INSTALLATION_FILES order: the profile is replaced last.
      for (const file of pending)
        await writeAtomically(path.join(directory, file.name), bytesOf(file.content));
      for (const file of pending)
        if (
          sha256((await readPrivate(path.join(directory, file.name))) ?? Buffer.alloc(0)) !==
          file.sha256
        )
          return refuse("file-verification-failed");
      await appendLog(
        path.join(directory, LOG),
        JSON.stringify({
          at: new Date(now()).toISOString(),
          kind: plan.kind,
          operationReference: plan.operationReference,
          planDigest: planDigest(plan),
          validUntil: plan.window.validUntil,
          approvedByReference: approval.approvedByReference,
          ownerApprovedBy: plan.ownerApproval.approvedBy,
          files: pending.length,
        }),
      );
    }
    return result;
  } finally {
    for (const file of staged) await unlink(file).catch(() => undefined);
    if (!dryRun) await rmdirQuiet(lock);
  }
}
async function rmdirQuiet(directory) {
  const { rmdir } = await import("node:fs/promises");
  await rmdir(directory).catch(() => undefined);
}

// ── Start readiness (DEC-PILOT-INSTALLATION) ────────────────────────────────────────────────
/**
 * Whether a Pilot runtime directory holds a complete issued installation: every file the services
 * load reads through `loadPilotInstallation` in this (Pilot) process, the three order Workflow
 * bindings and the cancellation Workflow are present, no InternalTest-only file is present, and
 * the binding window is in force. Returns problems as fixed reasons with file names only.
 */
export async function checkPilotInstallation(directory, { now = () => Date.now(), load } = {}) {
  const problems = [];
  try {
    const names = new Set(await readdir(directory));
    if (!names.has("installation.json")) return ["Installation: not-issued"];
    for (const name of INTERNAL_TEST_ONLY_FILES)
      if (names.has(name)) problems.push("Installation: internal-test-file-present " + name);
    for (const name of [
      ...INSTALLATION_FILES,
      "internal-test-workflow-Pickup.json",
      "internal-test-workflow-DineIn.json",
      "internal-test-workflow-AdditionalRelease.json",
      "cancellation-workflow-draft-result.json",
      "api-password",
      "worker-password",
    ])
      if (!names.has(name)) problems.push("Installation: missing " + name);
    if (problems.length > 0) return problems;
    const installation = await (
      load ??
      (async (value) => (await import("./pilot-installation.mjs")).loadPilotInstallation(value))
    )(directory);
    const checks = [
      ["internal-test-profile.json", () => installation.loadProfile()],
      ["internal-test-menu.json", () => installation.loadMenu()],
      [
        "internal-test-inventory.json",
        () => installation.loadCustomerData("internal-test-inventory.json"),
      ],
      ["internal-test-task-queue.json", () => installation.loadTaskQueue()],
      ["internal-test-receipt-template.json", () => installation.loadReceiptTemplate()],
      ["customer-runtime.json", () => installation.loadCustomerRuntime()],
      ["merchant-runtime.json", () => installation.loadMerchantRuntime()],
      ["business-worker.json", () => installation.loadBusinessWorker()],
      ["kitchen-queue-worker.json", () => installation.loadKitchenWorker()],
      ["dining-exception-worker.json", () => installation.loadDiningExceptionWorker()],
      ["daily-settlement-coverage.json", () => installation.loadDailySettlementCoverage()],
      ["internal-test-workflow-Pickup.json", () => installation.loadWorkflow("Pickup")],
      ["internal-test-workflow-DineIn.json", () => installation.loadWorkflow("DineIn")],
      [
        "internal-test-workflow-AdditionalRelease.json",
        () => installation.loadWorkflow("AdditionalRelease"),
      ],
      ["cancellation-workflow-draft-result.json", () => installation.loadCancellationWorkflow()],
    ];
    for (const [name, check] of checks)
      try {
        await check();
      } catch {
        problems.push("Installation: invalid " + name);
      }
    if (problems.length === 0) {
      const profile = await installation.loadProfile();
      const at = new Date(now()).toISOString();
      if (!(profile.binding?.validFrom <= at && at < profile.binding?.validUntil))
        problems.push("Installation: validity-window-not-in-force");
    }
  } catch {
    problems.push("Installation: unreadable");
  }
  return problems;
}

export async function run(args) {
  const { command, get } = parseCommand(args);
  if (command === "keygen") return keygen(get);
  if (command === "prepare") return prepare(get);
  if (command === "prepare-renewal") return prepareRenewal(get);
  if (command === "sign") return signPlanCommand(get);
  const plan = JSON.parse(await readFile(get("--plan"), "utf8"));
  const approval = JSON.parse(await readFile(get("--approval"), "utf8"));
  return applyPlan({
    envFile: get("--env-file"),
    plan,
    approval,
    // Reread at apply time, so a revocation published meanwhile is honoured.
    readTrust: async () => JSON.parse(await readFile(get("--trust"), "utf8")),
    confirmTarget: get("--confirm-target"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    (error) => {
      process.stderr.write(
        (error instanceof PilotInstallationError
          ? `${error.message} (${error.reason})`
          : typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
            ? error.code
            : /^usage: /u.test(error?.message ?? "")
              ? error.message
              : "PILOT_INSTALLATION_ISSUE_FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
