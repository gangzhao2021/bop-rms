import { createMerchantBusinessDayWindows } from "../../apps/api/dist/merchant-business-day-window.js";
import { readEarlierOrdersHoldingStock } from "../../apps/api/dist/merchant-stock-holding-orders.js";

/**
 * WP-2423 (2026-10-16 v15 stock leak): for the operations monitor, the installation Store's Orders
 * of earlier business days that still hold stock (read only, api role and Store row security):
 * how many are still open, how many ended with stock left, and when the oldest hold began.
 */
export async function readInternalHeldStockOrders(
  resources,
  transactions = resources.transactions,
) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    brandReference: resources.scope.brandReference,
    storeReference: resources.scope.storeReference,
  };
  const now = new Date(resources.now()).toISOString();
  return transactions.run(async (tx) => {
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
    const today = await createMerchantBusinessDayWindows({
      persistence: {
        now: () => now,
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: resources.operating.requiredLiveGateRequirementCodes,
          requiredValidationCheckCodes: resources.operating.requiredValidationCheckCodes,
        },
      },
      scope,
      timeZone: resources.operating.timeZone,
      authorize: async () => true,
    }).today(tx, now);
    const held = await readEarlierOrdersHoldingStock(tx, scope, today);
    const orders = new Map();
    for (const entry of held) {
      const prior = orders.get(entry.orderReference);
      orders.set(entry.orderReference, {
        open: (prior?.open ?? false) || entry.state === "Open",
        since: prior === undefined || entry.heldSince < prior.since ? entry.heldSince : prior.since,
      });
    }
    const values = [...orders.values()];
    const oldest = values.map((value) => value.since).sort()[0] ?? null;
    return {
      openCount: values.filter((value) => value.open).length,
      endedCount: values.filter((value) => !value.open).length,
      oldestAt: oldest,
    };
  });
}
