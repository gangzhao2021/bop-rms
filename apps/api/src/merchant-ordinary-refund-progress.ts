import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createOrdinaryRefundRoleResolver,
  createPostgresOrdinaryRefundRequestContextSource,
  createPostgresOrdinaryRefundRequestStatusSource,
} from "@rms/payment";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import { refundReadAccess } from "./merchant-refund-read-authority.js";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export type OrdinaryRefundProgress = "Recorded" | "Sending" | "Refunded" | "Declined";
/** Where one request stands, from committed Payment facts (Recorded, Sending, Refunded,
 * Declined). Shared by the request list and the Approvals page. */
export function ordinaryRefundProgress(
  declined: boolean,
  states: readonly string[],
): OrdinaryRefundProgress {
  if (declined) return "Declined";
  if (states.length > 0 && states.every((state) => state === "Confirmed")) return "Refunded";
  if (states.every((state) => state === "NotDispatched")) return "Recorded";
  return "Sending";
}

/**
 * WP-2423 Q5: the progress of one refund request for anyone who may read refunds (a Manager who
 * may request, or an Owner/Finance member who may approve). A small read the Approvals page
 * follows after an approval; it grants nothing.
 */
export function createMerchantOrdinaryRefundProgress(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    roleMapping: unknown;
  }>;
  newReference(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const deny = (): never => {
    throw new Error("ORDINARY_REFUND_PROGRESS_DENIED");
  };
  const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference", "requestReference"]);
    const orderReference = ref(raw.orderReference),
      requestReference = ref(raw.requestReference);
    return options.persistence.transactions.run(async (transaction) => {
      const current = await resolve(
        transaction,
        input.sessionCookie,
        "merchant.access",
        authenticated.sessionReference,
      );
      if (!(await current.allowed())) return deny();
      const tx = businessTransaction(transaction);
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: String(current.context.brand.brandReference),
        storeReference: String(current.store.storeReference),
      };
      const configuration = await options.resolveConfiguration(tx, scope);
      const role = createOrdinaryRefundRoleResolver(configuration.roleMapping);
      const workforce = createMerchantWorkforcePermissionSource({
        resolveContext: async () => ({
          tenantReference: scope.tenantReference,
          context: current.context,
        }),
      });
      const observedAt = String(current.context.resolvedAt);
      const allowed = async () =>
        (await current.allowed()) &&
        (
          await refundReadAccess(
            workforce,
            tx,
            { ...scope, actorReference: String(current.actorReference), observedAt },
            role,
          )
        ).canRead;
      if (!(await allowed())) return deny();
      const context = await createPostgresOrdinaryRefundRequestContextSource({
        scope,
        authorize: () => allowed(),
      })(tx, { orderReference, operationReference: ref(options.newReference()), observedAt });
      const request = context.history.find((entry) => entry.requestReference === requestReference);
      if (!request || context.existing !== null) return deny();
      let progress: OrdinaryRefundProgress = "Declined";
      if (!context.declines.has(requestReference)) {
        const status = await createPostgresOrdinaryRefundRequestStatusSource({
          scope,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
          authorize: () => allowed(),
        })(tx, { orderReference, operationReference: request.operationReference, observedAt });
        progress = ordinaryRefundProgress(
          false,
          status.payments.map((payment) => payment.state),
        );
      }
      if (!(await allowed())) return deny();
      return Object.freeze({ requestReference, progress, observedAt });
    });
  };
}
