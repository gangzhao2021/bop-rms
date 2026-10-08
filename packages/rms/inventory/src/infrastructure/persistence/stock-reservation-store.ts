import {
  createInventoryRecipeDemandSource,
  createInventoryRecipeLineDemandSource,
  type RecipeItemDemandContribution,
  type RecipeLineDemandContribution,
} from "../../application/recipe-demand-source.js";
import { createPostgresInventoryItemStore } from "./inventory-item-store.js";
import { createPostgresStockCandidateSource } from "./stock-candidate-source.js";
import { planStockAllocation } from "../../domain/stock-allocation.js";
import {
  parseInventoryReservationSet,
  planInventoryReservationSetRelease,
  reservationOrderKey,
  type InventoryReservationSet,
} from "../../domain/reservation-set.js";
import { parseLotHoldSnapshot } from "../../domain/lot-hold-snapshot.js";
import { parseInventoryItemSnapshot } from "../../domain/inventory-item-snapshot.js";
import {
  appendAuditRecordInTransaction,
  verifySystemAuditOperationBinding,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import {
  parseInventoryReference,
  parseInventoryInstant,
  type InventoryUnit,
} from "../../domain/inventory-item.js";
import {
  advanceInventoryReservation,
  createInventoryReservation,
  parseInventoryReservation,
  InventoryReservationError,
  type InventoryReservation,
} from "../../domain/inventory-reservation.js";
import {
  calculateReservationBalance,
  ReservationBalanceError,
} from "../../domain/reservation-balance.js";
import { parseStockMovementFact } from "../../domain/stock-movement.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";

export interface StockReservationWrite {
  readonly operationReference: string;
  readonly accountReference: string;
  readonly action: "Reserve" | "Release" | "Consume" | "StartProduction";
  readonly expectedLedgerVersion: number;
  readonly quantity: string | null;
  readonly reservation: InventoryReservation;
  readonly movementReference: string | null;
  readonly audit: unknown;
}
export interface StockReservationSetWrite {
  readonly setReference: string;
  readonly operationReference: string;
  readonly workflowReference: string;
  readonly workflowVersion: number;
  readonly writes: readonly StockReservationWrite[];
  readonly audit: unknown;
}
export interface StockReservationResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly reservation: InventoryReservation;
  readonly movementReference: string | null;
  readonly auditReference: string;
}
export class StockReservationStoreError extends Error {
  constructor(
    readonly code:
      | "STOCK_RESERVATION_UNAVAILABLE"
      | "STOCK_RESERVATION_CONFLICT"
      | "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT"
      | "STOCK_RESERVATION_INSUFFICIENT"
      | "STOCK_RESERVATION_ITEM_INELIGIBLE",
  ) {
    super("Stock reservation storage failed");
    this.name = "StockReservationStoreError";
  }
}
function fail(code: StockReservationStoreError["code"] = "STOCK_RESERVATION_UNAVAILABLE"): never {
  throw new StockReservationStoreError(code);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > 1
  )
    return fail();
  return descriptor.value as unknown[];
}
/** WP-2423: a bounded multi-row read (an Order line holds one reservation per ingredient). */
function manyRows(value: unknown, limit = 500): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > limit
  )
    return fail();
  return descriptor.value as unknown[];
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail();
  return Number(value);
}
function audit(
  value: unknown,
  reservation: InventoryReservation,
  operation: string,
  action: string,
  systemRelease = false,
) {
  const raw = closed(value, [
    "auditId",
    "brandId",
    "storeId",
    "actor",
    "actionCode",
    "targetType",
    "targetId",
    "reasonCode",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "dataClassification",
    "retentionPolicyCode",
    "retentionPolicyVersion",
  ]);
  const actor = closed(raw.actor, systemRelease ? ["type"] : ["type", "reference"]);
  const result = validateAuditRecord(
    { ...raw, actor: Object.freeze({ ...actor }) },
    Date.parse(reservation.updatedAt),
  );
  const expected = action === "StartProduction" ? "START_PRODUCTION" : action.toUpperCase();
  if (
    result.brandId !== reservation.binding.brandReference ||
    result.storeId !== reservation.binding.storeReference ||
    (systemRelease
      ? result.actor.type !== "System" ||
        action !== "Release" ||
        result.reasonCode !== "CHECKOUT_DEADLINE_REACHED" ||
        result.sourceChannel !== "SYSTEM"
      : result.actor.type === "System") ||
    result.targetType !== "InventoryReservation" ||
    result.targetId !== reservation.reservationReference ||
    result.correlationId !== operation ||
    result.occurredAt !== reservation.updatedAt ||
    result.actionCode !== "INVENTORY_RESERVATION_" + expected ||
    result.dataClassification !== "Internal"
  )
    return fail();
  return Object.freeze(result);
}
export interface SystemReservationReleaseCapability {
  readonly systemActorReference: string;
  authorize(
    transaction: InventoryItemTransaction,
    request: Readonly<{
      operationReference: string;
      accountReference: string;
      reservation: InventoryReservation;
    }>,
  ): Promise<boolean>;
}
/** Internal capability: current actor, workflow, demand, Item/lot/expiry authorization is required upstream. */
export function createPostgresStockReservationStore(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  systemRelease?: SystemReservationReleaseCapability,
) {
  const rawScope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = parseInventoryReference(rawScope.tenantReference),
    brand = parseInventoryReference(rawScope.brandReference),
    store = parseInventoryReference(rawScope.storeReference);
  const systemActorReference = systemRelease
    ? parseInventoryReference(systemRelease.systemActorReference)
    : null;
  const authorizeSystemRelease = systemRelease?.authorize.bind(systemRelease);
  function bind(value: unknown) {
    const result = parseInventoryReservation(value);
    if (
      result.binding.tenantReference !== tenant ||
      result.binding.brandReference !== brand ||
      result.binding.storeReference !== store
    )
      return fail("STOCK_RESERVATION_CONFLICT");
    return result;
  }
  async function run<T>(work: (tx: InventoryItemTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        return work(tx);
      });
    } catch (error) {
      if (
        error instanceof StockReservationStoreError ||
        error instanceof InventoryReservationError ||
        error instanceof ReservationBalanceError
      )
        throw error;
      return fail();
    }
  }
  function decode(value: unknown) {
    const row = closed(value, [
      "snapshot",
      "version",
      "occurredAt",
      "movement",
      "audit",
      "intent",
      "account",
      "action",
    ]);
    const reservation = bind(row.snapshot);
    if (
      row.version !== String(reservation.version) ||
      row.occurredAt !== reservation.updatedAt ||
      typeof row.intent !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.intent)
    )
      return fail();
    if (
      typeof row.action !== "string" ||
      !["Reserve", "Release", "Consume", "StartProduction"].includes(row.action) ||
      (row.action === "StartProduction") !== (row.movement === null)
    )
      return fail();
    return {
      reservation,
      movementReference: row.movement === null ? null : parseInventoryReference(row.movement),
      auditReference: parseInventoryReference(row.audit),
      intent: row.intent,
      account: parseInventoryReference(row.account),
      action: row.action,
    };
  }
  const columns = `snapshot_json AS snapshot,version::text AS version,
 to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
 movement_id AS movement,audit_id AS audit,intent_hash AS intent,account_id AS account,action`;
  async function resolve(tx: InventoryItemTransaction, operation: string) {
    const result = rows(
      await tx.query(
        "SELECT " +
          columns +
          " FROM rms_inventory.stock_reservation_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    );
    return result.length === 0 ? null : decode(result[0]);
  }
  const result = (
    record: ReturnType<typeof decode>,
    status: StockReservationResult["status"],
  ): StockReservationResult =>
    Object.freeze({
      status,
      reservation: record.reservation,
      movementReference: record.movementReference,
      auditReference: record.auditReference,
    });
  function reserveEntries(inputs: readonly StockReservationWrite[]) {
    if (
      !Array.isArray(inputs) ||
      inputs.length < 1 ||
      inputs.length > 1000 ||
      Reflect.ownKeys(inputs).length !== inputs.length + 1
    )
      return fail();
    const operations = new Set<string>(),
      accounts = new Set<string>(),
      reservations = new Set<string>();
    let common: string | null = null;
    const entries: { index: number; input: StockReservationWrite }[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(inputs, String(index));
      if (!slot?.enumerable || !("value" in slot)) return fail();
      const raw = closed(slot.value, [
        "operationReference",
        "accountReference",
        "action",
        "expectedLedgerVersion",
        "quantity",
        "reservation",
        "movementReference",
        "audit",
      ]);
      if (raw.action !== "Reserve" || typeof raw.quantity !== "string") return fail();
      const reservation = bind(raw.reservation),
        operationReference = parseInventoryReference(raw.operationReference),
        accountReference = parseInventoryReference(raw.accountReference);
      const recordAudit = audit(raw.audit, reservation, operationReference, "Reserve");
      const b = reservation.binding;
      const binding = canonicalizeRfc8785({
        submission: b.submissionReference,
        cart: b.cartReference,
        cartVersion: b.cartVersion,
        quote: b.quoteReference,
        demand: b.demandReference,
        digest: b.demandDigest,
        occurredAt: reservation.updatedAt,
        actor: recordAudit.actor,
      });
      // Per-line reservations (schema 2) may reserve the same account once per Order line.
      const accountLine = accountReference + ":" + (b.cartItemReference ?? "");
      if (
        (common !== null && common !== binding) ||
        operations.has(operationReference) ||
        accounts.has(accountLine) ||
        reservations.has(reservation.reservationReference)
      )
        return fail("STOCK_RESERVATION_CONFLICT");
      common = binding;
      operations.add(operationReference);
      accounts.add(accountLine);
      reservations.add(reservation.reservationReference);
      entries.push({
        index,
        input: {
          operationReference,
          accountReference,
          action: "Reserve" as const,
          expectedLedgerVersion: version(raw.expectedLedgerVersion),
          quantity: raw.quantity,
          reservation,
          movementReference: parseInventoryReference(raw.movementReference),
          audit: recordAudit,
        },
      });
    }
    // Same-account writes commit in Order-line order, matching the plan's ledger sequence.
    const sortKey = (input: StockReservationWrite) =>
      reservationOrderKey(input.reservation, input.accountReference);
    entries.sort((a, b) => {
      const left = sortKey(a.input);
      const right = sortKey(b.input);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return entries;
  }
  return Object.freeze({
    /** Caller supplies persisted child intents and owner-verified complete original set. */
    async releaseSet(
      value: Readonly<{ set: InventoryReservationSet; writes: readonly StockReservationWrite[] }>,
      validateSource: (
        tx: InventoryItemTransaction,
        set: InventoryReservationSet,
      ) => Promise<boolean>,
    ) {
      const raw = closed(value, ["set", "writes"]);
      const set = parseInventoryReservationSet(raw.set);
      if (
        !systemRelease ||
        typeof validateSource !== "function" ||
        !Array.isArray(raw.writes) ||
        raw.writes.length !== set.entries.length ||
        Reflect.ownKeys(raw.writes).length !== raw.writes.length + 1
      )
        return fail();
      const originals = new Map(
        set.entries.map((entry) => [entry.reservation.reservationReference, entry]),
      );
      const operations = new Set<string>();
      const writes: StockReservationWrite[] = [];
      let at: string | undefined;
      for (let i = 0; i < raw.writes.length; i++) {
        const slot = Object.getOwnPropertyDescriptor(raw.writes, String(i));
        if (!slot?.enumerable || !("value" in slot)) return fail();
        const entry = closed(slot.value, [
          "operationReference",
          "accountReference",
          "action",
          "expectedLedgerVersion",
          "quantity",
          "reservation",
          "movementReference",
          "audit",
        ]);
        const reservation = bind(entry.reservation),
          original = originals.get(reservation.reservationReference);
        const operationReference = parseInventoryReference(entry.operationReference),
          accountReference = parseInventoryReference(entry.accountReference);
        if (
          !original ||
          original.accountReference !== accountReference ||
          entry.action !== "Release" ||
          operations.has(operationReference) ||
          canonicalizeRfc8785(reservation.binding) !==
            canonicalizeRfc8785(original.reservation.binding) ||
          canonicalizeRfc8785(reservation.unit) !==
            canonicalizeRfc8785(original.reservation.unit) ||
          reservation.originalQuantity !== original.reservation.originalQuantity ||
          reservation.createdAt !== original.reservation.createdAt ||
          (at !== undefined && at !== reservation.updatedAt) ||
          typeof entry.quantity !== "string"
        )
          return fail();
        at = reservation.updatedAt;
        originals.delete(reservation.reservationReference);
        operations.add(operationReference);
        writes.push(
          Object.freeze({
            operationReference,
            accountReference,
            action: "Release",
            expectedLedgerVersion: version(entry.expectedLedgerVersion),
            quantity: entry.quantity,
            reservation,
            movementReference: parseInventoryReference(entry.movementReference),
            audit: audit(entry.audit, reservation, operationReference, "Release", true),
          }),
        );
      }
      if (originals.size || at === undefined) return fail();
      const occurredAt = at;
      writes.sort((a, b) => {
        const left = reservationOrderKey(a.reservation, a.accountReference),
          right = reservationOrderKey(b.reservation, b.accountReference);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      return run(async (tx) => {
        const allowed = async () => (await validateSource(tx, set)) === true;
        if (!(await allowed())) return fail();
        for (const write of writes)
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "StockReservation:" +
              tenant +
              ":" +
              brand +
              ":" +
              store +
              ":" +
              write.operationReference,
          ]);
        const prior = [];
        for (const write of writes) prior.push(await resolve(tx, write.operationReference));
        const replay = prior.filter(Boolean).length;
        if (replay !== 0 && replay !== writes.length) return fail("STOCK_RESERVATION_CONFLICT");
        const child = createPostgresStockReservationStore(
          { run: async (work) => work(tx) },
          { tenantReference: tenant, brandReference: brand, storeReference: store },
          systemRelease,
        );
        if (replay === 0) {
          for (const item of [
            ...new Set(writes.map((write) => write.reservation.binding.itemReference)),
          ].sort()) {
            if (
              rows(
                await tx.query(
                  "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
                  [tenant, brand, item],
                ),
              ).length !== 1
            )
              return fail();
          }
          const current = [];
          for (const write of writes) {
            const entry = await child.loadCurrent(write.reservation.reservationReference);
            if (!entry) return fail();
            current.push({
              accountReference: entry.accountReference,
              reservation: entry.reservation,
            });
          }
          const planned = planInventoryReservationSetRelease({ set, current, occurredAt });
          for (let i = 0; i < writes.length; i++) {
            const expected = planned.entries[i],
              write = writes[i];
            if (
              !expected ||
              !write ||
              expected.accountReference !== write.accountReference ||
              expected.quantity !== write.quantity ||
              canonicalizeRfc8785(expected.reservation) !== canonicalizeRfc8785(write.reservation)
            )
              return fail("STOCK_RESERVATION_CONFLICT");
          }
        }
        const saved = [];
        for (const write of writes) {
          const result = await child.commit(write);
          if (result.status !== (replay ? "AlreadyApplied" : "Applied"))
            return fail("STOCK_RESERVATION_CONFLICT");
          saved.push(result);
        }
        if (!(await allowed())) return fail();
        return Object.freeze({
          status: replay ? ("AlreadyApplied" as const) : ("Applied" as const),
          setReference: set.setReference,
          entries: Object.freeze(saved),
        });
      });
    },
    async commitSet(
      input: StockReservationSetWrite,
      validateNewWrite: (
        tx: InventoryItemTransaction,
        writes: readonly StockReservationWrite[],
      ) => Promise<void> = async () => undefined,
    ): Promise<
      Readonly<{
        status: "Applied" | "AlreadyApplied";
        set: InventoryReservationSet;
      }>
    > {
      const raw = closed(input, [
        "setReference",
        "operationReference",
        "workflowReference",
        "workflowVersion",
        "writes",
        "audit",
      ]);
      const setReference = parseInventoryReference(raw.setReference);
      const operationReference = parseInventoryReference(raw.operationReference);
      const workflowReference = parseInventoryReference(raw.workflowReference);
      const workflowVersion = version(raw.workflowVersion);
      const entries = reserveEntries(raw.writes as readonly StockReservationWrite[]);
      const first = entries[0];
      if (!first) return fail();
      const occurredAt = first.input.reservation.createdAt;
      const rawAudit = closed(raw.audit, [
        "auditId",
        "brandId",
        "storeId",
        "actor",
        "actionCode",
        "targetType",
        "targetId",
        "reasonCode",
        "correlationId",
        "occurredAt",
        "sourceChannel",
        "dataClassification",
        "retentionPolicyCode",
        "retentionPolicyVersion",
      ]);
      const rawActor = closed(rawAudit.actor, ["type", "reference"]);
      const recordAudit = validateAuditRecord(
        { ...rawAudit, actor: { ...rawActor } },
        Date.parse(occurredAt),
      );
      const childAudit = audit(
        first.input.audit,
        first.input.reservation,
        first.input.operationReference,
        "Reserve",
      );
      if (
        recordAudit.brandId !== brand ||
        recordAudit.storeId !== store ||
        recordAudit.targetType !== "InventoryReservationSet" ||
        recordAudit.targetId !== setReference ||
        recordAudit.actionCode !== "INVENTORY_RESERVATION_SET" ||
        recordAudit.correlationId !== operationReference ||
        recordAudit.occurredAt !== occurredAt ||
        recordAudit.dataClassification !== "Internal" ||
        canonicalizeRfc8785(recordAudit.actor) !== canonicalizeRfc8785(childAudit.actor)
      )
        return fail("STOCK_RESERVATION_CONFLICT");
      if (recordAudit.actor.type === "System") return fail();
      const actorReference = recordAudit.actor.reference;
      const requestDigest =
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            setReference,
            operationReference,
            workflowReference,
            workflowVersion,
            actor: recordAudit.actor,
            reasonCode: recordAudit.reasonCode,
            sourceChannel: recordAudit.sourceChannel,
            writes: entries.map(({ input: entry }) => {
              const a = audit(entry.audit, entry.reservation, entry.operationReference, "Reserve");
              return {
                operationReference: entry.operationReference,
                accountReference: entry.accountReference,
                expectedLedgerVersion: entry.expectedLedgerVersion,
                quantity: entry.quantity,
                reservation: entry.reservation,
                actor: a.actor,
                reasonCode: a.reasonCode,
                sourceChannel: a.sourceChannel,
              };
            }),
          }),
        );
      return run(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "StockReservationSet:" + tenant + ":" + brand + ":" + store + ":" + operationReference,
        ]);
        const existing = rows(
          await tx.query(
            "SELECT record_json AS record FROM rms_inventory.stock_reservation_set WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
            [tenant, brand, store, operationReference],
          ),
        );
        if (existing.length) {
          const set = parseInventoryReservationSet(closed(existing[0], ["record"]).record);
          const child = set.entries[0];
          if (!child) return fail();
          bind(child.reservation);
          if (set.operationReference !== operationReference || set.requestDigest !== requestDigest)
            return fail("STOCK_RESERVATION_IDEMPOTENCY_CONFLICT");
          return Object.freeze({ status: "AlreadyApplied" as const, set });
        }
        // Match the child operation-before-Item lock order; retain all Item fences until commit.
        for (const { input: entry } of entries) {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "StockReservation:" +
              tenant +
              ":" +
              brand +
              ":" +
              store +
              ":" +
              entry.operationReference,
          ]);
        }
        const items = [
          ...new Set(entries.map((entry) => entry.input.reservation.binding.itemReference)),
        ].sort();
        for (const item of items) {
          if (
            rows(
              await tx.query(
                "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
                [tenant, brand, item],
              ),
            ).length !== 1
          )
            return fail("STOCK_RESERVATION_ITEM_INELIGIBLE");
        }
        await validateNewWrite(
          tx,
          entries.map((entry) => entry.input),
        );
        const child = createPostgresStockReservationStore(
          { run: async (work) => work(tx) },
          { tenantReference: tenant, brandReference: brand, storeReference: store },
        );
        const saved = await child.reserveAll(entries.map((entry) => entry.input));
        if (saved.some((result) => result.status !== "Applied"))
          return fail("STOCK_RESERVATION_CONFLICT");
        const set = parseInventoryReservationSet({
          schemaVersion: 1,
          setReference,
          operationReference,
          workflowReference,
          workflowVersion,
          actorReference,
          auditReference: recordAudit.auditId,
          requestDigest,
          entries: saved.map((result, index) => {
            const entry = entries[index];
            if (!entry) return fail();
            return {
              accountReference: entry.input.accountReference,
              operationReference: entry.input.operationReference,
              movementReference: result.movementReference,
              auditReference: result.auditReference,
              reservation: result.reservation,
            };
          }),
        });
        await appendAuditRecordInTransaction(tx, recordAudit);
        const b = first.input.reservation.binding;
        await tx.query(
          `INSERT INTO rms_inventory.stock_reservation_set
          (tenant_id,brand_id,store_id,set_id,operation_id,actor_id,audit_id,workflow_id,workflow_version,
           request_digest,submission_id,cart_id,cart_version,quote_id,demand_id,demand_digest,created_at,record_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
          [
            tenant,
            brand,
            store,
            setReference,
            operationReference,
            set.actorReference,
            set.auditReference,
            workflowReference,
            workflowVersion,
            requestDigest,
            b.submissionReference,
            b.cartReference,
            b.cartVersion,
            b.quoteReference,
            b.demandReference,
            b.demandDigest,
            occurredAt,
            set,
          ],
        );
        return Object.freeze({ status: "Applied" as const, set });
      });
    },
    /** Atomic child set only; caller must seal the complete set in its submission/demand record. */
    async reserveAll(
      inputs: readonly StockReservationWrite[],
    ): Promise<readonly StockReservationResult[]> {
      const entries = reserveEntries(inputs);
      return run(async (tx) => {
        const child = createPostgresStockReservationStore(
          { run: async (work) => work(tx) },
          { tenantReference: tenant, brandReference: brand, storeReference: store },
        );
        let existing = 0;
        for (const entry of entries) {
          if (await child.resolveOperation(entry.input.operationReference)) existing++;
        }
        if (existing !== 0 && existing !== entries.length)
          return fail("STOCK_RESERVATION_CONFLICT");
        const saved: StockReservationResult[] = new Array(entries.length);
        for (const entry of entries) saved[entry.index] = await child.commit(entry.input);
        if (
          saved.some((r) => r.status === "Applied") &&
          saved.some((r) => r.status === "AlreadyApplied")
        )
          return fail("STOCK_RESERVATION_CONFLICT");
        return Object.freeze(saved);
      });
    },
    /** Latest state of every per-line (schema 2) reservation of one Order line, account order. */
    async loadOrderLine(submission: string, cartItem: string) {
      const submissionReference = parseInventoryReference(submission);
      const cartItemReference = parseInventoryReference(cartItem);
      return run(async (tx) => {
        const found = manyRows(
          await tx.query(
            "SELECT DISTINCT ON (reservation_id) " +
              columns +
              " FROM rms_inventory.stock_reservation_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND submission_id=$4 AND snapshot_json->'binding'->>'cartItemReference'=$5 ORDER BY reservation_id, version DESC",
            [tenant, brand, store, submissionReference, cartItemReference],
          ),
        );
        return Object.freeze(
          found
            .map((row) => {
              const current = decode(row);
              return Object.freeze({
                accountReference: current.account,
                reservation: current.reservation,
              });
            })
            .sort((a, b) =>
              reservationOrderKey(a.reservation, a.accountReference) <
              reservationOrderKey(b.reservation, b.accountReference)
                ? -1
                : 1,
            ),
        );
      });
    },
    /**
     * Latest scoped observation, not operation recovery or Payment authorization.
     * Callers needing a stable decision through a write must provide their transaction fence.
     */
    async loadCurrent(reference: string) {
      const reservationReference = parseInventoryReference(reference);
      return run(async (tx) => {
        const found = rows(
          await tx.query(
            "SELECT " +
              columns +
              " FROM rms_inventory.stock_reservation_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reservation_id=$4 ORDER BY version DESC LIMIT 1",
            [tenant, brand, store, reservationReference],
          ),
        );
        if (found.length === 0) return null;
        const current = decode(found[0]);
        if (current.reservation.reservationReference !== reservationReference) return fail();
        return Object.freeze({
          reservation: current.reservation,
          accountReference: current.account,
          movementReference: current.movementReference,
          auditReference: current.auditReference,
        });
      });
    },
    /** Optimistic scoped version only; commit retains the authoritative ledger fence. */
    async loadAccountLedgerVersion(reference: string): Promise<number | null> {
      const account = parseInventoryReference(reference);
      return run(async (tx) => {
        const found = rows(
          await tx.query(
            "SELECT ledger_version::text AS version FROM rms_inventory.stock_balance WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4",
            [tenant, brand, store, account],
          ),
        );
        if (found.length === 0) return null;
        const row = closed(found[0], ["version"]);
        if (typeof row.version !== "string" || !/^[1-9][0-9]*$/.test(row.version)) return fail();
        return version(Number(row.version));
      });
    },
    /** Verifies immutable System release, its original intent and owning Audit linkage. */
    async verifySystemRelease(reference: string): Promise<StockReservationResult | null> {
      const operation = parseInventoryReference(reference);
      if (!authorizeSystemRelease || !systemActorReference) return fail();
      return run(async (tx) => {
        const prior = await resolve(tx, operation);
        if (prior === null) return null;
        const request = Object.freeze({
          operationReference: operation,
          accountReference: prior.account,
          reservation: prior.reservation,
        });
        const allowed = async () => (await authorizeSystemRelease(tx, request)) === true;
        if (prior.action !== "Release" || prior.movementReference === null || !(await allowed()))
          return fail();
        const found = rows(
          await tx.query(
            "SELECT record_json AS record,audit_id AS audit FROM rms_inventory.stock_movement WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4 AND movement_id=$5",
            [tenant, brand, store, prior.account, prior.movementReference],
          ),
        );
        if (found.length !== 1) return fail();
        const row = closed(found[0], ["record", "audit"]),
          movement = parseStockMovementFact(row.record),
          reservation = prior.reservation;
        if (
          movement.movementType !== "Release" ||
          movement.movementReference !== prior.movementReference ||
          movement.auditReference !== prior.auditReference ||
          row.audit !== prior.auditReference ||
          movement.tenantReference !== tenant ||
          movement.brandReference !== brand ||
          movement.itemReference !== reservation.binding.itemReference ||
          movement.performedBy !== systemActorReference ||
          movement.businessSourceType !== "INVENTORY_RESERVATION" ||
          movement.businessSourceReference !== reservation.reservationReference ||
          movement.reasonCode !== "CHECKOUT_DEADLINE_REACHED" ||
          movement.occurredAt !== reservation.updatedAt ||
          movement.unitCode !== reservation.unit.unitCode ||
          movement.baseUnitCode !== reservation.unit.unitCode ||
          movement.conversionMultiplier !== "1" ||
          movement.quantityDelta !== movement.baseQuantityDelta ||
          !movement.baseQuantityDelta.startsWith("-") ||
          movement.sourceScope?.scopeType !== "Location" ||
          movement.sourceScope.scopeReference !== reservation.binding.locationReference ||
          movement.destinationScope !== null ||
          movement.lotReference !== reservation.binding.lotReference ||
          movement.correctsMovementReference !== null
        )
          return fail();
        const quantity = movement.baseQuantityDelta.slice(1);
        const calculation = calculateReservationBalance({
          action: "Release",
          quantity,
          unit: reservation.unit,
          expectedVersion: movement.before.ledgerVersion,
          negativeStockPolicy: "Block",
          before: movement.before,
        });
        if (
          calculation.requiredControl !== "None" ||
          canonicalizeRfc8785(calculation.after) !== canonicalizeRfc8785(movement.after)
        )
          return fail();
        const intent =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              operation,
              accountReference: prior.account,
              action: "Release",
              expectedLedgerVersion: movement.before.ledgerVersion,
              quantity,
              reservation,
              actor: { type: "System" },
              systemActorReference,
              reasonCode: "CHECKOUT_DEADLINE_REACHED",
              sourceChannel: "SYSTEM",
            }),
          );
        if (
          intent !== prior.intent ||
          !(await verifySystemAuditOperationBinding(
            tx,
            {
              auditId: prior.auditReference,
              brandId: brand,
              storeId: store,
              actionCode: "INVENTORY_RESERVATION_RELEASE",
              targetType: "InventoryReservation",
              targetId: reservation.reservationReference,
              correlationId: operation,
              reasonCode: "CHECKOUT_DEADLINE_REACHED",
              occurredAt: reservation.updatedAt,
              sourceChannel: "SYSTEM",
            },
            allowed,
          )) ||
          !(await allowed())
        )
          return fail();
        return result(prior, "AlreadyApplied");
      });
    },
    async resolveOperation(reference: string): Promise<StockReservationResult | null> {
      return run(async (tx) => {
        const prior = await resolve(tx, parseInventoryReference(reference));
        return prior === null ? null : result(prior, "AlreadyApplied");
      });
    },
    async commit(input: StockReservationWrite): Promise<StockReservationResult> {
      return run(async (tx) => {
        const raw = closed(input, [
          "operationReference",
          "accountReference",
          "action",
          "expectedLedgerVersion",
          "quantity",
          "reservation",
          "movementReference",
          "audit",
        ]);
        const next = bind(raw.reservation),
          operation = parseInventoryReference(raw.operationReference),
          accountReference = parseInventoryReference(raw.accountReference),
          expectedLedgerVersion = version(raw.expectedLedgerVersion);
        if (
          typeof raw.action !== "string" ||
          !["Reserve", "Release", "Consume", "StartProduction"].includes(raw.action)
        )
          return fail();
        const action = raw.action;
        const candidate = createInventoryReservation({
          reservationReference: next.reservationReference,
          binding: next.binding,
          unit: next.unit,
          quantity: action === "StartProduction" ? "1" : raw.quantity,
          occurredAt: next.updatedAt,
        });
        if (action === "StartProduction" && raw.quantity !== null) return fail();
        const quantity = action === "StartProduction" ? null : candidate.originalQuantity;
        const auditActor = Object.getOwnPropertyDescriptor(raw.audit as object, "actor");
        const system =
          auditActor &&
          "value" in auditActor &&
          auditActor.value !== null &&
          typeof auditActor.value === "object" &&
          Object.getOwnPropertyDescriptor(auditActor.value, "type")?.value === "System";
        if (system && (!authorizeSystemRelease || !systemActorReference || action !== "Release"))
          return fail();
        const recordAudit = audit(raw.audit, next, operation, action, Boolean(system));
        const performedBy =
          recordAudit.actor.type === "System" ? systemActorReference : recordAudit.actor.reference;
        if (!performedBy) return fail();
        const releaseRequest = Object.freeze({
          operationReference: operation,
          accountReference,
          reservation: next,
        });
        const allowed = async () =>
          !system || (await authorizeSystemRelease?.(tx, releaseRequest)) === true;
        if (!(await allowed())) return fail();
        const intent =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              operation,
              accountReference,
              action,
              expectedLedgerVersion,
              quantity,
              reservation: next,
              actor: recordAudit.actor,
              ...(system ? { systemActorReference: performedBy } : {}),
              reasonCode: recordAudit.reasonCode,
              sourceChannel: recordAudit.sourceChannel,
            }),
          );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "StockReservation:" + tenant + ":" + brand + ":" + store + ":" + operation,
        ]);
        const prior = await resolve(tx, operation);
        if (prior !== null) {
          if (prior.intent !== intent) return fail("STOCK_RESERVATION_IDEMPOTENCY_CONFLICT");
          if (!(await allowed())) return fail();
          return result(prior, "AlreadyApplied");
        }
        // The transition keeps productionStartedAt, so it is set on a Consume only if production
        // had started before this command.
        const productionStarted = next.productionStartedAt !== null && action === "Consume";
        const movementReference =
          raw.movementReference === null ? null : parseInventoryReference(raw.movementReference);
        if ((action === "StartProduction") !== (movementReference === null)) return fail();
        const itemLock = rows(
          await tx.query(
            "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
            [tenant, brand, next.binding.itemReference],
          ),
        );
        if (itemLock.length !== 1) return fail("STOCK_RESERVATION_CONFLICT");
        const itemRows = rows(
          await tx.query(
            `SELECT snapshot_json AS snapshot,version::text AS version,
          to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
          FROM rms_inventory.inventory_item_version WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3
          ORDER BY version DESC LIMIT 1`,
            [tenant, brand, next.binding.itemReference],
          ),
        );
        if (itemRows.length !== 1) return fail("STOCK_RESERVATION_ITEM_INELIGIBLE");
        const itemRow = closed(itemRows[0], ["snapshot", "version", "recordedAt"]);
        const item = parseInventoryItemSnapshot(itemRow.snapshot);
        if (
          item.tenantReference !== tenant ||
          item.brandReference !== brand ||
          item.itemReference !== next.binding.itemReference ||
          itemRow.version !== String(item.aggregateVersion) ||
          itemRow.recordedAt !== item.updatedAt ||
          item.updatedAt > next.updatedAt ||
          !item.trackingPolicy.stockTrackingEnabled ||
          canonicalizeRfc8785(item.baseUnit) !== canonicalizeRfc8785(next.unit) ||
          // Starting production is a safety gate. Release, and Consume of stock whose production
          // already started (WP-2423), record what happened, so a later deactivation still settles.
          (item.lifecycle !== "Active" &&
            !(
              (action === "Release" || (action === "Consume" && productionStarted)) &&
              item.lifecycle === "Inactive"
            ))
        )
          return fail("STOCK_RESERVATION_ITEM_INELIGIBLE");
        const accountRows = rows(
          await tx.query(
            "SELECT item_id AS item,stock_site_id AS site,location_id AS location,lot_id AS lot,expiry_date::text AS expiry,unit_code AS unit,ledger_precision AS precision FROM rms_inventory.stock_account WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4 FOR UPDATE",
            [tenant, brand, store, accountReference],
          ),
        );
        if (accountRows.length !== 1) return fail("STOCK_RESERVATION_CONFLICT");
        const account = closed(accountRows[0], [
          "item",
          "site",
          "location",
          "lot",
          "expiry",
          "unit",
          "precision",
        ]);
        if (
          account.item !== next.binding.itemReference ||
          account.site !== next.binding.stockSiteReference ||
          account.location !== next.binding.locationReference ||
          account.lot !== next.binding.lotReference ||
          account.unit !== next.unit.unitCode ||
          account.precision !== next.unit.ledgerPrecision
        )
          return fail("STOCK_RESERVATION_CONFLICT");
        const lotMode = item.trackingPolicy.lotTrackingMode;
        if (
          (lotMode === "NoLot" && (account.lot !== null || account.expiry !== null)) ||
          (account.lot === null && account.expiry !== null) ||
          ((lotMode === "LotRequired" || lotMode === "LotExpiryRequired") &&
            account.lot === null) ||
          (lotMode === "LotExpiryRequired" && account.expiry === null)
        )
          return fail("STOCK_RESERVATION_ITEM_INELIGIBLE");
        // A quality hold blocks Reserve, StartProduction and consuming unstarted stock; it does not
        // block recording stock already used in production.
        if (
          account.lot !== null &&
          action !== "Release" &&
          !(action === "Consume" && productionStarted)
        ) {
          const holds = rows(
            await tx.query(
              `SELECT record_json->'hold' AS hold,version::text AS version,
            to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
            FROM rms_inventory.stock_lot_hold_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4
            ORDER BY version DESC LIMIT 1`,
              [tenant, brand, store, accountReference],
            ),
          );
          if (holds.length === 1) {
            const row = closed(holds[0], ["hold", "version", "occurredAt"]),
              hold = parseLotHoldSnapshot(row.hold);
            if (
              hold.tenantReference !== tenant ||
              hold.brandReference !== brand ||
              hold.itemReference !== next.binding.itemReference ||
              hold.locationReference !== next.binding.locationReference ||
              hold.lotReference !== next.binding.lotReference ||
              hold.expiryDate !== account.expiry ||
              row.version !== String(hold.aggregateVersion) ||
              row.occurredAt !== hold.updatedAt ||
              hold.updatedAt > next.updatedAt ||
              hold.status !== "Available"
            )
              return fail("STOCK_RESERVATION_ITEM_INELIGIBLE");
          }
        }
        const currentRows = rows(
          await tx.query(
            "SELECT " +
              columns +
              " FROM rms_inventory.stock_reservation_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reservation_id=$4 ORDER BY version DESC LIMIT 1",
            [tenant, brand, store, next.reservationReference],
          ),
        );
        if (action === "Reserve") {
          if (
            currentRows.length !== 0 ||
            canonicalizeRfc8785(candidate) !== canonicalizeRfc8785(next)
          )
            return fail("STOCK_RESERVATION_CONFLICT");
        } else {
          if (currentRows.length !== 1) return fail("STOCK_RESERVATION_CONFLICT");
          const current = decode(currentRows[0]);
          if (current.account !== accountReference) return fail("STOCK_RESERVATION_CONFLICT");
          const expected = advanceInventoryReservation(current.reservation, {
            reservationReference: next.reservationReference,
            binding: next.binding,
            expectedVersion: next.version - 1,
            action,
            quantity,
            occurredAt: next.updatedAt,
          });
          if (canonicalizeRfc8785(expected) !== canonicalizeRfc8785(next))
            return fail("STOCK_RESERVATION_CONFLICT");
        }
        const balanceRows = rows(
          await tx.query(
            "SELECT on_hand::text AS on_hand,reserved::text AS reserved,available::text AS available,in_transit::text AS in_transit,ledger_version::text AS version FROM rms_inventory.stock_balance WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4 FOR UPDATE",
            [tenant, brand, store, accountReference],
          ),
        );
        if (balanceRows.length !== 1) return fail();
        const balance = closed(balanceRows[0], [
          "on_hand",
          "reserved",
          "available",
          "in_transit",
          "version",
        ]);
        if (balance.version !== String(expectedLedgerVersion))
          return fail("STOCK_RESERVATION_CONFLICT");
        if (action !== "StartProduction") {
          const calculation = calculateReservationBalance({
            action: action === "Consume" ? "ConsumeReserved" : action,
            quantity,
            unit: next.unit,
            expectedVersion: expectedLedgerVersion,
            negativeStockPolicy: "Block",
            before: {
              onHand: balance.on_hand,
              reserved: balance.reserved,
              available: balance.available,
              inTransit: balance.in_transit,
              unitCode: next.unit.unitCode,
              ledgerVersion: expectedLedgerVersion,
            },
          });
          if (calculation.requiredControl !== "None") return fail("STOCK_RESERVATION_INSUFFICIENT");
          const delta = (action === "Reserve" ? "" : "-") + calculation.quantity;
          if (recordAudit.actor.type === "System" && !system) return fail();
          const movement = parseStockMovementFact({
            movementReference,
            tenantReference: tenant,
            brandReference: brand,
            itemReference: next.binding.itemReference,
            movementType: action,
            quantityDelta: delta,
            unitCode: next.unit.unitCode,
            baseQuantityDelta: delta,
            baseUnitCode: next.unit.unitCode,
            conversionMultiplier: "1",
            sourceScope: { scopeType: "Location", scopeReference: next.binding.locationReference },
            destinationScope: null,
            lotReference: next.binding.lotReference,
            expiryDate: account.expiry,
            businessSourceType: "INVENTORY_RESERVATION",
            businessSourceReference: next.reservationReference,
            reasonCode: recordAudit.reasonCode,
            performedBy,
            occurredAt: parseInventoryInstant(next.updatedAt),
            before: calculation.before,
            after: calculation.after,
            auditReference: recordAudit.auditId,
            correctsMovementReference: null,
          });
          await tx.query(
            "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              tenant,
              brand,
              store,
              accountReference,
              movementReference,
              movement.after.ledgerVersion,
              action,
              delta,
              JSON.stringify(movement),
              recordAudit.auditId,
              next.updatedAt,
            ],
          );
        }
        await appendAuditRecordInTransaction(tx, recordAudit);
        await tx.query(
          "INSERT INTO rms_inventory.stock_reservation_version (tenant_id,brand_id,store_id,account_id,reservation_id,version,operation_id,intent_hash,action,submission_id,demand_id,movement_id,audit_id,snapshot_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            tenant,
            brand,
            store,
            accountReference,
            next.reservationReference,
            next.version,
            operation,
            intent,
            action,
            next.binding.submissionReference,
            next.binding.demandReference,
            movementReference,
            recordAudit.auditId,
            JSON.stringify(next),
            next.updatedAt,
          ],
        );
        if (!(await allowed())) return fail();
        return Object.freeze({
          status: "Applied",
          reservation: next,
          movementReference,
          auditReference: recordAudit.auditId,
        });
      });
    },
  });
}

/** Public-owner source evidence; the producer must fence its own facts in this transaction. */
export interface SubmissionInventoryDemand {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly stockSiteReference: string;
  readonly submissionReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly demandReference: string;
  readonly workflowReference: string;
  readonly workflowVersion: number;
  readonly reserveTrigger: "OrderSubmission";
  readonly sourceDigest: string;
  readonly contributions: readonly StockDemandContribution[];
}

/** Internal composition: authorize current caller; only original recovery skips current source resolution. */
export function createPostgresSubmissionReservationStore(
  runner: InventoryItemTransactionRunner,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  sources: Readonly<{
    authorize(tx: InventoryItemTransaction, input: StockReservationSetWrite): Promise<boolean>;
    resolveDemand(
      tx: InventoryItemTransaction,
      input: StockReservationSetWrite,
    ): Promise<SubmissionInventoryDemand>;
    resolveExpiryCutoff(
      tx: InventoryItemTransaction,
      input: Readonly<{
        storeReference: string;
        accountReference: string;
        expiryDate: string;
        observedAt: string;
      }>,
    ): Promise<string>;
  }>,
) {
  return Object.freeze({
    async commit(input: StockReservationSetWrite) {
      return runner.run(async (tx) => {
        if ((await sources.authorize(tx, input)) !== true)
          return fail("STOCK_RESERVATION_CONFLICT");
        const bound = {
          run: async <T>(work: (transaction: InventoryItemTransaction) => Promise<T>) => work(tx),
        };
        const store = createPostgresStockReservationStore(bound, scope);
        return store.commitSet(input, async (_tx, writes) => {
          const first = writes[0];
          if (!first) return fail();
          const b = first.reservation.binding;
          const observedAt = first.reservation.createdAt;
          const source = closed(await sources.resolveDemand(tx, input), [
            "tenantReference",
            "brandReference",
            "storeReference",
            "stockSiteReference",
            "submissionReference",
            "cartReference",
            "cartVersion",
            "quoteReference",
            "demandReference",
            "workflowReference",
            "workflowVersion",
            "reserveTrigger",
            "sourceDigest",
            "contributions",
          ]);
          for (const field of [
            "tenantReference",
            "brandReference",
            "storeReference",
            "stockSiteReference",
            "submissionReference",
            "cartReference",
            "cartVersion",
            "quoteReference",
            "demandReference",
          ] as const)
            if (source[field] !== b[field]) return fail("STOCK_RESERVATION_CONFLICT");
          if (
            source.workflowReference !== input.workflowReference ||
            source.workflowVersion !== input.workflowVersion ||
            source.reserveTrigger !== "OrderSubmission" ||
            typeof source.sourceDigest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(source.sourceDigest) ||
            b.demandDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(source))
          )
            return fail("STOCK_RESERVATION_CONFLICT");
          const plan = await createPostgresSubmissionStockPlanSource(bound, scope, {
            resolveExpiryCutoff: sources.resolveExpiryCutoff,
          }).resolve(source as unknown as SubmissionInventoryDemand, observedAt);
          const expected = plan.allocations;
          const actual = writes.map((w) => ({
            accountReference: w.accountReference,
            locationReference: w.reservation.binding.locationReference,
            expectedLedgerVersion: w.expectedLedgerVersion,
            quantity: w.quantity,
            itemReference: w.reservation.binding.itemReference,
            unit: w.reservation.unit,
            stockSiteReference: w.reservation.binding.stockSiteReference,
            lotReference: w.reservation.binding.lotReference,
            ...(w.reservation.binding.cartItemReference === undefined
              ? {}
              : { cartItemReference: w.reservation.binding.cartItemReference }),
          }));
          const canonicalSet = (values: readonly unknown[]) =>
            canonicalizeRfc8785(values.map((value) => canonicalizeRfc8785(value)).sort());
          if (canonicalSet(actual) !== canonicalSet(expected))
            return fail("STOCK_RESERVATION_CONFLICT");
        });
      });
    },
  });
}

export interface SubmissionStockAllocation {
  readonly accountReference: string;
  readonly locationReference: string;
  readonly expectedLedgerVersion: number;
  readonly quantity: string;
  readonly itemReference: string;
  readonly unit: InventoryUnit;
  readonly stockSiteReference: string;
  readonly lotReference: string | null;
  /** Present for per-line submission demand (WP-2423). */
  readonly cartItemReference?: string;
}
export type SubmissionExpiryCutoff = (
  transaction: InventoryItemTransaction,
  input: Readonly<{
    storeReference: string;
    accountReference: string;
    expiryDate: string;
    observedAt: string;
  }>,
) => Promise<string>;

/** A recipe contribution; submission demand tags each one with its Order line (all or none). */
export type StockDemandContribution = RecipeItemDemandContribution & {
  readonly cartItemReference?: string;
};
function captureStockContributions(value: unknown): readonly StockDemandContribution[] {
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  let tagged: boolean | null = null;
  const contributions = Object.freeze(
    Array.from({ length: value.length }, (_, i) => {
      const slot = Object.getOwnPropertyDescriptor(value, String(i));
      if (!slot?.enumerable || !("value" in slot)) return fail();
      const line =
        slot.value !== null &&
        typeof slot.value === "object" &&
        Object.hasOwn(slot.value, "cartItemReference");
      if (tagged !== null && tagged !== line) return fail();
      tagged = line;
      const c = closed(slot.value, [
        "itemReference",
        "configurationOperationReference",
        "unitDimension",
        "quantityNumerator",
        "quantityDenominator",
        ...(line ? ["cartItemReference"] : []),
      ]);
      if (
        typeof c.unitDimension !== "string" ||
        typeof c.quantityNumerator !== "string" ||
        typeof c.quantityDenominator !== "string"
      )
        return fail();
      return Object.freeze({
        itemReference: parseInventoryReference(c.itemReference),
        configurationOperationReference: parseInventoryReference(c.configurationOperationReference),
        unitDimension: c.unitDimension,
        quantityNumerator: c.quantityNumerator,
        quantityDenominator: c.quantityDenominator,
        ...(line ? { cartItemReference: parseInventoryReference(c.cartItemReference) } : {}),
      });
    }),
  );
  return contributions;
}

function captureSubmissionDemand(value: unknown): SubmissionInventoryDemand {
  const raw = closed(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "stockSiteReference",
    "submissionReference",
    "cartReference",
    "cartVersion",
    "quoteReference",
    "demandReference",
    "workflowReference",
    "workflowVersion",
    "reserveTrigger",
    "sourceDigest",
    "contributions",
  ]);
  if (
    raw.reserveTrigger !== "OrderSubmission" ||
    typeof raw.sourceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(raw.sourceDigest) ||
    !Array.isArray(raw.contributions) ||
    raw.contributions.length > 4096 ||
    Reflect.ownKeys(raw.contributions).length !== raw.contributions.length + 1
  )
    return fail();
  const contributions = captureStockContributions(raw.contributions);
  return Object.freeze({
    tenantReference: parseInventoryReference(raw.tenantReference),
    brandReference: parseInventoryReference(raw.brandReference),
    storeReference: parseInventoryReference(raw.storeReference),
    stockSiteReference: parseInventoryReference(raw.stockSiteReference),
    submissionReference: parseInventoryReference(raw.submissionReference),
    cartReference: parseInventoryReference(raw.cartReference),
    cartVersion: version(raw.cartVersion),
    quoteReference: parseInventoryReference(raw.quoteReference),
    demandReference: parseInventoryReference(raw.demandReference),
    workflowReference: parseInventoryReference(raw.workflowReference),
    workflowVersion: version(raw.workflowVersion),
    reserveTrigger: "OrderSubmission",
    sourceDigest: raw.sourceDigest,
    contributions,
  });
}

export type RecipeStockDemand = Pick<
  SubmissionInventoryDemand,
  "tenantReference" | "brandReference" | "storeReference" | "stockSiteReference" | "contributions"
>;

/**
 * Actual owner observations for server-side allocation. Not a durable reservation or authorization.
 * Commit uses this same calculation again under Item locks; stale account versions still reject.
 * Untracked/zero-demand Items stay in requirements but produce no reservation allocation.
 */
export function createPostgresRecipeStockPlanSource(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{ resolveExpiryCutoff: SubmissionExpiryCutoff }>,
) {
  const raw = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const scope = Object.freeze({
    tenantReference: parseInventoryReference(raw.tenantReference),
    brandReference: parseInventoryReference(raw.brandReference),
    storeReference: parseInventoryReference(raw.storeReference),
  });
  return Object.freeze({
    async resolve(value: RecipeStockDemand, at: string) {
      try {
        const captured = closed(value, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "stockSiteReference",
          "contributions",
        ]);
        const demand = Object.freeze({
          tenantReference: parseInventoryReference(captured.tenantReference),
          brandReference: parseInventoryReference(captured.brandReference),
          storeReference: parseInventoryReference(captured.storeReference),
          stockSiteReference: parseInventoryReference(captured.stockSiteReference),
          contributions: captureStockContributions(captured.contributions),
        });
        const observedAt = parseInventoryInstant(at);
        for (const field of ["tenantReference", "brandReference", "storeReference"] as const)
          if (demand[field] !== scope[field]) return fail("STOCK_RESERVATION_CONFLICT");
        return await runner.run(async (tx) => {
          const bound = {
            run: async <T>(work: (tx: InventoryItemTransaction) => Promise<T>) => work(tx),
          };
          try {
            const itemStore = createPostgresInventoryItemStore(bound, {
              tenantReference: demand.tenantReference,
              brandReference: demand.brandReference,
            });
            const itemScope = {
              tenantReference: demand.tenantReference,
              brandReference: demand.brandReference,
            };
            const perLine = demand.contributions.some((c) => c.cartItemReference !== undefined);
            // Per-line demand (WP-2423) allocates each Order line separately; the aggregate path
            // is kept for pre-submission observations that have no line identity.
            type Requirement = Awaited<
              ReturnType<ReturnType<typeof createInventoryRecipeDemandSource>["resolve"]>
            >[number];
            let requirements: readonly Requirement[];
            let work: { cartItemReference: string | null; requirement: Requirement }[];
            if (perLine) {
              const resolved = await createInventoryRecipeLineDemandSource(
                itemStore,
                itemScope,
              ).resolve(
                demand.contributions as readonly RecipeLineDemandContribution[],
                observedAt,
              );
              requirements = resolved.requirements;
              work = resolved.lines.flatMap((line) =>
                line.requirements.map((requirement) => ({
                  cartItemReference: line.cartItemReference,
                  requirement,
                })),
              );
            } else {
              requirements = await createInventoryRecipeDemandSource(itemStore, itemScope).resolve(
                demand.contributions,
                observedAt,
              );
              work = requirements.map((requirement) => ({ cartItemReference: null, requirement }));
            }
            const expected: SubmissionStockAllocation[] = [];
            const candidateCache = new Map<
              string,
              Awaited<ReturnType<ReturnType<typeof createPostgresStockCandidateSource>["list"]>>
            >();
            // Running per-account state across lines: availability already planned and the
            // ledger version each further Reserve on that account will observe.
            const running = new Map<string, { usedMicro: bigint; reserves: number }>();
            const microOf = (value: string) => {
              const [whole = "0", fraction = ""] = value.split(".");
              return BigInt(whole + fraction.padEnd(6, "0"));
            };
            const decimalOf = (value: bigint) => {
              const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
              return (value / 1_000_000n).toString() + (fraction ? "." + fraction : "");
            };
            for (const { cartItemReference, requirement } of work) {
              if (requirement.quantity === "0") continue;
              if (!requirement.trackingPolicy.stockTrackingEnabled) continue;
              let candidates = candidateCache.get(requirement.itemReference);
              if (!candidates) {
                candidates = await createPostgresStockCandidateSource(bound, scope).list({
                  itemReference: requirement.itemReference,
                  stockSiteReference: demand.stockSiteReference,
                  observedAt,
                });
                candidateCache.set(requirement.itemReference, candidates);
              }
              const normalized = [];
              for (const c of candidates) {
                const state = running.get(c.accountReference) ?? { usedMicro: 0n, reserves: 0 };
                const remaining = microOf(c.available) - state.usedMicro;
                normalized.push({
                  tenantReference: c.tenantReference,
                  brandReference: c.brandReference,
                  storeReference: c.storeReference,
                  stockSiteReference: c.stockSiteReference,
                  itemReference: c.itemReference,
                  currentItemVersion: c.currentItemVersion,
                  accountReference: c.accountReference,
                  locationReference: c.locationReference,
                  ledgerVersion: c.ledgerVersion + state.reserves,
                  unitCode: c.unit.unitCode,
                  ledgerPrecision: c.unit.ledgerPrecision,
                  available: decimalOf(remaining > 0n ? remaining : 0n),
                  holdStatus: c.holdStatus,
                  firstReceivedAt: c.firstReceivedAt,
                  observedAt: c.observedAt,
                  expiryDate: c.expiryDate,
                  expiryCutoff:
                    c.expiryDate === null
                      ? null
                      : await options.resolveExpiryCutoff(tx, {
                          storeReference: demand.storeReference,
                          accountReference: c.accountReference,
                          expiryDate: c.expiryDate,
                          observedAt,
                        }),
                });
              }
              const plan = planStockAllocation({
                tenantReference: demand.tenantReference,
                brandReference: demand.brandReference,
                storeReference: demand.storeReference,
                stockSiteReference: demand.stockSiteReference,
                itemReference: requirement.itemReference,
                currentItemVersion: requirement.currentItemVersion,
                unit: requirement.unit,
                quantity: requirement.quantity,
                issuePolicy: requirement.trackingPolicy.issuePolicy,
                observedAt,
                candidates: normalized,
              });
              if (plan.status !== "Ready") return fail("STOCK_RESERVATION_INSUFFICIENT");
              for (const allocation of plan.allocations) {
                const candidate = candidates.find(
                  (c) => c.accountReference === allocation.accountReference,
                );
                if (!candidate) return fail();
                const state = running.get(candidate.accountReference) ?? {
                  usedMicro: 0n,
                  reserves: 0,
                };
                running.set(candidate.accountReference, {
                  usedMicro: state.usedMicro + microOf(allocation.quantity),
                  reserves: state.reserves + 1,
                });
                expected.push({
                  ...allocation,
                  itemReference: requirement.itemReference,
                  unit: requirement.unit,
                  stockSiteReference: demand.stockSiteReference,
                  lotReference: candidate.lotReference,
                  ...(cartItemReference === null ? {} : { cartItemReference }),
                });
              }
            }
            return Object.freeze({
              demand,
              demandDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(demand)),
              observedAt,
              requirements,
              allocations: Object.freeze(expected.map((allocation) => Object.freeze(allocation))),
            });
          } finally {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [scope.tenantReference, scope.brandReference, scope.storeReference],
            );
          }
        });
      } catch (error) {
        if (error instanceof StockReservationStoreError) throw error;
        return fail();
      }
    },
  });
}

/** Preserve the submission contract while sharing the same current Item and
 * stock allocation calculation with pre-submission observations.
 */
export function createPostgresSubmissionStockPlanSource(
  runner: InventoryItemTransactionRunner,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{ resolveExpiryCutoff: SubmissionExpiryCutoff }>,
) {
  const source = createPostgresRecipeStockPlanSource(runner, scope, options);
  return Object.freeze({
    async resolve(value: SubmissionInventoryDemand, at: string) {
      const demand = captureSubmissionDemand(value);
      const plan = await source.resolve(
        {
          tenantReference: demand.tenantReference,
          brandReference: demand.brandReference,
          storeReference: demand.storeReference,
          stockSiteReference: demand.stockSiteReference,
          contributions: demand.contributions,
        },
        at,
      );
      return Object.freeze({
        ...plan,
        demand,
        demandDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(demand)),
      });
    },
  });
}
