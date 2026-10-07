import {
  parseOptionSetPublicationHistoryRequest,
  optionSetPublicationHistoryFields,
  readOptionSetHistoryRecord,
} from "../../contracts/option-set-publication-history.js";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingInstant,
  parsePublishingVersion,
  parseReleaseSequence,
  createPublishingScope,
  samePublishingScope,
} from "../../contracts/publishing.js";
import { evaluatePublishingTransition } from "../../domain/evaluate-publishing-transition.js";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "./publishing-mutation-store.js";

const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
export interface OptionSetPublicationHistoryStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly selectedStoreReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: PublishingTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: PublishingTransaction,
      input: Readonly<{
        tenantReference: string;
        brandReference: string;
        selectedStoreReference: string;
        actorReference: string;
        actorKind: "User";
        familyReference: string;
        permission: "catalog.manage";
        requiredPermissions: readonly ["catalog.manage", "catalog.option_set.history.read"];
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION_HISTORY";
        requiredFields: typeof optionSetPublicationHistoryFields;
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<Readonly<{ validUntil: string }>>;
  };
}
const columns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "family_id",
  "lifecycle_id",
  "lifecycle_version",
  "operation_id",
  "operation_code",
  "actor_id",
  "audit_id",
  "intent_hash",
  "release_id",
  "release_sequence",
  "changed_at",
  "mutation_json",
] as const;
const select =
  "SELECT tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version::text,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence::text,to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') changed_at,mutation_json FROM bop_publishing.publishing_mutation_record";
const where =
  " WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND family_id=$3 AND mutation_json#>>'{next,configurationType}'='CATALOG_OPTION_SET' AND mutation_json#>>'{next,purposeCode}'='CATALOG_OPTION_SET_PUBLICATION'";
