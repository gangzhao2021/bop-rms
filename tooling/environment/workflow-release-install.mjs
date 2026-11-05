import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/index.ts";
import {
  createPostgresWorkflowDefinitionStore,
  createWorkflowPublicationSnapshot,
  parseWorkflowDefinitionVersion,
} from "../../packages/bop/workflow/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../packages/bop/publishing/src/index.ts";
import {
  matchesPlatformWorkflow,
  orderWorkflowReleases,
  orderWorkflowRules,
  platformWorkflows,
} from "./platform-workflows.mjs";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423 Q6 / DEC-ORDER-CANCELLATION-PILOT: Platform release step that installs a repository-defined
 * Workflow into one Brand through the Workflow and Publishing owner stores (Draft, review, approval,
 * release, Published), run by the release operator with the migration authority file:
 *
 *   node --import ./tooling/environment/register-workspace-typescript.mjs \
 *     tooling/environment/workflow-release-install.mjs --env-file <path>
 *     --confirm-target <environment>:<database> --workflow <release>
 *     --runtime-environment <InternalTest|Pilot> --tenant <uuid> --brand <uuid> --store <uuid>
 *     --operator <uuid> --approved-by <uuid> --approval-evidence <uuid> --operation <uuidv7>
 *     --output <path>
 *
 * Every reference and instant derives from `--operation`, so rerunning the same operation replays
 * it exactly. A new operation must be fresh (issued within 15 minutes). `--approved-by` is the
 * independent Platform approver (never the operator). `--store` only binds the runtime file the
 * worker loads; the Workflow itself is Brand-wide. Prints only the purpose, version and status.
 *
 * A Brand holds one Workflow family per purpose and order type (the resolver refuses two, on a money
 * path, for good), so a new operation never starts a second one. When the Brand already has the
 * family this writes nothing to the database, uses no approval and writes the runtime file from the
 * published version if it is missing: a rerun, a lost file and a second Store of the Brand all work.
 * Status `AlreadyInstalled` when the family is the repository's current definition,
 * `AlreadyInstalledOlderDefinition` when the repository has moved on but the family still serves the
 * Brand and can be bound (moving a family is a future release step, not guessed here). Refused,
 * printing the code and exit 1: a Brand holding two families (`WORKFLOW_RELEASE_DUPLICATE_FAMILIES`),
 * a family that cannot serve this release (`WORKFLOW_RELEASE_ALREADY_INSTALLED_DIFFERENT`), an
 * `--output` named for another release (`WORKFLOW_RELEASE_OUTPUT_MISMATCH`), an existing file that
 * names anything else (`WORKFLOW_RELEASE_BINDING_CONFLICT`; nothing is written, a person looks), and
 * a Store whose order bindings name purposes this tool does not release
 * (`WORKFLOW_RELEASE_STORE_ON_OTHER_PURPOSE`): it was installed before this tool, and a rerun would
 * leave it unable to restart.
 *
 * Releases (platform-workflows.mjs): `UnpaidDineInBatchCancellation` writes the cancellation
 * runtime file (`cancellation-workflow-draft-result.json`); the order Workflows
 * (DEC-PILOT-INSTALLATION) `OrderFulfillmentPickup`, `OrderFulfillmentDineIn` and
 * `OrderFulfillmentAdditionalRound` each write their runtime binding
 * (`internal-test-workflow-Pickup|DineIn|AdditionalRelease.json`): the published version and
 * transition references the order compositions evaluate. `new-operation` prints a fresh UUIDv7
 * for `--operation` (keep it to replay the same release).
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const flagNames = Object.freeze({
  "--env-file": "envFile",
  "--confirm-target": "confirmTarget",
  "--workflow": "release",
  "--runtime-environment": "runtimeEnvironment",
  "--tenant": "tenantReference",
  "--brand": "brandReference",
  "--store": "storeReference",
  "--operator": "operatorReference",
  "--approved-by": "approvedByReference",
  "--approval-evidence": "approvalEvidenceReference",
  "--operation": "operationReference",
  "--output": "output",
});
const usage =
  "usage: workflow-release-install " + Object.keys(flagNames).join(" <value> ") + " <value>";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const freshnessMs = 15 * 60 * 1000;

