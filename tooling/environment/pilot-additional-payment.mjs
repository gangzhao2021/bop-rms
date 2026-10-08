import console from "node:console";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { createHash } from "node:crypto";
import { createPostgresSubmissionFinalValidationStore } from "../../packages/rms/inventory/src/index.ts";
import { paymentProviderAdmissionKillSwitchKey } from "../../packages/rms/payment/src/index.ts";
import { createCustomerAdmittedAdditionalDiningPayment } from "../../apps/api/dist/customer-admitted-additional-dining-payment.js";
import { createCustomerAdditionalDiningPaymentAdmission } from "../../apps/api/dist/customer-additional-dining-payment-store.js";
import { createInternalAdditionalSubmission } from "./pilot-additional-submission.mjs";
function frozen(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") frozen(child);
  return Object.freeze(value);
}
export async function createInternalAdditionalPayment(
  resources,
  checkout,
  diningCheckout,
  orders,
  catalogOptions,
  simulator,
  route,
  { saved, expectedDatabaseName, controlReference },
) {
  const { scope: identityScope, transactions, now, credentials } = resources,
    reference = credentials.reference,
    scope = { tenantReference: resources.publicProfile.binding.tenantReference, ...identityScope };
  if (
    saved.environment !== "InternalTest" ||
    saved.database !== expectedDatabaseName ||
    Object.keys(scope).some((k) => saved.scope[k] !== scope[k]) ||
    simulator.simulation !== true
  )
    throw new Error("INTERNAL_ADDITIONAL_PAYMENT_ONLY");
  async function resolveRequest(input) {
    const selected = await route.resolve(input);
    if (selected.kind !== "Additional") throw new Error("ADDITIONAL_PAYMENT_ROUTE_DENIED");
    const configured = await createInternalAdditionalSubmission(
      resources,
      checkout,
      diningCheckout,
      orders,
      catalogOptions,
      input,
      selected,
    );
    const inventory = {
      workflow: saved.workflow.payment,
      authorize: configured.authorize,
      authorizeOverride: async () => false,
      resolveExpiryCutoff: createInternalExpiryCutoff(resources),
    };
    const admission = createCustomerAdditionalDiningPaymentAdmission({
      scope,
      quoteVersion: 2,
      authorizeHistory: configured.submission.historyAuthorization,
      inventory,
    });
    const service = createCustomerAdmittedAdditionalDiningPayment({
      flow: {
        submission: configured.submission,
        tip: configured.tip,
        targetOrderReference: selected.orderReference,
      },
      transactions,
      generateObservationReference: reference,
      admission: () => ({ inventory }),
      payment: {
        inventory: createPostgresSubmissionFinalValidationStore(transactions, scope, {
          authorize: configured.authorize,
          resolveCurrent: async () => {
            throw new Error("READ_ONLY_INVENTORY_SOURCE");
          },
        }),
        nextPreparationReference: reference,
        ports: () => ({
          providerEnvironment: "Test",
          clock: { now },
          provider: simulator.adapter,
          killSwitch: {
            evaluate: async (request) =>
              frozen({
                effectiveControl: {
                  controlId: controlReference,
                  version: 1,
                  scope: { kind: "Store", ...identityScope },
                },
                backendExecution: "Allow",
                frontendVisibility: "Show",
                reason: "KILL_INACTIVE",
                killMode: "BlockNew",
                inFlightPolicy: "AllowToComplete",
                record: {
                  key: paymentProviderAdmissionKillSwitchKey,
                  kind: "KillSwitch",
                  version: 1,
                  scopeKind: "Store",
                  backendExecution: "Allow",
                  frontendVisibility: "Show",
                  reason: "KILL_INACTIVE",
                  killMode: "BlockNew",
                  evaluatedAt: request.evaluatedAt,
                },
              }),
          },
          references: {
            generate: reference,
            hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
            providerIdempotencyKey: reference,
          },
          audit: {
            create: async (value) => ({
              auditId: reference(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "PAYMENT_INTENT_CREATE",
              targetType: "PaymentIntent",
              targetId: value.paymentIntentReference,
              reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
              occurredAt: value.observedAt,
              correlationId: value.paymentOperationReference,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            }),
          },
        }),
      },
    });
    return { service, admission, session: selected.session };
  }
  return {
    resolveRequest,
    async create(input) {
      try {
        return await (await resolveRequest(input)).service.create(input);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "INTERNAL_ADDITIONAL_PAYMENT_UNAVAILABLE",
            code: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? "") ? error.code : "UNAVAILABLE",
            frames:
              String(error?.stack ?? "")
                .match(
                  /(?:apps\/api\/dist|packages\/[a-z]+\/[a-z-]+\/src|\.local\/pilot-v4)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
                )
                ?.slice(0, 5) ?? [],
          }),
        );
        throw error;
      }
    },
  };
}
