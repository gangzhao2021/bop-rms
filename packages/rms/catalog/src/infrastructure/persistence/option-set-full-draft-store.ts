import {
  appendOptionSetAuthoringIdentity,
  requireOriginalOptionSetAuthoringIdentity,
  requireOptionSetAuthoringOperationAvailable,
} from "./option-set-authoring-identity.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction, type DomainEventEnvelope } from "@bop/eventing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
} from "../../contracts/product.js";
import { parseOptionSetAggregate, parseOptionSetDraft } from "../../contracts/option-set.js";
import {
  parseCatalogOptionSetEditorContent,
  type OptionSetEditorContent,
  parseCatalogFullOptionSetPublicationContent,
  createCatalogFullOptionSetPublicationMaterialization,
  type CatalogFullOptionSetPublicationContent,
} from "../../contracts/option-set-editor-content.js";
import {
  parseFullOptionSetCreateCommand,
  materializeFullOptionSetCreation,
} from "../../contracts/option-set-full-create.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  parseFullOptionSetEditCommand,
  materializeFullOptionSetEdit,
  type FullOptionSetEditCommand,
} from "../../contracts/option-set-full-edit.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import {
  parseProductPublicationCommandV2,
  type ProductPublicationCommandV2,
} from "../../contracts/product-publication-v2.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type CatalogProductPublicationWarningAcknowledgementCommand,
} from "../../contracts/product-publication-warning-acknowledgement.js";
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("CATALOG_INPUT_INVALID");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)))
    return fail("CATALOG_INPUT_INVALID");
  return r;
}
const fields = Object.freeze([
  "optionSetReference",
  "versionReference",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
] as const);
export interface FullOptionSetDraftAuthority {
  /** Actual current active Brand/User/action/purpose/all fields held through outer
   * COMMIT. Returns its real shortest lease, never reference/publication readiness. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.update";
      readonly purposeCode: "CATALOG_OPTION_SET_DRAFT";
      readonly requiredFields: typeof fields;
      readonly optionSetReference: string;
      readonly proposedDraft: ReturnType<typeof parseOptionSetDraft>;
      readonly additionalContent: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
const utc = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const currentSql = `SELECT jsonb_build_object(
 'optionSetReference',s.option_set_id,'brandReference',s.brand_id,'internalCode',s.internal_code,'lifecycle',s.lifecycle,
 'aggregateVersion',s.aggregate_version,'createdAt',${utc("s.created_at")},'createdByActorReference',s.created_by_actor_id,'updatedAt',${utc("s.updated_at")},
 'draft',jsonb_build_object('versionReference',v.option_set_version_id,'status',v.status,'defaultLocale',v.default_locale,
 'localizedNames',v.localized_names_json,'localizedDescriptions',v.localized_descriptions_json,'displayStyle',v.display_style,
 'minimumSelection',v.minimum_selection,'maximumSelection',v.maximum_selection,'allowRepeatedOption',v.allow_repeated_option,
 'perOptionMaximumQuantity',v.per_option_maximum_quantity,'maximumTotalQuantity',v.maximum_total_quantity,
 'createdAt',${utc("v.created_at")},'updatedAt',${utc("v.updated_at")},'options',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'optionReference',o.option_id,'optionSetReference',o.option_set_id,'brandReference',o.brand_id,'stableCode',o.stable_code,
 'lifecycle',o.lifecycle,'localizedNames',o.localized_names_json,'localizedDescriptions',o.localized_descriptions_json,
 'sortOrder',o.sort_order,'defaultEligible',o.default_eligible,'triggeredOptionSetReference',o.triggered_option_set_id,
 'conflictOptionReferences',COALESCE((SELECT jsonb_agg(c.conflict_option_id ORDER BY c.conflict_option_id) FROM rms_catalog.option_conflict c WHERE c.option_id=o.option_id AND c.option_set_id=s.option_set_id AND c.brand_id=s.brand_id),'[]'::jsonb),
 'createdAt',${utc("o.created_at")},'createdByActorReference',o.created_by_actor_id) ORDER BY o.sort_order)
 FROM rms_catalog.option o WHERE o.option_set_id=s.option_set_id AND o.brand_id=s.brand_id AND o.option_set_version_id=v.option_set_version_id),'[]'::jsonb))) aggregate,
 v.editor_content_json details,
 (date_trunc('milliseconds',s.created_at)=s.created_at AND date_trunc('milliseconds',s.updated_at)=s.updated_at
 AND date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.option o WHERE o.option_set_id=s.option_set_id AND o.brand_id=s.brand_id
 AND (date_trunc('milliseconds',o.created_at)<>o.created_at OR o.option_set_version_id<>v.option_set_version_id))) coherent
 FROM rms_catalog.option_set s JOIN rms_catalog.option_set_version v ON v.option_set_id=s.option_set_id AND v.brand_id=s.brand_id
 WHERE s.option_set_id=$1 AND s.brand_id=$2 AND v.status='Draft'`;
interface CurrentRow {
  readonly aggregate: unknown;
  readonly details: unknown;
  readonly coherent: boolean;
}
interface OriginalRow {
  readonly snapshot: unknown;
  readonly source_digest: string;
  readonly content_digest: string;
  readonly configuration_digest: string;
  readonly intent_digest: string;
  readonly coherent: boolean;
}
export interface FullOptionSetCreateAuthority {
  /** Active Brand/User/create action and every field held through COMMIT. A null
   * target is the initial create intent; subsequent holds bind allocated/original Set. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.create";
      readonly purposeCode: "CATALOG_OPTION_SET_DRAFT";
      readonly requiredFields: readonly string[];
      readonly optionSetReference: string | null;
      readonly proposedCommand: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
export interface FullOptionSetEditAuthority {
  /** Actual current scoped User/update/all-field permission held through COMMIT.
   * Intent admits observation only; Apply binds the original complete baseline
   * and candidate; Replay verifies original facts without current qualification.
   * No Publishing eligibility or source readiness is supplied by this port. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.update";
      readonly purposeCode: "CATALOG_OPTION_SET_DRAFT";
      readonly requiredFields: readonly string[];
      readonly phase: "Intent" | "Apply" | "Replay";
      readonly proposedCommand: FullOptionSetEditCommand;
      readonly originalContent: OptionSetEditorContent | null;
      readonly proposedContent: OptionSetEditorContent | null;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
export function createPostgresFullOptionSetDraftStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: FullOptionSetDraftAuthority;
  readonly audit: {
    create(input: {
      readonly operationReference: string;
      readonly reasonCode: string;
      readonly occurredAt: string;
      readonly result: OptionSetEditorContent;
    }): AppendAuditRecordInput;
  };
  readonly events: { generateReference(): string };
  readonly editing?: {
    readonly authority: FullOptionSetEditAuthority;
    readonly references: { generateOption(): string };
    readonly registerBeforeCommit: (
      tx: Transaction,
      guard: () => Promise<void>,
      finalAssert: () => void,
    ) => Promise<void> | void;
  };
  readonly creation?: {
    readonly authority: FullOptionSetCreateAuthority;
    readonly references: { generate(kind: "OptionSet" | "OptionSetVersion" | "Option"): string };
  };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.audit?.create !== "function" ||
    typeof options.events?.generateReference !== "function"
  )
    return fail();
  if (
    options.editing !== undefined &&
    (typeof options.editing.authority?.holdUntilTransactionCompletes !== "function" ||
      typeof options.editing.references?.generateOption !== "function" ||
      typeof options.editing.registerBeforeCommit !== "function")
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    admission = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    auditFor = options.audit.create.bind(options.audit),
    eventFor = options.events.generateReference.bind(options.events);
  const editing =
    options.editing === undefined
      ? undefined
      : {
          hold: options.editing.authority.holdUntilTransactionCompletes.bind(
            options.editing.authority,
          ),
          allocate: options.editing.references.generateOption.bind(options.editing.references),
          register: options.editing.registerBeforeCommit.bind(options.editing),
        };
  const creationPorts =
    options.creation === undefined
      ? undefined
      : {
          hold:
            typeof options.creation.authority?.holdUntilTransactionCompletes === "function"
              ? options.creation.authority.holdUntilTransactionCompletes.bind(
                  options.creation.authority,
                )
              : undefined,
          generate:
            typeof options.creation.references?.generate === "function"
              ? options.creation.references.generate.bind(options.creation.references)
              : undefined,
        };
  const now = () => parseCatalogInstant(clock());
  async function write(value: unknown, editMode: boolean) {
    const editCommand = editMode ? parseFullOptionSetEditCommand(value) : undefined;
    if (editMode && !editing) return fail();
    const r =
        editCommand ??
        closed(copyCategoryPersistenceValue(value), [
          "optionSetReference",
          "expectedAggregateVersion",
          "draft",
          "additionalContent",
          "operationReference",
          "occurredAt",
          "reasonCode",
        ]),
      set = parseCatalogReference(r.optionSetReference),
      operation = parseCatalogReference(r.operationReference),
      at = parseCatalogInstant(r.occurredAt),
      reason = parseCatalogCode(r.reasonCode),
      expected = r.expectedAggregateVersion;
    let draft = editMode ? undefined : parseOptionSetDraft(r.draft),
      additional: unknown = r.additionalContent;
    if (draft)
      draft = parseOptionSetDraft({
        ...draft,
        options: draft.options
          .map((o) => ({ ...o, conflictOptionReferences: [...o.conflictOptionReferences].sort() }))
          .sort((a, b) => a.sortOrder - b.sortOrder),
      });
    if (
      !Number.isSafeInteger(expected) ||
      (expected as number) < 1 ||
      (expected as number) >= 2147483647 ||
      (!editMode && draft?.updatedAt !== at) ||
      reason !== r.reasonCode
    )
      return fail("CATALOG_INPUT_INVALID");
    const intent = editCommand
      ? hash({
          profile: "CatalogFullOptionSetEditV1",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          command: editCommand,
        })
      : hash({
          profile: "CatalogFullOptionSetDraftWriteV1",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          optionSetReference: set,
          expectedAggregateVersion: expected,
          draft,
          additionalContent: additional,
          operationReference: operation,
          occurredAt: at,
          reasonCode: reason,
        });
    let invocations = 0;
    try {
      const result = await run(async (tx) => {
        if (++invocations !== 1) return fail();
        let deadline = editMode ? Date.parse(now()) + 30000 : Infinity,
          latest = now(),
          poisoned = false,
          closedHost = false,
          pending = true,
          guardCalls = 0,
          guardComplete = false,
          phase: "Intent" | "Apply" | "Replay" = "Intent",
          originalContent: OptionSetEditorContent | null = null,
          proposedContent: OptionSetEditorContent | null = null;
        const descriptor = Object.getOwnPropertyDescriptor(tx, "query");
        if (
          editMode &&
          (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
        )
          return fail();
        const queryReference = tx.query,
          queryOriginal = queryReference.bind(tx);
        const check = () => {
          const at = now();
          if (
            poisoned ||
            closedHost ||
            (editMode &&
              (at < latest ||
                Object.getOwnPropertyDescriptor(tx, "query")?.value !== queryReference)) ||
            Date.parse(at) >= deadline
          ) {
            poisoned = true;
            return fail();
          }
          latest = at;
        };
        const query: Transaction["query"] = async <Row>(
          sql: string,
          values: readonly unknown[],
        ) => {
          check();
          try {
            const result = await queryOriginal<Row>(sql, values);
            check();
            return result;
          } catch (error) {
            poisoned = true;
            throw error;
          }
        };
        const hold = async () => {
          check();
          const observedAt = now();
          const proof =
            editCommand && editing
              ? await editing.hold(tx, {
                  tenantReference: tenant,
                  brandReference: brand,
                  actorReference: actor,
                  actorKind: "User",
                  permission: "catalog.manage",
                  action: "catalog.option_set.update",
                  purposeCode: "CATALOG_OPTION_SET_DRAFT",
                  requiredFields: Object.freeze([
                    "internalCode",
                    "aggregateVersion",
                    "archiveOptionReferences",
                    ...fields,
                  ]),
                  phase,
                  proposedCommand: parseFullOptionSetEditCommand(editCommand),
                  originalContent:
                    originalContent === null
                      ? null
                      : (copyCategoryPersistenceValue(originalContent) as OptionSetEditorContent),
                  proposedContent:
                    proposedContent === null
                      ? null
                      : (copyCategoryPersistenceValue(proposedContent) as OptionSetEditorContent),
                  observedAt,
                })
              : draft === undefined
                ? fail()
                : await admission(tx, {
                    tenantReference: tenant,
                    brandReference: brand,
                    actorReference: actor,
                    actorKind: "User",
                    permission: "catalog.manage",
                    action: "catalog.option_set.update",
                    purposeCode: "CATALOG_OPTION_SET_DRAFT",
                    requiredFields: fields,
                    optionSetReference: set,
                    proposedDraft: draft,
                    additionalContent: copyCategoryPersistenceValue(additional),
                    observedAt,
                  });
          const evidence = closed(copyCategoryPersistenceValue(proof), [
              "observedAt",
              "validUntil",
            ]),
            until = parseCatalogInstant(evidence.validUntil);
          if (
            evidence.observedAt !== observedAt ||
            until <= observedAt ||
            Date.parse(until) - Date.parse(observedAt) > 30000
          )
            return fail();
          deadline = Math.min(deadline, Date.parse(until));
          check();
        };
        try {
          if (editing && editCommand) {
            const returned: unknown = await editing.register(
              tx,
              async () => {
                try {
                  guardCalls++;
                  if (pending || guardCalls !== 1) return fail();
                  check();
                  await hold();
                  check();
                  guardComplete = true;
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
              () => {
                if (pending || guardCalls !== 1 || !guardComplete) {
                  poisoned = true;
                  return fail();
                }
                check();
                closedHost = true;
              },
            );
            if (returned !== undefined) return fail();
          }
          const baseline = async () => {
            const read = await query<OriginalRow>(
              `SELECT f.snapshot_json snapshot,f.source_digest,f.content_digest,f.configuration_digest,o.intent_digest,
              (f.tenant_id=$1 AND f.brand_id=o.brand_id AND f.option_set_id=o.option_set_id AND f.action_code=o.action_code AND f.intent_digest=o.intent_digest AND f.result_aggregate_version=o.result_aggregate_version AND f.occurred_at=o.occurred_at AND f.data_classification='ConfigurationMetadata' AND s.aggregate_version>=f.result_aggregate_version AND f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code AND f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text AND f.snapshot_json#>>'{sourceAggregate,createdAt}'=to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) coherent
              FROM rms_catalog.option_set_draft_content_snapshot f JOIN rms_catalog.option_set_operation_record o ON o.operation_id=f.operation_id JOIN rms_catalog.option_set s ON s.option_set_id=f.option_set_id AND s.brand_id=f.brand_id WHERE f.tenant_id=$1 AND f.brand_id=$2 AND f.option_set_id=$3 AND f.result_aggregate_version=$4`,
              [tenant, brand, set, expected],
            );
            const row = read.rows[0];
            if (read.rows.length !== 1 || !row || row.coherent !== true) return fail();
            const body = closed(copyCategoryPersistenceValue(row.snapshot), [
                "profile",
                "sourceAggregate",
                "optionDetails",
                "conditionalRules",
                "conflictRules",
                "scopeSet",
                "effectivePeriod",
              ]),
              { sourceAggregate, ...additional } = body;
            const prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
            if (
              prepared.content.sourceAggregate.optionSetReference !== set ||
              prepared.content.sourceAggregate.brandReference !== brand ||
              prepared.content.sourceAggregate.aggregateVersion !== expected ||
              prepared.sourceDigest !== row.source_digest ||
              prepared.contentDigest !== row.content_digest ||
              prepared.configurationDigest !== row.configuration_digest
            )
              return fail();
            return prepared.content;
          };
          await hold();
          await requireCategoryCurrentReads(tx);
          if (at > now()) return fail();
          await query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenant, brand],
          );
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionOperation:" + operation,
          ]);
          const original = await query<OriginalRow>(
            `SELECT f.snapshot_json snapshot,f.source_digest,f.content_digest,f.configuration_digest,o.intent_digest,
           (f.operation_id IS NOT NULL AND o.action_code='ReplaceDraft' AND o.result_aggregate_version=$4+1 AND o.occurred_at=$5::timestamptz AND f.tenant_id=$1 AND f.action_code=o.action_code AND f.intent_digest=o.intent_digest AND f.result_aggregate_version=o.result_aggregate_version AND f.occurred_at=o.occurred_at AND f.option_set_id=o.option_set_id AND f.brand_id=o.brand_id AND f.data_classification='ConfigurationMetadata' AND s.aggregate_version>=o.result_aggregate_version AND f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code AND f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text AND date_trunc('milliseconds',s.created_at)=s.created_at AND f.snapshot_json#>>'{sourceAggregate,createdAt}'=to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) coherent
           FROM rms_catalog.option_set_operation_record o JOIN rms_catalog.option_set s ON s.option_set_id=o.option_set_id AND s.brand_id=o.brand_id LEFT JOIN rms_catalog.option_set_draft_content_snapshot f ON f.operation_id=o.operation_id
           WHERE o.operation_id=$3 AND o.brand_id=$2`,
            [tenant, brand, operation, expected, at],
          );
          if (original.rows.length > 1) return fail();
          const stored = original.rows[0];
          if (stored) {
            if (stored.intent_digest !== intent) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            if (stored.coherent !== true || stored.snapshot === null) return fail();
            const s = closed(copyCategoryPersistenceValue(stored.snapshot), [
                "profile",
                "sourceAggregate",
                "optionDetails",
                "conditionalRules",
                "conflictRules",
                "scopeSet",
                "effectivePeriod",
              ]),
              { sourceAggregate, ...details } = s,
              recovered = parseCatalogOptionSetEditorContent(sourceAggregate, details);
            if (
              stored.coherent !== true ||
              recovered.content.sourceAggregate.optionSetReference !== set ||
              recovered.content.sourceAggregate.brandReference !== brand ||
              recovered.content.sourceAggregate.aggregateVersion !== (expected as number) + 1 ||
              recovered.content.sourceAggregate.updatedAt !== at ||
              recovered.sourceDigest !== stored.source_digest ||
              recovered.contentDigest !== stored.content_digest ||
              recovered.configurationDigest !== stored.configuration_digest
            )
              return fail();
            if (editCommand) {
              await requireOriginalOptionSetAuthoringIdentity(
                { query },
                { tenantReference: tenant, brandReference: brand, actorReference: actor },
                { action: "Edit", command: editCommand },
                recovered.content,
              );
              originalContent = await baseline();
              const allocation = editCommand.draft.options
                .filter((option) => option.identity.kind === "New")
                .map((option) => {
                  const original = recovered.content.sourceAggregate.draft.options.find(
                    (candidate) => candidate.stableCode === option.stableCode,
                  );
                  if (
                    !original ||
                    original.createdAt !== at ||
                    original.createdByActorReference !== actor
                  )
                    return fail();
                  return {
                    stableCode: option.stableCode,
                    optionReference: String(original.optionReference),
                  };
                });
              const requested = materializeFullOptionSetEdit(editCommand, originalContent, {
                actorReference: actor,
                newOptions: allocation,
              });
              if (canonicalizeRfc8785(requested.content) !== canonicalizeRfc8785(recovered.content))
                return fail();
              proposedContent = recovered.content;
              phase = "Replay";
            } else {
              if (
                !draft ||
                canonicalizeRfc8785(recovered.content.sourceAggregate.draft) !==
                  canonicalizeRfc8785(draft)
              )
                return fail();
              const requestedOriginal = parseCatalogOptionSetEditorContent(
                recovered.content.sourceAggregate,
                additional,
              );
              if (
                canonicalizeRfc8785(requestedOriginal.content) !==
                canonicalizeRfc8785(recovered.content)
              )
                return fail();
            }
            await hold();
            if (Date.parse(now()) >= deadline) return fail();
            return Object.freeze({
              status: "Replayed" as const,
              content: recovered.content,
              operationReference: operation,
              contentDigest: recovered.contentDigest,
              configurationDigest: recovered.configurationDigest,
              referenceEligibility: "NotEvaluated" as const,
            });
          }
          if (editCommand) await requireOptionSetAuthoringOperationAvailable({ query }, operation);
          if (at > now() || Date.parse(now()) - Date.parse(at) >= 30000) return fail();
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionSource:" + brand + ":" + set,
          ]);
          const root = await query(
            "SELECT option_set_id FROM rms_catalog.option_set WHERE option_set_id=$1 AND brand_id=$2 FOR UPDATE",
            [set, brand],
          );
          if (root.rows.length !== 1) return fail("CATALOG_UNAVAILABLE");
          await query(
            "SELECT option_set_version_id FROM rms_catalog.option_set_version WHERE option_set_id=$1 AND brand_id=$2 AND status='Draft' FOR UPDATE",
            [set, brand],
          );
          const counts = await query<{ n: string; conflicts: string }>(
            "SELECT (SELECT count(*)::text FROM rms_catalog.option WHERE option_set_id=$1 AND brand_id=$2) n,(SELECT count(*)::text FROM rms_catalog.option_conflict WHERE option_set_id=$1 AND brand_id=$2) conflicts",
            [set, brand],
          );
          if (
            counts.rows.length !== 1 ||
            !/^(0|[1-9][0-9]*)$/.test(counts.rows[0]?.n ?? "") ||
            !/^(0|[1-9][0-9]*)$/.test(counts.rows[0]?.conflicts ?? "") ||
            BigInt(counts.rows[0]?.n ?? "101") > 100n ||
            BigInt(counts.rows[0]?.conflicts ?? "10001") > 10000n
          )
            return fail();
          await query(
            "SELECT option_id FROM rms_catalog.option WHERE option_set_id=$1 AND brand_id=$2 ORDER BY option_id FOR UPDATE",
            [set, brand],
          );
          await query(
            "SELECT option_id FROM rms_catalog.option_conflict WHERE option_set_id=$1 AND brand_id=$2 ORDER BY option_id,conflict_option_id FOR UPDATE",
            [set, brand],
          );
          const read = await query<CurrentRow>(currentSql, [set, brand]),
            row = read.rows[0];
          if (read.rows.length !== 1 || row?.coherent !== true) return fail();
          const current = parseOptionSetAggregate(copyCategoryPersistenceValue(row.aggregate));
          if (current.lifecycle !== "Draft") return fail("CATALOG_LIFECYCLE_CONFLICT");
          if (current.aggregateVersion !== expected) return fail("CATALOG_VERSION_CONFLICT");
          const newReferences = new Set<string>();
          if (editCommand && editing) {
            originalContent = await baseline();
            const original = parseCatalogOptionSetEditorContent(current, row.details);
            if (canonicalizeRfc8785(original.content) !== canonicalizeRfc8785(originalContent))
              return fail();
            const allocations = editCommand.draft.options
              .filter((option) => option.identity.kind === "New")
              .map((option) => ({
                stableCode: option.stableCode,
                optionReference: parseCatalogReference(editing.allocate()),
              }));
            const proposal = materializeFullOptionSetEdit(editCommand, originalContent, {
              actorReference: actor,
              newOptions: allocations,
            });
            proposedContent = proposal.content;
            draft = proposal.content.sourceAggregate.draft;
            const { sourceAggregate, ...details } = proposal.content;
            void sourceAggregate;
            additional = details;
            for (const allocation of allocations) newReferences.add(allocation.optionReference);
            phase = "Apply";
            await hold();
          }
          if (!draft) return fail();
          if (
            current.updatedAt > at ||
            current.draft.versionReference !== draft.versionReference ||
            current.draft.createdAt !== draft.createdAt ||
            (!editMode && current.draft.options.length !== draft.options.length) ||
            new Set(draft.options.map((o) => o.optionReference)).size !== draft.options.length
          )
            return fail("CATALOG_INPUT_INVALID");
          for (const option of draft.options) {
            const prior = current.draft.options.find(
              (o) => o.optionReference === option.optionReference,
            );
            if (editMode && !prior && newReferences.has(option.optionReference)) continue;
            if (
              !prior ||
              prior.stableCode !== option.stableCode ||
              prior.createdAt !== option.createdAt ||
              prior.createdByActorReference !== option.createdByActorReference
            )
              return fail("CATALOG_INPUT_INVALID");
          }
          const prepared = parseCatalogOptionSetEditorContent(
            { ...current, aggregateVersion: (expected as number) + 1, draft, updatedAt: at },
            additional,
          );
          const audit = validateAuditRecord(
            copyCategoryPersistenceValue(
              auditFor({
                operationReference: operation,
                reasonCode: reason,
                occurredAt: at,
                result: prepared.content,
              }),
            ),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type !== "User" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_OPTION_SET_REPLACEDRAFT" ||
            audit.targetType !== "CatalogOptionSet" ||
            audit.targetId !== set ||
            audit.reasonCode !== reason ||
            audit.occurredAt !== at ||
            audit.correlationId !== operation ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();
          const cas = await query(
            "UPDATE rms_catalog.option_set SET aggregate_version=aggregate_version+1,updated_at=$4 WHERE option_set_id=$1 AND brand_id=$2 AND aggregate_version=$3 AND lifecycle='Draft'",
            [set, brand, expected, at],
          );
          if (cas.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          const version = await query(
            "UPDATE rms_catalog.option_set_version SET default_locale=$4,localized_names_json=$5::jsonb,localized_descriptions_json=$6::jsonb,display_style=$7,minimum_selection=$8,maximum_selection=$9,allow_repeated_option=$10,per_option_maximum_quantity=$11,maximum_total_quantity=$12,updated_at=$13,editor_content_json=$14::jsonb WHERE option_set_id=$1 AND brand_id=$2 AND option_set_version_id=$3 AND status='Draft'",
            [
              set,
              brand,
              draft.versionReference,
              draft.defaultLocale,
              canonicalizeRfc8785(draft.localizedNames),
              canonicalizeRfc8785(draft.localizedDescriptions),
              draft.displayStyle,
              draft.minimumSelection,
              draft.maximumSelection,
              draft.allowRepeatedOption,
              draft.perOptionMaximumQuantity,
              draft.maximumTotalQuantity,
              at,
              canonicalizeRfc8785(additional),
            ],
          );
          if (version.rowCount !== 1) return fail();
          // Free slots disjoint from both old and final orders avoid immediate
          // UNIQUE conflicts without integer overflow or weakening identity rules.
          const used = new Set(
            [...current.draft.options, ...draft.options].map((o) => o.sortOrder),
          );
          let slot = 0;
          for (const option of current.draft.options) {
            while (used.has(slot)) slot++;
            const shifted = await query(
              "UPDATE rms_catalog.option SET sort_order=$4 WHERE option_id=$1 AND option_set_id=$2 AND brand_id=$3",
              [option.optionReference, set, brand, slot],
            );
            if (shifted.rowCount !== 1) return fail();
            used.add(slot++);
          }
          for (const option of draft.options) {
            if (newReferences.has(option.optionReference)) {
              const inserted = await query(
                "INSERT INTO rms_catalog.option(option_id,option_set_id,option_set_version_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,triggered_option_set_id,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)",
                [
                  option.optionReference,
                  set,
                  draft.versionReference,
                  brand,
                  option.stableCode,
                  option.lifecycle,
                  canonicalizeRfc8785(option.localizedNames),
                  canonicalizeRfc8785(option.localizedDescriptions),
                  option.sortOrder,
                  option.defaultEligible,
                  option.triggeredOptionSetReference,
                  option.createdAt,
                  option.createdByActorReference,
                ],
              );
              if (inserted.rowCount !== 1) return fail();
              continue;
            }
            const updated = await query(
              "UPDATE rms_catalog.option SET lifecycle=$4,localized_names_json=$5::jsonb,localized_descriptions_json=$6::jsonb,sort_order=$7,default_eligible=$8,triggered_option_set_id=$9 WHERE option_id=$1 AND option_set_id=$2 AND brand_id=$3",
              [
                option.optionReference,
                set,
                brand,
                option.lifecycle,
                canonicalizeRfc8785(option.localizedNames),
                canonicalizeRfc8785(option.localizedDescriptions),
                option.sortOrder,
                option.defaultEligible,
                option.triggeredOptionSetReference,
              ],
            );
            if (updated.rowCount !== 1) return fail();
          }
          await query(
            "DELETE FROM rms_catalog.option_conflict WHERE option_set_id=$1 AND brand_id=$2",
            [set, brand],
          );
          for (const option of draft.options)
            for (const conflict of option.conflictOptionReferences) {
              const inserted = await query(
                "INSERT INTO rms_catalog.option_conflict(option_id,conflict_option_id,option_set_id,brand_id) VALUES($1,$2,$3,$4)",
                [option.optionReference, conflict, set, brand],
              );
              if (inserted.rowCount !== 1) return fail();
            }
          const saved = await query<CurrentRow>(currentSql, [set, brand]),
            savedRow = saved.rows[0];
          if (saved.rows.length !== 1 || savedRow?.coherent !== true) return fail();
          const verified = parseCatalogOptionSetEditorContent(savedRow.aggregate, savedRow.details);
          if (
            verified.sourceDigest !== prepared.sourceDigest ||
            verified.contentDigest !== prepared.contentDigest ||
            verified.configurationDigest !== prepared.configurationDigest ||
            canonicalizeRfc8785(verified.content) !== canonicalizeRfc8785(prepared.content)
          )
            return fail();
          const op = await query(
            "INSERT INTO rms_catalog.option_set_operation_record(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'ReplaceDraft',$4,$5,$6)",
            [operation, brand, set, intent, (expected as number) + 1, at],
          );
          if (op.rowCount !== 1) return fail();
          const snapshot = await query(
            "INSERT INTO rms_catalog.option_set_draft_content_snapshot(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at,source_digest,content_digest,configuration_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,'ReplaceDraft',$6,$7,$8,$9,$10,$11,$12::jsonb)",
            [
              operation,
              tenant,
              brand,
              set,
              draft.versionReference,
              intent,
              (expected as number) + 1,
              at,
              prepared.sourceDigest,
              prepared.contentDigest,
              prepared.configurationDigest,
              canonicalizeRfc8785(prepared.content),
            ],
          );
          if (snapshot.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction({ query }, audit);
          if (editCommand)
            await appendOptionSetAuthoringIdentity(
              { query },
              { tenantReference: tenant, brandReference: brand, actorReference: actor },
              { action: "Edit", command: editCommand },
              prepared.content,
              audit,
            );
          const envelope: DomainEventEnvelope = {
            eventId: parseCatalogReference(eventFor()),
            eventType: "OptionSetDraftReplaced",
            schemaVersion: 1,
            occurredAt: at,
            producerModule: "@rms/catalog",
            tenantId: brand,
            aggregateType: "CatalogOptionSet",
            aggregateId: set,
            aggregateVersion: BigInt((expected as number) + 1),
            correlationId: operation,
            actor: { type: "Actor", actorId: actor },
            payload: {
              tenantReference: tenant,
              optionSetReference: set,
              versionReference: draft.versionReference,
              aggregateVersion: (expected as number) + 1,
              operationReference: operation,
              contentDigest: prepared.contentDigest,
              configurationDigest: prepared.configurationDigest,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: {
              operationReference: operation,
              aggregateVersion: (expected as number) + 1,
            },
          };
          await appendEventInTransaction(
            {
              query: async (sql, values) => {
                const r = await query(sql, values);
                return { rowCount: r.rowCount ?? null };
              },
            },
            envelope,
          );
          await hold();
          if (
            invocations !== 1 ||
            Date.parse(now()) >= deadline ||
            at > now() ||
            Date.parse(now()) - Date.parse(at) >= 30000
          )
            return fail();
          return Object.freeze({
            status: "Applied" as const,
            content: prepared.content,
            operationReference: operation,
            contentDigest: prepared.contentDigest,
            configurationDigest: prepared.configurationDigest,
            referenceEligibility: "NotEvaluated" as const,
          });
        } catch (error) {
          poisoned = true;
          throw error;
        } finally {
          pending = false;
        }
      });
      if (invocations !== 1) return fail();
      return result;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  }
  return Object.freeze({
    async create(value: unknown) {
      const command = parseFullOptionSetCreateCommand(value),
        creation = creationPorts;
      if (typeof creation?.hold !== "function" || typeof creation?.generate !== "function")
        return fail();
      const holdCreation = creation.hold,
        allocateCreation = creation.generate;
      const operation = command.operationReference,
        at = command.occurredAt,
        reason = command.reasonCode;
      const intent = hash({
        profile: "CatalogFullOptionSetCreateV1",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        command,
      });
      let invocations = 0;
      try {
        const result = await run(async (tx) => {
          if (++invocations !== 1) return fail();
          let deadline = Infinity,
            target: string | null = null,
            poisoned = false,
            latest = now();
          const queryReference = tx.query,
            queryOriginal = queryReference.bind(tx);
          const check = () => {
            const at = now();
            if (
              poisoned ||
              at < latest ||
              Object.getOwnPropertyDescriptor(tx, "query")?.value !== queryReference ||
              Date.parse(at) >= deadline
            ) {
              poisoned = true;
              return fail();
            }
            latest = at;
          };
          const query: Transaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            try {
              const result = await queryOriginal<Row>(sql, values);
              check();
              return result;
            } catch (error) {
              poisoned = true;
              throw error;
            }
          };
          const hold = async () => {
            check();
            const observedAt = now();
            const evidence = closed(
              copyCategoryPersistenceValue(
                await holdCreation(tx, {
                  tenantReference: tenant,
                  brandReference: brand,
                  actorReference: actor,
                  actorKind: "User",
                  permission: "catalog.manage",
                  action: "catalog.option_set.create",
                  purposeCode: "CATALOG_OPTION_SET_DRAFT",
                  requiredFields: Object.freeze(["internalCode", ...fields]),
                  optionSetReference: target,
                  proposedCommand: copyCategoryPersistenceValue(command),
                  observedAt,
                }),
              ),
              ["observedAt", "validUntil"],
            );
            const until = parseCatalogInstant(evidence.validUntil);
            if (
              evidence.observedAt !== observedAt ||
              until <= observedAt ||
              Date.parse(until) - Date.parse(observedAt) > 30000
            )
              return fail();
            deadline = Math.min(deadline, Date.parse(until));
            check();
          };
          await hold();
          await requireCategoryCurrentReads(tx);
          if (at > now()) return fail();
          await query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenant, brand],
          );
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionOperation:" + operation,
          ]);
          const original = await query<OriginalRow>(
            `SELECT f.snapshot_json snapshot,f.source_digest,f.content_digest,f.configuration_digest,o.intent_digest,
            (f.operation_id IS NOT NULL AND o.action_code='Create' AND o.result_aggregate_version=1 AND o.occurred_at=$4::timestamptz
             AND f.tenant_id=$1 AND f.action_code=o.action_code AND f.intent_digest=o.intent_digest AND f.result_aggregate_version=o.result_aggregate_version
             AND f.occurred_at=o.occurred_at AND f.option_set_id=o.option_set_id AND f.brand_id=o.brand_id AND f.data_classification='ConfigurationMetadata'
             AND s.aggregate_version>=1 AND f.snapshot_json#>>'{sourceAggregate,optionSetReference}'=s.option_set_id::text
             AND f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code AND s.internal_code=$5
             AND f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text AND s.created_by_actor_id=$6
             AND s.created_at=$4::timestamptz AND date_trunc('milliseconds',s.created_at)=s.created_at
             AND f.snapshot_json#>>'{sourceAggregate,createdAt}'=to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) coherent
            FROM rms_catalog.option_set_operation_record o JOIN rms_catalog.option_set s ON s.option_set_id=o.option_set_id AND s.brand_id=o.brand_id
            LEFT JOIN rms_catalog.option_set_draft_content_snapshot f ON f.operation_id=o.operation_id WHERE o.operation_id=$3 AND o.brand_id=$2`,
            [tenant, brand, operation, at, command.internalCode, actor],
          );
          if (original.rows.length > 1) return fail();
          const stored = original.rows[0];
          if (stored) {
            if (stored.intent_digest !== intent) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            if (stored.coherent !== true || stored.snapshot === null) return fail();
            const recover = () => {
              try {
                const s = closed(copyCategoryPersistenceValue(stored.snapshot), [
                    "profile",
                    "sourceAggregate",
                    "optionDetails",
                    "conditionalRules",
                    "conflictRules",
                    "scopeSet",
                    "effectivePeriod",
                  ]),
                  { sourceAggregate, ...details } = s,
                  recovered = parseCatalogOptionSetEditorContent(sourceAggregate, details),
                  root = recovered.content.sourceAggregate;
                const requested = materializeFullOptionSetCreation(command, {
                  brandReference: brand,
                  actorReference: actor,
                  allocations: {
                    optionSetReference: root.optionSetReference,
                    versionReference: root.draft.versionReference,
                    options: root.draft.options.map((o) => ({
                      stableCode: o.stableCode,
                      optionReference: o.optionReference,
                    })),
                  },
                });
                if (
                  root.aggregateVersion !== 1 ||
                  root.updatedAt !== at ||
                  root.brandReference !== brand ||
                  recovered.sourceDigest !== stored.source_digest ||
                  recovered.contentDigest !== stored.content_digest ||
                  recovered.configurationDigest !== stored.configuration_digest ||
                  canonicalizeRfc8785(recovered.content) !== canonicalizeRfc8785(requested.content)
                )
                  return fail();
                return recovered;
              } catch {
                return fail();
              }
            };
            const recovered = recover(),
              root = recovered.content.sourceAggregate;
            await requireOriginalOptionSetAuthoringIdentity(
              { query },
              { tenantReference: tenant, brandReference: brand, actorReference: actor },
              { action: "Create", command },
              recovered.content,
            );
            target = root.optionSetReference;
            await hold();
            if (Date.parse(now()) >= deadline) return fail();
            return Object.freeze({
              status: "Replayed" as const,
              content: recovered.content,
              operationReference: operation,
              contentDigest: recovered.contentDigest,
              configurationDigest: recovered.configurationDigest,
              referenceEligibility: "NotEvaluated" as const,
            });
          }
          await requireOptionSetAuthoringOperationAvailable({ query }, operation);
          if (Date.parse(now()) - Date.parse(at) >= 30000) return fail();
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionCode:" + brand + ":" + command.internalCode,
          ]);
          const collision = await query(
            "SELECT option_set_id FROM rms_catalog.option_set WHERE brand_id=$1 AND internal_code=$2 FOR UPDATE",
            [brand, command.internalCode],
          );
          if (collision.rows.length) return fail("CATALOG_CODE_CONFLICT");
          const prepared = materializeFullOptionSetCreation(command, {
              brandReference: brand,
              actorReference: actor,
              allocations: {
                optionSetReference: allocateCreation("OptionSet"),
                versionReference: allocateCreation("OptionSetVersion"),
                options: command.draft.options.map((o) => ({
                  stableCode: o.stableCode,
                  optionReference: allocateCreation("Option"),
                })),
              },
            }),
            source = prepared.content.sourceAggregate,
            set = source.optionSetReference,
            draft = source.draft;
          target = set;
          await hold();
          const audit = validateAuditRecord(
            copyCategoryPersistenceValue(
              auditFor({
                operationReference: operation,
                reasonCode: reason,
                occurredAt: at,
                result: prepared.content,
              }),
            ),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type !== "User" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_OPTION_SET_CREATE" ||
            audit.targetType !== "CatalogOptionSet" ||
            audit.targetId !== set ||
            audit.reasonCode !== reason ||
            audit.occurredAt !== at ||
            audit.correlationId !== operation ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();

          const root = await query(
            "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'Draft',1,$4,$5,$4)",
            [set, brand, command.internalCode, at, actor],
          );
          if (root.rowCount !== 1) return fail();
          const additional = {
            profile: prepared.content.profile,
            optionDetails: prepared.content.optionDetails,
            conditionalRules: prepared.content.conditionalRules,
            conflictRules: prepared.content.conflictRules,
            scopeSet: prepared.content.scopeSet,
            effectivePeriod: prepared.content.effectivePeriod,
          };
          const version = await query(
            "INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at,editor_content_json) VALUES($1,$2,$3,'Draft',$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$13,$14::jsonb)",
            [
              draft.versionReference,
              set,
              brand,
              draft.defaultLocale,
              canonicalizeRfc8785(draft.localizedNames),
              canonicalizeRfc8785(draft.localizedDescriptions),
              draft.displayStyle,
              draft.minimumSelection,
              draft.maximumSelection,
              draft.allowRepeatedOption,
              draft.perOptionMaximumQuantity,
              draft.maximumTotalQuantity,
              at,
              canonicalizeRfc8785(additional),
            ],
          );
          if (version.rowCount !== 1) return fail();
          for (const o of draft.options) {
            const row = await query(
              "INSERT INTO rms_catalog.option(option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,triggered_option_set_id,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)",
              [
                o.optionReference,
                draft.versionReference,
                set,
                brand,
                o.stableCode,
                o.lifecycle,
                canonicalizeRfc8785(o.localizedNames),
                canonicalizeRfc8785(o.localizedDescriptions),
                o.sortOrder,
                o.defaultEligible,
                o.triggeredOptionSetReference,
                at,
                actor,
              ],
            );
            if (row.rowCount !== 1) return fail();
          }
          for (const o of draft.options)
            for (const c of o.conflictOptionReferences) {
              const row = await query(
                "INSERT INTO rms_catalog.option_conflict(option_id,conflict_option_id,option_set_id,brand_id) VALUES($1,$2,$3,$4)",
                [o.optionReference, c, set, brand],
              );
              if (row.rowCount !== 1) return fail();
            }
          const saved = await query<CurrentRow>(currentSql, [set, brand]),
            row = saved.rows[0];
          if (saved.rows.length !== 1 || row?.coherent !== true) return fail();
          const verified = parseCatalogOptionSetEditorContent(row.aggregate, row.details);
          if (
            verified.sourceDigest !== prepared.sourceDigest ||
            verified.contentDigest !== prepared.contentDigest ||
            verified.configurationDigest !== prepared.configurationDigest ||
            canonicalizeRfc8785(verified.content) !== canonicalizeRfc8785(prepared.content)
          )
            return fail();
          const op = await query(
            "INSERT INTO rms_catalog.option_set_operation_record(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'Create',$4,1,$5)",
            [operation, brand, set, intent, at],
          );
          if (op.rowCount !== 1) return fail();
          const snapshot = await query(
            "INSERT INTO rms_catalog.option_set_draft_content_snapshot(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at,source_digest,content_digest,configuration_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,'Create',$6,1,$7,$8,$9,$10,$11::jsonb)",
            [
              operation,
              tenant,
              brand,
              set,
              draft.versionReference,
              intent,
              at,
              prepared.sourceDigest,
              prepared.contentDigest,
              prepared.configurationDigest,
              canonicalizeRfc8785(prepared.content),
            ],
          );
          if (snapshot.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction({ query }, audit);
          await appendOptionSetAuthoringIdentity(
            { query },
            { tenantReference: tenant, brandReference: brand, actorReference: actor },
            { action: "Create", command },
            prepared.content,
            audit,
          );
          const envelope: DomainEventEnvelope = {
            eventId: parseCatalogReference(eventFor()),
            eventType: "OptionSetDraftCreated",
            schemaVersion: 1,
            occurredAt: at,
            producerModule: "@rms/catalog",
            tenantId: brand,
            aggregateType: "CatalogOptionSet",
            aggregateId: set,
            aggregateVersion: BigInt(1),
            correlationId: operation,
            actor: { type: "Actor", actorId: actor },
            payload: {
              tenantReference: tenant,
              optionSetReference: set,
              versionReference: draft.versionReference,
              aggregateVersion: 1,
              operationReference: operation,
              contentDigest: prepared.contentDigest,
              configurationDigest: prepared.configurationDigest,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: {
              operationReference: operation,
              aggregateVersion: 1,
            },
          };
          await appendEventInTransaction(
            {
              query: async (sql, values) => {
                const r = await query(sql, values);
                return { rowCount: r.rowCount ?? null };
              },
            },
            envelope,
          );

          await hold();
          if (
            invocations !== 1 ||
            Date.parse(now()) >= deadline ||
            at > now() ||
            Date.parse(now()) - Date.parse(at) >= 30000
          )
            return fail();
          return Object.freeze({
            status: "Applied" as const,
            content: prepared.content,
            operationReference: operation,
            contentDigest: prepared.contentDigest,
            configurationDigest: prepared.configurationDigest,
            referenceEligibility: "NotEvaluated" as const,
          });
        });
        if (invocations !== 1) return fail();
        return result;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        // A concurrent writer outside our code advisory lock may win this exact
        // owning unique constraint. Other allocator/SQL failures stay unavailable.
        if (
          error &&
          typeof error === "object" &&
          Object.getOwnPropertyDescriptor(error, "code")?.value === "23505" &&
          Object.getOwnPropertyDescriptor(error, "constraint")?.value ===
            "option_set_brand_code_unique"
        )
          return fail("CATALOG_CODE_CONFLICT");
        return fail();
      }
    },
    replace: (value: unknown) => write(value, false),
    edit: (value: unknown) => write(value, true),
  });
}

/** Canonical complete current read fields; provenance remains a separate
 * authorized owner read and is never supplied by a caller. */
export const currentFullOptionSetDraftFields = Object.freeze([
  "internalCode",
  "brandReference",
  "lifecycle",
  "aggregateVersion",
  "createdAt",
  "createdByActorReference",
  "updatedAt",
  ...fields,
] as const);
export const currentFullOptionSetDraftReviewFields = Object.freeze([
  ...currentFullOptionSetDraftFields,
  "sourceOperationReference",
  "sourceSnapshotTuple",
] as const);
export interface CurrentFullOptionSetDraftAuthority {
  /** Real active Brand/User/read action/purpose/all fields held through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.read";
      readonly purposeCode: "CATALOG_OPTION_SET_DRAFT";
      readonly requiredFields: readonly string[];
      readonly optionSetReference: string;
      readonly content: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
/** Current editable full Draft only. PostgreSQL SHARE row locks need an owning
 * read-write transaction/UPDATE lock privileges, but this factory writes no facts. */
interface CurrentFullOptionSetDraftStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CurrentFullOptionSetDraftAuthority;
}
export function createPostgresCurrentFullOptionSetDraftStore(
  options: CurrentFullOptionSetDraftStoreOptions,
) {
  return createCurrentFullOptionSetDraftStoreKernel(options);
}
function createCurrentFullOptionSetDraftStoreKernel(
  options: CurrentFullOptionSetDraftStoreOptions,
  originalValidUntil?: string,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = () => parseCatalogInstant(options.clock.now());
  async function readCurrentKernel(value: unknown, forReview: boolean) {
    const r = closed(copyCategoryPersistenceValue(value), [
        "optionSetReference",
        "expectedAggregateVersion",
      ]),
      set = parseCatalogReference(r.optionSetReference),
      expected = r.expectedAggregateVersion;
    if (
      expected !== null &&
      (!Number.isSafeInteger(expected) ||
        (expected as number) < 1 ||
        (expected as number) > 2147483647)
    )
      return fail("CATALOG_INPUT_INVALID");
    let invocations = 0;
    try {
      const result = await options.transactions.run(async (tx) => {
        if (++invocations !== 1) return fail();
        const observedAt = now();
        let deadline = Math.min(
          Date.parse(observedAt) + 30000,
          originalValidUntil === undefined
            ? Infinity
            : Date.parse(parseCatalogInstant(originalValidUntil)),
        );
        const check = () => {
          const current = now();
          if (current < observedAt || Date.parse(current) >= deadline) return fail();
        };
        const queryCurrent = async <Row>(sql: string, values: readonly unknown[] = []) => {
          if (originalValidUntil !== undefined) {
            check();
            const remaining = Math.max(1, Math.min(5000, deadline - Date.parse(now())));
            await tx.query(
              "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
              [String(remaining)],
            );
            check();
          }
          return tx.query<Row>(sql, values);
        };
        const hold = async (content: unknown) => {
          const observation = now();
          if (observation < observedAt) return fail();
          const evidence = closed(
              copyCategoryPersistenceValue(
                await options.authority.holdUntilTransactionCompletes(tx, {
                  tenantReference: tenant,
                  brandReference: brand,
                  actorReference: actor,
                  actorKind: "User",
                  permission: "catalog.manage",
                  action: "catalog.option_set.read",
                  purposeCode: "CATALOG_OPTION_SET_DRAFT",
                  requiredFields: forReview
                    ? currentFullOptionSetDraftReviewFields
                    : currentFullOptionSetDraftFields,
                  optionSetReference: set,
                  content: copyCategoryPersistenceValue(content),
                  observedAt: observation,
                }),
              ),
              ["observedAt", "validUntil"],
            ),
            until = parseCatalogInstant(evidence.validUntil);
          if (
            evidence.observedAt !== observation ||
            until <= observation ||
            Date.parse(until) - Date.parse(observation) > 30000
          )
            return fail();
          deadline = Math.min(deadline, Date.parse(until));
          check();
        };
        await hold(null);
        await requireCategoryCurrentReads(tx);
        if (originalValidUntil === undefined) {
          await queryCurrent(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenant, brand],
          );
        } else {
          check();
          await queryCurrent(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
        }
        await queryCurrent("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          "CatalogFullOptionSource:" + brand + ":" + set,
        ]);
        const root = await queryCurrent(
          "SELECT option_set_id FROM rms_catalog.option_set WHERE option_set_id=$1 AND brand_id=$2 FOR SHARE",
          [set, brand],
        );
        if (root.rows.length !== 1) return fail("CATALOG_UNAVAILABLE");
        const version = await queryCurrent(
          "SELECT option_set_version_id FROM rms_catalog.option_set_version WHERE option_set_id=$1 AND brand_id=$2 AND status='Draft' FOR SHARE",
          [set, brand],
        );
        if (version.rows.length !== 1) return fail();
        const counts = await queryCurrent<{ n: string; conflicts: string }>(
          "SELECT (SELECT count(*)::text FROM rms_catalog.option WHERE option_set_id=$1 AND brand_id=$2) n,(SELECT count(*)::text FROM rms_catalog.option_conflict WHERE option_set_id=$1 AND brand_id=$2) conflicts",
          [set, brand],
        );
        if (
          counts.rows.length !== 1 ||
          !/^(0|[1-9][0-9]*)$/.test(counts.rows[0]?.n ?? "") ||
          !/^(0|[1-9][0-9]*)$/.test(counts.rows[0]?.conflicts ?? "") ||
          BigInt(counts.rows[0]?.n ?? "101") > 100n ||
          BigInt(counts.rows[0]?.conflicts ?? "10001") > 10000n
        )
          return fail();
        await queryCurrent(
          "SELECT option_id FROM rms_catalog.option WHERE option_set_id=$1 AND brand_id=$2 ORDER BY option_id FOR SHARE",
          [set, brand],
        );
        await queryCurrent(
          "SELECT option_id FROM rms_catalog.option_conflict WHERE option_set_id=$1 AND brand_id=$2 ORDER BY option_id,conflict_option_id FOR SHARE",
          [set, brand],
        );
        const read = async () => {
          const result = await queryCurrent<CurrentRow>(currentSql, [set, brand]),
            row = result.rows[0];
          if (result.rows.length !== 1 || row?.coherent !== true || row.details === null)
            return fail();
          try {
            const p = parseCatalogOptionSetEditorContent(row.aggregate, row.details),
              source = p.content.sourceAggregate;
            if (
              source.optionSetReference !== set ||
              source.brandReference !== brand ||
              source.updatedAt > observedAt ||
              source.draft.updatedAt > observedAt ||
              source.createdAt > observedAt
            )
              return fail();
            const original = await queryCurrent<
              OriginalRow & {
                readonly sourceOperationReference?: unknown;
                readonly sourceTenantReference?: unknown;
                readonly sourceBrandReference?: unknown;
                readonly sourceOptionSetReference?: unknown;
                readonly sourceVersionReference?: unknown;
                readonly sourceAggregateVersion?: unknown;
              }
            >(
              `SELECT f.snapshot_json snapshot,f.source_digest,f.content_digest,f.configuration_digest,o.intent_digest,
                ${forReview ? 'o.operation_id "sourceOperationReference",f.tenant_id "sourceTenantReference",f.brand_id "sourceBrandReference",f.option_set_id "sourceOptionSetReference",f.option_set_version_id "sourceVersionReference",f.result_aggregate_version "sourceAggregateVersion",' : ""}
                (f.action_code=o.action_code AND f.intent_digest=o.intent_digest AND f.result_aggregate_version=o.result_aggregate_version
                 AND f.occurred_at=o.occurred_at AND f.option_set_id=o.option_set_id AND f.brand_id=o.brand_id
                 AND f.data_classification='ConfigurationMetadata' AND f.occurred_at=$6::timestamptz) coherent
                FROM rms_catalog.option_set_draft_content_snapshot f JOIN rms_catalog.option_set_operation_record o ON o.operation_id=f.operation_id
                WHERE f.option_set_id=$1 AND f.brand_id=$2 AND f.tenant_id=$3 AND f.result_aggregate_version=$4 AND f.option_set_version_id=$5`,
              [
                set,
                brand,
                tenant,
                source.aggregateVersion,
                source.draft.versionReference,
                source.updatedAt,
              ],
            );
            const stored = original.rows[0];
            if (original.rows.length !== 1 || stored?.coherent !== true || stored.snapshot === null)
              return fail();
            const body = closed(copyCategoryPersistenceValue(stored.snapshot), [
                "profile",
                "sourceAggregate",
                "optionDetails",
                "conditionalRules",
                "conflictRules",
                "scopeSet",
                "effectivePeriod",
              ]),
              { sourceAggregate, ...details } = body,
              full = parseCatalogOptionSetEditorContent(sourceAggregate, details);
            if (
              full.sourceDigest !== stored.source_digest ||
              full.contentDigest !== stored.content_digest ||
              full.configurationDigest !== stored.configuration_digest ||
              full.sourceDigest !== p.sourceDigest ||
              full.contentDigest !== p.contentDigest ||
              full.configurationDigest !== p.configurationDigest ||
              canonicalizeRfc8785(full.content) !== canonicalizeRfc8785(p.content)
            )
              return fail();
            let provenance: Readonly<{
              sourceOperationReference: ReturnType<typeof parseCatalogReference>;
              sourceSnapshotTuple: Readonly<{
                tenantReference: ReturnType<typeof parseCatalogReference>;
                brandReference: ReturnType<typeof parseCatalogReference>;
                optionSetReference: ReturnType<typeof parseCatalogReference>;
                versionReference: ReturnType<typeof parseCatalogReference>;
                aggregateVersion: number;
                sourceDigest: string;
                contentDigest: string;
                configurationDigest: string;
              }>;
            }> | null = null;
            if (forReview) {
              const sourceOperationReference = parseCatalogReference(
                  stored.sourceOperationReference,
                ),
                sourceSnapshotTuple = Object.freeze({
                  tenantReference: parseCatalogReference(stored.sourceTenantReference),
                  brandReference: parseCatalogReference(stored.sourceBrandReference),
                  optionSetReference: parseCatalogReference(stored.sourceOptionSetReference),
                  versionReference: parseCatalogReference(stored.sourceVersionReference),
                  aggregateVersion: stored.sourceAggregateVersion,
                  sourceDigest: full.sourceDigest,
                  contentDigest: full.contentDigest,
                  configurationDigest: full.configurationDigest,
                });
              if (
                sourceSnapshotTuple.tenantReference !== tenant ||
                sourceSnapshotTuple.brandReference !== brand ||
                sourceSnapshotTuple.optionSetReference !== set ||
                sourceSnapshotTuple.versionReference !== source.draft.versionReference ||
                sourceSnapshotTuple.aggregateVersion !== source.aggregateVersion
              )
                return fail();
              provenance = Object.freeze({
                sourceOperationReference,
                sourceSnapshotTuple: Object.freeze({
                  ...sourceSnapshotTuple,
                  aggregateVersion: source.aggregateVersion,
                }),
              });
            }
            return Object.freeze({ ...p, provenance });
          } catch {
            return fail();
          }
        };
        const current = await read(),
          source = current.content.sourceAggregate;
        if (expected !== null && source.aggregateVersion !== expected)
          return fail("CATALOG_VERSION_CONFLICT");
        await hold(current.content);
        const last = await read();
        if (
          last.sourceDigest !== current.sourceDigest ||
          last.contentDigest !== current.contentDigest ||
          last.configurationDigest !== current.configurationDigest ||
          canonicalizeRfc8785(last.content) !== canonicalizeRfc8785(current.content) ||
          canonicalizeRfc8785(last.provenance) !== canonicalizeRfc8785(current.provenance)
        )
          return fail();
        await hold(current.content);
        check();
        if (invocations !== 1) return fail();
        return Object.freeze({
          provenance: current.provenance,
          content: current.content,
          sourceDigest: current.sourceDigest,
          contentDigest: current.contentDigest,
          configurationDigest: current.configurationDigest,
          observedAt,
          validUntil: new Date(deadline).toISOString(),
          referenceEligibility: "NotEvaluated" as const,
        });
      });
      if (invocations !== 1) return fail();
      return result;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  }
  return Object.freeze({
    async readCurrent(value: unknown) {
      const { provenance, ...view } = await readCurrentKernel(value, false);
      void provenance;
      return Object.freeze(view);
    },
    async readCurrentForReview(value: unknown) {
      const { provenance, ...view } = await readCurrentKernel(value, true);
      if (!provenance) return fail();
      return Object.freeze({ ...view, ...provenance });
    },
  });
}

export const frozenFullOptionSetContentFields = Object.freeze([
  ...fields,
  "internalCode",
  "brandReference",
  "lifecycle",
  "aggregateVersion",
  "createdAt",
  "createdByActorReference",
  "updatedAt",
  "publicationOperationReference",
  "publicationIntentDigest",
  "successorDraftVersionReference",
  "sealedAt",
  "sourceDigest",
  "contentDigest",
  "configurationDigest",
  "digest",
]);

/** Shared owning immutable SELECT/coherence only. Admission and lease protocols stay
 * separate at their fixed public entries. */
async function readFrozenFullOptionSetContent(
  tx: Transaction,
  tenant: string,
  brand: string,
  set: string,
  version: string,
  observedAt: string,
): Promise<CatalogFullOptionSetPublicationContent> {
  const rows = await tx.query<{
    snapshot: unknown;
    metadata: unknown;
    coherent: boolean;
  }>(
    `
              SELECT p.snapshot_json snapshot,
              jsonb_build_object('tenantReference',p.tenant_id,'brandReference',p.brand_id,'optionSetReference',p.option_set_id,
                'versionReference',p.option_set_version_id,'publicationOperationReference',p.operation_id,
                'publicationIntentDigest',p.intent_digest,'successorDraftVersionReference',p.successor_draft_version_id,
                'sourceAggregateVersion',p.source_aggregate_version,'resultAggregateVersion',p.result_aggregate_version,
                'sealedAt',to_char(p.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'sourceDigest',p.source_digest,'contentDigest',p.content_digest,'configurationDigest',p.configuration_digest,'recordDigest',p.record_digest) metadata,
              (p.action_code='Publish' AND p.data_classification='ConfigurationMetadata' AND v.status='Frozen'
                AND o.action_code=p.action_code AND o.intent_digest=p.intent_digest AND o.result_aggregate_version=p.result_aggregate_version AND o.occurred_at=p.sealed_at
                AND date_trunc('milliseconds',p.sealed_at)=p.sealed_at AND date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at
                AND f.data_classification='ConfigurationMetadata' AND f.action_code=o0.action_code AND f.intent_digest=o0.intent_digest
                AND f.result_aggregate_version=o0.result_aggregate_version AND f.occurred_at=o0.occurred_at
                AND f.snapshot_json=p.snapshot_json->'editorContent' AND f.source_digest=p.source_digest AND f.content_digest=p.content_digest AND f.configuration_digest=p.configuration_digest
                AND f.occurred_at=(p.snapshot_json#>>'{editorContent,sourceAggregate,updatedAt}')::timestamptz
                AND v.editor_content_json=(p.snapshot_json->'editorContent')-'sourceAggregate'
                AND jsonb_build_object('versionReference',v.option_set_version_id,'status','Draft','defaultLocale',v.default_locale,
                  'localizedNames',v.localized_names_json,'localizedDescriptions',v.localized_descriptions_json,'displayStyle',v.display_style,
                  'minimumSelection',v.minimum_selection,'maximumSelection',v.maximum_selection,'allowRepeatedOption',v.allow_repeated_option,
                  'perOptionMaximumQuantity',v.per_option_maximum_quantity,'maximumTotalQuantity',v.maximum_total_quantity,
                  'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                    =(p.snapshot_json#>'{editorContent,sourceAggregate,draft}')-'options') coherent
              FROM rms_catalog.option_set_publication_content p
              JOIN rms_catalog.option_set_version v ON v.option_set_version_id=p.option_set_version_id AND v.option_set_id=p.option_set_id AND v.brand_id=p.brand_id
              JOIN rms_catalog.option_set_operation_record o ON o.operation_id=p.operation_id AND o.option_set_id=p.option_set_id AND o.brand_id=p.brand_id
              JOIN rms_catalog.option_set_draft_content_snapshot f ON f.option_set_version_id=p.option_set_version_id AND f.result_aggregate_version=p.source_aggregate_version
                AND f.option_set_id=p.option_set_id AND f.brand_id=p.brand_id AND f.tenant_id=p.tenant_id
              JOIN rms_catalog.option_set_operation_record o0 ON o0.operation_id=f.operation_id AND o0.option_set_id=f.option_set_id AND o0.brand_id=f.brand_id
              WHERE p.tenant_id=$1 AND p.brand_id=$2 AND p.option_set_id=$3 AND p.option_set_version_id=$4 AND octet_length(p.snapshot_json::text)<=3145728`,
    [tenant, brand, set, version],
  );
  const row = rows.rows[0];
  if (rows.rows.length === 0) return fail("CATALOG_UNAVAILABLE");
  if (rows.rows.length !== 1 || row?.coherent !== true) return fail();
  try {
    const content = parseCatalogFullOptionSetPublicationContent(row.snapshot),
      s = content.supportedContent;
    const expected = {
      tenantReference: tenant,
      brandReference: brand,
      optionSetReference: set,
      versionReference: version,
      publicationOperationReference: s.publicationOperationReference,
      publicationIntentDigest: s.publicationIntentDigest,
      successorDraftVersionReference: s.successorDraftVersionReference,
      sourceAggregateVersion: s.sourceAggregateVersion,
      resultAggregateVersion: s.sourceAggregateVersion + 1,
      sealedAt: s.sealedAt,
      sourceDigest: content.sourceDigest,
      contentDigest: content.contentDigest,
      configurationDigest: content.configurationDigest,
      recordDigest: content.digest,
    };
    if (
      s.tenantReference !== tenant ||
      s.brandReference !== brand ||
      s.optionSetReference !== set ||
      s.versionReference !== version ||
      s.sealedAt > observedAt ||
      canonicalizeRfc8785(copyCategoryPersistenceValue(row.metadata)) !==
        canonicalizeRfc8785(expected)
    )
      return fail();
    return content;
  } catch {
    return fail();
  }
}

export interface FrozenFullOptionSetContentAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.read";
      readonly purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT";
      readonly requiredFields: readonly string[];
      readonly optionSetReference: string;
      readonly versionReference: string;
      readonly content: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
/** Exact immutable historical content, never current Published/sale eligibility.
 * Only SELECT privileges are needed; current read authority must survive COMMIT. */
interface FrozenFullOptionSetContentStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: FrozenFullOptionSetContentAuthority;
}
export function createPostgresFrozenFullOptionSetContentStore(
  options: FrozenFullOptionSetContentStoreOptions,
) {
  return createFrozenFullOptionSetContentStoreKernel(options);
}
function createFrozenFullOptionSetContentStoreKernel(
  options: FrozenFullOptionSetContentStoreOptions,
  originalValidUntil?: string,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    clock = options.clock,
    transactions = options.transactions,
    authority = options.authority;
  if (
    typeof clock?.now !== "function" ||
    typeof transactions?.run !== "function" ||
    typeof authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = () => parseCatalogInstant(clock.now());
  return Object.freeze({
    async readPinned(value: unknown) {
      const r = closed(copyCategoryPersistenceValue(value), [
          "optionSetReference",
          "versionReference",
          "expectedRecordDigest",
        ]),
        set = parseCatalogReference(r.optionSetReference),
        version = parseCatalogReference(r.versionReference);
      if (
        r.expectedRecordDigest !== null &&
        (typeof r.expectedRecordDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(r.expectedRecordDigest))
      )
        return fail("CATALOG_INPUT_INVALID");
      let invocations = 0;
      try {
        const result = await transactions.run(async (tx) => {
          if (++invocations !== 1) return fail();
          const observedAt = now();
          let deadline = Math.min(
            Date.parse(observedAt) + 30000,
            originalValidUntil === undefined
              ? Infinity
              : Date.parse(parseCatalogInstant(originalValidUntil)),
          );
          const check = () => {
            const current = now();
            if (current < observedAt || Date.parse(current) >= deadline) return fail();
          };
          const hold = async (content: unknown) => {
            const observation = now();
            if (observation < observedAt) return fail();
            const evidence = closed(
                copyCategoryPersistenceValue(
                  await authority.holdUntilTransactionCompletes(tx, {
                    tenantReference: tenant,
                    brandReference: brand,
                    actorReference: actor,
                    actorKind: "User",
                    permission: "catalog.manage",
                    action: "catalog.option_set.read",
                    purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT",
                    requiredFields: frozenFullOptionSetContentFields,
                    optionSetReference: set,
                    versionReference: version,
                    content: copyCategoryPersistenceValue(content),
                    observedAt: observation,
                  }),
                ),
                ["observedAt", "validUntil"],
              ),
              until = parseCatalogInstant(evidence.validUntil);
            if (
              evidence.observedAt !== observation ||
              until <= observation ||
              Date.parse(until) - Date.parse(observation) > 30000
            )
              return fail();
            deadline = Math.min(deadline, Date.parse(until));
            check();
          };
          await hold(null);
          await requireCategoryCurrentReads(tx);
          if (originalValidUntil === undefined) {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          } else {
            check();
            const remaining = Math.max(1, Math.min(5000, deadline - Date.parse(now())));
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout',$3,true),set_config('statement_timeout',$3,true)",
              [tenant, brand, String(remaining)],
            );
            check();
          }
          const read = async () => {
            if (originalValidUntil !== undefined) {
              check();
              const remaining = Math.max(1, Math.min(5000, deadline - Date.parse(now())));
              await tx.query(
                "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
                [String(remaining)],
              );
              check();
            }
            return readFrozenFullOptionSetContent(tx, tenant, brand, set, version, observedAt);
          };
          const content = await read();
          if (r.expectedRecordDigest !== null && r.expectedRecordDigest !== content.digest)
            return fail("CATALOG_VERSION_CONFLICT");
          await hold(content);
          const last = await read();
          if (canonicalizeRfc8785(last) !== canonicalizeRfc8785(content)) return fail();
          await hold(content);
          check();
          if (invocations !== 1) return fail();
          return Object.freeze({
            content,
            observedAt,
            validUntil: new Date(deadline).toISOString(),
            eligibility: "NotEvaluated" as const,
          });
        });
        if (invocations !== 1) return fail();
        return result;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}

type ProductFrozenOptionCommand =
  ProductPublicationCommandV2 | CatalogProductPublicationWarningAcknowledgementCommand;
export const productPublicationFrozenFullOptionSetContentFields = Object.freeze([
  ...frozenFullOptionSetContentFields,
  "command",
  "originalIntentDigest",
  "replacementIntentDigest",
  "warningBindingDigest",
  "actorKind",
  "requestObservedAt",
  "requestValidUntil",
] as const);
export interface ProductPublicationFrozenFullOptionSetContentAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User" | "System";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.read";
      readonly purposeCode: ProductFrozenOptionCommand["purposeCode"];
      readonly requiredFields: typeof productPublicationFrozenFullOptionSetContentFields;
      readonly command: ProductFrozenOptionCommand;
      readonly originalIntentDigest: string;
      readonly replacementIntentDigest: string | null;
      readonly warningBindingDigest: string | null;
      readonly requestObservedAt: string;
      readonly requestValidUntil: string;
      readonly optionSetReference: string;
      readonly versionReference: string;
      readonly content: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
/** Full actual publication/Ack intent is fixed for the whole graph acquisition.
 * Frozen historical content supplies no current publication or sale eligibility. */
export function createPostgresProductPublicationFrozenFullOptionSetContentStore(options: {
  readonly command: unknown;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductPublicationFrozenFullOptionSetContentAuthority;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}) {
  const raw = copyCategoryPersistenceValue(options.command);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const command =
    Object.hasOwn(raw, "profile") &&
    (raw as Record<string, unknown>).profile ===
      "CatalogProductPublicationWarningAcknowledgementCommandV1"
      ? parseCatalogProductPublicationWarningAcknowledgementCommand(raw)
      : parseProductPublicationCommandV2(raw);
  const observedAt = parseCatalogInstant(options.observedAt),
    validUntil = parseCatalogInstant(options.validUntil);
  if (
    command.occurredAt > observedAt ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    admission = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    originalIntentDigest = hash(command),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const binding = Object.freeze({
    command,
    originalIntentDigest,
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: command.actorKind,
    purposeCode: command.purposeCode,
    replacementIntentDigest:
      "replacementIntentDigest" in command ? command.replacementIntentDigest : null,
    warningBindingDigest: "warningBindingDigest" in command ? command.warningBindingDigest : null,
    requestObservedAt: observedAt,
    requestValidUntil: validUntil,
  });
  return Object.freeze({
    async readPinned(value: unknown) {
      let transaction: Transaction | undefined,
        entered = false,
        poisoned = false,
        invocations = 0,
        finalCheck: (() => unknown) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        let completed:
          | {
              readonly content: CatalogFullOptionSetPublicationContent;
              readonly observedAt: ReturnType<typeof parseCatalogInstant>;
              readonly validUntil: string;
              readonly eligibility: "NotEvaluated";
            }
          | undefined;
        const result = await run(async (tx) => {
          if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return poison();
          transaction = tx;
          if (++invocations !== 1 || active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          entered = true;
          const originalQuery = tx.query,
            queryPort = originalQuery.bind(tx);
          let latest = observedAt,
            deadline = validUntil,
            ready = false,
            guardCalls = 0,
            content: CatalogFullOptionSetPublicationContent | null = null,
            set = "",
            version = "";
          const check = () => {
            const at = parseCatalogInstant(clock());
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== originalQuery ||
              at < latest ||
              at >= deadline
            )
              return poison();
            latest = at;
            return at;
          };
          finalCheck = check;
          const query: Transaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            const result = await queryPort<Row>(sql, values);
            check();
            return result;
          };
          const read = () =>
            readFrozenFullOptionSetContent(
              { query },
              command.tenantReference,
              command.brandReference,
              set,
              version,
              observedAt,
            );
          const hold = async () => {
            const at = check(),
              evidence = closed(
                copyCategoryPersistenceValue(
                  await admission(
                    tx,
                    Object.freeze({
                      ...binding,
                      permission: "catalog.manage" as const,
                      action: "catalog.option_set.read" as const,
                      requiredFields: productPublicationFrozenFullOptionSetContentFields,
                      optionSetReference: set,
                      versionReference: version,
                      content,
                      observedAt: at,
                    }),
                  ),
                ),
                ["observedAt", "validUntil"],
              ),
              until = parseCatalogInstant(evidence.validUntil);
            if (
              evidence.observedAt !== at ||
              until <= at ||
              Date.parse(until) - Date.parse(at) > 30000
            )
              return poison();
            deadline = until < deadline ? until : deadline;
            check();
          };
          if (
            (await register(
              tx,
              async () => {
                try {
                  if (++guardCalls !== 1 || !ready || content === null) return poison();
                  await hold();
                  const last = await read();
                  if (canonicalizeRfc8785(last) !== canonicalizeRfc8785(content)) return poison();
                  await hold();
                  check();
                } catch (error) {
                  poisoned = true;
                  failed.add(tx);
                  throw error;
                }
              },
              () => {
                if (!ready || guardCalls !== 1) return poison();
                check();
              },
            )) !== undefined
          )
            return poison();
          const r = closed(copyCategoryPersistenceValue(value), [
            "optionSetReference",
            "versionReference",
            "expectedRecordDigest",
          ]);
          set = parseCatalogReference(r.optionSetReference);
          version = parseCatalogReference(r.versionReference);
          if (
            r.expectedRecordDigest !== null &&
            (typeof r.expectedRecordDigest !== "string" ||
              !/^sha256:[0-9a-f]{64}$/.test(r.expectedRecordDigest))
          )
            return fail("CATALOG_INPUT_INVALID");
          check();
          await hold();
          await requireCategoryCurrentReads({ query });
          await query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [command.tenantReference, command.brandReference],
          );
          content = await read();
          if (r.expectedRecordDigest !== null && r.expectedRecordDigest !== content.digest)
            return fail("CATALOG_VERSION_CONFLICT");
          await hold();
          const last = await read();
          if (canonicalizeRfc8785(last) !== canonicalizeRfc8785(content)) return poison();
          await hold();
          check();
          ready = true;
          completed = Object.freeze({
            content,
            observedAt,
            validUntil: deadline,
            eligibility: "NotEvaluated" as const,
          });
          return completed;
        });
        if (
          !completed ||
          result !== completed ||
          invocations !== 1 ||
          poisoned ||
          (transaction && failed.has(transaction))
        )
          return poison();
        finalCheck?.();
        return result;
      } catch (error) {
        poisoned = true;
        if (transaction) failed.add(transaction);
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        if (entered && transaction) active.delete(transaction);
      }
    },
  });
}

function parseFullOptionSetContentSealCommand(value: unknown) {
  const command = closed(copyCategoryPersistenceValue(value), [
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "operationReference",
    "occurredAt",
    "reasonCode",
  ]);
  const digest = (value: unknown) => {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
      return fail("CATALOG_INPUT_INVALID");
    return value;
  };
  const set = parseCatalogReference(command.optionSetReference),
    version = parseCatalogReference(command.versionReference),
    operation = parseCatalogReference(command.operationReference),
    at = parseCatalogInstant(command.occurredAt),
    reason = parseCatalogCode(command.reasonCode),
    expected = command.expectedAggregateVersion,
    sourceDigest = digest(command.sourceDigest),
    contentDigest = digest(command.contentDigest),
    configurationDigest = digest(command.configurationDigest);
  if (
    typeof expected !== "number" ||
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    expected >= 2147483647 ||
    reason !== command.reasonCode
  )
    return fail("CATALOG_INPUT_INVALID");
  return {
    command,
    set,
    version,
    operation,
    at,
    reason,
    expected,
    sourceDigest,
    contentDigest,
    configurationDigest,
  };
}
/** Canonical original Seal intent only; this parser grants no command authority
 * and does not qualify any source. Uses exactly the owning operation's bytes. */
export function createCatalogFullOptionSetContentSealIntent(value: unknown): string {
  const input = closed(copyCategoryPersistenceValue(value), [
      "tenantReference",
      "brandReference",
      "actorReference",
      "command",
    ]),
    tenantReference = parseCatalogReference(input.tenantReference),
    brandReference = parseCatalogReference(input.brandReference),
    actorReference = parseCatalogReference(input.actorReference),
    { command } = parseFullOptionSetContentSealCommand(input.command);
  return hash({
    profile: "CatalogFullOptionSetContentSealV1",
    tenantReference,
    brandReference,
    actorReference,
    command,
  });
}

export const fullOptionSealChecks = Object.freeze([
  "CurrentReferences",
  "RuleSatisfiability",
  "ScopeTopology",
  "PublishingPolicy",
  "IndependentApproval",
] as const);
export interface FullOptionSetSealAuthority {
  /** Owning current User/publish/action/purpose/all fields held through COMMIT.
   * Apply additionally requires ALL current checks and their source barriers.
   * Intent/Replay authorize observation/recovery only. A lease is not eligibility.
   * No configured production provider currently exists; synthetic fixtures are
   * exclusively acceptance controls, never a runtime admission implementation. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action: "catalog.option_set.publish";
      readonly purposeCode: "CATALOG_OPTION_SET_PUBLICATION";
      readonly requiredFields: readonly string[];
      readonly requiredChecks: readonly string[];
      readonly phase: "Intent" | "Apply" | "Replay";
      readonly command: unknown;
      readonly content: unknown;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
/** Atomic internal Frozen content producer. This factory creates no Publishing
 * release, current eligibility or endpoint; those need genuine owning sources. */
export function createPostgresFullOptionSetContentSealStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: FullOptionSetSealAuthority;
  readonly readAuthority: CurrentFullOptionSetDraftAuthority;
  readonly references: { generateSuccessorVersion(): string };
  readonly audit: {
    create(input: {
      readonly operationReference: string;
      readonly reasonCode: string;
      readonly occurredAt: string;
      readonly result: CatalogFullOptionSetPublicationContent;
    }): AppendAuditRecordInput;
  };
  readonly events: { generateReference(): string };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.readAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.references?.generateSuccessorVersion !== "function" ||
    typeof options.audit?.create !== "function" ||
    typeof options.events?.generateReference !== "function"
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    admission = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    readAdmission = options.readAuthority.holdUntilTransactionCompletes.bind(options.readAuthority),
    allocate = options.references.generateSuccessorVersion.bind(options.references),
    auditFor = options.audit.create.bind(options.audit),
    eventFor = options.events.generateReference.bind(options.events);
  const now = () => parseCatalogInstant(clock());
  return Object.freeze({
    async seal(value: unknown) {
      const {
        command,
        set,
        version,
        operation,
        at,
        reason,
        expected,
        sourceDigest,
        contentDigest,
        configurationDigest,
      } = parseFullOptionSetContentSealCommand(value);
      const intent = createCatalogFullOptionSetContentSealIntent({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        command,
      });
      let invocations = 0;
      try {
        const result = await run(async (tx) => {
          if (++invocations !== 1) return fail();
          const originalObservation = now();
          let deadline = Date.parse(originalObservation) + 30000,
            latest = originalObservation;
          const check = () => {
            const t = now();
            if (t < latest || Date.parse(t) >= deadline) return fail();
            latest = t;
          };
          const lease = (value: unknown, observation: string) => {
            const e = closed(copyCategoryPersistenceValue(value), ["observedAt", "validUntil"]),
              until = parseCatalogInstant(e.validUntil);
            if (
              e.observedAt !== observation ||
              until <= observation ||
              Date.parse(until) - Date.parse(observation) > 30000
            )
              return fail();
            deadline = Math.min(deadline, Date.parse(until));
            check();
          };
          const hold = async (
            phase: "Intent" | "Apply" | "Replay",
            content: OptionSetEditorContent | null,
          ) => {
            check();
            const observedAt = now();
            lease(
              await admission(tx, {
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                actorKind: "User",
                permission: "catalog.manage",
                action: "catalog.option_set.publish",
                purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                requiredFields: Object.freeze(["internalCode", "aggregateVersion", ...fields]),
                requiredChecks: phase === "Apply" ? fullOptionSealChecks : Object.freeze([]),
                phase,
                command: copyCategoryPersistenceValue(command),
                content: copyCategoryPersistenceValue(content),
                observedAt,
              }),
              observedAt,
            );
          };
          await hold("Intent", null);
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenant, brand],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionOperation:" + operation,
          ]);
          const recovered = await tx.query<{
            snapshot: unknown;
            intent_digest: string;
            coherent: boolean;
          }>(
            `SELECT p.snapshot_json snapshot,o.intent_digest,
             (p.tenant_id=$1 AND p.brand_id=o.brand_id AND p.option_set_id=o.option_set_id AND p.action_code='Publish'
              AND o.action_code=p.action_code AND p.intent_digest=o.intent_digest AND p.result_aggregate_version=o.result_aggregate_version
              AND p.sealed_at=o.occurred_at AND p.data_classification='ConfigurationMetadata' AND v.status='Frozen'
              AND p.snapshot_json->>'digest'=p.record_digest AND p.snapshot_json->>'sourceDigest'=p.source_digest
              AND p.snapshot_json->>'contentDigest'=p.content_digest AND p.snapshot_json->>'configurationDigest'=p.configuration_digest
              AND p.snapshot_json#>>'{supportedContent,publicationOperationReference}'=o.operation_id::text
              AND p.snapshot_json#>>'{supportedContent,publicationIntentDigest}'=p.intent_digest
              AND p.snapshot_json#>>'{supportedContent,tenantReference}'=p.tenant_id::text
              AND p.snapshot_json#>>'{supportedContent,brandReference}'=p.brand_id::text
              AND p.snapshot_json#>>'{supportedContent,optionSetReference}'=p.option_set_id::text
              AND p.snapshot_json#>>'{supportedContent,versionReference}'=p.option_set_version_id::text
              AND p.snapshot_json#>>'{supportedContent,successorDraftVersionReference}'=p.successor_draft_version_id::text
              AND (p.snapshot_json#>>'{supportedContent,sourceAggregateVersion}')::integer=p.source_aggregate_version
              AND p.result_aggregate_version=p.source_aggregate_version+1
              AND p.snapshot_json#>>'{supportedContent,sealedAt}'=${utc("p.sealed_at")}) coherent
             FROM rms_catalog.option_set_operation_record o LEFT JOIN rms_catalog.option_set_publication_content p ON p.operation_id=o.operation_id
             LEFT JOIN rms_catalog.option_set_version v ON v.option_set_version_id=p.option_set_version_id AND v.option_set_id=p.option_set_id AND v.brand_id=p.brand_id
             WHERE o.operation_id=$3 AND o.brand_id=$2`,
            [tenant, brand, operation],
          );
          if (recovered.rows.length > 1) return fail();
          const old = recovered.rows[0];
          if (old) {
            if (old.intent_digest !== intent) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            if (old.coherent !== true) return fail();
            const content = parseCatalogFullOptionSetPublicationContent(old.snapshot),
              s = content.supportedContent;
            if (
              s.tenantReference !== tenant ||
              s.brandReference !== brand ||
              s.optionSetReference !== set ||
              s.versionReference !== version ||
              s.sourceAggregateVersion !== expected ||
              s.publicationOperationReference !== operation ||
              s.publicationIntentDigest !== intent ||
              s.sealedAt !== at ||
              content.sourceDigest !== sourceDigest ||
              content.contentDigest !== contentDigest ||
              content.configurationDigest !== configurationDigest
            )
              return fail();
            await hold("Replay", content.editorContent);
            check();
            return Object.freeze({
              status: "Replayed" as const,
              content,
              successorDraftVersionReference: s.successorDraftVersionReference,
              operationReference: operation,
              referenceEligibility: "NotEvaluated" as const,
            });
          }
          if (at > now() || Date.parse(now()) - Date.parse(at) >= 30000) return fail();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogFullOptionSource:" + brand + ":" + set,
          ]);
          const root = await tx.query(
            "SELECT option_set_id FROM rms_catalog.option_set WHERE option_set_id=$1 AND brand_id=$2 FOR UPDATE",
            [set, brand],
          );
          if (root.rows.length !== 1) return fail("CATALOG_UNAVAILABLE");
          await tx.query(
            "SELECT option_set_version_id FROM rms_catalog.option_set_version WHERE option_set_id=$1 AND brand_id=$2 AND status='Draft' FOR UPDATE",
            [set, brand],
          );
          // Public owning reader verifies all full fields and original provenance;
          // its shorter lease remains part of this same outer transaction window.
          const read = async (revision: number) => {
            const r = await createPostgresCurrentFullOptionSetDraftStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now },
              transactions: { run: (work) => work(tx) },
              authority: {
                holdUntilTransactionCompletes: async (same, input) => {
                  if (same !== tx) return fail();
                  check();
                  const e = await readAdmission(tx, input);
                  lease(e, input.observedAt);
                  return e;
                },
              },
            }).readCurrent({ optionSetReference: set, expectedAggregateVersion: revision });
            deadline = Math.min(deadline, Date.parse(r.validUntil));
            check();
            return r;
          };
          const source = await read(expected as number),
            current = source.content.sourceAggregate;
          if (current.lifecycle !== "Draft") return fail("CATALOG_LIFECYCLE_CONFLICT");
          if (
            current.draft.versionReference !== version ||
            current.updatedAt > at ||
            source.sourceDigest !== sourceDigest ||
            source.contentDigest !== contentDigest ||
            source.configurationDigest !== configurationDigest
          )
            return fail("CATALOG_VERSION_CONFLICT");
          await hold("Apply", source.content);
          const still = await read(expected as number);
          if (canonicalizeRfc8785(still.content) !== canonicalizeRfc8785(source.content))
            return fail();
          const successor = parseCatalogReference(allocate());
          if (
            successor === version ||
            successor === set ||
            current.draft.options.some((o) => o.optionReference === successor)
          )
            return fail();
          const prior = await tx.query(
            "SELECT option_set_version_id FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
            [successor],
          );
          if (prior.rows.length !== 0) return fail();
          const { sourceAggregate, ...additional } = source.content;
          const plan = createCatalogFullOptionSetPublicationMaterialization(
            sourceAggregate,
            additional,
            {
              tenantReference: tenant,
              brandReference: brand,
              optionSetReference: set,
              versionReference: version,
              sourceAggregateVersion: expected,
              publicationOperationReference: operation,
              publicationIntentDigest: intent,
              successorDraftVersionReference: successor,
              sealedAt: at,
              sourceDigest,
              contentDigest,
              configurationDigest,
            },
          );
          const audit = validateAuditRecord(
            copyCategoryPersistenceValue(
              auditFor({
                operationReference: operation,
                reasonCode: reason,
                occurredAt: at,
                result: plan.content,
              }),
            ),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type !== "User" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_OPTION_SET_CONTENT_SEALED" ||
            audit.targetType !== "CatalogOptionSet" ||
            audit.targetId !== set ||
            audit.reasonCode !== reason ||
            audit.occurredAt !== at ||
            audit.correlationId !== operation ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();
          check();
          const cas = await tx.query(
            "UPDATE rms_catalog.option_set SET aggregate_version=aggregate_version+1,updated_at=$4 WHERE option_set_id=$1 AND brand_id=$2 AND aggregate_version=$3 AND lifecycle='Draft'",
            [set, brand, expected, at],
          );
          if (cas.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          const frozen = await tx.query(
            "UPDATE rms_catalog.option_set_version SET status='Frozen' WHERE option_set_id=$1 AND brand_id=$2 AND option_set_version_id=$3 AND status='Draft'",
            [set, brand, version],
          );
          if (frozen.rowCount !== 1) return fail();
          const d = plan.successor.draft;
          const v = await tx.query(
            `INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at,editor_content_json)
            VALUES($1,$2,$3,'Draft',$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$13,$14::jsonb)`,
            [
              successor,
              set,
              brand,
              d.defaultLocale,
              canonicalizeRfc8785(d.localizedNames),
              canonicalizeRfc8785(d.localizedDescriptions),
              d.displayStyle,
              d.minimumSelection,
              d.maximumSelection,
              d.allowRepeatedOption,
              d.perOptionMaximumQuantity,
              d.maximumTotalQuantity,
              at,
              canonicalizeRfc8785(additional),
            ],
          );
          if (v.rowCount !== 1) return fail();
          const op = await tx.query(
            "INSERT INTO rms_catalog.option_set_operation_record(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'Publish',$4,$5,$6)",
            [operation, brand, set, intent, plan.successor.aggregateVersion, at],
          );
          if (op.rowCount !== 1) return fail();
          const successorFull = parseCatalogOptionSetEditorContent(plan.successor, additional);
          const saved = await tx.query(
            `INSERT INTO rms_catalog.option_set_draft_content_snapshot(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at,source_digest,content_digest,configuration_digest,snapshot_json)
            VALUES($1,$2,$3,$4,$5,'Publish',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
            [
              operation,
              tenant,
              brand,
              set,
              successor,
              intent,
              plan.successor.aggregateVersion,
              at,
              successorFull.sourceDigest,
              successorFull.contentDigest,
              successorFull.configurationDigest,
              canonicalizeRfc8785(successorFull.content),
            ],
          );
          if (saved.rowCount !== 1) return fail();
          const content = await tx.query(
            `INSERT INTO rms_catalog.option_set_publication_content(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,successor_draft_version_id,action_code,intent_digest,source_aggregate_version,result_aggregate_version,sealed_at,source_digest,content_digest,configuration_digest,record_digest,snapshot_json)
            VALUES($1,$2,$3,$4,$5,$6,'Publish',$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
            [
              operation,
              tenant,
              brand,
              set,
              version,
              successor,
              intent,
              expected,
              plan.successor.aggregateVersion,
              at,
              sourceDigest,
              contentDigest,
              configurationDigest,
              plan.content.digest,
              canonicalizeRfc8785(plan.content),
            ],
          );
          if (content.rowCount !== 1) return fail();
          // Immediate stable-parent guard requires its immutable owning proof
          // before movement; deferred guards still validate the entire result.
          const moved = await tx.query(
            "UPDATE rms_catalog.option SET option_set_version_id=$4 WHERE option_set_id=$1 AND brand_id=$2 AND option_set_version_id=$3",
            [set, brand, version, successor],
          );
          if (moved.rowCount !== current.draft.options.length) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          const envelope: DomainEventEnvelope = {
            eventId: parseCatalogReference(eventFor()),
            eventType: "OptionSetContentSealed",
            schemaVersion: 1,
            occurredAt: at,
            producerModule: "@rms/catalog",
            tenantId: brand,
            aggregateType: "CatalogOptionSet",
            aggregateId: set,
            aggregateVersion: BigInt(plan.successor.aggregateVersion),
            correlationId: operation,
            actor: { type: "Actor", actorId: actor },
            payload: {
              tenantReference: tenant,
              optionSetReference: set,
              versionReference: version,
              successorDraftVersionReference: successor,
              aggregateVersion: plan.successor.aggregateVersion,
              operationReference: operation,
              contentDigest,
              configurationDigest,
              recordDigest: plan.content.digest,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: {
              operationReference: operation,
              aggregateVersion: plan.successor.aggregateVersion,
            },
          };
          await appendEventInTransaction(
            {
              query: async (sql, values) => {
                const r = await tx.query(sql, values);
                return { rowCount: r.rowCount ?? null };
              },
            },
            envelope,
          );
          await hold("Apply", source.content);
          const last = await read(plan.successor.aggregateVersion);
          if (
            canonicalizeRfc8785(last.content) !== canonicalizeRfc8785(plan.successorEditorContent)
          )
            return fail();
          check();
          if (at > now() || Date.parse(now()) - Date.parse(at) >= 30000) return fail();
          return Object.freeze({
            status: "Applied" as const,
            content: plan.content,
            successorDraftVersionReference: successor,
            operationReference: operation,
            referenceEligibility: "NotEvaluated" as const,
          });
        });
        if (invocations !== 1) return fail();
        return result;
      } catch (e) {
        if (e instanceof CatalogError) throw e;
        return fail();
      }
    },
  });
}

