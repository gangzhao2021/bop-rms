import { createAdditionalOrderPaidContextSource } from "../../apps/api/dist/additional-order-paid-context-source.js";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { createMerchantStoreScope } from "../../apps/api/dist/merchant-store-scope.js";
import { createMerchantOrderAcceptanceCommand } from "../../apps/api/dist/merchant-order-acceptance-command.js";
import { createMerchantAcceptanceConfigurationResolver } from "../../apps/api/dist/merchant-acceptance-configuration-resolver.js";
import { createOrderPaidContextSource } from "../../apps/api/dist/order-paid-context-source.js";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";
export async function createInternalMerchantAcceptance(
  resources,
  persistence,
  authentication,
  { loadPickupWorkflow, loadDiningWorkflow, expectedDatabaseName, providerAccountReference },
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
  const resolveScope = createMerchantStoreScope(persistence);
  return async (input) => {
    const authenticated = await authentication.authorize(input);
    const allowed = async (tx) => {
      const resolved = await resolveScope(
        tx,
        input.sessionCookie,
        "order.accept",
        authenticated.sessionReference,
      );
      return (
        resolved.selected.tenantReference === saved.scope.tenantReference &&
        resolved.context.brand.brandReference === saved.scope.brandReference &&
        resolved.store.storeReference === saved.scope.storeReference &&
        (await resolved.allowed())
      );
    };
    return createMerchantOrderAcceptanceCommand({
      persistence,
      authentication,
      generateAuditReference: resources.credentials.reference,
      audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
      resolveConfiguration: async (tx, scope, command) => {
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
          environment: "Test",
        };
        const initial = {
          quoteVersion: 2,
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
            quoteVersion: 2,
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
            quoteVersion: 2,
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
    })(input);
  };
}
