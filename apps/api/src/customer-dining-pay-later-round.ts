import type { ConsumerTransaction } from "@bop/eventing";
import {
  assertGuestSessionUsable,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import { OrderPayLaterConfirmationError } from "@rms/ordering";
import { createDiningPayLaterRound } from "./dining-pay-later-round.js";

/** DEC-DINE-IN-PAY-LATER: why a guest's round could not be sent to the kitchen this way. */
export class CustomerDiningPayLaterError extends Error {
  constructor(
    /** PayFirst: this table pays each round as it is sent; NotJoined: not a current guest. */
    readonly code: "PayFirst" | "PayLater" | "NotJoined" | "Invalid" | "Unavailable",
  ) {
    super("dine-in pay-later round unavailable");
    this.name = "CustomerDiningPayLaterError";
  }
}

export interface CustomerDiningPayLaterRoundOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: ConsumerTransaction): GuestSessionServiceOptions["binding"];
  readonly workflow: {
    readonly purposeCode: string;
    readonly applicabilityCode: string;
    readonly workflowVersionReference: string;
  };
  /** The checkout's round submission for a pay-later table (Ordering, no clock, no Provider). */
  submitRound(value: unknown): Promise<{
    readonly submissionReference: string;
    readonly kind: "Initial" | "Additional";
    readonly guestSessionReference: string;
  }>;
  now(): string;
  newReference(): string;
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a guest at a table opened "pay later" sends a round straight to
 * the kitchen from their phone: no payment and no tip now (the table pays once at the end). The
 * guest is a current participant of the table (Guest identity and Dining binding, re-checked in
 * each transaction); the table's timing is Dining's, captured when it was opened. The round is
 * submitted through the guest's own checkout, then sent to the kitchen in a second transaction —
 * sending again with the same checkout and key finishes a round whose sending was cut off and
 * never sends a round twice.
 */
export function createCustomerDiningPayLaterRound(options: CustomerDiningPayLaterRoundOptions) {
  const round = createDiningPayLaterRound({
    scope: options.scope,
    quoteVersion: 2,
    workflow: options.workflow,
    now: options.now,
    generateReference: options.newReference,
  });
  const credentialsOf = (value: unknown, keys: readonly string[]) => {
    try {
      const raw = readClosedRecord(value, keys);
      return {
        raw,
        credentials: {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        },
      };
    } catch {
      throw new CustomerDiningPayLaterError("Invalid");
    }
  };
  /** The current guest's table, in this transaction (null: not a current dine-in guest here). */
  const tableOf = async (
    transaction: ConsumerTransaction,
    credentials: { sessionCredential: string; csrfCredential: string },
  ) => {
    const binding = options.binding(transaction);
    const identity = new GuestSessionService({
      credentials: options.credentials,
      binding,
      store: createPostgresGuestSessionEntryStore(
        { run: (work) => work(transaction) },
        {
          brandReference: options.scope.brandReference,
          storeReference: options.scope.storeReference,
        },
      ),
      admission: { consume: async () => null },
      now: options.now,
    });
    try {
      const guest = await identity.authorize({
        ...credentials,
        observedAt: parseCanonicalInstant(options.now()),
      });
      const checked = parseCanonicalInstant(options.now());
      assertGuestSessionUsable(guest, checked);
      if (
        String(guest.brandReference) !== options.scope.brandReference ||
        String(guest.storeReference) !== options.scope.storeReference ||
        guest.channel !== "DineIn" ||
        guest.diningState !== "DiningBound" ||
        guest.diningSessionReference === null ||
        (await binding.validate(guest, checked)) !== "Current"
      )
        return null;
      return {
        guestSessionReference: String(guest.sessionReference),
        diningSessionReference: String(guest.diningSessionReference),
      };
    } catch {
      return null;
    }
  };
  return Object.freeze({
    /**
     * How the asking guest's table pays: PayLater, PayFirst, or null when the guest is not a
     * current dine-in guest of this Store (a pickup guest pays first as always).
     */
    async tableTiming(value: {
      readonly sessionCredential: string;
      readonly csrfCredential: string;
    }): Promise<"PayFirst" | "PayLater" | null> {
      const { credentials } = credentialsOf(
        { sessionCredential: value.sessionCredential, csrfCredential: value.csrfCredential },
        ["sessionCredential", "csrfCredential"],
      );
      return options.transactions.run(async (transaction) => {
        const table = await tableOf(transaction, credentials);
        if (table === null) return null;
        return (await round.isPayLater(transaction, table.diningSessionReference))
          ? "PayLater"
          : "PayFirst";
      });
    },

    /** Sends the checkout's round to the kitchen; `selectionReference` is the request's key. */
    async send(value: unknown) {
      const { raw, credentials } = credentialsOf(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
        "selectionReference",
      ]);
      try {
        const before = await options.transactions.run(async (transaction) => {
          const table = await tableOf(transaction, credentials);
          if (table === null) throw new CustomerDiningPayLaterError("NotJoined");
          if (!(await round.isPayLater(transaction, table.diningSessionReference)))
            throw new CustomerDiningPayLaterError("PayFirst");
          return table;
        });
        const submitted = await options.submitRound({
          ...credentials,
          checkoutSessionReference: raw.checkoutSessionReference,
          selectionReference: raw.selectionReference,
        });
        if (submitted.guestSessionReference !== before.guestSessionReference)
          throw new CustomerDiningPayLaterError("Unavailable");
        return await options.transactions.run(async (transaction) => {
          const current = async () => {
            const table = await tableOf(transaction, credentials);
            return (
              table !== null &&
              table.guestSessionReference === before.guestSessionReference &&
              table.diningSessionReference === before.diningSessionReference
            );
          };
          if (!(await current())) throw new CustomerDiningPayLaterError("NotJoined");
          // WP-2423 item 8 ⑤: a round that must wait for staff is held, not sent.
          const held = await round.holdIfNeeded(transaction, {
            submissionReference: submitted.submissionReference,
            guestSessionReference: before.guestSessionReference,
            authorize: current,
          });
          if (held?.status === "Cancelled") throw new CustomerDiningPayLaterError("Unavailable");
          if (held?.status === "Waiting")
            return Object.freeze({
              status: "Held" as const,
              waitingReason: held.reason,
              orderReference: held.orderReference,
              totalMinor: await round.roundTotalMinor(transaction, {
                orderReference: held.orderReference,
                orderBatchReference: held.orderBatchReference,
                authorize: current,
              }),
            });
          const sent = await round.confirm(transaction, {
            submissionReference: submitted.submissionReference,
            actorReference: before.guestSessionReference,
            operationReference: String(raw.selectionReference),
            correlationReference: String(raw.selectionReference),
            authorize: current,
          });
          const totalMinor = await round.roundTotalMinor(transaction, {
            orderReference: String(sent.confirmation.orderReference),
            orderBatchReference: String(sent.confirmation.orderBatchReference),
            authorize: current,
          });
          return Object.freeze({
            status: sent.status === "Confirmed" ? ("Sent" as const) : ("AlreadySent" as const),
            orderReference: String(sent.confirmation.orderReference),
            totalMinor,
          });
        });
      } catch (error) {
        // Checkout and submission refusals keep their own meaning for the route (stock, closed).
        if (error instanceof OrderPayLaterConfirmationError)
          throw new CustomerDiningPayLaterError(
            error.code === "ORDER_PAY_LATER_NOT_PAY_LATER" ? "PayFirst" : "Unavailable",
          );
        throw error;
      }
    },
  });
}
