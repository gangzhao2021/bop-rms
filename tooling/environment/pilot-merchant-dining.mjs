import { createHash } from "node:crypto";
import { createMerchantDiningItemService } from "../../apps/api/dist/merchant-dining-item-service.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
export const diningPreparationDigest = (current) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        brandReference: current.brandReference,
        storeReference: current.storeReference,
        orderReference: current.orderReference,
        orderVersion: current.orderVersion,
        items: current.items,
      }),
    )
    .digest("hex");
export function createInternalMerchantDining(resources, persistence, authentication) {
  return createMerchantDiningItemService({
    persistence,
    authentication,
    validateSource: async (_tx, record, current) =>
      isPilotRuntime() &&
      resources.now() < resources.publicProfile.binding.validUntil &&
      record.brandReference === resources.scope.brandReference &&
      record.storeReference === resources.scope.storeReference &&
      record.sourceCheckpoint === current.orderReference &&
      record.orderReference === current.orderReference &&
      record.sourceDigest === diningPreparationDigest(current),
    audit: {
      reasonCode: "DINING_ITEM_SERVED",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
}
