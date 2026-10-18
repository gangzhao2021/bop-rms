import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { parseInventoryReference } from "../../domain/inventory-item.js";
import {
  StockPlaceError,
  type StockPlaceCommand,
  type StockSite,
  type StorageLocation,
} from "../../domain/stock-place.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";

const fail = (code: StockPlaceError["code"] = "STOCK_PLACE_DEPENDENCY_UNAVAILABLE"): never => {
  throw new StockPlaceError(code);
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  const value =
    result !== null && typeof result === "object"
      ? (Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown)
      : null;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : fail();
}
/** Map owner database guards to stable domain codes without exposing database text. */
function translate(error: unknown): never {
  if (error instanceof StockPlaceError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (code === "23505") return fail("STOCK_PLACE_CONFLICT");
  if (code === "23514" && /Default stock place/u.test(message))
    return fail("STOCK_PLACE_DEFAULT_REQUIRED");
  if (code === "23514" && /still holds stock/u.test(message)) return fail("STOCK_PLACE_CONFLICT");
  if (code === "23514" && /version/u.test(message)) return fail("STOCK_PLACE_CONFLICT");
  throw new StockPlaceError("STOCK_PLACE_DEPENDENCY_UNAVAILABLE", { cause: error });
}

/** Inventory owner persistence for Stock Sites and Storage Locations of one Store. */
export function createPostgresStockPlaceStore(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
) {
  const tenant = parseInventoryReference(scopeInput.tenantReference),
    brand = parseInventoryReference(scopeInput.brandReference),
    store = parseInventoryReference(scopeInput.storeReference);
  async function scoped(tx: InventoryItemTransaction) {
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [tenant, brand, store],
    );
  }
  const latest = {
    StockSite:
      "SELECT DISTINCT ON (stock_site_id) snapshot_json AS snapshot FROM rms_inventory.stock_site_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3",
    StorageLocation:
      "SELECT DISTINCT ON (location_id) snapshot_json AS snapshot FROM rms_inventory.storage_location_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3",
  } as const;
  const order = { StockSite: "stock_site_id", StorageLocation: "location_id" } as const;
  async function load(
    tx: InventoryItemTransaction,
    kind: "StockSite" | "StorageLocation",
    reference: string,
  ) {
    const found = rows(
      await tx.query(
        latest[kind] + " AND " + order[kind] + "=$4 ORDER BY " + order[kind] + ", version DESC",
        [tenant, brand, store, parseInventoryReference(reference)],
      ),
    );
    return found.length === 1 ? (found[0]?.snapshot as StockSite | StorageLocation) : null;
  }
  return Object.freeze({
    /** Locations of this Store that still hold, reserve or expect stock (deactivation guard). */
    async locationsHoldingStock(): Promise<readonly string[]> {
      return runner.run(async (tx) => {
        await scoped(tx);
        return rows(
          await tx.query(
            `SELECT DISTINCT a.location_id::text AS location FROM rms_inventory.stock_account a
             JOIN rms_inventory.stock_balance b ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id
               AND b.store_id=a.store_id AND b.account_id=a.account_id
             WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3
               AND (b.on_hand<>0 OR b.reserved<>0 OR b.in_transit<>0)`,
            [tenant, brand, store],
          ),
        ).map((row) => String(row.location));
      });
    },
    async list() {
      return runner.run(async (tx) => {
        await scoped(tx);
        const sites = rows(
          await tx.query(latest.StockSite + " ORDER BY stock_site_id, version DESC", [
            tenant,
            brand,
            store,
          ]),
        ).map((row) => row.snapshot as StockSite);
        const locations = rows(
          await tx.query(latest.StorageLocation + " ORDER BY location_id, version DESC", [
            tenant,
            brand,
            store,
          ]),
        ).map((row) => row.snapshot as StorageLocation);
        return Object.freeze({
          sites: Object.freeze(sites),
          locations: Object.freeze(
            [...locations].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1)),
          ),
        });
      });
    },
    async load(kind: "StockSite" | "StorageLocation", reference: string) {
      return runner.run(async (tx) => {
        await scoped(tx);
        return load(tx, kind, reference);
      });
    },
    /** Caller supplies the candidate from `applyStockPlaceCommand` against `load` in this runner. */
    async commit(input: {
      readonly operationReference: string;
      readonly command: StockPlaceCommand;
      readonly candidate: StockSite | StorageLocation;
      readonly audit: AppendAuditRecordInput;
    }): Promise<
      Readonly<{ status: "Applied" | "AlreadyApplied"; place: StockSite | StorageLocation }>
    > {
      const operation = parseInventoryReference(input.operationReference);
      const candidate = input.candidate;
      const kind = "locationReference" in candidate ? "StorageLocation" : "StockSite";
      const target =
        kind === "StorageLocation"
          ? (candidate as StorageLocation).locationReference
          : candidate.stockSiteReference;
      if (
        candidate.tenantReference !== tenant ||
        candidate.brandReference !== brand ||
        candidate.storeReference !== store ||
        input.command.kind !== kind
      )
        return fail("STOCK_PLACE_INVALID");
      const audit = validateAuditRecord(input.audit, Date.parse(candidate.updatedAt));
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.targetType !== kind ||
        audit.targetId !== target ||
        audit.correlationId !== operation ||
        audit.occurredAt !== candidate.updatedAt ||
        audit.actor.type !== "User" ||
        audit.actor.reference !== candidate.updatedBy
      )
        return fail("STOCK_PLACE_INVALID");
      const intent =
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({ operation, command: input.command, candidate, actor: audit.actor }),
        );
      return runner.run(async (tx) => {
        try {
          await scoped(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "StockPlace:" + tenant + ":" + brand + ":" + store + ":" + operation,
          ]);
          const prior = rows(
            await tx.query(
              "SELECT intent_hash AS intent,target_kind AS kind,target_id::text AS target FROM rms_inventory.stock_place_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
              [tenant, brand, store, operation],
            ),
          );
          if (prior.length === 1) {
            if (prior[0]?.intent !== intent) return fail("STOCK_PLACE_IDEMPOTENCY_CONFLICT");
            const place = await load(tx, kind, target);
            return Object.freeze({ status: "AlreadyApplied" as const, place: place ?? fail() });
          }
          if (input.command.action === "Create") {
            // Codes are unique per Store; decided here rather than from database error text, which
            // a caller's transaction runner may withhold.
            const taken = rows(
              await tx.query(
                kind === "StockSite"
                  ? "SELECT 1 FROM rms_inventory.stock_site WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND code=$4"
                  : "SELECT 1 FROM rms_inventory.storage_location WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND code=$4",
                [tenant, brand, store, candidate.code],
              ),
            );
            if (taken.length > 0) return fail("STOCK_PLACE_CONFLICT");
            if (kind === "StockSite") {
              const site = candidate as StockSite;
              await tx.query(
                "INSERT INTO rms_inventory.stock_site (tenant_id,brand_id,store_id,stock_site_id,site_kind,code,is_default,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                  tenant,
                  brand,
                  store,
                  target,
                  site.siteKind,
                  site.code,
                  site.isDefault,
                  site.createdAt,
                  site.createdBy,
                ],
              );
            } else {
              const location = candidate as StorageLocation;
              await tx.query(
                "INSERT INTO rms_inventory.storage_location (tenant_id,brand_id,store_id,location_id,stock_site_id,code,is_default,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                  tenant,
                  brand,
                  store,
                  target,
                  location.stockSiteReference,
                  location.code,
                  location.isDefault,
                  location.createdAt,
                  location.createdBy,
                ],
              );
            }
          }
          await tx.query(
            kind === "StockSite"
              ? "INSERT INTO rms_inventory.stock_site_version (tenant_id,brand_id,store_id,stock_site_id,version,lifecycle,snapshot_json,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"
              : "INSERT INTO rms_inventory.storage_location_version (tenant_id,brand_id,store_id,location_id,version,lifecycle,snapshot_json,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              tenant,
              brand,
              store,
              target,
              candidate.aggregateVersion,
              candidate.lifecycle,
              JSON.stringify(candidate),
              candidate.updatedAt,
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query(
            "INSERT INTO rms_inventory.stock_place_operation (tenant_id,brand_id,store_id,operation_id,target_kind,target_id,version,intent_hash,action,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              tenant,
              brand,
              store,
              operation,
              kind,
              target,
              candidate.aggregateVersion,
              intent,
              input.command.action,
              audit.auditId,
            ],
          );
          return Object.freeze({ status: "Applied" as const, place: candidate });
        } catch (error) {
          return translate(error);
        }
      });
    },
  });
}