function rawRows(result: unknown, maximum: number) {
  if (!result || typeof result !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
  const values: unknown = descriptor.value;
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > maximum ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    return fail();
  return Array.from({ length: values.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(values, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    const value: unknown = d.value;
    return value;
  });
}
function rows(result: unknown, maximum: number) {
  return rawRows(result, maximum).map((row) => readOptionSetHistoryRecord(row, columns));
}
function decimal(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    String(Number(value)) !== value
  )
    return fail();
  return Number(value);
}
/** Borrowed original READ COMMITTED host. Results remain tentative until both registered guards finish. */
export function createPostgresOptionSetPublicationHistoryStore(
  options: OptionSetPublicationHistoryStoreOptions,
) {
  const tenant = parsePublishingReference(options.tenantReference),
    brand = parsePublishingReference(options.brandReference),
    store = parsePublishingReference(options.selectedStoreReference),
    actor = parsePublishingReference(options.actorReference);
  const clockPort = options.clock?.now,
    registerPort = options.registerBeforeCommit,
    authority = options.authority,
    holdPort = authority?.holdUntilTransactionCompletes;
  if (
    typeof clockPort !== "function" ||
    typeof registerPort !== "function" ||
    typeof holdPort !== "function"
  )
    return fail();
  const clock = clockPort.bind(options.clock),
    hold = holdPort.bind(authority),
    register = registerPort.bind(options),
    origin = parsePublishingInstant(clock());
  const originalDeadline = parsePublishingInstant(options.originalValidUntil);
  let deadline = originalDeadline,
    latest = origin,
    poisoned = false,
    entered = false,
    ready = false,
    active = false,
    guardComplete = false,
    guardCount = 0,
    finalCount = 0;
  if (deadline <= origin || Date.parse(deadline) - Date.parse(origin) > 5000) return fail();
  let capturedTx: PublishingTransaction | undefined,
    capturedQuery: PublishingTransaction["query"] | undefined;
  const reject = (error: unknown): never => {
    poisoned = true;
    if (error instanceof PublishingContractError) throw error;
    return fail();
  };
  const check = () => {
    try {
      const now = parsePublishingInstant(clock());
      if (
        poisoned ||
        now < latest ||
        now >= deadline ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.selectedStoreReference !== store ||
        options.actorReference !== actor ||
        options.originalValidUntil !== originalDeadline ||
        options.clock.now !== clockPort ||
        options.authority !== authority ||
        authority.holdUntilTransactionCompletes !== holdPort ||
        options.registerBeforeCommit !== registerPort ||
        capturedTx?.query !== capturedQuery
      )
        return fail();
      latest = now;
      return now;
    } catch (error) {
      return reject(error);
    }
  };
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: brand,
    storeReference: null,
  });
  const permissions = Object.freeze(["catalog.manage", "catalog.option_set.history.read"] as const);
  const auditActions = {
    CreateDraft: "PUBLISHING_DRAFT_CREATED",
    SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
    Approve: "PUBLISHING_REVIEW_APPROVED",
    Publish: "PUBLISHING_RELEASE_PUBLISHED",
    Archive: "PUBLISHING_RELEASE_ARCHIVED",
    Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
  } as const;
  return Object.freeze({
    async list(tx: PublishingTransaction, raw: unknown) {
      if (entered) return reject(new PublishingContractError("PUBLISHING_INPUT_INVALID"));
      entered = true;
      active = true;
      capturedTx = tx;
      capturedQuery = tx?.query;
      try {
        if (typeof capturedQuery !== "function") return fail();
        const rawQuery = capturedQuery.bind(tx),
          request = parseOptionSetPublicationHistoryRequest(raw);
        const query = async (sql: string, values: readonly unknown[]) => {
          const remaining = Date.parse(deadline) - Date.parse(check());
          if (remaining < 1 || remaining > 5000) return fail();
          await rawQuery(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
            [String(remaining)],
          );
          check();
          const result: unknown = await rawQuery(sql, values);
          check();
          return result;
        };
        const fresh = async () => {
          const observedAt = check();
          const proof = readOptionSetHistoryRecord(
            await hold(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                selectedStoreReference: store,
                actorReference: actor,
                actorKind: "User",
                familyReference: request.familyReference,
                permission: "catalog.manage",
                requiredPermissions: permissions,
                purposeCode: "CATALOG_OPTION_SET_PUBLICATION_HISTORY",
                requiredFields: optionSetPublicationHistoryFields,
                observedAt,
                validUntil: deadline,
              }),
            ),
            ["validUntil"],
          );
          const until = parsePublishingInstant(proof.validUntil);
          if (until <= observedAt || until > deadline) return fail();
          deadline = until;
          check();
          await query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          check();
        };
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guardCount !== 1)
                return reject(new PublishingContractError("PUBLISHING_INPUT_INVALID"));
              try {
                await fresh();
                guardComplete = true;
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              if (!ready || active || !guardComplete || guardCount !== 1 || ++finalCount !== 1)
                return reject(new PublishingContractError("PUBLISHING_INPUT_INVALID"));
              check();
            },
          )) !== undefined
        )
          return fail();
        await fresh();
        const environmentRows = rawRows(
          await query(
            "SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only",
            [],
          ),
          1,
        );
        const environment = readOptionSetHistoryRecord(environmentRows[0], [
          "isolation",
          "read_only",
        ]);
        if (environment.isolation !== "read committed" || environment.read_only !== "off")
          return fail();
        // Table-before-family matches the actual owning writer's lock order.
        await query("LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE MODE", []);
        check();
        await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          "PublishingFamily:" + tenant + ":" + brand + ":Brand:" + request.familyReference,
        ]);
        check();
        const header = (r: Readonly<Record<string, unknown>>) => {
          const m = parseRecordedPublishingMutation(r.mutation_json),
            next = m.next;
          const originalActor =
            m.audit.actor.type === "System"
              ? null
              : parsePublishingReference(m.audit.actor.reference);
          if (
            m.audit.actionCode !== auditActions[m.operation] ||
            (m.release !== null &&
              (m.release.familyReference !== next.familyReference ||
                m.release.sourceLifecycleId !== next.lifecycleId ||
                m.release.snapshotReference !== next.snapshotReference ||
                m.release.snapshotDigest !== next.snapshotDigest ||
                m.release.configurationType !== next.configurationType ||
                m.release.purposeCode !== next.purposeCode ||
                m.release.createdAt > check() ||
                !samePublishingScope(m.release.scope, scope)))
          )
            return fail();
          if (
            r.tenant_id !== tenant ||
            r.brand_id !== brand ||
            r.store_id !== null ||
            r.family_id !== request.familyReference ||
            next.familyReference !== request.familyReference ||
            next.configurationType !== "CATALOG_OPTION_SET" ||
            next.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
            !samePublishingScope(next.scope, scope) ||
            (m.current !== null && !samePublishingScope(m.current.scope, scope)) ||
            r.lifecycle_id !== next.lifecycleId ||
            decimal(r.lifecycle_version) !== next.version ||
            r.operation_id !== m.idempotencyKey ||
            r.operation_code !== m.operation ||
            r.actor_id !== originalActor ||
            r.audit_id !== m.audit.auditId ||
            r.intent_hash !== publishingRecordedMutationDigest(m) ||
            r.changed_at !== next.changedAt ||
            next.changedAt > check() ||
            m.audit.occurredAt > check() ||
            m.audit.occurredAt < next.changedAt ||
            m.audit.brandId !== brand ||
            (m.audit.storeId ?? null) !== null ||
            m.audit.targetId !== next.lifecycleId ||
            m.audit.targetType !== "PublishingLifecycle" ||
            m.audit.dataClassification !== "Confidential" ||
            r.release_id !== (m.release?.releaseId ?? null) ||
            (r.release_sequence === null ? null : decimal(r.release_sequence)) !==
              (m.release?.sequence ?? null) ||
            !evaluatePublishingTransition({
              operation: m.operation,
              optionSetApprovalWaived: m.optionSetApprovalWaiver !== undefined,
              expectedVersion: m.expectedVersion,
              current: m.current,
              next,
            }).allowed
          )
            return fail();
          return Object.freeze({
            operationReference: parsePublishingReference(m.idempotencyKey),
            lifecycleReference: parsePublishingReference(next.lifecycleId),
            lifecycleVersion: parsePublishingVersion(next.version),
            operation: m.operation,
            actorKind: m.audit.actor.type,
            actorReference: originalActor,
            occurredAt: parsePublishingInstant(next.changedAt),
            recordedAt: parsePublishingInstant(m.audit.occurredAt),
            reasonCode: m.audit.reasonCode,
            fromState: m.current?.state ?? null,
            toState: next.state,
            snapshotReference: next.snapshotReference,
            snapshotDigest: next.snapshotDigest,
            releaseReference: m.release?.releaseId ?? null,
            releaseSequence: m.release === null ? null : parseReleaseSequence(m.release.sequence),
            supersededReleaseReference: m.supersededReleaseId,
            rollbackTargetReleaseReference: m.rollbackTargetReleaseId,
          });
        };
        const args = [tenant, brand, request.familyReference];
        if (request.before !== null) {
          const anchors = rows(
            await query(select + where + " AND operation_id=$4 LIMIT 2", [
              ...args,
              request.before.operationReference,
            ]),
            1,
          );
          if (anchors.length !== 1) return fail();
          const anchor = header(anchors[0] ?? fail());
          if (
            anchor.occurredAt !== request.before.occurredAt ||
            anchor.operationReference !== request.before.operationReference
          )
            return fail();
        }
        const result = rows(
          await query(
            select +
              where +
              (request.before === null
                ? " ORDER BY changed_at DESC,operation_id DESC LIMIT $4"
                : " AND (changed_at,operation_id)<($4::timestamptz,$5::uuid) ORDER BY changed_at DESC,operation_id DESC LIMIT $6"),
            request.before === null
              ? [...args, request.limit + 1]
              : [
                  ...args,
                  request.before.occurredAt,
                  request.before.operationReference,
                  request.limit + 1,
                ],
          ),
          request.limit + 1,
        ).map(header);
        const before = request.before;
        if (
          before !== null &&
          result.some(
            (entry) =>
              entry.occurredAt > before.occurredAt ||
              (entry.occurredAt === before.occurredAt &&
                entry.operationReference >= before.operationReference),
          )
        )
          return fail();
        for (let i = 1; i < result.length; i++) {
          const previous = result[i - 1],
            current = result[i];
          if (
            !previous ||
            !current ||
            current.occurredAt > previous.occurredAt ||
            (current.occurredAt === previous.occurredAt &&
              current.operationReference >= previous.operationReference)
          )
            return fail();
        }
        const entries = Object.freeze(result.slice(0, request.limit)),
          last = entries[entries.length - 1];
        await fresh();
        ready = true;
        return Object.freeze({
          profile: "PublishingOptionSetHistoryV1" as const,
          scope: Object.freeze({
            tenantReference: tenant,
            brandReference: brand,
            selectedStoreReference: store,
            actorReference: actor,
          }),
          familyReference: request.familyReference,
          entries,
          nextBefore:
            result.length > request.limit && last
              ? Object.freeze({
                  occurredAt: last.occurredAt,
                  operationReference: last.operationReference,
                })
              : null,
          observedAt: check(),
          validUntil: deadline,
        });
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
    assertFinalized(tx: PublishingTransaction): string {
      if (
        tx !== capturedTx ||
        !ready ||
        active ||
        !guardComplete ||
        guardCount !== 1 ||
        finalCount !== 1
      )
        return reject(new PublishingContractError("PUBLISHING_INPUT_INVALID"));
      check();
      return deadline;
    },
  });
}
