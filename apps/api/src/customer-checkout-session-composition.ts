import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  createCheckoutSessionService,
  createPostgresCheckoutSessionAllocationStore,
  type CheckoutSessionAllocation,
  type CheckoutSessionAllocationGates,
  createPostgresCheckoutSessionStore,
  CheckoutSessionServiceError,
  type CheckoutSessionRequest,
  type CheckoutSessionStoreGates,
} from "@rms/ordering";
import {
  createCustomerCheckoutSessionAuthorization,
  type CustomerCheckoutSessionAuthorizationOptions,
} from "./customer-checkout-session-authorization.js";

export interface CustomerCheckoutSessionOptions extends CustomerCheckoutSessionAuthorizationOptions {
  readonly quoteVersion: 1 | 2;
  readonly nextReference: () => string;
  readonly allocationAudit: CheckoutSessionAllocationGates["audit"];
  readonly audit: CheckoutSessionStoreGates["audit"];
  /** Actual checkout validation composition, retaining credentials in request memory only. */
  readonly validate: (
    input: Readonly<{
      sessionCredential: string;
      csrfCredential: string;
      request: CheckoutSessionRequest;
      allocation: CheckoutSessionAllocation;
    }>,
  ) => Promise<unknown>;
}
/** Internal composition; expose a minimal projection through the canonical HTTP handler. */
export function createCustomerCheckoutSessionComposition(options: CustomerCheckoutSessionOptions) {
  return Object.freeze({
    async create(value: unknown) {
      try {
        const envelope = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "command",
        ]);
        const command = readClosedRecord(envelope.command, [
          "createOperationReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "quoteVersion",
        ]);
        if (command.quoteVersion !== options.quoteVersion)
          throw new CheckoutSessionServiceError("INPUT_INVALID");
        const credentials = Object.freeze({
          sessionCredential: parseGuestRawCredential(envelope.sessionCredential),
          csrfCredential: parseGuestRawCredential(envelope.csrfCredential),
        });
        const access = createCustomerCheckoutSessionAuthorization(options, {
          ...credentials,
          cartReference: command.cartReference,
        });
        const repository = createPostgresCheckoutSessionStore(options.transactions, options.scope, {
          authorize: access.authorizeInTransaction,
          audit: options.audit,
        });
        const allocations = createPostgresCheckoutSessionAllocationStore(
          options.transactions,
          options.scope,
          {
            authorize: access.authorizeInTransaction,
            audit: options.allocationAudit,
          },
        );
        return await createCheckoutSessionService({
          now: options.now,
          nextReference: options.nextReference,
          authorize: access.authorize,
          repository: { ...repository, allocate: allocations.allocate },
          validate: (request, allocation) =>
            options.validate({ ...credentials, request, allocation }),
        }).create(command);
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
