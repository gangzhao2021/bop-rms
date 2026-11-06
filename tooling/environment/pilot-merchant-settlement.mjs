import { createPersistentMerchantSettlement } from "../../apps/api/dist/persistent-merchant-settlement.js";
import {
  dailySettlementRunReference,
  dailySettlementRecheckRunReference,
  dailySettlementRecheckLimit,
} from "./pilot-daily-settlement-reference.mjs";

/**
 * WP-2423 P1: the day-end settlement read of this merchant composition's own Store (`selected`),
 * with the Provider account it settles and the run references its daily settlement scheduler
 * derives for a closed day. WP-2423 M160: the first day it can show is the Store's own (its
 * business-day owner), not the installation's daily-settlement coverage file, which names the one
 * Store the reconciliation scheduler runs for; a day the scheduler does not cover shows its
 * figures with the reconciliation "not checked yet".
 */
export function createPilotMerchantSettlement({ persistence, selected, refundConfiguration }) {
  return createPersistentMerchantSettlement({
    persistence,
    resolveConfiguration: async (tx, scope) => {
      const configuration = await refundConfiguration(tx, scope);
      return {
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
      };
    },
    // The run the pilot's daily settlement scheduler creates for that closed day.
    settlementRunReference: async (scope, window) => {
      for (const key of ["brandReference", "storeReference"])
        if (scope[key] !== selected[key]) throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
      return dailySettlementRunReference({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        businessDate: window.businessDate,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      }).runReference;
    },
    // WP-2423: the re-check runs the settlement worker derives for that day, in order.
    settlementRecheckRunReferences: async (scope, window) => {
      for (const key of ["brandReference", "storeReference"])
        if (scope[key] !== selected[key]) throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
      const day = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        businessDate: window.businessDate,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
      };
      return Array.from({ length: dailySettlementRecheckLimit }, (_, n) =>
        dailySettlementRecheckRunReference(day, n + 1),
      );
    },
  });
}
