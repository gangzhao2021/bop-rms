import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  parseCatalogOptionSetHistoryRequest,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoricalDraftRequest,
  parseCatalogOptionSetHistoricalFrozenRequest,
  parseCatalogOptionSetHistoricalFrozenResult,
  type OptionSetHistoricalFrozenRequest,
  parseCatalogOptionSetHistoricalDraftResult,
  type OptionSetHistoryRequest,
  type OptionSetHistoricalDraftRequest,
} from "../../contracts/option-set-history.js";
import { currentFullOptionSetDraftFields } from "./option-set-full-draft-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";

function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const copied = copyCategoryPersistenceValue(value);
  if (
    copied === null ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.getPrototypeOf(copied) !== Object.prototype ||
    Reflect.ownKeys(copied).length !== keys.length ||
    Reflect.ownKeys(copied).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return copied as Record<string, unknown>;
}

export const optionSetHistoryFields = Object.freeze([
  "optionSetReference",
  "currentAggregateVersion",
  "operationReference",
  "action",
  "intentDigest",
  "resultAggregateVersion",
  "kind",
  "occurredAt",
  "availability",
  "versionReference",
  "sourceAggregateVersion",
  "sourceDigest",
  "contentDigest",
  "configurationDigest",
  "recordDigest",
]);
export const optionSetHistoricalDraftFields = Object.freeze([
  ...currentFullOptionSetDraftFields,
  "operationReference",
  "action",
  "intentDigest",
  "resultAggregateVersion",
  "occurredAt",
  "sourceDigest",
  "contentDigest",
  "configurationDigest",
]);
export const optionSetHistoricalFrozenFields = Object.freeze([
  ...optionSetHistoricalDraftFields,
  "recordDigest",
  "sourceAggregateVersion",
  "sealedAt",
  "successorDraftVersionReference",
  "recordingStatus",
]);
export interface OptionSetHistoryStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: Readonly<{
        tenantReference: string;
        brandReference: string;
        actorReference: string;
        actorKind: "User";
        permission: "catalog.manage";
        action: "catalog.option_set.history.read";
        purposeCode: "CATALOG_OPTION_SET_HISTORY";
        requiredFields: readonly string[];
        request:
          | OptionSetHistoryRequest
          | OptionSetHistoricalDraftRequest
          | OptionSetHistoricalFrozenRequest;
        content: unknown;
        observedAt: string;
      }>,
    ): Promise<Readonly<{ observedAt: string; validUntil: string }>>;
  };
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const utc = (v: string) => `to_char(${v} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Headers only: no historical snapshot body is returned by a roster page.
const rosterSql = `/* OptionSetHistoryRosterV1 */
WITH facts AS (
 SELECT o.*, f.operation_id draft_op, f.tenant_id draft_tenant, f.option_set_version_id draft_version,
 f.action_code draft_action, f.intent_digest draft_intent, f.result_aggregate_version draft_revision,
 f.occurred_at draft_at,f.source_digest draft_source,f.content_digest draft_content,f.configuration_digest draft_configuration,
 (f.data_classification='ConfigurationMetadata' AND f.snapshot_json->>'profile'='CatalogOptionSetEditorContentV1'
 AND f.snapshot_json#>>'{sourceAggregate,optionSetReference}'=o.option_set_id::text
 AND f.snapshot_json#>>'{sourceAggregate,brandReference}'=o.brand_id::text
 AND f.snapshot_json#>>'{sourceAggregate,draft,versionReference}'=f.option_set_version_id::text
 AND f.snapshot_json#>'{sourceAggregate,aggregateVersion}'=to_jsonb(o.result_aggregate_version)
 AND f.snapshot_json#>>'{sourceAggregate,updatedAt}'=${utc("o.occurred_at")}
 AND s.aggregate_version>=f.result_aggregate_version
 AND f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code
 AND f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text
 AND date_trunc('milliseconds',s.created_at)=s.created_at
 AND f.snapshot_json#>>'{sourceAggregate,createdAt}'=${utc("s.created_at")}
 AND octet_length(f.snapshot_json::text)<=1048576) draft_body,
 p.operation_id seal_op,p.tenant_id seal_tenant,p.option_set_version_id seal_version,
 p.action_code seal_action,p.intent_digest seal_intent,p.result_aggregate_version seal_revision,p.source_aggregate_version seal_source_revision,
 p.sealed_at seal_at,p.source_digest seal_source,p.content_digest seal_content,p.configuration_digest seal_configuration,p.record_digest seal_digest,
 (p.data_classification='ConfigurationMetadata' AND p.snapshot_json->>'profile'='CatalogFullOptionSetDraftContentV2'
 AND p.snapshot_json#>>'{supportedContent,optionSetReference}'=o.option_set_id::text
 AND p.snapshot_json#>>'{supportedContent,versionReference}'=p.option_set_version_id::text
 AND p.snapshot_json#>>'{supportedContent,publicationOperationReference}'=o.operation_id::text
 AND p.snapshot_json->>'digest'=p.record_digest AND v.status='Frozen') seal_body
 FROM rms_catalog.option_set_operation_record o
 JOIN rms_catalog.option_set s ON s.brand_id=o.brand_id AND s.option_set_id=o.option_set_id
 LEFT JOIN rms_catalog.option_set_draft_content_snapshot f ON f.operation_id=o.operation_id AND f.brand_id=o.brand_id AND f.option_set_id=o.option_set_id
 LEFT JOIN rms_catalog.option_set_publication_content p ON p.operation_id=o.operation_id AND p.brand_id=o.brand_id AND p.option_set_id=o.option_set_id
 LEFT JOIN rms_catalog.option_set_version v ON v.option_set_version_id=p.option_set_version_id AND v.brand_id=o.brand_id AND v.option_set_id=o.option_set_id
 WHERE o.brand_id=$2 AND o.option_set_id=$3
), entries AS (
 SELECT result_aggregate_version,operation_id,'DraftSnapshot'::text kind,
 jsonb_build_object('resultAggregateVersion',result_aggregate_version,'operationReference',operation_id,'kind','DraftSnapshot','action',action_code,'occurredAt',${utc("occurred_at")},'availability','Complete','versionReference',draft_version,'sourceAggregateVersion',result_aggregate_version,'sourceDigest',draft_source,'contentDigest',draft_content,'configurationDigest',draft_configuration,'recordDigest',NULL) entry,
 (draft_tenant=$1 AND draft_action=action_code AND draft_intent=intent_digest AND draft_revision=result_aggregate_version AND draft_at=occurred_at AND draft_body AND (action_code<>'Publish' OR seal_op IS NOT NULL)) coherent
 FROM facts WHERE draft_op IS NOT NULL
 UNION ALL
 SELECT result_aggregate_version,operation_id,'FrozenSeal'::text,
 jsonb_build_object('resultAggregateVersion',result_aggregate_version,'operationReference',operation_id,'kind','FrozenSeal','action',action_code,'occurredAt',${utc("occurred_at")},'availability','Complete','versionReference',seal_version,'sourceAggregateVersion',seal_source_revision,'sourceDigest',seal_source,'contentDigest',seal_content,'configurationDigest',seal_configuration,'recordDigest',seal_digest),
 (seal_tenant=$1 AND action_code='Publish' AND seal_action=action_code AND seal_intent=intent_digest AND seal_revision=result_aggregate_version AND seal_at=occurred_at AND seal_body AND draft_op IS NOT NULL)
 FROM facts WHERE seal_op IS NOT NULL
 UNION ALL
 SELECT result_aggregate_version,operation_id,'OperationOnly'::text,
 jsonb_build_object('resultAggregateVersion',result_aggregate_version,'operationReference',operation_id,'kind','OperationOnly','action',action_code,'occurredAt',${utc("occurred_at")},'availability','UnavailableLegacy','versionReference',NULL,'sourceAggregateVersion',NULL,'sourceDigest',NULL,'contentDigest',NULL,'configurationDigest',NULL,'recordDigest',NULL),true
 FROM facts WHERE draft_op IS NULL AND seal_op IS NULL
)
SELECT entry,coherent FROM entries
WHERE $4::integer IS NULL OR (result_aggregate_version,operation_id,kind COLLATE "C") < ($4,$5::uuid,$6::text COLLATE "C")
ORDER BY result_aggregate_version DESC,operation_id DESC,kind COLLATE "C" DESC LIMIT $7`;
const selectedSql = `/* OptionSetHistoricalDraftV1 */
SELECT f.snapshot_json content, jsonb_build_object('operationReference',o.operation_id,'versionReference',f.option_set_version_id,'resultAggregateVersion',f.result_aggregate_version,'action',o.action_code,'intentDigest',o.intent_digest,'occurredAt',${utc("o.occurred_at")}) original,
f.source_digest,f.content_digest,f.configuration_digest,
(f.action_code=o.action_code AND f.intent_digest=o.intent_digest AND f.result_aggregate_version=o.result_aggregate_version AND f.occurred_at=o.occurred_at AND f.brand_id=o.brand_id AND f.option_set_id=o.option_set_id AND f.data_classification='ConfigurationMetadata' AND octet_length(f.snapshot_json::text)<=1048576
 AND s.aggregate_version>=f.result_aggregate_version
 AND f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code
 AND f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text
 AND date_trunc('milliseconds',s.created_at)=s.created_at
 AND f.snapshot_json#>>'{sourceAggregate,createdAt}'=${utc("s.created_at")}) coherent
FROM rms_catalog.option_set_draft_content_snapshot f JOIN rms_catalog.option_set_operation_record o ON o.operation_id=f.operation_id
JOIN rms_catalog.option_set s ON s.brand_id=f.brand_id AND s.option_set_id=f.option_set_id
JOIN rms_catalog.option_set_version v ON v.option_set_version_id=f.option_set_version_id AND v.brand_id=f.brand_id AND v.option_set_id=f.option_set_id
WHERE f.tenant_id=$1 AND f.brand_id=$2 AND f.option_set_id=$3 AND f.operation_id=$4 AND f.option_set_version_id=$5 AND f.result_aggregate_version=$6`;
const selectedFrozenSql = `/* OptionSetHistoricalFrozenV1 */
SELECT p.snapshot_json content,jsonb_build_object('operationReference',o.operation_id,'versionReference',p.option_set_version_id,'resultAggregateVersion',p.result_aggregate_version,'action',o.action_code,'intentDigest',o.intent_digest,'occurredAt',${utc("o.occurred_at")}) original,
p.source_digest,p.content_digest,p.configuration_digest,p.record_digest,
(p.action_code='Publish' AND o.action_code=p.action_code AND p.intent_digest=o.intent_digest AND p.result_aggregate_version=o.result_aggregate_version
 AND p.sealed_at=o.occurred_at AND p.brand_id=o.brand_id AND p.option_set_id=o.option_set_id AND p.data_classification='ConfigurationMetadata'
 AND v.status='Frozen' AND p.result_aggregate_version=p.source_aggregate_version+1 AND s.aggregate_version>=p.result_aggregate_version
 AND p.snapshot_json->>'profile'='CatalogFullOptionSetDraftContentV2' AND octet_length(p.snapshot_json::text)<=3145728
 AND p.snapshot_json->>'digest'=p.record_digest AND p.snapshot_json->>'sourceDigest'=p.source_digest
 AND p.snapshot_json->>'contentDigest'=p.content_digest AND p.snapshot_json->>'configurationDigest'=p.configuration_digest
 AND p.snapshot_json#>>'{supportedContent,publicationOperationReference}'=o.operation_id::text
 AND p.snapshot_json#>>'{supportedContent,publicationIntentDigest}'=p.intent_digest
 AND p.snapshot_json#>>'{supportedContent,tenantReference}'=p.tenant_id::text
 AND p.snapshot_json#>>'{supportedContent,brandReference}'=p.brand_id::text
 AND p.snapshot_json#>>'{supportedContent,optionSetReference}'=p.option_set_id::text
 AND p.snapshot_json#>>'{supportedContent,versionReference}'=p.option_set_version_id::text
 AND p.snapshot_json#>>'{supportedContent,successorDraftVersionReference}'=p.successor_draft_version_id::text
 AND p.snapshot_json#>'{supportedContent,sourceAggregateVersion}'=to_jsonb(p.source_aggregate_version)
 AND p.snapshot_json#>>'{supportedContent,sealedAt}'=${utc("p.sealed_at")}
 AND p.snapshot_json#>>'{editorContent,sourceAggregate,internalCode}'=s.internal_code
 AND p.snapshot_json#>>'{editorContent,sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text
 AND date_trunc('milliseconds',s.created_at)=s.created_at
 AND p.snapshot_json#>>'{editorContent,sourceAggregate,createdAt}'=${utc("s.created_at")}) coherent
FROM rms_catalog.option_set_publication_content p
JOIN rms_catalog.option_set_operation_record o ON o.operation_id=p.operation_id AND o.brand_id=p.brand_id AND o.option_set_id=p.option_set_id
JOIN rms_catalog.option_set s ON s.brand_id=p.brand_id AND s.option_set_id=p.option_set_id
JOIN rms_catalog.option_set_version v ON v.option_set_version_id=p.option_set_version_id AND v.brand_id=p.brand_id AND v.option_set_id=p.option_set_id
WHERE p.tenant_id=$1 AND p.brand_id=$2 AND p.option_set_id=$3 AND p.operation_id=$4 AND p.option_set_version_id=$5 AND p.result_aggregate_version=$6`;
function rows(value: unknown, maximum: number): readonly unknown[] {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d)) return fail();
  const copied = copyCategoryPersistenceValue(d.value);
  if (!Array.isArray(copied) || copied.length > maximum) return fail();
  return copied;
}
/** Owning immutable Catalog history only, not Publishing or current eligibility.
 * The supplied host must run both registered guards before its actual COMMIT. */
export function createPostgresOptionSetHistoryStore(options: OptionSetHistoryStoreOptions) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  const clockPort = options.clock.now,
    runPort = options.transactions.run,
    holdPort = options.authority.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit;
  if ([clockPort, runPort, holdPort, registerPort].some((v) => typeof v !== "function"))
    return fail();
  const clock = clockPort.bind(options.clock),
    run = runPort.bind(options.transactions),
    holdAuthority = holdPort.bind(options.authority),
    register = registerPort.bind(options);
  const origin = parseCatalogInstant(options.originalObservedAt),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= origin || Date.parse(originalDeadline) - Date.parse(origin) > 5000)
    return fail();
  let active = false,
    failed = false;
  const finalizers: (() => string)[] = [];
  const poison = (): never => {
    failed = true;
    return fail();
  };
  async function execute<T extends { readonly validUntil: string }>(
    request:
      OptionSetHistoryRequest | OptionSetHistoricalDraftRequest | OptionSetHistoricalFrozenRequest,
    fields: readonly string[],
    load: (
      query: Transaction["query"],
      observedAt: string,
      deadline: () => string,
      currentAggregateVersion: number,
    ) => Promise<T>,
  ) {
    if (active || failed) return poison();
    active = true;
    let invocations = 0,
      guardCalls = 0,
      guardComplete = false,
      finalCalls = 0,
      ready = false,
      payload: T;
    let latest = origin,
      deadline = originalDeadline;
    try {
      const result = await run(async (tx) => {
        if (++invocations !== 1) return poison();
        const descriptor = Object.getOwnPropertyDescriptor(tx, "query");
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
          return poison();
        const originalQuery: Transaction["query"] = descriptor.value,
          query = originalQuery.bind(tx);
        const check = () => {
          const d = Object.getOwnPropertyDescriptor(tx, "query"),
            at = parseCatalogInstant(clock());
          if (
            failed ||
            !d ||
            !("value" in d) ||
            d.value !== originalQuery ||
            options.clock.now !== clockPort ||
            options.transactions.run !== runPort ||
            options.authority.holdUntilTransactionCompletes !== holdPort ||
            options.registerBeforeCommit !== registerPort ||
            options.tenantReference !== tenant ||
            options.brandReference !== brand ||
            options.actorReference !== actor ||
            options.originalObservedAt !== origin ||
            options.originalValidUntil !== originalDeadline ||
            at < latest ||
            at >= deadline
          )
            return poison();
          latest = at;
          return at;
        };
        const observedAt = check();
        const queryCurrent: Transaction["query"] = async <Row>(
          sql: string,
          values: readonly unknown[],
        ) => {
          const at = check(),
            remaining = Math.max(1, Date.parse(deadline) - Date.parse(at));
          await query(
            "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
            [String(remaining)],
          );
          check();
          const value = await query<Row>(sql, values);
          check();
          return value;
        };
        const hold = async (content: unknown) => {
          const at = check(),
            evidence = readClosedRecord(
              copyCategoryPersistenceValue(
                await holdAuthority(
                  tx,
                  Object.freeze({
                    tenantReference: tenant,
                    brandReference: brand,
                    actorReference: actor,
                    actorKind: "User",
                    permission: "catalog.manage",
                    action: "catalog.option_set.history.read",
                    purposeCode: "CATALOG_OPTION_SET_HISTORY",
                    requiredFields: fields,
                    request,
                    content: copyCategoryPersistenceValue(content),
                    observedAt: at,
                  }),
                ),
              ),
              ["observedAt", "validUntil"],
            );
          const until = parseCatalogInstant(evidence.validUntil);
          if (
            evidence.observedAt !== at ||
            until <= at ||
            Date.parse(until) - Date.parse(at) > 5000
          )
            return poison();
          if (until < deadline) deadline = until;
          check();
        };
        const registered = await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1 || !ready || active) return poison();
              await hold(payload);
              check();
              guardComplete = true;
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          () => {
            if (++finalCalls !== 1 || guardCalls !== 1 || !guardComplete || !ready || active)
              return poison();
            check();
          },
        );
        if (registered !== undefined) return poison();
        finalizers.push(() => {
          if (guardCalls !== 1 || !guardComplete || finalCalls !== 1 || !ready || active)
            return poison();
          check();
          return deadline;
        });
        await hold(null);
        // This adapter is only for the pure owning isolation check. Authority
        // always receives the original tx; queryCurrent checks its actual identity.
        await requireCategoryCurrentReads({ query: queryCurrent });
        await queryCurrent(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        await queryCurrent("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          "CatalogFullOptionSource:" + brand + ":" + request.optionSetReference,
        ]);
        const root = rows(
          await queryCurrent(
            "SELECT aggregate_version FROM rms_catalog.option_set WHERE brand_id=$1 AND option_set_id=$2 FOR SHARE",
            [brand, request.optionSetReference],
          ),
          1,
        );
        if (root.length !== 1) return fail("CATALOG_UNAVAILABLE");
        const header = readClosedRecord(root[0], ["aggregate_version"]);
        if (
          !Number.isSafeInteger(header.aggregate_version) ||
          (header.aggregate_version as number) < 1 ||
          (header.aggregate_version as number) > 2147483647
        )
          return poison();
        if (
          "expectedAggregateVersion" in request &&
          request.expectedAggregateVersion !== null &&
          request.expectedAggregateVersion !== header.aggregate_version
        )
          return fail("CATALOG_VERSION_CONFLICT");
        // Root/shared source locks protect roster pagination and all original
        // immutable facts; current authority itself is freshly reheld at COMMIT.
        payload = await load(
          queryCurrent,
          observedAt,
          () => deadline,
          header.aggregate_version as number,
        );
        await hold(payload);
        payload = Object.freeze({ ...payload, validUntil: deadline });
        check();
        ready = true;
        active = false;
        return payload;
      });
      if (invocations !== 1 || !ready) return poison();
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    /** Held reads may return inside a borrowed outer runner. Only the actual
     * outer host can complete its registered guards; call after that COMMIT. */
    assertFinalized() {
      if (failed || active || finalizers.length === 0) return poison();
      let finalDeadline: string = originalDeadline;
      for (const finalizer of finalizers) {
        const until = finalizer();
        if (until < finalDeadline) finalDeadline = until;
      }
      return finalDeadline;
    },
    async listHistory(value: unknown) {
      const request = parseCatalogOptionSetHistoryRequest(value);
      return execute(
        request,
        optionSetHistoryFields,
        async (query, observedAt, deadline, revision) => {
          const before = request.before;
          const entries = rows(
            await query(rosterSql, [
              tenant,
              brand,
              request.optionSetReference,
              before?.resultAggregateVersion ?? null,
              before?.operationReference ?? null,
              before?.kind ?? null,
              request.limit + 1,
            ]),
            request.limit + 1,
          ).map((v) => {
            const r = readClosedRecord(v, ["entry", "coherent"]);
            if (r.coherent !== true) return poison();
            return r.entry;
          });
          // Validate the look-ahead row too; it cannot conceal corrupt source
          // metadata simply because it will appear on the next page.
          for (const entry of entries)
            parseCatalogOptionSetHistoryResult(
              {
                profile: "CatalogOptionSetHistoryV1",
                tenantReference: tenant,
                brandReference: brand,
                optionSetReference: request.optionSetReference,
                currentAggregateVersion: revision,
                entries: [entry],
                nextBefore: null,
                observedAt,
                validUntil: deadline(),
                publicationStatus: "NotEvaluated",
              },
              request,
            );
          const visible = entries.slice(0, request.limit),
            last = visible.at(-1);
          let nextBefore: unknown = null;
          if (entries.length > request.limit) {
            const e = readClosedRecord(last, [
              "resultAggregateVersion",
              "operationReference",
              "kind",
              "action",
              "occurredAt",
              "availability",
              "versionReference",
              "sourceAggregateVersion",
              "sourceDigest",
              "contentDigest",
              "configurationDigest",
              "recordDigest",
            ]);
            nextBefore = {
              resultAggregateVersion: e.resultAggregateVersion,
              operationReference: e.operationReference,
              kind: e.kind,
            };
          }
          return parseCatalogOptionSetHistoryResult(
            {
              profile: "CatalogOptionSetHistoryV1",
              tenantReference: tenant,
              brandReference: brand,
              optionSetReference: request.optionSetReference,
              currentAggregateVersion: revision,
              entries: visible,
              nextBefore,
              observedAt,
              validUntil: deadline(),
              publicationStatus: "NotEvaluated",
            },
            request,
          );
        },
      );
    },
    async readHistoricalFrozen(value: unknown) {
      const request = parseCatalogOptionSetHistoricalFrozenRequest(value);
      return execute(
        request,
        optionSetHistoricalFrozenFields,
        async (query, observedAt, deadline) => {
          const found = rows(
            await query(selectedFrozenSql, [
              tenant,
              brand,
              request.optionSetReference,
              request.operationReference,
              request.versionReference,
              request.resultAggregateVersion,
            ]),
            1,
          );
          if (found.length === 0) return fail("CATALOG_UNAVAILABLE");
          const r = readClosedRecord(found[0], [
            "content",
            "original",
            "source_digest",
            "content_digest",
            "configuration_digest",
            "record_digest",
            "coherent",
          ]);
          if (r.coherent !== true || r.content === null) return poison();
          return parseCatalogOptionSetHistoricalFrozenResult(
            {
              profile: "CatalogOptionSetHistoricalFrozenV1",
              tenantReference: tenant,
              brandReference: brand,
              optionSetReference: request.optionSetReference,
              originalTuple: r.original,
              content: r.content,
              sourceDigest: r.source_digest,
              contentDigest: r.content_digest,
              configurationDigest: r.configuration_digest,
              recordDigest: r.record_digest,
              observedAt,
              validUntil: deadline(),
              recordingStatus: "RecordedFrozen",
              referenceEligibility: "NotEvaluated",
            },
            request,
          );
        },
      );
    },
    async readHistoricalDraft(value: unknown) {
      const request = parseCatalogOptionSetHistoricalDraftRequest(value);
      return execute(
        request,
        optionSetHistoricalDraftFields,
        async (query, observedAt, deadline) => {
          const found = rows(
            await query(selectedSql, [
              tenant,
              brand,
              request.optionSetReference,
              request.operationReference,
              request.versionReference,
              request.resultAggregateVersion,
            ]),
            1,
          );
          if (found.length === 0) return fail("CATALOG_UNAVAILABLE");
          const r = readClosedRecord(found[0], [
            "content",
            "original",
            "source_digest",
            "content_digest",
            "configuration_digest",
            "coherent",
          ]);
          if (r.coherent !== true || r.content === null) return poison();
          return parseCatalogOptionSetHistoricalDraftResult(
            {
              profile: "CatalogOptionSetHistoricalDraftV1",
              tenantReference: tenant,
              brandReference: brand,
              optionSetReference: request.optionSetReference,
              originalTuple: r.original,
              content: r.content,
              sourceDigest: r.source_digest,
              contentDigest: r.content_digest,
              configurationDigest: r.configuration_digest,
              observedAt,
              validUntil: deadline(),
              referenceEligibility: "NotEvaluated",
            },
            request,
          );
        },
      );
    },
  });
}
