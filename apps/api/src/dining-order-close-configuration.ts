import { createPostgresMerchantOrderIndex, parseOrderingReference } from "@rms/ordering";
import type { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
type Resolve = Parameters<typeof createMerchantDiningOrderCloseCommand>[0]["resolveConfiguration"];
const fail = (): never => {
  throw new Error("ORDER_CLOSE_CONFIGURATION_UNAVAILABLE");
};
/** Fixed pilot configuration is server-owned. The command supplies its current
 * request authority; initial owner binding is not current Order execution state. */
export function createDiningOrderCloseConfiguration(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  providerAccountReference: string;
  environment: "Test" | "Live";
}): Resolve {
  const scope = Object.freeze({
      tenantReference: String(parseOrderingReference(options.tenantReference)),
      brandReference: String(parseOrderingReference(options.brandReference)),
      storeReference: String(parseOrderingReference(options.storeReference)),
    }),
    providerAccountReference = String(parseOrderingReference(options.providerAccountReference)),
    environment = options.environment;
  if (environment !== "Test" && environment !== "Live") return fail();
  return async (tx, selected, command, authority) => {
    try {
      if (
        selected.tenantReference !== scope.tenantReference ||
        selected.brandReference !== scope.brandReference ||
        selected.storeReference !== scope.storeReference
      )
        return fail();
      parseOrderingReference(selected.actorReference);
      if ((await authority.authorize()) !== true) return fail();
      const order = await createPostgresMerchantOrderIndex({
        ...scope,
        authorize: () => authority.authorize(),
      }).find({ transaction: tx, orderReference: command.orderReference });
      if (
        !order ||
        order.orderType !== "DineIn" ||
        String(order.orderReference) !== command.orderReference ||
        order.diningSessionReference === null
      )
        return fail();
      const diningSessionReference = String(parseOrderingReference(order.diningSessionReference)),
        guestSessionReference = String(parseOrderingReference(order.guestSessionReference));
      if ((await authority.authorize()) !== true) return fail();
      return Object.freeze({
        providerAccountReference,
        environment,
        diningSessionReference,
        guestSessionReference,
      });
    } catch {
      return fail();
    }
  };
}
