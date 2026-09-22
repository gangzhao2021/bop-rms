import { createMerchantReconciliationEvidenceQuery } from "../../apps/api/dist/merchant-reconciliation-evidence-query.js";
import { createMerchantReconciliationFollowUpCommand } from "../../apps/api/dist/merchant-reconciliation-follow-up-command.js";
import { createMerchantReconciliationFollowUpQuery } from "../../apps/api/dist/merchant-reconciliation-follow-up-query.js";
import { resolveInternalDiningTaskPolicy } from "./pilot-dining-task-policy.mjs";
import { createInternalExceptionSnapshotTransactions } from "./pilot-exception-snapshot.mjs";
import { readInternalExceptionCoverage } from "./pilot-exception-coverage.mjs";
import { createPersistentMerchantOrderExceptions } from "../../apps/api/dist/persistent-merchant-order-exceptions.js";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { createMerchantCompensationReconciliationQuery } from "../../apps/api/dist/merchant-compensation-reconciliation-query.js";
import { createMerchantCompensationReconciliationCommand } from "../../apps/api/dist/merchant-compensation-reconciliation-command.js";
import { createMerchantDiningHostSelection } from "../../apps/api/dist/merchant-dining-host-selection.js";
import { createMerchantDiningHostTransfer } from "../../apps/api/dist/merchant-dining-host-transfer.js";
import { createMerchantOrdinaryRefundStatus } from "../../apps/api/dist/merchant-ordinary-refund-status.js";
import { createMerchantRefundPaymentContext } from "../../apps/api/dist/merchant-refund-payment-context.js";
import { createMerchantOrdinaryRefundItems } from "../../apps/api/dist/merchant-ordinary-refund-items.js";
import { createMerchantOrdinaryRefundRequest } from "../../apps/api/dist/merchant-ordinary-refund-request.js";
import { createMerchantDiningJoinState } from "../../apps/api/dist/merchant-dining-join-state.js";
import { createMerchantDiningJoinRegenerate } from "../../apps/api/dist/merchant-dining-join-regenerate.js";
import { createMerchantDiningSessionStart } from "../../apps/api/dist/merchant-dining-session-start.js";
import { createMerchantDiningTables } from "../../apps/api/dist/merchant-dining-tables.js";
import { createMerchantDiningClosingCommand } from "../../apps/api/dist/merchant-dining-closing-command.js";
import { createMerchantDiningOrderCloseCommand } from "../../apps/api/dist/merchant-dining-order-close-command.js";
import { createDiningOrderCloseConfiguration } from "../../apps/api/dist/dining-order-close-configuration.js";
import { createPersistentMerchantTaskInbox } from "../../apps/api/dist/persistent-merchant-task-inbox.js";
import { createMerchantDiningTaskSource } from "../../apps/api/dist/merchant-dining-task-source.js";
import { createMerchantDiningServeCommand } from "../../apps/api/dist/merchant-dining-serve-command.js";
import { createMerchantDiningOrderProgress } from "../../apps/api/dist/merchant-dining-order-progress.js";
import { createHash } from "node:crypto";
import { createMerchantKitchenQuery } from "../../apps/api/dist/merchant-kitchen-query.js";
import { createPersistentMerchantBffService } from "../../apps/api/dist/persistent-merchant-bff.js";
import { createPersistentMerchantOrderQueue } from "../../apps/api/dist/persistent-merchant-order-queue.js";
export async function createInternalMerchant(
  resources,
  {
    createInternalRefundReconciliation,
    createInternalRefundSend,
    createInternalRefundPreparation,
    createInternalDiningCredentials,
    createInternalMerchantDining,
    createInternalMerchantPickup,
    createInternalKitchenCommand,
    createInternalMerchantAcceptance,
    createInternalMerchantSession,
    loadTaskQueue,
    expectedDatabaseName,
    providerAccountReference,
    exceptionPaymentMode,
    roleMapping,
  },
) {
  const session = await createInternalMerchantSession(resources);
  const selected = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const targetScope = async (_tx, authenticated, reference = selected.storeReference) => {
    if (
      reference !== selected.storeReference ||
      !(await session.validateAssociation(_tx, authenticated, selected, resources.now()))
    )
      throw new Error("INTERNAL_MERCHANT_SCOPE_DENIED");
    return selected;
  };
  const persistence = {
    ...session.persistence,
    publication: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    },
    initialScope: targetScope,
    targetScope,
    workspace: async (_tx, { context }) => ({
      screenId: "HOME-OVERVIEW",
      selectedScope: {
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: selected.storeReference,
      },
      authorizedStores: [
        {
          brandLabel: context.brand.displayName,
          storeLabel: context.store.displayName,
          storeReference: selected.storeReference,
        },
      ],
      businessDate: context.resolvedAt.slice(0, 10),
      storeStatus: "Unavailable",
      freshness: "Stale",
      dashboardAvailability: "UnavailableUntilWP1905",
      navigation: [
        {
          screenId: "OPS-ORDER-QUEUE",
          label: "Orders",
          href: "/operations/orders",
          permission: "ordering.operate",
        },
        {
          screenId: "KIT-KITCHEN-QUEUE",
          label: "Kitchen",
          href: "/operations/kitchen",
          permission: "kitchen.operate",
        },
        {
          screenId: "FUL-PICKUP-QUEUE",
          label: "Pickup",
          href: "/operations/pickup",
          permission: "fulfillment.operate",
        },
      ],
    }),
  };
  const queue = await loadTaskQueue();
  if (
    queue.environment !== "InternalTest" ||
    queue.database !== expectedDatabaseName ||
    queue.tenantReference !== selected.tenantReference ||
    queue.brandReference !== selected.brandReference ||
    queue.storeReference !== selected.storeReference
  )
    throw new Error("INTERNAL_TASK_QUEUE_UNAVAILABLE");
  const taskInbox = createPersistentMerchantTaskInbox({
    persistence,
    queue,
    authorizeSource: createMerchantDiningTaskSource(persistence),
  });
  const service = createPersistentMerchantBffService(persistence);
  const orderExceptions = createPersistentMerchantOrderExceptions({
    persistence: {
      ...persistence,
      transactions: createInternalExceptionSnapshotTransactions(resources),
    },
    metadata: async (tx, { scope, storeLabel, sources }) => {
      if (
        scope.tenantReference !== selected.tenantReference ||
        scope.brandReference !== selected.brandReference ||
        scope.storeReference !== selected.storeReference
      )
        throw new Error("INTERNAL_EXCEPTION_SCOPE_DENIED");
      const at = resources.now();
      const status = await createPostgresPublishedStoreOperatingStatusReader({
        ...resources.operating,
        authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
      })(tx, at);
      if (
        status.businessDate.brandReference !== scope.brandReference ||
        status.businessDate.storeReference !== scope.storeReference ||
        status.evaluatedAt !== at
      )
        throw new Error("INTERNAL_EXCEPTION_SOURCE_UNAVAILABLE");
      const freshnessStatus = await readInternalExceptionCoverage({
        resources,
        providerAccountReference,
        paymentMode: exceptionPaymentMode,
        tx,
        sources,
      });
      return {
        storeLabel,
        businessDate: status.businessDate.businessDate,
        checkpointReference: resources.credentials.reference(),
        projectedAt: at,
        freshnessStatus,
        ...(freshnessStatus === "Fresh" ? { currentSourceCheck: "Complete" } : {}),
      };
    },
  });
  const reconciliationEvidenceQuery = createMerchantReconciliationEvidenceQuery({
    persistence,
    authentication: service,
  });
  const reconciliationFollowUpQuery = createMerchantReconciliationFollowUpQuery({
    persistence,
    authentication: service,
  });
  const reconciliationFollowUp = createMerchantReconciliationFollowUpCommand({
    persistence,
    authentication: service,
    now: resources.now,
    reference: () => resources.credentials.reference(),
  });
  const compensationQuery = createMerchantCompensationReconciliationQuery({
    persistence,
    authentication: service,
  });
  const compensationReconciliation = createMerchantCompensationReconciliationCommand({
    persistence,
    authentication: service,
    now: resources.now,
  });
  const refundConfiguration = async (_tx, scope) => {
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (scope[key] !== selected[key]) throw new Error("INTERNAL_REFUND_SCOPE_DENIED");
    return { providerAccountReference, environment: "Test", roleMapping };
  };
  const refundPaymentContext = createMerchantRefundPaymentContext({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
  });
  const ordinaryRefund = createInternalRefundPreparation({
    resources,
    persistence,
    authentication: service,
    resolveRefundConfiguration: refundConfiguration,
  });
  const ordinaryRefundReconciliation = createInternalRefundReconciliation({
    resources,
    persistence,
    authentication: service,
  });
  const ordinaryRefundSend = createInternalRefundSend({
    resources,
    persistence,
    authentication: service,
    resolveRefundConfiguration: refundConfiguration,
  });
  const ordinaryRefundStatus = createMerchantOrdinaryRefundStatus({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
  });
  const ordinaryRefundItems = createMerchantOrdinaryRefundItems({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    newReference: () => resources.credentials.reference(),
    locale: "en-CA",
  });
  const ordinaryRefundRequest = createMerchantOrdinaryRefundRequest({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    newAuditReference: () => resources.credentials.reference(),
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const diningClosing = createMerchantDiningClosingCommand({
    exceptionTaskPolicy: resolveInternalDiningTaskPolicy({
      queue,
      scope: selected,
      observedAt: resources.now(),
    }),
    persistence,
    authentication: service,
    providerAccountReference,
    environment: "Test",
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const orderClosure = createMerchantDiningOrderCloseCommand({
    persistence,
    authentication: service,
    resolveConfiguration: createDiningOrderCloseConfiguration({
      ...selected,
      providerAccountReference,
      environment: "Test",
    }),
    newReference: () => resources.credentials.reference(),
    audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
  const orderAcceptance = await createInternalMerchantAcceptance(resources, persistence, service);
  const diningJoinState = createMerchantDiningJoinState({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
  });
  const diningJoinRegenerate = createMerchantDiningJoinRegenerate({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
    pepperVersion: 1,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningSessionStart = createMerchantDiningSessionStart({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
    pepperVersion: 1,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningHostSelection = createMerchantDiningHostSelection({
    persistence,
    authentication: service,
  });
  const diningHostTransfer = createMerchantDiningHostTransfer({
    persistence,
    authentication: service,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningTables = createMerchantDiningTables({ persistence, authentication: service });
  const diningOrderProgress = createMerchantDiningOrderProgress({
    locale: "en-CA",
    persistence,
    authentication: service,
  });
  const diningServe = createMerchantDiningServeCommand({
    persistence,
    authentication: service,
    reference: () => resources.credentials.reference(),
    audit: {
      reasonCode: "DINING_ITEM_SERVED",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const diningItemService = createInternalMerchantDining(resources, persistence, service);
  const kitchenCommand = createInternalKitchenCommand(resources, persistence, service);
  const kitchenQuery = createMerchantKitchenQuery({
    persistence,
    authentication: service,
    sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
  });
  const { pickupQuery, pickupProof, pickupHandoff } = await createInternalMerchantPickup(
    resources,
    { persistence, service },
  );
  const orderQueue = createPersistentMerchantOrderQueue({
    persistence,
    quoteVersion: 1,
    acceptanceConfigured: true,
  });
  return {
    ordinaryRefundReconciliation,
    ordinaryRefundSend,
    issue: session.issue,
    persistence,
    service,
    orderQueue,
    kitchenQuery,
    kitchenCommand,
    pickupQuery,
    pickupProof,
    pickupHandoff,
    orderAcceptance,
    bff: {
      reconciliationEvidenceQuery,
      reconciliationFollowUp,
      reconciliationFollowUpQuery,
      orderExceptions,
      compensationReconciliation,
      compensationQuery,
      ordinaryRefundSend,
      ordinaryRefundReconciliation,
      ordinaryRefund,
      diningHostSelection,
      diningHostTransfer,
      ordinaryRefundStatus,
      refundPaymentContext,
      ordinaryRefundPreview: ordinaryRefundRequest.preview,
      ordinaryRefundItems,
      ordinaryRefundRequest,
      diningJoinState,
      diningJoinRegenerate,
      diningSessionStart,
      diningTables,
      diningClosing,
      orderClosure,
      taskInbox,
      diningServe,
      diningOrderProgress,
      diningItemService,
      service,
      orderQueue,
      kitchenQuery,
      kitchenCommand,
      pickupQuery,
      pickupProof,
      pickupHandoff,
      orderAcceptance,
      exactOrigin: "https://127.0.0.1:4443",
      acceptedHost: "127.0.0.1:4443",
    },
  };
}
