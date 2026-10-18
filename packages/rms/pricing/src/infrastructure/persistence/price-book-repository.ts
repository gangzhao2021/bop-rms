import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { createPriceBookSnapshot, type PriceBookSnapshot } from "../../domain/price-resolution.js";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingDigest,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import { PriceBookWorkflowError } from "../../application/price-book-service.js";
import type {
  PriceBookPorts,
  PriceBookOperationRecord,
  PriceBookEvent,
  PriceBookAction,
} from "../../application/ports/price-book-ports.js";

export interface PriceBookTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
}
type Repository = PriceBookPorts["repository"];
export interface PersistentPriceBookRepository extends Repository {
  loadCurrentOperation(priceBookReference: string): Promise<PriceBookOperationRecord | null>;
}

const fail = (
  code: ConstructorParameters<
    typeof PriceBookWorkflowError
  >[0] = "PRICE_BOOK_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PriceBookWorkflowError(code);
};
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
const events: Record<PriceBookAction, PriceBookEvent["eventType"]> = {
  CreateDraft: "PriceBookDraftCreated",
  ReplaceDraft: "PriceBookDraftReplaced",
  Publish: "PriceBookVersionPublished",
  Archive: "PriceBookArchived",
};
function eventFor(action: PriceBookAction, aggregate: PriceBookSnapshot): PriceBookEvent {
  return {
    eventType: events[action],
    priceBookReference: aggregate.priceBookReference,
    versionReference: aggregate.versionReference,
    brandReference: aggregate.brandReference,
    aggregateVersion: aggregate.aggregateVersion,
    lifecycle: aggregate.lifecycle,
    currencyCode: aggregate.currencyMetadata.currencyCode,
    snapshotDigest: aggregate.snapshotDigest,
    occurredAt: aggregate.createdAt,
  };
}
const selectVersion = `SELECT jsonb_build_object(
 'priceBookReference',b.price_book_id,'versionReference',v.price_book_version_id,
 'brandReference',b.brand_id,'stableCode',b.stable_code,'aggregateVersion',v.version_number,
 'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,'lifecycle',v.lifecycle,
 'currencyMetadata',jsonb_build_object('currencyCode',v.currency_code,
   'metadataVersion',v.currency_metadata_version,'metadataVersionReference',v.currency_metadata_version_id,
   'metadataDigest',v.currency_metadata_digest),
 'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'entryReference',e.price_entry_id,'sellableReference',e.sellable_id,'scopeKind',e.scope_kind,
   'scopeReference',e.scope_id,'channelCode',e.channel_code,'orderType',e.order_type,
   'amount',jsonb_build_object('amountMinor',e.amount_minor::text,'currencyCode',e.currency_code),
   'effectivePeriod',jsonb_build_object('timeZone',e.effective_time_zone,
     'effectiveFrom',jsonb_build_object('instant',to_char(e.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(e.effective_from AT TIME ZONE e.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((e.effective_from AT TIME ZONE e.effective_time_zone)-(e.effective_from AT TIME ZONE 'UTC')))/60),'effectiveUntil',CASE WHEN e.effective_until IS NULL THEN NULL ELSE jsonb_build_object('instant',to_char(e.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localDateTime',to_char(e.effective_until AT TIME ZONE e.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((e.effective_until AT TIME ZONE e.effective_time_zone)-(e.effective_until AT TIME ZONE 'UTC')))/60) END),
   'reasonCode',e.reason_code) ORDER BY e.price_entry_id)
 FROM rms_pricing.price_entry e WHERE e.brand_id=b.brand_id AND e.price_book_id=b.price_book_id
 AND e.price_book_version_id=v.price_book_version_id),'[]'::jsonb)
) AS snapshot,b.aggregate_version AS head_version,
 (date_trunc('milliseconds',v.created_at)=v.created_at
 AND date_trunc('milliseconds',b.updated_at)=b.updated_at
 AND NOT EXISTS (SELECT 1 FROM rms_pricing.price_entry e
 WHERE e.brand_id=b.brand_id AND e.price_book_id=b.price_book_id AND e.price_book_version_id=v.price_book_version_id
 AND (date_trunc('milliseconds',e.effective_from)<>e.effective_from
 OR date_trunc('milliseconds',e.effective_until)<>e.effective_until))) AS precise
FROM rms_pricing.price_book b JOIN rms_pricing.price_book_version v
 ON v.price_book_id=b.price_book_id AND v.brand_id=b.brand_id
WHERE b.brand_id=$1 AND b.price_book_id=$2
 AND ($3::uuid IS NULL OR v.price_book_version_id=$3)
 ORDER BY v.version_number DESC LIMIT 1`;

