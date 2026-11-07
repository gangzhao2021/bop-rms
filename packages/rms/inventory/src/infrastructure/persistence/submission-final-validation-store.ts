import { createPostgresStockCandidateSource } from "./stock-candidate-source.js";
import { createPostgresInventoryItemStore } from "./inventory-item-store.js";
import {
  createInventoryRecipeDemandSource,
  createInventoryRecipeLineDemandSource,
  type RecipeItemDemandContribution,
  type RecipeLineDemandContribution,
} from "../../application/recipe-demand-source.js";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
  sha256Hex,
} from "@bop/audit";
import {
  parseInventoryReference,
  parseInventoryInstant,
  type InventoryItemAggregate,
} from "../../domain/inventory-item.js";
import { createPostgresStockReservationStore } from "./stock-reservation-store.js";
import {
  parseSubmissionInventoryFinalValidation,
  type SubmissionInventoryFinalValidation,
} from "../../domain/submission-final-validation.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";

export interface SystemInventoryReleaseLookup {
  readonly submissionReference: string;
  readonly orderReference: string;
  readonly cancellationReference: string;
  readonly systemActorReference: string;
  readonly observedAt: string;
}

export interface CurrentSubmissionInventoryFacts {
  readonly record: SubmissionInventoryFinalValidation;
  readonly observedAt: string;
  readonly items: readonly InventoryItemAggregate[];
  readonly accounts: readonly NonNullable<
    Awaited<ReturnType<ReturnType<typeof createPostgresStockCandidateSource>["loadAccount"]>>
  >[];
  readonly reservations: readonly NonNullable<
    Awaited<ReturnType<ReturnType<typeof createPostgresStockReservationStore>["loadCurrent"]>>
  >[];
}

