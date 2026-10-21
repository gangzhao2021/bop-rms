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
import { orderWorkflowRules, platformWorkflows } from "./platform-workflows.mjs";
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
  return Object.freeze(values);
}

/** Pure release plan: the Workflow versions and Publishing mutations one operation writes. */
export function planWorkflowRelease(options) {
  const operation = options.operationReference,
    at = operationInstant(operation),
    ref = (label) => derivedReference(operation, label);
  const workflow = platformWorkflows[options.release];
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

/** Applies (or exactly replays) one release in a single transaction. */
export async function applyWorkflowRelease(client, options, now = () => Date.now()) {
  const plan = planWorkflowRelease(options);
  const scope = {
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    storeReference: null,
  };
  const inTransaction = { run: (work) => work(client) };
  const workflows = createPostgresWorkflowDefinitionStore(inTransaction, scope);
  const publisher = createPostgresPublishingMutationStore(
    inTransaction,
    options.tenantReference,
    plan.snapshot.scope,
  );
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
  });
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
  const transition = (currentState, action) => {
    const found = plan.published.transitions.filter(
      (t) => t.currentState === currentState && t.action === action,
    );
    if (found.length !== 1) throw new Error("WORKFLOW_RELEASE_BINDING_UNAVAILABLE");
    return found[0];
  };
  const submit = transition("CartReady", "SubmitOrder"),
    pay = transition("Submitted", "CreatePaymentIntent");
  return {
    environment,
    database,
    scope,
    operationReference,
    release,
    workflow: {
      payment: {
        fulfillmentTransitionReference: transition("Accepted", "FulfillOrder").transitionReference,
        acceptanceTransitionReference: transition("Submitted", "Accept").transitionReference,
        releaseTransitionReference: transition("Accepted", "ReleasePaidOrder").transitionReference,
        workflowVersionReference: plan.published.versionReference,
        purposeCode: plan.published.purposeCode,
        action: pay.action,
        permissionCode: pay.permissionCode,
        paymentCommandCode: pay.effects[0].commandCode,
        intactReservationRuleReference: orderWorkflowRules.intactReservation,
      },
      purposeCode: plan.published.purposeCode,
      applicabilityCode: plan.published.applicabilityCode,
      currentState: submit.currentState,
      action: submit.action,
      reserveCommandCode: submit.effects[0].commandCode,
      deferredActionCode: null,
    },
  };
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
  // DEC-PILOT-INSTALLATION: written into an issued runtime directory, the binding must belong to
  // its profile (same environment, database and Store) before anything is released.
  await requireMatchingProfile(path.dirname(path.resolve(options.output)), {
    environment: options.runtimeEnvironment,
    database: config.database,
    scope: {
      tenantReference: options.tenantReference,
      brandReference: options.brandReference,
      storeReference: options.storeReference,
    },
  });
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
  let result;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    result = await applyWorkflowRelease(client, options, now);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
  // The runtime file the services load; written only after the release committed.
  await writePrivateFileAtomically(
    options.output,
    JSON.stringify(
      workflowRuntimeFile(result.plan, {
        environment: options.runtimeEnvironment,
        database: config.database,
        scope: {
          tenantReference: options.tenantReference,
          brandReference: options.brandReference,
          storeReference: options.storeReference,
        },
        operationReference: options.operationReference,
        release: options.release,
      }),
      null,
      2,
    ) + "\n",
  );
  return {
    release: options.release,
    purposeCode: result.plan.published.purposeCode,
    versionReference: result.plan.published.versionReference,
    status: result.status,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (process.argv.length === 3 && process.argv[2] === "new-operation"
    ? Promise.resolve({ operationReference: uuidV7() })
    : installWorkflowRelease(process.argv.slice(2))
  ).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      process.stderr.write(
        (typeof error?.code === "string" ? error.code : error?.message || "FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
