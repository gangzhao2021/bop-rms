import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingInstant,
} from "@bop/publishing";
import {
  bindWorkflowPublicationSnapshot,
  workflowDefinitionContent,
} from "../../application/workflow-publication-snapshot.js";
import {
  evaluateWorkflowAction,
  type WorkflowActionPorts,
} from "../../application/evaluate-workflow-action.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import {
  parseWorkflowDefinitionVersion,
  parseWorkflowActionRequest,
  workflowReference,
  workflowUnavailable,
  type WorkflowDefinitionVersion,
} from "../../domain/workflow-definition.js";
import { resolveWorkflowDefinition } from "../../domain/resolve-workflow-definition.js";
export interface WorkflowTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkflowTransactionRunner {
  run<T>(work: (tx: WorkflowTransaction) => Promise<T>): Promise<T>;
}
export type WorkflowTransactionActionGates = {
  [K in Exclude<keyof WorkflowActionPorts, "resolveVersions">]: (
    tx: WorkflowTransaction,
    input: Parameters<WorkflowActionPorts[K]>[0],
  ) => Promise<boolean>;
};
export interface WorkflowDefinitionWrite {
  readonly definition: WorkflowDefinitionVersion;
  readonly operationReference: string;
  readonly audit: unknown;
}
function rows(value: unknown, max = 1): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return workflowUnavailable();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > max)
    return workflowUnavailable();
  return d.value;
}
/** Internal owner capability. Reauthorize every access; new writes also require current publication/override gates. */
export function createPostgresWorkflowDefinitionStore(
  runner: WorkflowTransactionRunner,
  scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string | null;
  }>,
) {
  const tenant = workflowReference(scope.tenantReference),
    brand = workflowReference(scope.brandReference),
    store = scope.storeReference === null ? null : workflowReference(scope.storeReference);
  const run = async <T>(work: (tx: WorkflowTransaction) => Promise<T>): Promise<T> => {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store ?? ""],
        );
        return work(tx);
      });
    } catch {
      return workflowUnavailable();
    }
  };
  function bind(value: unknown) {
    const definition = parseWorkflowDefinitionVersion(value);
    if (
      definition.tenantReference !== tenant ||
      definition.brandReference !== brand ||
      (definition.storeReference !== null && definition.storeReference !== store)
    )
      return workflowUnavailable();
    return definition;
  }
  async function original(tx: WorkflowTransaction, operation: string) {
    const found = rows(
      await tx.query(
        "SELECT definition_json AS definition,intent_hash AS intent,audit_id AS audit,actor_id AS actor FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3",
        [tenant, brand, operation],
      ),
    );
    const row = found[0];
    if (!row) return null;
    if (typeof row.intent !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(row.intent))
      return workflowUnavailable();
    return Object.freeze({
      definition: bind(row.definition),
      intent: row.intent,
      auditReference: workflowReference(row.audit),
      actorReference: workflowReference(row.actor),
    });
  }
  return Object.freeze({
    /** Validate a persisted Published definition against the actual current Publishing owner. */
    async validatePublication(versionReference: string, observedAt: string) {
      const version = workflowReference(versionReference),
        at = parsePublishingInstant(observedAt);
      return run(async (tx) => {
        await tx.query("LOCK TABLE bop_workflow.workflow_definition_version IN SHARE MODE", []);
        const found = rows(
          await tx.query(
            "SELECT definition_json AS definition FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3",
            [tenant, brand, version],
          ),
        )[0];
        if (!found) return workflowUnavailable();
        const published = bind(found.definition);
        if (published.lifecycle !== "Published" || published.createdAt > at)
          return workflowUnavailable();
        const draftRow = rows(
          await tx.query(
            "SELECT definition_json AS definition FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND workflow_id=$3 AND version_number=$4",
            [tenant, brand, published.workflowReference, published.versionNumber - 1],
          ),
        )[0];
        if (!draftRow) return workflowUnavailable();
        const snapshot = bindWorkflowPublicationSnapshot(published, bind(draftRow.definition));
        try {
          const publishing = createPostgresPublishingMutationStore(
            { run: async (work) => work(tx) },
            tenant,
            createPublishingScope({
              kind: snapshot.scope.kind,
              brandReference: published.brandReference as never,
              storeReference: published.storeReference as never,
            }),
          );
          const actual = await publishing.resolveCurrentRelease({
            familyReference: snapshot.familyReference,
            configurationType: snapshot.configurationType,
            purposeCode: snapshot.purposeCode,
            observedAt: at,
          });
          if (
            actual.release.releaseId !== published.publicationReference ||
            actual.approvalEvidence.evidenceReference !== published.approvalEvidenceReference ||
            actual.release.snapshotReference !== snapshot.snapshotReference ||
            actual.release.snapshotDigest !== snapshot.snapshotDigest ||
            actual.release.createdAt > published.createdAt
          )
            return workflowUnavailable();
          return Object.freeze({ snapshot, publication: actual });
        } finally {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store ?? ""],
          );
        }
      });
    },
    async commit(
      input: WorkflowDefinitionWrite,
      validateNewWrite: (
        tx: WorkflowTransaction,
        definition: WorkflowDefinitionVersion,
      ) => Promise<boolean>,
    ) {
      const definition = bind(input.definition),
        operation = workflowReference(input.operationReference);
      const audit = validateAuditRecord(input.audit, Date.parse(definition.createdAt));
      if (
        definition.storeReference !== store ||
        audit.brandId !== brand ||
        (audit.storeId ?? null) !== store ||
        audit.actor.type === "System" ||
        audit.targetType !== "WorkflowDefinitionVersion" ||
        audit.targetId !== definition.versionReference ||
        audit.correlationId !== operation ||
        audit.occurredAt !== definition.createdAt ||
        audit.actionCode !== "WORKFLOW_DEFINITION_" + definition.lifecycle.toUpperCase() ||
        audit.dataClassification !== "Internal" ||
        (definition.lifecycle === "Draft" &&
          audit.actor.reference !== definition.authoredByReference)
      )
        return workflowUnavailable();
      const actorReference = audit.actor.reference;
      const intent =
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            operation,
            definition,
            actor: audit.actor,
            reasonCode: audit.reasonCode,
            sourceChannel: audit.sourceChannel,
          }),
        );
      return run(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "WorkflowOperation:" + tenant + ":" + brand + ":" + operation,
        ]);
        const prior = await original(tx, operation);
        if (prior) {
          if (prior.intent !== intent) return workflowUnavailable();
          return Object.freeze({ status: "AlreadyApplied" as const, ...prior });
        }
        await tx.query(
          "LOCK TABLE bop_workflow.workflow_definition_version IN ROW EXCLUSIVE MODE",
          [],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "WorkflowDefinition:" + tenant + ":" + brand + ":" + definition.workflowReference,
        ]);
        const previousRows = rows(
          await tx.query(
            "SELECT definition_json AS definition FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND workflow_id=$3 ORDER BY version_number DESC LIMIT 1",
            [tenant, brand, definition.workflowReference],
          ),
        );
        const previous = previousRows[0] ? bind(previousRows[0].definition) : null;
        if (
          (previous === null &&
            (definition.versionNumber !== 1 || definition.lifecycle !== "Draft")) ||
          (previous !== null && definition.versionNumber !== previous.versionNumber + 1) ||
          (previous !== null &&
            definition.lifecycle !== "Draft" &&
            workflowDefinitionContent(previous) !== workflowDefinitionContent(definition))
        )
          return workflowUnavailable();
        if ((await validateNewWrite(tx, definition)) !== true) return workflowUnavailable();
        await appendAuditRecordInTransaction(tx, audit);
        await tx.query(
          "INSERT INTO bop_workflow.workflow_definition_version (tenant_id,brand_id,store_id,workflow_id,version_id,version_number,operation_id,intent_hash,actor_id,audit_id,purpose_code,applicability_code,lifecycle,effective_from,effective_until,created_at,definition_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)",
          [
            tenant,
            brand,
            store,
            definition.workflowReference,
            definition.versionReference,
            definition.versionNumber,
            operation,
            intent,
            actorReference,
            audit.auditId,
            definition.purposeCode,
            definition.applicabilityCode,
            definition.lifecycle,
            definition.effectiveFrom,
            definition.effectiveUntil,
            definition.createdAt,
            definition,
          ],
        );
        return Object.freeze({
          status: "Applied" as const,
          definition,
          intent,
          actorReference,
          auditReference: audit.auditId,
        });
      });
    },
    async resolveCurrent(
      input: Readonly<{ purposeCode: string; applicabilityCode: string; observedAt: string }>,
    ) {
      return run((tx) => resolveCurrentInTransaction(tx, input));
    },
    /** Bind runner to the outer domain transaction to retain fences through its commit. */
    /** Production publication gate: owner evidence cannot be replaced by a caller boolean. */
    async evaluatePublishedAction(
      input: unknown,
      gates: Omit<WorkflowTransactionActionGates, "validatePublication"> & {
        authorizeOverride: WorkflowTransactionActionGates["validatePublication"];
      },
    ) {
      return run(async (tx) => {
        const bound = createPostgresWorkflowDefinitionStore(
          { run: async (work) => work(tx) },
          scope,
        );
        return bound.evaluateAction(input, {
          ...gates,
          validatePublication: async (shared, context) => {
            await bound.validatePublication(
              context.brandDefinition.versionReference,
              context.request.observedAt,
            );
            if (context.definition.versionReference !== context.brandDefinition.versionReference) {
              await bound.validatePublication(
                context.definition.versionReference,
                context.request.observedAt,
              );
              return gates.authorizeOverride(shared, context);
            }
            return true;
          },
        });
      });
    },
    async evaluateAction(input: unknown, gates: WorkflowTransactionActionGates) {
      const request = parseWorkflowActionRequest(input);
      if (
        request.tenantReference !== tenant ||
        request.brandReference !== brand ||
        request.storeReference !== store
      )
        return workflowUnavailable();
      return run((tx) =>
        evaluateWorkflowAction(request, {
          authorizeResource: (request) => gates.authorizeResource(tx, request),
          resolveVersions: async (request) => {
            const current = await resolveCurrentInTransaction(tx, request);
            return current.definition.versionReference === current.brandDefinition.versionReference
              ? [current.definition]
              : [current.brandDefinition, current.definition];
          },
          validatePublication: (input) => gates.validatePublication(tx, input),
          authorizeAction: (input) => gates.authorizeAction(tx, input),
          evaluateRule: (input) => gates.evaluateRule(tx, input),
        }),
      );
    },
  });
  async function resolveCurrentInTransaction(
    tx: WorkflowTransaction,
    input: Readonly<{ purposeCode: string; applicabilityCode: string; observedAt: string }>,
  ) {
    if (store === null) return workflowUnavailable();
    await tx.query("LOCK TABLE bop_workflow.workflow_definition_version IN SHARE MODE", []);
    const definitions = rows(
      await tx.query(
        "SELECT definition_json AS definition FROM bop_workflow.workflow_definition_version WHERE tenant_id=$1 AND brand_id=$2 AND (store_id IS NULL OR store_id=$3) AND purpose_code=$4 AND applicability_code=$5 ORDER BY workflow_id,version_number LIMIT 1025",
        [tenant, brand, store, input.purposeCode, input.applicabilityCode],
      ),
      1024,
    );
    return resolveWorkflowDefinition({
      versions: definitions.map((row) => bind(row.definition)),
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      purposeCode: input.purposeCode,
      applicabilityCode: input.applicabilityCode,
      observedAt: input.observedAt,
    });
  }
}
