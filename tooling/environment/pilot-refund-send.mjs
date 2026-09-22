import { createTenantContext } from "../../packages/bop/tenant/src/index.ts";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { createMerchantOrdinaryRefundSendCommand } from "../../apps/api/dist/merchant-ordinary-refund-send-command.js";
/** Internal authenticated send only; construction never calls the Provider. */
export function createInternalRefundSend({
  resources,
  persistence,
  authentication,
  resolveRefundConfiguration,
  providerAccountReference,
  createSimulatedProvider,
}) {
  const expected = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  return createMerchantOrdinaryRefundSendCommand({
    persistence,
    authentication,
    audit: {
      reasonCode: "CUSTOMER_REQUEST",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
    resolveConfiguration: async ({ scope, actorReference, resolveAuthority }) => {
      const deny = () => {
        throw new Error("INTERNAL_REFUND_SEND_CONFIGURATION_DENIED");
      };
      for (const key of ["tenantReference", "brandReference", "storeReference"])
        if (scope[key] !== expected[key]) deny();
      const current = async (tx, at) => {
        if (
          parseCanonicalInstant(at) > parseCanonicalInstant(resources.now()) ||
          resources.now() >= resources.publicProfile.binding.validUntil
        )
          deny();
        const authority = await resolveAuthority(tx);
        if (
          authority.context.actor.actorReference !== actorReference ||
          authority.context.store?.timeZone !== resources.operating.timeZone ||
          !(await authority.authorize())
        )
          deny();
        return authority;
      };
      const configuration = async (tx) => {
        await current(tx, resources.now());
        const c = await resolveRefundConfiguration(tx, { ...scope, actorReference });
        if (c.providerAccountReference !== providerAccountReference || c.environment !== "Test")
          deny();
        return c;
      };
      return {
        providerAccountReference: providerAccountReference,
        environment: "Test",
        workforce: {
          resolveContext: async (tx, q) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (q[key] !== expected[key]) deny();
            if (
              q.actorReference !== actorReference ||
              ![
                "payment.refund.request",
                "payment.refund.approve",
                "payment.refund.execute",
              ].includes(q.permissionCode)
            )
              deny();
            const { context } = await current(tx, q.observedAt);
            return {
              tenantReference: scope.tenantReference,
              context: createTenantContext(
                context.actor,
                context.brand,
                context.store,
                parseCanonicalInstant(q.observedAt),
              ),
            };
          },
          resolveRoleMapping: async (tx, q) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (q[key] !== expected[key]) deny();
            await current(tx, q.observedAt);
            return (await configuration(tx)).roleMapping;
          },
        },
        store: {
          ...scope,
          ...persistence.publication,
          timeZone: resources.operating.timeZone,
          authorize: async (tx, at) => {
            await current(tx, at);
            return true;
          },
        },
        provider: {
          refundPayment: async (request) => {
            const simulator = await createSimulatedProvider();
            try {
              return await simulator.adapter.refundPayment(request);
            } finally {
              simulator.close();
            }
          },
        },
        generateObservationIdentity: () => ({
          observationReference: resources.credentials.reference(),
          auditReference: resources.credentials.reference(),
        }),
      };
    },
  });
}
