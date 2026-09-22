import { createTenantContext } from "../../packages/bop/tenant/src/index.ts";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { createMerchantOrdinaryRefundCommand } from "../../apps/api/dist/merchant-ordinary-refund-command.js";
/** Uses actual command fences and existing owner MFA; creates no role or MFA facts. */
export function createInternalRefundPreparation({
  resources,
  persistence,
  authentication,
  resolveRefundConfiguration,
}) {
  const expected = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  return createMerchantOrdinaryRefundCommand({
    persistence,
    authentication,
    audit: {
      reasonCode: "CUSTOMER_REQUEST",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
    resolveConfiguration: async (tx, scope, authority) => {
      const deny = () => {
        throw new Error("INTERNAL_REFUND_CONFIGURATION_DENIED");
      };
      for (const key of ["tenantReference", "brandReference", "storeReference"])
        if (scope[key] !== expected[key]) deny();
      const context = authority.context;
      if (
        context.actor.actorReference !== scope.actorReference ||
        context.brand.brandReference !== scope.brandReference ||
        context.store?.storeReference !== scope.storeReference ||
        !(await authority.authorize())
      )
        deny();
      const bound = await resolveRefundConfiguration(tx, scope);
      const current = async (t, at) =>
        t === tx &&
        parseCanonicalInstant(at) <= parseCanonicalInstant(resources.now()) &&
        (await authority.authorize());
      return {
        providerAccountReference: bound.providerAccountReference,
        environment: bound.environment,
        workforce: {
          resolveContext: async (t, query) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (query[key] !== expected[key]) deny();
            // The current InternalTest source only knows this configured employee; never borrow its identity for another approver.
            if (
              query.actorReference !== scope.actorReference ||
              ![
                "payment.refund.request",
                "payment.refund.approve",
                "payment.refund.execute",
              ].includes(query.permissionCode) ||
              !(await current(t, query.observedAt))
            )
              deny();
            return {
              tenantReference: scope.tenantReference,
              context: createTenantContext(
                context.actor,
                context.brand,
                context.store,
                parseCanonicalInstant(query.observedAt),
              ),
            };
          },
          resolveRoleMapping: async (t, query) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (query[key] !== expected[key]) deny();
            if (!(await current(t, query.observedAt))) deny();
            return (await resolveRefundConfiguration(t, scope)).roleMapping;
          },
        },
        store: {
          ...expected,
          ...persistence.publication,
          timeZone: context.store.timeZone,
          authorize: current,
        },
      };
    },
  });
}