export interface FullOptionSetPublicationSealIdentity {
  readonly operationReference: string;
  readonly publicationIntentDigest: string;
  readonly occurredAt: string;
}
export function parseFullOptionSetPublicationSealIdentity(
  value: unknown,
): FullOptionSetPublicationSealIdentity {
  const r = closed(copyCategoryPersistenceValue(value), [
    "operationReference",
    "publicationIntentDigest",
    "occurredAt",
  ]);
  if (
    typeof r.publicationIntentDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(r.publicationIntentDigest)
  )
    return fail();
  return Object.freeze({
    operationReference: parseCatalogReference(r.operationReference),
    publicationIntentDigest: r.publicationIntentDigest,
    occurredAt: parseCatalogInstant(r.occurredAt),
  });
}
type FullOptionReviewView = Awaited<
  ReturnType<
    ReturnType<typeof createPostgresCurrentFullOptionSetDraftStore>["readCurrentForReview"]
  >
>;
/** Fixed same-operation transition proof. Actual immutable original, Frozen and
 * unique current successor are read by Catalog; supplied receipts grant nothing. */
export function createPostgresFullOptionSetSealHandoffStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly sealIdentity: FullOptionSetPublicationSealIdentity;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly currentDraftAuthority: CurrentFullOptionSetDraftAuthority;
  readonly frozenAuthority: FrozenFullOptionSetContentAuthority;
}) {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.currentDraftAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.frozenAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    identity = parseFullOptionSetPublicationSealIdentity(options.sealIdentity),
    origin = parseCatalogInstant(options.originalObservedAt),
    until = parseCatalogInstant(options.originalValidUntil),
    clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    currentHold = options.currentDraftAuthority.holdUntilTransactionCompletes.bind(
      options.currentDraftAuthority,
    ),
    frozenHold = options.frozenAuthority.holdUntilTransactionCompletes.bind(
      options.frozenAuthority,
    );
  if (
    until <= origin ||
    Date.parse(until) - Date.parse(origin) > 5000 ||
    identity.occurredAt < origin ||
    identity.occurredAt >= until
  )
    return fail();
  let capturedTx: Transaction | undefined,
    capturedQuery: Transaction["query"] | undefined,
    latest = origin,
    deadline = until,
    admitted = false,
    active = false,
    poisoned = false;
  let original: FullOptionReviewView | undefined,
    receiptContent: CatalogFullOptionSetPublicationContent | undefined;
  const check = () => {
    const now = parseCatalogInstant(clock());
    if (
      poisoned ||
      now < latest ||
      now >= deadline ||
      (capturedTx && capturedTx.query !== capturedQuery)
    ) {
      poisoned = true;
      return fail();
    }
    latest = now;
    return now;
  };
  const tighten = (value: string) => {
    const at = parseCatalogInstant(value);
    if (at < deadline) deadline = at;
    check();
  };
  const stable = ({ observedAt, validUntil, ...v }: FullOptionReviewView) => {
    void observedAt;
    void validUntil;
    return v;
  };
  async function read() {
    if (!original || !receiptContent) return fail();
    const old = original,
      claimed = receiptContent;
    let calls = 0,
      complete = false;
    let produced: unknown;
    let successor: FullOptionReviewView | undefined;
    const result = await run(async (tx) => {
      if (++calls !== 1 || (capturedTx && capturedTx !== tx)) return fail();
      if (!capturedTx) {
        capturedTx = tx;
        capturedQuery = tx.query;
      }
      check();
      const tuple = old.sourceSnapshotTuple,
        aggregate = old.content.sourceAggregate;
      const scope = await tx.query<{
        tenant: unknown;
        brand: unknown;
        store: unknown;
        isolation: unknown;
      }>(
        "SELECT current_setting('bop.tenant_id',true) tenant,current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store,current_setting('transaction_isolation') isolation",
        [],
      );
      const context = scope.rows[0];
      if (
        scope.rows.length !== 1 ||
        !context ||
        context.tenant !== tenant ||
        context.brand !== brand ||
        (context.store !== null && context.store !== "") ||
        context.isolation !== "read committed"
      )
        return fail();
      const source = await tx.query<{ snapshot: unknown; coherent: unknown }>(
        `SELECT f.snapshot_json snapshot,(f.tenant_id=$2::uuid AND f.brand_id=$3::uuid AND f.option_set_id=$4::uuid
          AND f.option_set_version_id=$5::uuid AND f.result_aggregate_version=$6 AND f.source_digest=$7 AND f.content_digest=$8 AND f.configuration_digest=$9
          AND f.option_set_id=o.option_set_id AND f.brand_id=o.brand_id AND f.action_code=o.action_code AND f.intent_digest=o.intent_digest
          AND f.result_aggregate_version=o.result_aggregate_version AND f.occurred_at=o.occurred_at AND f.data_classification='ConfigurationMetadata') coherent
          FROM rms_catalog.option_set_draft_content_snapshot f JOIN rms_catalog.option_set_operation_record o ON o.operation_id=f.operation_id WHERE f.operation_id=$1`,
        [
          old.sourceOperationReference,
          tenant,
          brand,
          aggregate.optionSetReference,
          aggregate.draft.versionReference,
          aggregate.aggregateVersion,
          old.sourceDigest,
          old.contentDigest,
          old.configurationDigest,
        ],
      );
      const row = source.rows[0];
      if (
        source.rows.length !== 1 ||
        !row ||
        row.coherent !== true ||
        canonicalizeRfc8785(copyCategoryPersistenceValue(row.snapshot)) !==
          canonicalizeRfc8785(old.content)
      )
        return fail();
      check();
      const held = await createFrozenFullOptionSetContentStoreKernel(
        {
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== tx) return fail();
              check();
              const proof = await frozenHold(tx, input);
              check();
              return proof;
            },
          },
        },
        deadline,
      ).readPinned({
        optionSetReference: aggregate.optionSetReference,
        versionReference: aggregate.draft.versionReference,
        expectedRecordDigest: claimed.digest,
      });
      tighten(held.validUntil);
      const frozen = held.content,
        supported = frozen.supportedContent;
      if (
        canonicalizeRfc8785(frozen) !== canonicalizeRfc8785(claimed) ||
        supported.publicationOperationReference !== identity.operationReference ||
        supported.publicationIntentDigest !== identity.publicationIntentDigest ||
        supported.sealedAt !== identity.occurredAt ||
        frozen.sourceDigest !== old.sourceDigest ||
        frozen.contentDigest !== old.contentDigest ||
        frozen.configurationDigest !== old.configurationDigest ||
        canonicalizeRfc8785(frozen.editorContent) !== canonicalizeRfc8785(old.content) ||
        tuple.tenantReference !== tenant ||
        tuple.brandReference !== brand
      )
        return fail();
      const { sourceAggregate, ...details } = old.content;
      const materialized = createCatalogFullOptionSetPublicationMaterialization(
        sourceAggregate,
        details,
        {
          tenantReference: tenant,
          brandReference: brand,
          optionSetReference: aggregate.optionSetReference,
          versionReference: aggregate.draft.versionReference,
          sourceAggregateVersion: aggregate.aggregateVersion,
          publicationOperationReference: identity.operationReference,
          publicationIntentDigest: identity.publicationIntentDigest,
          successorDraftVersionReference: supported.successorDraftVersionReference,
          sealedAt: identity.occurredAt,
          sourceDigest: old.sourceDigest,
          contentDigest: old.contentDigest,
          configurationDigest: old.configurationDigest,
        },
      );
      if (canonicalizeRfc8785(materialized.content) !== canonicalizeRfc8785(frozen)) return fail();
      successor = await createCurrentFullOptionSetDraftStoreKernel(
        {
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: check },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== tx) return fail();
              check();
              const proof = await currentHold(tx, input);
              check();
              return proof;
            },
          },
        },
        deadline,
      ).readCurrentForReview({
        optionSetReference: aggregate.optionSetReference,
        expectedAggregateVersion: aggregate.aggregateVersion + 1,
      });
      tighten(successor.validUntil);
      if (
        successor.sourceOperationReference !== identity.operationReference ||
        successor.content.sourceAggregate.draft.versionReference !==
          supported.successorDraftVersionReference ||
        canonicalizeRfc8785(successor.content) !==
          canonicalizeRfc8785(materialized.successorEditorContent)
      )
        return fail();
      check();
      complete = true;
      const packet = Object.freeze({
        profile: "CurrentOwnFullOptionSealHandoffV1" as const,
        original: old,
        content: frozen,
        successor,
        sealIdentity: identity,
        observedAt: check(),
        validUntil: deadline,
        referenceEligibility: "NotEvaluated" as const,
      });
      produced = packet;
      return packet;
    });
    if (
      calls !== 1 ||
      !complete ||
      !successor ||
      result !== produced ||
      result.successor !== successor
    )
      return fail();
    check();
    return result;
  }
  return Object.freeze({
    async admit(originalValue: FullOptionReviewView, receiptValue: unknown) {
      if (active || admitted || poisoned) {
        poisoned = true;
        return fail();
      }
      admitted = active = true;
      try {
        const originalCopy = copyCategoryPersistenceValue(originalValue);
        const o = closed(originalCopy, [
          "content",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
          "observedAt",
          "validUntil",
          "referenceEligibility",
          "sourceOperationReference",
          "sourceSnapshotTuple",
        ]);
        const { sourceAggregate, ...additional } = closed(o.content, [
          "profile",
          "sourceAggregate",
          "optionDetails",
          "conditionalRules",
          "conflictRules",
          "scopeSet",
          "effectivePeriod",
        ]);
        const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
        const tuple = closed(o.sourceSnapshotTuple, [
          "tenantReference",
          "brandReference",
          "optionSetReference",
          "versionReference",
          "aggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
        ]);
        const agg = parsed.content.sourceAggregate;
        if (
          o.referenceEligibility !== "NotEvaluated" ||
          tuple.tenantReference !== tenant ||
          tuple.brandReference !== brand ||
          tuple.optionSetReference !== agg.optionSetReference ||
          tuple.versionReference !== agg.draft.versionReference ||
          tuple.aggregateVersion !== agg.aggregateVersion ||
          parsed.sourceDigest !== o.sourceDigest ||
          parsed.contentDigest !== o.contentDigest ||
          parsed.configurationDigest !== o.configurationDigest ||
          tuple.sourceDigest !== o.sourceDigest ||
          tuple.contentDigest !== o.contentDigest ||
          tuple.configurationDigest !== o.configurationDigest ||
          parseCatalogInstant(o.observedAt) < origin ||
          parseCatalogInstant(o.observedAt) > check()
        )
          return fail();
        original = {
          content: parsed.content,
          sourceDigest: parsed.sourceDigest,
          contentDigest: parsed.contentDigest,
          configurationDigest: parsed.configurationDigest,
          observedAt: parseCatalogInstant(o.observedAt),
          validUntil: parseCatalogInstant(o.validUntil),
          referenceEligibility: "NotEvaluated",
          sourceOperationReference: parseCatalogReference(o.sourceOperationReference),
          sourceSnapshotTuple: {
            tenantReference: parseCatalogReference(tuple.tenantReference),
            brandReference: parseCatalogReference(tuple.brandReference),
            optionSetReference: agg.optionSetReference,
            versionReference: agg.draft.versionReference,
            aggregateVersion: agg.aggregateVersion,
            sourceDigest: parsed.sourceDigest,
            contentDigest: parsed.contentDigest,
            configurationDigest: parsed.configurationDigest,
          },
        };
        Object.freeze(original.sourceSnapshotTuple);
        Object.freeze(original);
        tighten(original.validUntil);
        const r = closed(copyCategoryPersistenceValue(receiptValue), [
          "status",
          "content",
          "successorDraftVersionReference",
          "operationReference",
          "referenceEligibility",
        ]);
        receiptContent = parseCatalogFullOptionSetPublicationContent(r.content);
        if (
          (r.status !== "Applied" && r.status !== "Replayed") ||
          r.referenceEligibility !== "NotEvaluated" ||
          r.operationReference !== identity.operationReference ||
          r.successorDraftVersionReference !==
            receiptContent.supportedContent.successorDraftVersionReference
        )
          return fail();
        return await read();
      } catch (error) {
        poisoned = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    },
    async revalidate() {
      if (!admitted || active || poisoned) {
        poisoned = true;
        return fail();
      }
      active = true;
      try {
        const result = await read();
        if (
          !original ||
          canonicalizeRfc8785(stable(result.original)) !== canonicalizeRfc8785(stable(original))
        )
          return fail();
        return result;
      } catch (error) {
        poisoned = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    },
  });
}

export type FullOptionSetPublicationSourceAction = "SubmitReview" | "Approve" | "Publish";
export interface FullOptionSetPublicationSourceRequest {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
}
export const fullOptionSetPublicationSourceAdmissionFields = Object.freeze([
  ...currentFullOptionSetDraftReviewFields,
  "operationReference",
  "reasonCode",
  "originalObservedAt",
  "originalValidUntil",
  "sealIdentity",
]);
export interface FullOptionSetPublicationSourceAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action:
        "catalog.option_set.submit" | "catalog.option_set.read" | "catalog.option_set.publish";
      readonly purposeCode: "CATALOG_OPTION_SET_PUBLICATION";
      readonly phase: "Intent" | "Current" | "Final";
      readonly requiredFields: readonly string[];
      readonly request: FullOptionSetPublicationSourceRequest;
      readonly operationReference: string;
      readonly reasonCode: string;
      readonly originalObservedAt: string;
      readonly originalValidUntil: string;
      readonly sealIdentity: FullOptionSetPublicationSealIdentity | null;
      readonly current: FullOptionReviewView | null;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
/** Catalog barrier before the Publishing operation fence. Source facts and
 * locks do not authorize qualification, approval, or a Publishing mutation.
 * Actual committed original receipts must be inspected before this new-write
 * admission; this entry never requalifies a historical operation as current. */
export function createPostgresFullOptionSetPublicationSourceAdmissionStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly action: FullOptionSetPublicationSourceAction;
  readonly operationReference: string;
  readonly reasonCode: string;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly sealCommand?: unknown;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: FullOptionSetPublicationSourceAuthority;
  readonly currentDraftAuthority: CurrentFullOptionSetDraftAuthority;
  readonly frozenAuthority?: FrozenFullOptionSetContentAuthority;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    operation = parseCatalogReference(options.operationReference),
    reason = parseCatalogCode(options.reasonCode),
    origin = parseCatalogInstant(options.originalObservedAt),
    until = parseCatalogInstant(options.originalValidUntil),
    action = options.action;
  const clockPort = options.clock?.now,
    runPort = options.transactions?.run,
    authorityPort = options.authority?.holdUntilTransactionCompletes,
    currentPort = options.currentDraftAuthority?.holdUntilTransactionCompletes,
    frozenPort = options.frozenAuthority?.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit;
  if (
    (action !== "SubmitReview" && action !== "Approve" && action !== "Publish") ||
    reason !== options.reasonCode ||
    until <= origin ||
    Date.parse(until) - Date.parse(origin) > 5000 ||
    typeof clockPort !== "function" ||
    typeof runPort !== "function" ||
    typeof authorityPort !== "function" ||
    typeof currentPort !== "function" ||
    typeof registerPort !== "function" ||
    (action === "Publish"
      ? options.sealCommand === undefined || typeof frozenPort !== "function"
      : options.sealCommand !== undefined || options.frozenAuthority !== undefined)
  )
    return fail();
  const run = runPort.bind(options.transactions);
  const seal =
    action === "Publish" ? parseFullOptionSetContentSealCommand(options.sealCommand) : null;
  const sealIdentity = seal
    ? parseFullOptionSetPublicationSealIdentity({
        operationReference: seal.operation,
        occurredAt: seal.at,
        publicationIntentDigest: createCatalogFullOptionSetContentSealIntent({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          command: seal.command,
        }),
      })
    : null;
  if (sealIdentity && (sealIdentity.occurredAt < origin || sealIdentity.occurredAt >= until))
    return fail();
  const fineAction =
    action === "SubmitReview"
      ? ("catalog.option_set.submit" as const)
      : action === "Publish"
        ? ("catalog.option_set.publish" as const)
        : ("catalog.option_set.read" as const);
  let entered = false,
    ready = false,
    poisoned = false,
    workRunning = false,
    busy = false,
    guardCalls = 0,
    finalCalls = 0,
    guardComplete = false,
    latest = origin,
    deadline = until,
    tx: Transaction | undefined,
    query: Transaction["query"] | undefined,
    original: FullOptionReviewView | undefined,
    request: FullOptionSetPublicationSourceRequest | undefined,
    handoffAdmitted = false;
  let handoff: ReturnType<typeof createPostgresFullOptionSetSealHandoffStore> | undefined;
  const poison = (): never => {
    poisoned = true;
    return fail();
  };
  const check = () => {
    const now = parseCatalogInstant(clockPort.call(options.clock));
    const descriptor = tx ? Object.getOwnPropertyDescriptor(tx, "query") : undefined;
    if (
      poisoned ||
      now < latest ||
      now >= deadline ||
      options.clock.now !== clockPort ||
      options.transactions.run !== runPort ||
      options.authority.holdUntilTransactionCompletes !== authorityPort ||
      options.currentDraftAuthority.holdUntilTransactionCompletes !== currentPort ||
      options.frozenAuthority?.holdUntilTransactionCompletes !== frozenPort ||
      options.registerBeforeCommit !== registerPort ||
      (tx && (!descriptor || !("value" in descriptor) || descriptor.value !== query))
    )
      return poison();
    latest = now;
    return now;
  };
  const tighten = (value: string) => {
    const at = parseCatalogInstant(value);
    if (at < deadline) deadline = at;
    check();
  };
  const held = async (phase: "Intent" | "Current" | "Final") => {
    if (!tx || !request) return poison();
    const observedAt = check(),
      evidence = closed(
        copyCategoryPersistenceValue(
          await authorityPort.call(options.authority, tx, {
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            actorKind: "User",
            permission: "catalog.manage",
            action: fineAction,
            purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
            phase,
            requiredFields: fullOptionSetPublicationSourceAdmissionFields,
            request,
            operationReference: operation,
            reasonCode: reason,
            originalObservedAt: origin,
            originalValidUntil: until,
            sealIdentity,
            current: original ?? null,
            observedAt,
          }),
        ),
        ["observedAt", "validUntil"],
      );
    if (
      evidence.observedAt !== observedAt ||
      parseCatalogInstant(evidence.validUntil) <= observedAt
    )
      return poison();
    tighten(parseCatalogInstant(evidence.validUntil));
  };
  const stable = ({ observedAt, validUntil, ...value }: FullOptionReviewView) => {
    void observedAt;
    void validUntil;
    return value;
  };
  const read = async () => {
    if (!tx || !request) return poison();
    const actualTx = tx;
    const view = await createCurrentFullOptionSetDraftStoreKernel(
      {
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now: check },
        transactions: { run: (work) => work(actualTx) },
        authority: {
          async holdUntilTransactionCompletes(actual, input) {
            if (actual !== actualTx) return poison();
            check();
            const evidence = await currentPort.call(options.currentDraftAuthority, actualTx, input);
            check();
            return evidence;
          },
        },
      },
      deadline,
    ).readCurrentForReview({
      optionSetReference: request.optionSetReference,
      expectedAggregateVersion: request.expectedAggregateVersion,
    });
    tighten(view.validUntil);
    const aggregate = view.content.sourceAggregate;
    if (
      aggregate.draft.versionReference !== request.versionReference ||
      view.sourceDigest !== request.sourceDigest ||
      view.contentDigest !== request.contentDigest ||
      view.configurationDigest !== request.configurationDigest ||
      view.observedAt < origin ||
      view.observedAt > check() ||
      view.sourceSnapshotTuple.tenantReference !== tenant ||
      view.sourceSnapshotTuple.brandReference !== brand
    )
      return poison();
    return view;
  };
  return Object.freeze({
    async withOriginalSource<T>(
      value: unknown,
      work: (source: {
        readonly current: FullOptionReviewView;
        readonly action: FullOptionSetPublicationSourceAction;
        readonly originalObservedAt: string;
        readonly validUntil: string;
        readonly sealIdentity: FullOptionSetPublicationSealIdentity | null;
        readonly referenceEligibility: "NotEvaluated";
        readonly admitOwnSeal: (
          receipt: unknown,
        ) => Promise<
          Awaited<
            ReturnType<ReturnType<typeof createPostgresFullOptionSetSealHandoffStore>["admit"]>
          >
        >;
      }) => Promise<T>,
    ): Promise<T> {
      if (entered || typeof work !== "function") return poison();
      entered = true;
      try {
        const input = closed(copyCategoryPersistenceValue(value), [
          "optionSetReference",
          "versionReference",
          "expectedAggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
        ]);
        const expected = input.expectedAggregateVersion;
        if (
          typeof expected !== "number" ||
          !Number.isSafeInteger(expected) ||
          expected < 1 ||
          expected >= 2147483647 ||
          [input.sourceDigest, input.contentDigest, input.configurationDigest].some(
            (v) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v),
          )
        )
          return poison();
        request = Object.freeze({
          optionSetReference: parseCatalogReference(input.optionSetReference),
          versionReference: parseCatalogReference(input.versionReference),
          expectedAggregateVersion: expected,
          sourceDigest: String(input.sourceDigest),
          contentDigest: String(input.contentDigest),
          configurationDigest: String(input.configurationDigest),
        });
        if (
          seal &&
          (seal.set !== request.optionSetReference ||
            seal.version !== request.versionReference ||
            seal.expected !== expected ||
            seal.sourceDigest !== request.sourceDigest ||
            seal.contentDigest !== request.contentDigest ||
            seal.configurationDigest !== request.configurationDigest)
        )
          return poison();
        let calls = 0,
          complete = false;
        let produced: T | undefined;
        const result = await run(async (actual) => {
          if (++calls !== 1 || tx) return poison();
          tx = actual;
          query = actual.query;
          check();
          await held("Intent");
          await requireCategoryCurrentReads(actual);
          const remaining = Math.max(1, Math.min(5000, Date.parse(deadline) - Date.parse(check())));
          await actual.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout',$3,true),set_config('statement_timeout',$3,true)",
            [tenant, brand, String(remaining)],
          );
          check();
          if (sealIdentity) {
            await actual.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "CatalogFullOptionOperation:" + sealIdentity.operationReference,
            ]);
            check();
          }
          const sourceRemaining = Math.max(
            1,
            Math.min(5000, Date.parse(deadline) - Date.parse(check())),
          );
          await actual.query(
            "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            [String(sourceRemaining)],
          );
          check();
          await actual.query(
            action === "Publish"
              ? "SELECT pg_advisory_xact_lock(hashtextextended($1,0))"
              : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
            ["CatalogFullOptionSource:" + brand + ":" + request?.optionSetReference],
          );
          check();
          if (action === "SubmitReview") {
            const currentRequest = request;
            if (!currentRequest) return poison();
            const reviewRemaining = Math.max(
              1,
              Math.min(5000, Date.parse(deadline) - Date.parse(check())),
            );
            await actual.query(
              "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
              [String(reviewRemaining)],
            );
            check();
            await actual.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "CatalogOptionCurrentReview:" +
                tenant +
                ":" +
                brand +
                ":" +
                currentRequest.optionSetReference,
            ]);
            check();
          }
          original = await read();
          await held("Current");
          if (sealIdentity && frozenPort)
            handoff = createPostgresFullOptionSetSealHandoffStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              sealIdentity,
              clock: { now: check },
              transactions: { run: (callback) => callback(actual) },
              currentDraftAuthority: {
                async holdUntilTransactionCompletes(heldTx, packet) {
                  if (heldTx !== actual) return poison();
                  check();
                  const evidence = await currentPort.call(
                    options.currentDraftAuthority,
                    actual,
                    packet,
                  );
                  check();
                  return evidence;
                },
              },
              frozenAuthority: {
                async holdUntilTransactionCompletes(heldTx, packet) {
                  if (heldTx !== actual) return poison();
                  check();
                  const evidence = await frozenPort.call(options.frozenAuthority, actual, packet);
                  check();
                  return evidence;
                },
              },
            });
          const registration = await registerPort(
            actual,
            async () => {
              if (!ready || workRunning || busy || ++guardCalls !== 1 || !original) return poison();
              busy = true;
              try {
                await held("Final");
                if (action === "Publish") {
                  if (!handoffAdmitted || !handoff) return poison();
                  const proof = await handoff.revalidate();
                  tighten(proof.validUntil);
                } else {
                  const current = await read();
                  if (
                    canonicalizeRfc8785(stable(current)) !== canonicalizeRfc8785(stable(original))
                  )
                    return poison();
                }
                await held("Final");
                check();
                guardComplete = true;
              } catch (error) {
                poisoned = true;
                throw error;
              } finally {
                busy = false;
              }
            },
            () => {
              if (
                !ready ||
                workRunning ||
                busy ||
                !guardComplete ||
                guardCalls !== 1 ||
                ++finalCalls !== 1
              )
                return poison();
              check();
            },
          );
          if (registration !== undefined) return poison();
          check();
          workRunning = true;
          try {
            if (!original) return poison();
            const view = original;
            produced = await work(
              Object.freeze({
                current: view,
                action,
                originalObservedAt: origin,
                validUntil: deadline,
                sealIdentity,
                referenceEligibility: "NotEvaluated" as const,
                async admitOwnSeal(receipt: unknown) {
                  if (!workRunning || busy || handoffAdmitted || !handoff || !original || ready)
                    return poison();
                  busy = true;
                  try {
                    await held("Current");
                    const proof = await handoff.admit(original, receipt);
                    tighten(proof.validUntil);
                    await held("Current");
                    handoffAdmitted = true;
                    return proof;
                  } catch (error) {
                    poisoned = true;
                    throw error;
                  } finally {
                    busy = false;
                  }
                },
              }),
            );
            check();
            if (action === "Publish" && !handoffAdmitted) return poison();
            ready = true;
            complete = true;
            return produced;
          } finally {
            workRunning = false;
          }
        });
        if (calls !== 1 || !complete || result !== produced) return poison();
        check();
        return result;
      } catch (error) {
        poisoned = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