export class InventoryFinalValidationStoreError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_FINAL_VALIDATION_UNAVAILABLE"
      | "INVENTORY_FINAL_VALIDATION_CONFLICT"
      | "INVENTORY_FINAL_VALIDATION_DENIED",
  ) {
    super("Inventory final validation storage is unavailable");
    this.name = "InventoryFinalValidationStoreError";
  }
}
function fail(
  code: InventoryFinalValidationStoreError["code"] = "INVENTORY_FINAL_VALIDATION_UNAVAILABLE",
): never {
  throw new InventoryFinalValidationStoreError(code);
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
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return fail();
  return d.value;
}
/** Internal owner capability. Runner must retain all source fences through COMMIT/ROLLBACK. */
export function createPostgresSubmissionFinalValidationStore(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  sources: Readonly<{
    authorize(
      transaction: InventoryItemTransaction,
      input: Readonly<{
        submissionReference: string;
        actorReference: string;
      }>,
    ): Promise<boolean>;
    /** Current cancellation authority must be established through its owning Domain. */
    authorizeSystemRelease?(
      transaction: InventoryItemTransaction,
      input: Readonly<SystemInventoryReleaseLookup>,
    ): Promise<boolean>;
    /** Resolve actual Workflow/Recipe/Item/reservation facts; do not echo an unverified proposal. */
    resolveCurrent(
      transaction: InventoryItemTransaction,
      proposal: SubmissionInventoryFinalValidation,
    ): Promise<
      Readonly<{ record: unknown; contributions: readonly RecipeItemDemandContribution[] }>
    >;
  }>,
) {
  const rawScope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const scope = Object.freeze({
    tenantReference: parseInventoryReference(rawScope.tenantReference),
    brandReference: parseInventoryReference(rawScope.brandReference),
    storeReference: parseInventoryReference(rawScope.storeReference),
  });
  const scopeValues = [scope.tenantReference, scope.brandReference, scope.storeReference];
  function bind(value: unknown) {
    const record = parseSubmissionInventoryFinalValidation(value);
    for (const field of ["tenantReference", "brandReference", "storeReference"] as const)
      if (record[field] !== scope[field]) return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
    return record;
  }
  async function configure(tx: InventoryItemTransaction) {
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      scopeValues,
    );
  }
  async function read(tx: InventoryItemTransaction, submission: string) {
    const result = rows(
      await tx.query(
        "SELECT record_json,record_digest FROM rms_inventory.submission_final_validation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND submission_id=$4",
        [...scopeValues, submission],
      ),
    );
    if (result.length === 0) return null;
    const row = closed(result[0], ["record_json", "record_digest"]);
    const record = bind(row.record_json);
    if (record.submissionReference !== submission || digest(record) !== row.record_digest)
      return fail();
    return record;
  }
  async function authorize(
    tx: InventoryItemTransaction,
    submissionReference: string,
    actorReference: string,
  ) {
    if (
      (await sources.authorize(tx, Object.freeze({ submissionReference, actorReference }))) !== true
    )
      return fail("INVENTORY_FINAL_VALIDATION_DENIED");
  }
  return Object.freeze({
    /** Immutable original submission facts only; does not authorize or perform release. */
    async loadForSystemRelease(value: SystemInventoryReleaseLookup) {
      try {
        const raw = closed(value, [
          "submissionReference",
          "orderReference",
          "cancellationReference",
          "systemActorReference",
          "observedAt",
        ]);
        const input = Object.freeze({
          submissionReference: parseInventoryReference(raw.submissionReference),
          orderReference: parseInventoryReference(raw.orderReference),
          cancellationReference: parseInventoryReference(raw.cancellationReference),
          systemActorReference: parseInventoryReference(raw.systemActorReference),
          observedAt: parseInventoryInstant(raw.observedAt),
        });
        if (typeof sources.authorizeSystemRelease !== "function")
          return fail("INVENTORY_FINAL_VALIDATION_DENIED");
        const authorizeRelease = sources.authorizeSystemRelease.bind(sources);
        return await runner.run(async (tx) => {
          await configure(tx);
          if ((await authorizeRelease(tx, input)) !== true)
            return fail("INVENTORY_FINAL_VALIDATION_DENIED");
          const record = await read(tx, input.submissionReference);
          if (
            record !== null &&
            (record.orderReference !== input.orderReference || record.observedAt > input.observedAt)
          )
            return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          if ((await authorizeRelease(tx, input)) !== true)
            return fail("INVENTORY_FINAL_VALIDATION_DENIED");
          return record;
        });
      } catch (error) {
        if (error instanceof InventoryFinalValidationStoreError) throw error;
        return fail();
      }
    },
    async load(input: Readonly<{ submissionReference: string; actorReference: string }>) {
      try {
        const raw = closed(input, ["submissionReference", "actorReference"]);
        const submission = parseInventoryReference(raw.submissionReference);
        const actor = parseInventoryReference(raw.actorReference);
        return await runner.run(async (tx) => {
          await configure(tx);
          await authorize(tx, submission, actor);
          const record = await read(tx, submission);
          if (record !== null && record.actorReference !== actor)
            return fail("INVENTORY_FINAL_VALIDATION_DENIED");
          return record;
        });
      } catch (error) {
        if (error instanceof InventoryFinalValidationStoreError) throw error;
        return fail();
      }
    },
    /**
     * Current facts fenced through caller work and the runner's commit/rollback.
     * Does not assert Payment readiness; the caller supplies its business decision and authorization.
     */
    async withCurrent<T>(
      input: Readonly<{ submissionReference: string; actorReference: string; observedAt: string }>,
      work: (
        transaction: InventoryItemTransaction,
        facts: CurrentSubmissionInventoryFacts,
      ) => Promise<T>,
    ): Promise<T | null> {
      try {
        const raw = closed(input, ["submissionReference", "actorReference", "observedAt"]);
        const submission = parseInventoryReference(raw.submissionReference);
        const actor = parseInventoryReference(raw.actorReference);
        const observedAt = parseInventoryInstant(raw.observedAt);
        return await runner.run(async (tx) => {
          await configure(tx);
          await authorize(tx, submission, actor);
          const record = await read(tx, submission);
          if (record === null) return null;
          if (record.actorReference !== actor) return fail("INVENTORY_FINAL_VALIDATION_DENIED");
          if (record.observedAt > observedAt) return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          const bound = {
            run: async <R>(action: (transaction: InventoryItemTransaction) => Promise<R>) =>
              action(tx),
          };
          const itemStore = createPostgresInventoryItemStore(bound, {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
          });
          const items: InventoryItemAggregate[] = [];
          for (const original of [...record.items].sort((a, b) =>
            a.itemReference.localeCompare(b.itemReference),
          )) {
            const item = await itemStore.loadForUpdate(original.itemReference);
            if (
              item === null ||
              item.aggregateVersion < original.currentItemVersion ||
              item.updatedAt > observedAt
            )
              return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
            items.push(item);
          }
          await configure(tx);
          const reservationStore = createPostgresStockReservationStore(bound, scope);
          const reservations: NonNullable<
            Awaited<ReturnType<typeof reservationStore.loadCurrent>>
          >[] = [];
          const accountSource = createPostgresStockCandidateSource(bound, scope);
          const accounts: NonNullable<Awaited<ReturnType<typeof accountSource.loadAccount>>>[] = [];
          for (const original of record.reservationSet?.entries ?? []) {
            const current = await reservationStore.loadCurrent(
              original.reservation.reservationReference,
            );
            if (
              current === null ||
              current.accountReference !== original.accountReference ||
              current.reservation.version < original.reservation.version ||
              current.reservation.updatedAt > observedAt ||
              current.reservation.originalQuantity !== original.reservation.originalQuantity ||
              canonicalizeRfc8785(current.reservation.binding) !==
                canonicalizeRfc8785(original.reservation.binding) ||
              canonicalizeRfc8785(current.reservation.unit) !==
                canonicalizeRfc8785(original.reservation.unit)
            )
              return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
            const binding = current.reservation.binding;
            const account = await accountSource.loadAccount({
              accountReference: current.accountReference,
              itemReference: binding.itemReference,
              stockSiteReference: binding.stockSiteReference,
              observedAt,
            });
            if (
              account === null ||
              account.locationReference !== binding.locationReference ||
              account.lotReference !== binding.lotReference ||
              canonicalizeRfc8785(account.unit) !== canonicalizeRfc8785(current.reservation.unit)
            )
              return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
            accounts.push(account);
            reservations.push(current);
          }
          await configure(tx);
          await authorize(tx, submission, actor);
          const result = await work(
            tx,
            Object.freeze({
              record,
              observedAt,
              items: Object.freeze(items),
              accounts: Object.freeze(accounts),
              reservations: Object.freeze(reservations),
            }),
          );
          await configure(tx);
          await authorize(tx, submission, actor);
          return result;
        });
      } catch (error) {
        if (error instanceof InventoryFinalValidationStoreError) throw error;
        return fail();
      }
    },
    async commit(input: Readonly<{ record: unknown; audit: unknown }>) {
      try {
        const raw = closed(input, ["record", "audit"]);
        const record = bind(raw.record);
        const auditRaw = closed(raw.audit, [
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
        const actor = closed(auditRaw.actor, ["type", "reference"]);
        const audit = validateAuditRecord(
          { ...auditRaw, actor: Object.freeze(actor) },
          Date.parse(record.observedAt),
        );
        if (
          audit.auditId !== record.auditReference ||
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          audit.actor.type === "System" ||
          audit.actor.reference !== record.actorReference ||
          audit.actionCode !== "INVENTORY_SUBMISSION_FINALIZE" ||
          audit.targetType !== "InventoryFinalValidation" ||
          audit.targetId !== record.validationReference ||
          audit.correlationId !== record.operationReference ||
          audit.occurredAt !== record.observedAt ||
          audit.dataClassification !== "Internal"
        )
          return fail();
        const hash = digest(record);
        return await runner.run(async (tx) => {
          await configure(tx);
          await authorize(tx, record.submissionReference, record.actorReference);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            ["InventoryFinalValidation", ...scopeValues, record.submissionReference].join(":"),
          ]);
          const original = await read(tx, record.submissionReference);
          if (original !== null) {
            if (digest(original) !== hash) return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
            return Object.freeze({ status: "AlreadyApplied" as const, record: original });
          }
          const source = closed(await sources.resolveCurrent(tx, record), [
            "record",
            "contributions",
          ]);
          const current = bind(source.record);
          if (digest(current) !== hash) return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          if (
            !Array.isArray(source.contributions) ||
            source.contributions.length > 4096 ||
            Reflect.ownKeys(source.contributions).length !== source.contributions.length + 1
          )
            return fail();
          let tagged: boolean | null = null;
          const contributions = Object.freeze(
            Array.from({ length: source.contributions.length }, (_, index) => {
              const slot = Object.getOwnPropertyDescriptor(source.contributions, String(index));
              if (!slot?.enumerable || !("value" in slot)) return fail();
              const line =
                slot.value !== null &&
                typeof slot.value === "object" &&
                Object.hasOwn(slot.value, "cartItemReference");
              if (tagged !== null && tagged !== line) return fail();
              tagged = line;
              const raw = closed(slot.value, [
                "itemReference",
                "configurationOperationReference",
                "unitDimension",
                "quantityNumerator",
                "quantityDenominator",
                ...(line ? ["cartItemReference"] : []),
              ]);
              if (
                typeof raw.unitDimension !== "string" ||
                typeof raw.quantityNumerator !== "string" ||
                typeof raw.quantityDenominator !== "string"
              )
                return fail();
              return Object.freeze({
                itemReference: parseInventoryReference(raw.itemReference),
                configurationOperationReference: parseInventoryReference(
                  raw.configurationOperationReference,
                ),
                unitDimension: raw.unitDimension,
                quantityNumerator: raw.quantityNumerator,
                quantityDenominator: raw.quantityDenominator,
                ...(line
                  ? { cartItemReference: parseInventoryReference(raw.cartItemReference) }
                  : {}),
              });
            }),
          );
          const itemStore = createPostgresInventoryItemStore(
            { run: async (work) => work(tx) },
            { tenantReference: scope.tenantReference, brandReference: scope.brandReference },
          );
          // Lock the complete independently resolved demand, not just the proposed result items.
          const references = [...new Set(contributions.map((item) => item.itemReference))].sort();
          for (const reference of references) {
            if ((await itemStore.loadForUpdate(reference)) === null)
              return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          }
          // Per-line demand (WP-2423) validates the same rounded line totals that were reserved.
          const requirements = tagged
            ? (
                await createInventoryRecipeLineDemandSource(itemStore, scope).resolve(
                  contributions as readonly RecipeLineDemandContribution[],
                  current.observedAt,
                )
              ).requirements
            : await createInventoryRecipeDemandSource(itemStore, scope).resolve(
                contributions,
                current.observedAt,
              );
          if (requirements.length !== current.items.length)
            return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          for (const actual of requirements) {
            const item = current.items.find((item) => item.itemReference === actual.itemReference);
            if (
              !item ||
              actual.currentItemVersion !== item.currentItemVersion ||
              actual.trackingPolicy.stockTrackingEnabled !== item.stockTrackingEnabled ||
              actual.quantity !== item.quantity ||
              canonicalizeRfc8785(actual.unit) !== canonicalizeRfc8785(item.unit) ||
              canonicalizeRfc8785(
                actual.sources.map((source) => source.sourceVersionReference).sort(),
              ) !== canonicalizeRfc8785([...item.configurationOperationReferences].sort())
            )
              return fail("INVENTORY_FINAL_VALIDATION_CONFLICT");
          }
          // The Brand-scoped Item owner clears Store context while resolving its facts.
          await configure(tx);
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query(
            `INSERT INTO rms_inventory.submission_final_validation
             (tenant_id,brand_id,store_id,validation_id,operation_id,actor_id,audit_id,order_id,
              submission_id,cart_id,cart_version,quote_id,demand_id,demand_digest,workflow_id,
              workflow_version_id,workflow_version,transition_id,reservation_set_id,observed_at,
              record_digest,record_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)`,
            [
              ...scopeValues,
              record.validationReference,
              record.operationReference,
              record.actorReference,
              record.auditReference,
              record.orderReference,
              record.submissionReference,
              record.cartReference,
              record.cartVersion,
              record.quoteReference,
              record.demandReference,
              record.demandDigest,
              record.workflowReference,
              record.workflowVersionReference,
              record.workflowVersion,
              record.transitionReference,
              record.reservationSet?.setReference ?? null,
              record.observedAt,
              hash,
              canonicalizeRfc8785(record),
            ],
          );
          const saved = await read(tx, record.submissionReference);
          if (saved === null || digest(saved) !== hash) return fail();
          return Object.freeze({ status: "Applied" as const, record: saved });
        });
      } catch (error) {
        if (error instanceof InventoryFinalValidationStoreError) throw error;
        return fail();
      }
    },
  });
}
