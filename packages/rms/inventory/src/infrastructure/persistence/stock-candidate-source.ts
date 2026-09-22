import {
  createPostgresInventoryItemStore,
  type InventoryItemTransactionRunner,
} from "./inventory-item-store.js";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryDecimal,
} from "../../domain/inventory-item.js";
import { parseLotHoldSnapshot } from "../../domain/lot-hold-snapshot.js";
function fail(): never {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1000) return fail();
  return d.value;
}
function version(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail();
  return Number(value);
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00.000Z")) ||
    new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) !== value
  )
    return fail();
  return value;
}
/** Scoped observations only: access authorization, expiry resolution and write fences belong to the caller. */
export function createPostgresStockCandidateSource(
  runner: InventoryItemTransactionRunner,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
) {
  const tenant = parseInventoryReference(scope.tenantReference),
    brand = parseInventoryReference(scope.brandReference),
    store = parseInventoryReference(scope.storeReference);
  async function observe(
    input: Readonly<{ itemReference: string; stockSiteReference: string; observedAt: string }>,
    accountReference: string | null,
  ) {
    try {
      const itemReference = parseInventoryReference(input.itemReference),
        site = parseInventoryReference(input.stockSiteReference),
        observedAt = parseInventoryInstant(input.observedAt);
      return await runner.run(async (tx) => {
        const item = await createPostgresInventoryItemStore(
          { run: async (work) => work(tx) },
          { tenantReference: tenant, brandReference: brand },
        ).load(itemReference);
        if (
          item === null ||
          item.lifecycle !== "Active" ||
          !item.trackingPolicy.stockTrackingEnabled ||
          item.updatedAt > observedAt
        )
          return fail();
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        const candidates = rows(
          await tx.query(
            `
            SELECT a.account_id::text AS account,a.location_id::text AS location,a.lot_id::text AS lot,
              a.expiry_date::text AS expiry,a.unit_code AS unit,a.ledger_precision AS precision,
              b.ledger_version::text AS version,b.available::text AS available,
              to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
              to_char(m.first_received AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received,
              to_char(m.last_movement AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS moved,
              h.record_json->'hold' AS hold,h.version::text AS hold_version
            FROM rms_inventory.stock_account a
            JOIN rms_inventory.stock_balance b ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.account_id=a.account_id
            LEFT JOIN LATERAL (
              SELECT min(occurred_at) FILTER (WHERE movement_type='Receive') AS first_received,max(occurred_at) AS last_movement
              FROM rms_inventory.stock_movement m WHERE m.tenant_id=a.tenant_id AND m.brand_id=a.brand_id AND m.store_id=a.store_id AND m.account_id=a.account_id
            ) m ON true
            LEFT JOIN LATERAL (
              SELECT record_json,version FROM rms_inventory.stock_lot_hold_version h
              WHERE h.tenant_id=a.tenant_id AND h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.account_id=a.account_id
              ORDER BY version DESC LIMIT 1
            ) h ON true
            WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND a.item_id=$4 AND a.stock_site_id=$5 AND ($6::uuid IS NULL AND b.available>0 OR a.account_id=$6::uuid)
            ORDER BY a.account_id LIMIT 1001
          `,
            [tenant, brand, store, itemReference, site, accountReference],
          ),
        );
        return Object.freeze(
          candidates.map((row) => {
            const accountReference = parseInventoryReference(row.account),
              locationReference = parseInventoryReference(row.location),
              lotReference = row.lot === null ? null : parseInventoryReference(row.lot),
              expiryDate = date(row.expiry),
              firstReceivedAt = parseInventoryInstant(row.received),
              lastMovementAt = parseInventoryInstant(row.moved),
              createdAt = parseInventoryInstant(row.created);
            const available = parseInventoryDecimal(row.available);
            if (
              createdAt > firstReceivedAt ||
              firstReceivedAt > lastMovementAt ||
              lastMovementAt > observedAt ||
              row.unit !== item.baseUnit.unitCode ||
              row.precision !== item.baseUnit.ledgerPrecision ||
              (expiryDate !== null && lotReference === null)
            )
              return fail();
            const mode = item.trackingPolicy.lotTrackingMode;
            if (
              (mode === "NoLot" && lotReference !== null) ||
              ((mode === "LotRequired" || mode === "LotExpiryRequired") && lotReference === null) ||
              (mode === "LotExpiryRequired" && expiryDate === null)
            )
              return fail();
            const hold = row.hold === null ? null : parseLotHoldSnapshot(row.hold);
            if (
              hold !== null &&
              (hold.tenantReference !== tenant ||
                hold.brandReference !== brand ||
                hold.itemReference !== itemReference ||
                hold.locationReference !== locationReference ||
                hold.stockScope.scopeReference !==
                  { Store: store, StockSite: site, Location: locationReference }[
                    hold.stockScope.scopeType
                  ] ||
                hold.lotReference !== lotReference ||
                hold.expiryDate !== expiryDate ||
                hold.updatedAt > observedAt ||
                hold.aggregateVersion !== version(row.hold_version))
            )
              return fail();
            if (hold === null && row.hold_version !== null) return fail();
            return Object.freeze({
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              itemReference,
              currentItemVersion: item.aggregateVersion,
              stockSiteReference: site,
              accountReference,
              locationReference,
              lotReference,
              expiryDate,
              firstReceivedAt,
              lastMovementAt,
              available,
              ledgerVersion: version(row.version),
              unit: item.baseUnit,
              trackingPolicy: item.trackingPolicy,
              holdStatus: hold?.status ?? "Available",
              holdVersion: hold?.aggregateVersion ?? null,
              observedAt,
            });
          }),
        );
      });
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    list: (
      input: Readonly<{ itemReference: string; stockSiteReference: string; observedAt: string }>,
    ) => observe(input, null),
    /** Exact account observation, including zero available stock. Caller retains authorization and Item fence. */
    async loadAccount(
      input: Readonly<{
        itemReference: string;
        stockSiteReference: string;
        observedAt: string;
        accountReference: string;
      }>,
    ) {
      const account = parseInventoryReference(input.accountReference);
      const result = await observe(input, account);
      if (result.length > 1 || (result[0] && result[0].accountReference !== account)) return fail();
      return result[0] ?? null;
    },
  });
}
