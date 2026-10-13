import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { createMerchantOrdinaryRefundCommand } from "../../apps/api/dist/merchant-ordinary-refund-command.js";
import { createInternalRefundWorkforceContext } from "./pilot-refund-workforce.mjs";
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
      // WP-2423 Q5: executing a recorded request; the request and its Audit carry the staff reason.
      reasonCode: "REFUND_REQUEST_EXECUTION",
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
          // WP-2423 Q5: the requester (or approver) of an escalated refund is resolved for that
          // person through owners; the session's own identity is never lent to someone else.
          resolveContext: createInternalRefundWorkforceContext({
            expected,
            persistence,
            sessionActorReference: scope.actorReference,
            sessionContext: async () => context,
            current,
          }),
          resolveRoleMapping: async (t, query) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (query[key] !== expected[key]) deny();
            if (!(await current(t, query.observedAt))) deny();
            return (await resolveRefundConfiguration(t, scope)).roleMapping;
          },
          stepUp: true,
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
