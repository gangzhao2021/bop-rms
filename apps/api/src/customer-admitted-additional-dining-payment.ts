import { createPersistentAdditionalDiningPaymentAuthorization } from "./customer-dining-payment-authorization.js";
import { createCustomerAdditionalDiningHistoryAuthorization } from "./customer-additional-dining-history-authorization.js";
import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import { createCustomerPersistentAdditionalDiningPayment } from "./customer-persistent-additional-dining-payment.js";
import { createCustomerAdditionalDiningPaymentStore } from "./customer-additional-dining-payment-store.js";

type Flow = Parameters<typeof createCustomerPersistentAdditionalDiningPayment>[0];
type Store = Parameters<typeof createCustomerAdditionalDiningPaymentStore>[0];
type Context = Parameters<Flow["payment"]["payment"]>[0];
type Credentials = Context["credentials"];
/** Request-local admitted repository is shared by history recovery and Payment claim. */
export function createCustomerAdmittedAdditionalDiningPayment(options: {
  flow: Omit<Flow, "payment">;
  transactions: Store["transactions"];
  generateObservationReference: Store["clock"]["generateObservationReference"];
  admission(credentials: Credentials): Pick<Store, "inventory">;
  payment: Omit<Flow["payment"], "history" | "payment"> & {
    ports(
      context: Context,
    ): Omit<ReturnType<Flow["payment"]["payment"]>, "repository" | "authorization">;
  };
}) {
  return Object.freeze({
    async create(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
        "selectionReference",
        "tip",
      ]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      });
      const authorizeHistory = createCustomerAdditionalDiningHistoryAuthorization(
        {
          scope: options.flow.submission.runtime.inventory.scope,
          identity: (transaction) => options.flow.submission.runtime.identity(transaction),
        },
        credentials,
      );
      const authorization = createPersistentAdditionalDiningPaymentAuthorization(
        {
          preparation: options.flow.tip.preparation,
          history: {
            brandReference: options.flow.submission.runtime.inventory.scope.brandReference,
            storeReference: options.flow.submission.runtime.inventory.scope.storeReference,
            transactions: options.flow.submission.runtime.transactions,
            authorize: authorizeHistory,
          },
        },
        credentials,
      );
      const repository = createCustomerAdditionalDiningPaymentStore({
        ...options.admission(credentials),
        authorizeHistory,
        transactions: options.transactions,
        scope: options.flow.submission.runtime.inventory.scope,
        quoteVersion: options.flow.tip.quoteVersion ?? 1,
        clock: {
          now: () => options.flow.submission.source.clock.now(),
          generateObservationReference: options.generateObservationReference,
        },
      });
      return createCustomerPersistentAdditionalDiningPayment({
        ...options.flow,
        payment: {
          inventory: options.payment.inventory,
          nextPreparationReference: options.payment.nextPreparationReference,
          history: repository,
          payment: (context) => ({ ...options.payment.ports(context), authorization, repository }),
        },
      }).create(value);
    },
  });
}
