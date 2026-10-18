import { createDiningExceptionFinancialEvidence } from "../../apps/api/dist/dining-exception-financial-evidence.js";
import {
  createDiningExceptionResolution,
  parseDiningReference,
} from "../../packages/rms/dining/src/index.ts";
import { createInternalDiningExceptionPageRunner } from "./pilot-dining-exceptions.mjs";
/** Current owner resolution only; does not persist or terminalize a projection. */
export function createInternalDiningExceptionResolution({ resources, providerAccountReference }) {
  const account = String(parseDiningReference(providerAccountReference));
  const deny = () => {
    throw Error("INTERNAL_DINING_EXCEPTION_RESOLUTION_UNAVAILABLE");
  };
  return createInternalDiningExceptionPageRunner(
    resources,
    async ({ tx, page, scope, authorize }) => {
      const items = [];
      for (const { task, association } of page.items) {
        const query = { orderReference: association.orderReference, observedAt: page.observedAt };
        const allowedQuery = (t, q) =>
          t === tx &&
          authorize() &&
          q.orderReference === query.orderReference &&
          q.observedAt === query.observedAt;
        const allowedTask = (t, value) =>
          t === tx && authorize() && JSON.stringify(value) === JSON.stringify(task);
        const financial = await createDiningExceptionFinancialEvidence({
          scope,
          providerAccountReference: account,
          environment: "Test",
          authorize: async (t, q) => allowedQuery(t, q),
        })(tx, query);
        const resolver = createDiningExceptionResolution({
          scope,
          authorize: async (t, value) => allowedTask(t, value),
          association: async (t, q) => {
            if (!allowedTask(t, q.task) || q.observedAt !== page.observedAt) return deny();
            return association;
          },
          financial: async (t, q) => {
            if (!allowedQuery(t, q)) return deny();
            return financial.financial;
          },
        });
        const resolution = await resolver.resolve(tx, {
          task,
          ...query,
          expectedOrderVersion: financial.orderVersion,
        });
        if (!authorize()) return deny();
        items.push(Object.freeze({ task, association, resolution }));
      }
      return Object.freeze({ ...page, items: Object.freeze(items) });
    },
  );
}
