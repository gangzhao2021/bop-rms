import { createAdditionalOrderPaidContextSource } from "../../apps/api/dist/additional-order-paid-context-source.js";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { createMerchantOrderAcceptanceCommand } from "../../apps/api/dist/merchant-order-acceptance-command.js";
import { createMerchantAcceptanceConfigurationResolver } from "../../apps/api/dist/merchant-acceptance-configuration-resolver.js";
import { createOrderPaidContextSource } from "../../apps/api/dist/order-paid-context-source.js";
import { matchesPilotEnvironment, pilotProviderEnvironment } from "./pilot-environment.mjs";
export async function createInternalMerchantAcceptance(
  resources,
  persistence,
  authentication,
  {
    loadPickupWorkflow,
    loadDiningWorkflow,
    expectedDatabaseName,
    providerAccountReference,
    // The pilot prices every Order with Quote v2; isolated acceptances seed v1 Orders (test only).
    quoteVersion = 2,
  },
) {
  const saved = await loadPickupWorkflow();
  if (
    !matchesPilotEnvironment(saved.environment) ||
    saved.database !== expectedDatabaseName ||
    saved.scope.storeReference !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_ACCEPTANCE_ONLY");
  const dining = await loadDiningWorkflow();
  if (
    dining.environment !== saved.environment ||
    dining.database !== saved.database ||
    JSON.stringify(dining.scope) !== JSON.stringify(saved.scope)
  )
    throw new Error("INTERNAL_ACCEPTANCE_SCOPE_MISMATCH");
  // WP-2423 D1: `mode` "CurrentVersion" is the server-side acceptance after a card-machine payment.
  // The command resolves the staff member and `order.accept` in full at its start and once more
  // before the commit; every owner check inside (Order, Payment, Inventory, workflow gates; dozens
  // per acceptance) takes that run's guard. Re-resolving the caller in each of them (~25 queries
  // apiece) made one Accept cost about a thousand queries (2.4 s on v15, order 9).
  return async (input, mode) => {
    return createMerchantOrderAcceptanceCommand({
      persistence,
      authentication,
      generateAuditReference: resources.credentials.reference,
      audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
      resolveConfiguration: async (tx, scope, command, run) => {
        // The run's caller is the pilot Store's staff member (checked once: the scope is fixed for
        // the run) and the run is still in progress.
        const pilotStore =
          scope.tenantReference === saved.scope.tenantReference &&
          scope.brandReference === saved.scope.brandReference &&
          scope.storeReference === saved.scope.storeReference;
        const allowed = async () => pilotStore && (await run.allowed());
        const identity = await createPostgresOrderBatchIdentitySource({
          ...resources.scope,
          authorize: allowed,
        }).load(tx, {
          orderReference: command.orderReference,
          orderBatchReference: command.orderBatchReference,
          observedAt: resources.now(),
        });
        if (!identity) throw new Error("INTERNAL_ACCEPTANCE_IDENTITY_UNAVAILABLE");
        const workflow = identity.orderType === "DineIn" ? dining.workflow : saved.workflow;
        const paymentScope = {
          ...resources.scope,
          providerAccountReference: providerAccountReference,
          environment: pilotProviderEnvironment(),
        };
        const initial = {
          quoteVersion,
          acceptance: {
            action: "Accept",
            purposeCode: workflow.purposeCode,
            permissionCode: "order.accept",
          },
          workflowVersionReference: workflow.payment.workflowVersionReference,
          reasonCode: "INTERNAL_TEST_ACCEPTANCE",
          context: createOrderPaidContextSource({
            currentDiningAcceptance: identity.orderType === "DineIn",
            scope: paymentScope,
            tenantReference: scope.tenantReference,
            quoteVersion,
            now: resources.now,
            authorize: async (transaction, event) =>
              event.payload.orderReference === command.orderReference &&
              (await allowed(transaction)),
            authorizeOrder: async (transaction, current) =>
              current.orderReference === command.orderReference &&
              current.orderBatchReference === command.orderBatchReference &&
              (await allowed(transaction)),
            authorizeInventory: allowed,
          }),
          gates: {
            authorizeResource: async (transaction, request) =>
              request.tenantReference === scope.tenantReference &&
              request.brandReference === scope.brandReference &&
              request.storeReference === scope.storeReference &&
              request.actorReference === scope.actorReference &&
              request.resourceReference === command.orderReference &&
              request.resourceVersion === command.expectedOrderVersion &&
              (await allowed(transaction)),
            authorizeAction: allowed,
            evaluateRule: async () => true,
            authorizeOverride: async () => false,
          },
        };
        const additional = {
          ...initial,
          context: createAdditionalOrderPaidContextSource({
            scope: paymentScope,
            tenantReference: scope.tenantReference,
            quoteVersion,
            now: resources.now,
            authorize: async (transaction, event) =>
              event.payload.orderReference === command.orderReference &&
              (await allowed(transaction)),
            authorizeOrder: async (transaction, current) =>
              current.brandReference === scope.brandReference &&
              current.storeReference === scope.storeReference &&
              current.submissionReference === identity.submissionReference &&
              (await allowed(transaction)),
            authorizeInventory: allowed,
          }),
        };
        return createMerchantAcceptanceConfigurationResolver({
          now: resources.now,
          authorize: allowed,
          resolvePolicy: async () => ({ paymentScope, initial, additional }),
        })(tx, scope, command);
      },
    })(input, mode);
  };
}