/** A UUIDv7 with the operation's instant and bits fixed by the operation and label. */
export function derivedReference(operationReference, label) {
  const hex = createHash("sha256")
    .update(operationReference + ":" + label)
    .digest("hex");
  const time = operationReference.replaceAll("-", "").slice(0, 12);
  const variant = ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(7, 19)}`;
}
export function operationInstant(operationReference) {
  return new Date(parseInt(operationReference.replaceAll("-", "").slice(0, 12), 16)).toISOString();
}

export function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = flagNames[args[index]],
      value = args[index + 1];
    if (
      !Object.hasOwn(flagNames, args[index]) ||
      typeof value !== "string" ||
      value.startsWith("--") ||
      Object.hasOwn(values, name)
    )
      throw new Error(usage);
    values[name] = value;
  }
  if (Object.keys(values).length !== Object.keys(flagNames).length) throw new Error(usage);
  if (
    !Object.hasOwn(platformWorkflows, values.release) ||
    !["InternalTest", "Pilot"].includes(values.runtimeEnvironment) ||
    [
      values.tenantReference,
      values.brandReference,
      values.storeReference,
      values.operatorReference,
      values.approvedByReference,
      values.approvalEvidenceReference,
    ].some((value) => !uuid.test(value)) ||
    !uuidV7Pattern.test(values.operationReference)
  )
    throw new Error(usage);
  if (values.operatorReference === values.approvedByReference)
    throw new Error("WORKFLOW_RELEASE_APPROVER_NOT_INDEPENDENT");
  if (path.basename(values.output) !== runtimeFileName(values.release))
    throw new Error("WORKFLOW_RELEASE_OUTPUT_MISMATCH");
  return Object.freeze(values);
}

/** The file each release writes: the name the Store's services load for that order type. */
export function runtimeFileName(release) {
  const { binding } = platformWorkflows[release];
  return binding === undefined
    ? "cancellation-workflow-draft-result.json"
    : `internal-test-workflow-${binding}.json`;
}

/**
 * Pure release plan: the Workflow versions and Publishing mutations one operation writes. The
 * definition is the repository's; only a test plans another one, to install a family as it was.
 */
export function planWorkflowRelease(options, workflow = platformWorkflows[options.release]) {
  const operation = options.operationReference,
    at = operationInstant(operation),
    ref = (label) => derivedReference(operation, label);
  const draft = parseWorkflowDefinitionVersion({
    schemaVersion: 1,
    workflowReference: ref("workflow"),
    versionReference: ref("draft-version"),
    versionNumber: 1,
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    storeReference: null,
    purposeCode: workflow.purposeCode,
    applicabilityCode: workflow.applicabilityCode,
    lifecycle: "Draft",
    baseVersionReference: null,
    overrideAuthorizationReference: null,
    effectiveFrom: at,
    effectiveUntil: null,
    publicationReference: null,
    approvalEvidenceReference: null,
    authoredByReference: options.operatorReference,
    createdAt: at,
    transitions: workflow.transitions.map((transition, index) => ({
      transitionReference: ref("transition-" + index),
      ...transition,
    })),
  });
  const snapshot = createWorkflowPublicationSnapshot(draft);
  const lifecycleId = ref("lifecycle");
  const draftLifecycle = {
    lifecycleId,
    familyReference: snapshot.familyReference,
    configurationType: snapshot.configurationType,
    purposeCode: snapshot.purposeCode,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const validUntil = new Date(Date.parse(at) + freshnessMs).toISOString();
  const validation = {
    evidenceReference: ref("validation"),
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    result: "Pass",
    checkedAt: at,
    validUntil,
    checkCodes: ["PLATFORM_WORKFLOW_MATCHES_REPOSITORY"],
  };
  const review = {
    ...draftLifecycle,
    version: 2,
    state: "InReview",
    validationEvidenceReference: validation.evidenceReference,
  };
  const approval = {
    evidenceReference: options.approvalEvidenceReference,
    reviewLifecycleId: lifecycleId,
    reviewVersion: 2,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    decision: "Accepted",
    approvedActorReference: options.approvedByReference,
    approvedAt: at,
    validUntil,
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: approval.evidenceReference,
  };
  const publishedLifecycle = { ...approved, version: 4, state: "Published" };
  const release = {
    releaseId: ref("release"),
    familyReference: snapshot.familyReference,
    configurationType: snapshot.configurationType,
    purposeCode: snapshot.purposeCode,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    sequence: 1,
    sourceLifecycleId: lifecycleId,
    kind: "Publish",
    previousReleaseId: null,
    createdAt: at,
  };
  const actionCodes = {
    CreateDraft: "PUBLISHING_DRAFT_CREATED",
    SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
    Approve: "PUBLISHING_REVIEW_APPROVED",
    Publish: "PUBLISHING_RELEASE_PUBLISHED",
  };
  const mutation = (operationCode, current, next, actor, extra = {}) => ({
    operation: operationCode,
    current,
    next,
    expectedVersion: current?.version ?? 1,
    idempotencyKey: ref("publishing-" + operationCode),
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: null,
    audit: {
      auditId: ref("publishing-audit-" + operationCode),
      brandId: options.brandReference,
      actor: { type: "User", reference: actor },
      actionCode: actionCodes[operationCode],
      targetType: "PublishingLifecycle",
      targetId: lifecycleId,
      reasonCode: "RELEASE_PLATFORM_WORKFLOW",
      correlationId: operation,
      occurredAt: at,
      sourceChannel: "PLATFORM_RELEASE",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
    ...extra,
  });
  const operator = options.operatorReference;
  const publishing = [
    mutation("CreateDraft", null, draftLifecycle, operator),
    mutation("SubmitReview", draftLifecycle, review, operator, { validationEvidence: validation }),
    mutation("Approve", review, approved, options.approvedByReference, {
      approvalEvidence: approval,
    }),
    mutation("Publish", approved, publishedLifecycle, operator, {
      validationEvidence: validation,
      approvalEvidence: approval,
      release,
    }),
  ];
  const published = parseWorkflowDefinitionVersion({
    ...draft,
    versionReference: ref("published-version"),
    versionNumber: 2,
    lifecycle: "Published",
    publicationReference: release.releaseId,
    approvalEvidenceReference: approval.evidenceReference,
  });
  const workflowWrite = (definition, label) => ({
    definition,
    operationReference: ref("workflow-" + label),
    audit: {
      auditId: ref("workflow-audit-" + label),
      brandId: options.brandReference,
      actor: { type: "User", reference: operator },
      actionCode: "WORKFLOW_DEFINITION_" + definition.lifecycle.toUpperCase(),
      targetType: "WorkflowDefinitionVersion",
      targetId: definition.versionReference,
      reasonCode: "RELEASE_PLATFORM_WORKFLOW",
      correlationId: ref("workflow-" + label),
      occurredAt: definition.createdAt,
      sourceChannel: "PLATFORM_RELEASE",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    },
  });
  return Object.freeze({
    at,
    snapshot,
    release,
    draft,
    published,
    publishing,
    workflowWrites: [workflowWrite(draft, "draft"), workflowWrite(published, "published")],
  });
}

/**
 * What the Brand's one family is to this release, or null when it cannot serve the Store's runtime
 * file: not published or no longer in force, a cancellation family that is not the repository's
 * current one (its worker accepts nothing else, pilot-batch-cancellation acceptedWorkflow), or an
 * order family the binding cannot name. An older order family keeps serving the Brand: the resolver
 * uses it whatever this tool says, and its other Stores already run on it.
 */
export function installedStatus(definition, release, at) {
  if (
    definition.lifecycle !== "Published" ||
    definition.effectiveFrom > at ||
    (definition.effectiveUntil !== null && definition.effectiveUntil <= at)
  )
    return null;
  if (matchesPlatformWorkflow(definition)) return "AlreadyInstalled";
  if (platformWorkflows[release].binding === undefined) return null;
  try {
    orderBinding(definition);
    return "AlreadyInstalledOlderDefinition";
  } catch {
    return null;
  }
}

/**
 * The Brand's family for this release, or null when it has none yet. Writes nothing. Reading it
 * takes the purpose lock, so a second install waits for the first and then finds its family.
 */
async function installedFamily(workflows, options, at) {
  const families = await workflows.familiesOfPurpose(platformWorkflows[options.release]);
  if (families.length === 0) return null;
  if (families.length > 1) throw new Error("WORKFLOW_RELEASE_DUPLICATE_FAMILIES");
  const [{ definition, operationReference }] = families;
  const status = installedStatus(definition, options.release, at);
  if (status === null) throw new Error("WORKFLOW_RELEASE_ALREADY_INSTALLED_DIFFERENT");
  await workflows.validatePublication(definition.versionReference, at);
  return Object.freeze({
    plan: Object.freeze({ published: definition }),
    status,
    operationReference,
  });
}

const brandWorkflows = (client, options) =>
  createPostgresWorkflowDefinitionStore(
    { run: (work) => work(client) },
    {
      tenantReference: options.tenantReference,
      brandReference: options.brandReference,
      storeReference: null,
    },
  );

/** Writes (or exactly replays) one planned release through the Workflow and Publishing owners. */
export async function commitPlannedRelease(client, plan, options) {
  const workflows = brandWorkflows(client, options);
  const publisher = createPostgresPublishingMutationStore(
    { run: (work) => work(client) },
    options.tenantReference,
    plan.snapshot.scope,
  );
  const draft = await workflows.commit(plan.workflowWrites[0], async () => true);
  for (const mutation of plan.publishing) await publisher.commit(mutation);
  const published = await workflows.commit(plan.workflowWrites[1], async () => {
    const current = await publisher.resolveCurrentRelease({
      familyReference: plan.snapshot.familyReference,
      configurationType: plan.snapshot.configurationType,
      purposeCode: plan.snapshot.purposeCode,
      observedAt: plan.at,
    });
    return (
      current.release.releaseId === plan.release.releaseId &&
      current.release.snapshotDigest === plan.snapshot.snapshotDigest
    );
  });
  await workflows.validatePublication(plan.published.versionReference, plan.at);
  return Object.freeze({
    plan,
    status:
      draft.status === "AlreadyApplied" && published.status === "AlreadyApplied"
        ? "AlreadyApplied"
        : "Applied",
    operationReference: options.operationReference,
  });
}

/**
 * Applies (or exactly replays) one release in a single transaction, or finds the Brand already has
 * it and writes nothing. The caller holds the transaction: the purpose lock lasts until it ends.
 */
export async function applyWorkflowRelease(client, options, now = () => Date.now()) {
  const plan = planWorkflowRelease(options);
  await client.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
    [options.tenantReference, options.brandReference],
  );
  const prior = await client.query(
    "SELECT 1 FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3",
    [options.tenantReference, options.brandReference, plan.workflowWrites[0].operationReference],
  );
  const replay = prior.rows.length > 0,
    age = now() - Date.parse(plan.at);
  if (!replay && (age < 0 || age > freshnessMs))
    throw new Error("WORKFLOW_RELEASE_OPERATION_NOT_FRESH");
  if (!replay) {
    const installed = await installedFamily(
      brandWorkflows(client, options),
      options,
      new Date(now()).toISOString(),
    );
    if (installed !== null) return installed;
  }
  return commitPlannedRelease(client, plan, options);
}

/**
 * What an order binding names from a published version: the transitions the compositions evaluate.
 * Refuses a definition missing one of them, or one whose payment step the compositions refuse.
 */
function orderBinding(published) {
  const transition = (currentState, action) => {
    const found = published.transitions.filter(
      (t) => t.currentState === currentState && t.action === action,
    );
    if (found.length !== 1) throw new Error("WORKFLOW_RELEASE_BINDING_UNAVAILABLE");
    return found[0];
  };
  const submit = transition("CartReady", "SubmitOrder"),
    pay = transition("Submitted", "CreatePaymentIntent");
  const reserveCommandCode = submit.effects[0]?.commandCode,
    paymentCommandCode = pay.effects[0]?.commandCode;
  if (
    reserveCommandCode === undefined ||
    paymentCommandCode !== "CreatePaymentIntent" ||
    !pay.ruleReferences.includes(orderWorkflowRules.intactReservation)
  )
    throw new Error("WORKFLOW_RELEASE_BINDING_UNAVAILABLE");
  return {
    payment: {
      fulfillmentTransitionReference: transition("Accepted", "FulfillOrder").transitionReference,
      acceptanceTransitionReference: transition("Submitted", "Accept").transitionReference,
      releaseTransitionReference: transition("Accepted", "ReleasePaidOrder").transitionReference,
      workflowVersionReference: published.versionReference,
      purposeCode: published.purposeCode,
      action: pay.action,
      permissionCode: pay.permissionCode,
      paymentCommandCode,
      intactReservationRuleReference: orderWorkflowRules.intactReservation,
    },
    purposeCode: published.purposeCode,
    applicabilityCode: published.applicabilityCode,
    currentState: submit.currentState,
    action: submit.action,
    reserveCommandCode,
    deferredActionCode: null,
  };
}

/**
 * The runtime file of one release. The cancellation release keeps its established shape; an order
 * release writes the binding the order compositions load (`loadWorkflow(kind)`): the published
 * version, the purpose and the transition references they evaluate, never a gate or a secret.
 */
export function workflowRuntimeFile(
  plan,
  { environment, database, scope, operationReference, release },
) {
  const workflow = platformWorkflows[release];
  if (workflow.binding === undefined)
    return { environment, database, scope, operationReference, definition: plan.published };
  return {
    environment,
    database,
    scope,
    operationReference,
    release,
    workflow: orderBinding(plan.published),
  };
}

/** The runtime file already at this path, or null when there is none. */
export async function readExistingBinding(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("WORKFLOW_RELEASE_BINDING_UNREADABLE", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("WORKFLOW_RELEASE_BINDING_UNREADABLE", { cause: error });
  }
  if (value === null || typeof value !== "object")
    throw new Error("WORKFLOW_RELEASE_BINDING_UNREADABLE");
  return value;
}

const bindingIdentity = (file) =>
  JSON.stringify([
    file.environment,
    file.database,
    file.scope?.tenantReference,
    file.scope?.brandReference,
    file.scope?.storeReference,
    file.workflow?.purposeCode ?? file.definition?.purposeCode,
    file.workflow?.applicabilityCode ?? file.definition?.applicabilityCode,
    file.workflow?.payment?.workflowVersionReference ?? file.definition?.versionReference,
  ]);

/**
 * A rerun never moves a live Store's binding: the services read it at their next restart, so a wrong
 * one would stay hidden until then. A file naming anything else is left for a person to look at.
 * Files from before this tool carry no `release`; what they name is compared all the same.
 */
export function requireSameBinding(existing, next) {
  if (
    (existing.release !== undefined && existing.release !== next.release) ||
    bindingIdentity(existing) !== bindingIdentity(next)
  )
    throw new Error("WORKFLOW_RELEASE_BINDING_CONFLICT");
}

/**
 * A Store's services load its order bindings together, and its worker does not start on Pickup and
 * DineIn of different purposes (pilot-paid-outcome `INTERNAL_PAID_SCOPE_MISMATCH`). A Store installed
 * before this tool runs on other purposes: looking up the release's purpose finds nothing there, so
 * a rerun for a lost file would start a new family and write a binding that stops the Store at its
 * next restart. Files say which purpose a Store is on; a damaged one says nothing here (its own
 * rerun reports it). The cancellation runs on its own and is not held to this.
 */
export async function requireReleasedOrderPurposes(directory, release) {
  if (platformWorkflows[release].binding === undefined) return;
  for (const name of orderWorkflowReleases) {
    const binding = await readExistingBinding(path.join(directory, runtimeFileName(name))).catch(
      () => null,
    );
    const purposeCode = binding?.workflow?.purposeCode;
    if (typeof purposeCode === "string" && purposeCode !== platformWorkflows[name].purposeCode)
      throw new Error("WORKFLOW_RELEASE_STORE_ON_OTHER_PURPOSE");
  }
}

/** Owner-only (0600) file replaced atomically, so a reader never sees a partial binding. */
export async function writePrivateFileAtomically(file, text) {
  const staging = file + ".staging-" + randomBytes(6).toString("hex");
  const handle = await open(staging, "wx", 0o600);
  try {
    await handle.writeFile(text);
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

/** Refuses a runtime directory whose installation profile names another environment or Store. */
export async function requireMatchingProfile(directory, expected) {
  let profile;
  try {
    profile = JSON.parse(
      await readFile(path.join(directory, "internal-test-profile.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("WORKFLOW_RELEASE_PROFILE_UNREADABLE", { cause: error });
  }
  if (
    profile?.environment !== expected.environment ||
    profile.database !== expected.database ||
    Object.entries(expected.scope).some(([key, value]) => profile.binding?.[key] !== value)
  )
    throw new Error("WORKFLOW_RELEASE_PROFILE_MISMATCH");
}

export async function installWorkflowRelease(args, now = () => Date.now()) {
  const options = parseArguments(args);
  const config = await loadMigrationConnectionConfig(root, options.envFile);
  if (options.confirmTarget !== `${config.environment}:${config.database}`)
    throw new Error("WORKFLOW_RELEASE_TARGET_NOT_CONFIRMED");
  const scope = {
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    storeReference: options.storeReference,
  };
  // DEC-PILOT-INSTALLATION: written into an issued runtime directory, the binding must belong to
  // its profile (same environment, database and Store) before anything is released.
  const directory = path.dirname(path.resolve(options.output));
  await requireMatchingProfile(directory, {
    environment: options.runtimeEnvironment,
    database: config.database,
    scope,
  });
  await requireReleasedOrderPurposes(directory, options.release);
  const existing = await readExistingBinding(options.output);
  const client = new pg.Client({
    application_name: "bop-rms-workflow-release",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  });
  await client.connect();
  let result, runtimeFile;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    result = await applyWorkflowRelease(client, options, now);
    runtimeFile = workflowRuntimeFile(result.plan, {
      environment: options.runtimeEnvironment,
      database: config.database,
      scope,
      operationReference: result.operationReference,
      release: options.release,
    });
    // Before the commit, so a refused run installs nothing either.
    if (existing !== null) requireSameBinding(existing, runtimeFile);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
  // The runtime file the services load; written only after the release committed. One already
  // there names the same release and version: a rerun leaves it as it is.
  if (existing === null)
    await writePrivateFileAtomically(options.output, JSON.stringify(runtimeFile, null, 2) + "\n");
  return {
    release: options.release,
    purposeCode: result.plan.published.purposeCode,
    versionReference: result.plan.published.versionReference,
    status: result.status,
    // Services read the file when they start: "Written" means this Store needs a restart for it.
    bindingFile: existing === null ? "Written" : "Unchanged",
  };
}

/**
 * What a refusal prints: its code and, when a Workflow rule refused, the rule, plus what failed when
 * the rule is a failed dependency. Words and codes only.
 */
export function failureLine(error) {
  const code = typeof error?.code === "string" ? error.code : error?.message || "FAILED";
  const rule = typeof error?.rule === "string" && /^[A-Za-z]{1,40}$/u.test(error.rule);
  const cause = error?.cause?.code;
  return [
    code,
    ...(rule ? [error.rule] : []),
    ...(rule && typeof cause === "string" && /^[A-Za-z0-9_]{1,80}$/u.test(cause) ? [cause] : []),
  ].join(" ");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (process.argv.length === 3 && process.argv[2] === "new-operation"
    ? Promise.resolve({ operationReference: uuidV7() })
    : installWorkflowRelease(process.argv.slice(2))
  ).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      process.stderr.write(failureLine(error) + "\n");
      process.exitCode = 1;
    },
  );
}