/** Owner repository. Service owns policy/approval/coverage; current authority and
 * event append must be supplied by its trusted composition, in this transaction.
 * No published version is overwritten. Read/operation replay also reauthorize.
 */
export function createPostgresPriceBookRepository(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: PriceBookTransaction) => Promise<T>): Promise<T> };
  currencyMetadata: CurrencyMetadataSnapshot;
  authorize(
    tx: PriceBookTransaction,
    input: {
      brandReference: string;
      priceBookReference: string | null;
      write: boolean;
      record?: PriceBookOperationRecord;
    },
  ): Promise<boolean>;
  appendEvent(tx: PriceBookTransaction, record: PriceBookOperationRecord): Promise<void>;
}): PersistentPriceBookRepository {
  const brand = parsePricingReference(options.brandReference);
  const currency = createCurrencyMetadataSnapshot(options.currencyMetadata);
  const allowed = async (
    tx: PriceBookTransaction,
    book: string | null,
    record?: PriceBookOperationRecord,
  ) => {
    if (
      (await options.authorize(tx, {
        brandReference: brand,
        priceBookReference: book,
        write: record !== undefined,
        ...(record ? { record } : {}),
      })) !== true
    )
      fail("PRICE_BOOK_PERMISSION_DENIED");
  };
  const scoped = async <T>(book: string | null, work: (tx: PriceBookTransaction) => Promise<T>) =>
    options.transactions.run(async (tx) => {
      await allowed(tx, book);
      await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brand]);
      const result = await work(tx);
      await allowed(tx, book);
      return result;
    });
  const load = async (tx: PriceBookTransaction, book: string, version: string | null = null) => {
    const found = await tx.query(selectVersion, [brand, book, version]);
    if (found.rows.length === 0) return null;
    if (found.rows.length !== 1) return fail();
    const envelope = found.rows[0];
    if (
      !envelope ||
      envelope.precise !== true ||
      !envelope.snapshot ||
      typeof envelope.snapshot !== "object"
    )
      return fail();
    const raw = envelope.snapshot as Record<string, unknown>;
    const metadata = raw.currencyMetadata as Record<string, unknown>;
    for (const key of [
      "currencyCode",
      "metadataVersion",
      "metadataVersionReference",
      "metadataDigest",
    ] as const)
      if (metadata[key] !== currency[key]) return fail();
    if (!Array.isArray(raw.entries)) return fail();
    const entries = raw.entries.map((value: unknown) => {
      if (!value || typeof value !== "object") return fail();
      const entry = value as Record<string, unknown>,
        money = entry.amount as Record<string, unknown>;
      if (typeof money?.amountMinor !== "string" || !/^(0|[1-9][0-9]*)$/.test(money.amountMinor))
        return fail();
      return { ...entry, amount: { ...money, amountMinor: BigInt(money.amountMinor) } };
    });
    const snapshot = createPriceBookSnapshot({
      ...raw,
      entries,
      currencyMetadata: currency,
    } as unknown as PriceBookSnapshot);
    if (
      typeof envelope.head_version !== "number" ||
      envelope.head_version < snapshot.aggregateVersion ||
      (version === null && envelope.head_version !== snapshot.aggregateVersion) ||
      snapshot.brandReference !== brand ||
      snapshot.priceBookReference !== book ||
      (version !== null && snapshot.versionReference !== version)
    )
      return fail();
    return snapshot;
  };
  const replay = async (tx: PriceBookTransaction, operation: string) => {
    const rows = await tx.query(
      "SELECT price_book_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at FROM rms_pricing.price_book_operation_record WHERE brand_id=$1 AND operation_id=$2",
      [brand, operation],
    );
    if (!rows.rows.length) return null;
    const row = rows.rows[0];
    if (
      rows.rows.length !== 1 ||
      !row ||
      typeof row.action_code !== "string" ||
      !Object.hasOwn(events, row.action_code)
    )
      return fail();
    await allowed(tx, parsePricingReference(row.price_book_id));
    const aggregate = await load(
      tx,
      parsePricingReference(row.price_book_id),
      parsePricingReference(row.result_version_id),
    );
    const at = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at;
    if (
      !aggregate ||
      aggregate.aggregateVersion !== row.result_aggregate_version ||
      aggregate.createdAt !== at
    )
      return fail();
    const action = row.action_code as PriceBookAction;
    return Object.freeze({
      action,
      operationReference: parsePricingReference(operation),
      operationIntentHash: parsePricingDigest(row.intent_digest),
      aggregate,
      event: eventFor(action, aggregate),
    });
  };
  const save = async (input: Parameters<Repository["create"]>[0], expected: number | null) => {
    const parsed = createPriceBookSnapshot(input.record.aggregate);
    // Entries are a resolution set. Use the same deterministic identity order as
    // SQL reads so create and historical replay have identical representations.
    const aggregate = createPriceBookSnapshot({
      ...parsed,
      entries: [...parsed.entries].sort((left, right) =>
        left.entryReference < right.entryReference
          ? -1
          : left.entryReference > right.entryReference
            ? 1
            : 0,
      ),
    });
    const record = { ...input.record, aggregate };
    if (
      aggregate.brandReference !== brand ||
      !Object.hasOwn(events, record.action) ||
      encode(record.event) !== encode(eventFor(record.action, aggregate)) ||
      aggregate.aggregateVersion !== aggregate.versionNumber ||
      encode(aggregate.currencyMetadata) !== encode(currency)
    )
      return fail();
    parsePricingReference(record.operationReference);
    parsePricingDigest(record.operationIntentHash);
    const lifecycle =
      record.action === "Publish"
        ? "Published"
        : record.action === "Archive"
          ? "Archived"
          : "Draft";
    if (
      aggregate.lifecycle !== lifecycle ||
      (expected === null) !== (record.action === "CreateDraft")
    )
      return fail();
    const audit = validateAuditRecord(input.audit, Date.parse(aggregate.createdAt));
    if (
      audit.brandId !== brand ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.targetType !== "PricingPriceBook" ||
      audit.targetId !== aggregate.priceBookReference ||
      audit.actionCode !== "PRICING_PRICE_BOOK_" + record.action.toUpperCase() ||
      audit.occurredAt !== aggregate.createdAt
    )
      return fail("PRICE_BOOK_PERMISSION_DENIED");
    return scoped(aggregate.priceBookReference, async (tx) => {
      await allowed(tx, aggregate.priceBookReference, record);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PricingPriceOperation:" + brand + ":" + record.operationReference,
      ]);
      const prior = await replay(tx, record.operationReference);
      if (prior) {
        if (encode(prior) !== encode(record)) return fail("PRICE_BOOK_IDEMPOTENCY_CONFLICT");
        return prior;
      }
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PricingPriceBook:" + brand + ":" + aggregate.priceBookReference,
      ]);
      const current = await load(tx, aggregate.priceBookReference);
      if (expected === null) {
        if (current !== null || aggregate.aggregateVersion !== 1)
          return fail("PRICE_BOOK_VERSION_CONFLICT");
      } else {
        if (
          !Number.isSafeInteger(expected) ||
          !current ||
          current.aggregateVersion !== expected ||
          aggregate.aggregateVersion !== expected + 1 ||
          aggregate.stableCode !== current.stableCode ||
          aggregate.createdAt < current.createdAt
        )
          return fail("PRICE_BOOK_VERSION_CONFLICT");
        if (
          current.lifecycle === "Archived" ||
          (["ReplaceDraft", "Publish"].includes(record.action) && current.lifecycle !== "Draft")
        )
          return fail("PRICE_BOOK_LIFECYCLE_CONFLICT");
      }
      await tx.query("SAVEPOINT pricing_price_book_write", []);
      try {
        if (expected === null)
          await tx.query("INSERT INTO rms_pricing.price_book VALUES($1,$2,$3,1,NULL,$4,$5,$4)", [
            aggregate.priceBookReference,
            brand,
            aggregate.stableCode,
            aggregate.createdAt,
            audit.actor.type === "System" ? null : audit.actor.reference,
          ]);
        await tx.query(
          "INSERT INTO rms_pricing.price_book_version VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            aggregate.versionReference,
            aggregate.priceBookReference,
            brand,
            aggregate.versionNumber,
            aggregate.snapshotDigest,
            aggregate.lifecycle,
            currency.currencyCode,
            currency.metadataVersion,
            currency.metadataVersionReference,
            currency.metadataDigest,
            aggregate.createdAt,
          ],
        );
        for (const entry of aggregate.entries)
          await tx.query(
            "INSERT INTO rms_pricing.price_entry VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
            [
              entry.entryReference,
              aggregate.versionReference,
              aggregate.priceBookReference,
              brand,
              entry.sellableReference,
              entry.scopeKind,
              entry.scopeReference,
              entry.channelCode,
              entry.orderType,
              entry.amount.amountMinor.toString(),
              entry.amount.currencyCode,
              entry.effectivePeriod.effectiveFrom.instant,
              entry.effectivePeriod.effectiveUntil?.instant ?? null,
              entry.effectivePeriod.timeZone,
              entry.reasonCode,
            ],
          );
        const updated = await tx.query(
          "UPDATE rms_pricing.price_book SET aggregate_version=$1,current_version_id=$2,updated_at=$3 WHERE brand_id=$4 AND price_book_id=$5 AND aggregate_version=$6",
          [
            aggregate.aggregateVersion,
            aggregate.lifecycle === "Published" ? aggregate.versionReference : null,
            aggregate.createdAt,
            brand,
            aggregate.priceBookReference,
            expected ?? 1,
          ],
        );
        if (updated.rowCount !== 1) return fail("PRICE_BOOK_VERSION_CONFLICT");
        await tx.query(
          "INSERT INTO rms_pricing.price_book_operation_record VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            record.operationReference,
            aggregate.priceBookReference,
            brand,
            record.action,
            record.operationIntentHash,
            aggregate.aggregateVersion,
            aggregate.versionReference,
            aggregate.createdAt,
          ],
        );
        await appendAuditRecordInTransaction(tx, audit);
        await options.appendEvent(tx, record);
        await allowed(tx, aggregate.priceBookReference, record);
        await tx.query("RELEASE SAVEPOINT pricing_price_book_write", []);
        return record;
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT pricing_price_book_write", []);
        await tx.query("RELEASE SAVEPOINT pricing_price_book_write", []);
        throw error;
      }
    });
  };
  return Object.freeze<PersistentPriceBookRepository>({
    loadCurrentOperation: (reference: string) =>
      scoped(parsePricingReference(reference), async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PricingPriceBook:" + brand + ":" + reference,
        ]);
        const current = await load(tx, reference);
        if (!current) return null;
        const rows = await tx.query(
          "SELECT operation_id FROM rms_pricing.price_book_operation_record WHERE brand_id=$1 AND price_book_id=$2 AND result_version_id=$3 AND result_aggregate_version=$4 LIMIT 2",
          [brand, reference, current.versionReference, current.aggregateVersion],
        );
        if (rows.rows.length === 0) return null;
        if (rows.rows.length !== 1 || !rows.rows[0]) return fail();
        return replay(tx, parsePricingReference(rows.rows[0].operation_id));
      }),
    resolveOperation: (operation) =>
      scoped(null, async (tx) => {
        const reference = parsePricingReference(operation);
        // Service replay precedes draft-author lookup. Hold the operation fence
        // first so the borrowed transaction keeps operation -> book lock order.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PricingPriceOperation:" + brand + ":" + reference,
        ]);
        return replay(tx, reference);
      }),
    load: (book) => scoped(parsePricingReference(book), (tx) => load(tx, book)),
    codeAvailable: (input) =>
      scoped(null, async (tx) => {
        if (input.brandReference !== brand) return fail("PRICE_BOOK_PERMISSION_DENIED");
        const rows = await tx.query(
          "SELECT price_book_id FROM rms_pricing.price_book WHERE brand_id=$1 AND stable_code=$2 AND ($3::uuid IS NULL OR price_book_id<>$3) LIMIT 1",
          [brand, input.stableCode, input.excludingPriceBookReference],
        );
        return rows.rows.length === 0;
      }),
    create: (input) => save(input, null),
    commit: (input) => save(input, input.expectedAggregateVersion),
  });
}
