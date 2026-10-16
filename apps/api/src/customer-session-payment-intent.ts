import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import { createMoney, type Money } from "@rms/pricing";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  parseOrderingReference,
  type CheckoutSession,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import {
  createPaymentIntentCreationService,
  parsePaymentIntentCreationRecord,
  parsePaymentTipSelection,
  type PaymentIntentCreationPorts,
} from "@rms/payment";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { buildCustomerPaymentPreparationSnapshot } from "./customer-payment-preparation-snapshot.js";

export interface CustomerSessionPaymentIntentOptions {
  readonly submissionKind?: "Additional";
  /** Current server-owned session/parent binding; never a client-selected mode. */
  readonly resolveSubmission?: (session: CheckoutSession) => Promise<{
    readonly kind: "Initial" | "Additional";
    readonly orders: CustomerSessionPaymentIntentOptions["orders"];
    readonly tips: CustomerSessionPaymentIntentOptions["tips"];
  }>;
  readonly access: CustomerCheckoutSessionAuthorizationOptions;
  readonly tenantReference: string;
  readonly orders: {
    create(input: unknown): Promise<unknown>;
    preparePaymentClock(input: unknown): Promise<unknown>;
  };
  readonly tips: { select(input: unknown): Promise<unknown> };
  /** Actual current-authorized Inventory owner reader. */
  readonly inventory: {
    load(input: { submissionReference: string; actorReference: string }): Promise<unknown>;
  };
  /** Public Payment owner history; same scoped repository used by payment factory. */
  readonly history: Pick<PaymentIntentCreationPorts["repository"], "resolveOperation">;
  readonly nextPreparationReference: () => string;
  /** Real current authorization/kill-switch and admitted repository are required.
   * Factory keeps credentials request-local; never persist or log this context.
   * No default Provider, credentials or policy is supplied by this composition. */
  readonly payment: (context: {
    credentials: { sessionCredential: string; csrfCredential: string };
    session: CheckoutSession;
    preparation: OrderPaymentPreparationEvidence;
  }) => Omit<PaymentIntentCreationPorts, "ordering">;
}
/** Internal composition; Provider result and owner records require a separate safe HTTP projection. */
export function createCustomerSessionPaymentIntent(options: CustomerSessionPaymentIntentOptions) {
  if (options.resolveSubmission !== undefined && options.submissionKind !== undefined)
    throw new CheckoutSessionServiceError("INPUT_INVALID");

  const reader = createCustomerCheckoutSessionRead(options.access);
  const parseRequest = (value: unknown) => {
    try {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
        "selectionReference",
        "tip",
      ]);
      const tip = createMoney(raw.tip as Money);
      if (
        tip.currencyCode !== "CAD" ||
        tip.amountMinor < 0n ||
        tip.amountMinor > 9223372036854775807n
      )
        throw new Error("invalid tip");
      return {
        input: {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        },
        selectionReference: String(parseOrderingReference(raw.selectionReference)),
        tip,
      };
    } catch {
      throw new CheckoutSessionServiceError("INPUT_INVALID");
    }
  };
  return Object.freeze({
    /**
     * WP-2423 Q7 slice 2: the same preparation steps as {@link create} (submit the round, record
     * the tip, start the payment clock) without any Provider call; staff then take the payment on
     * the Store's card machine. A payment already started online for this checkout is refused.
     */
    async prepare(value: unknown): Promise<OrderPaymentPreparationEvidence> {
      const { input, selectionReference, tip } = parseRequest(value);
      const session = parseCheckoutSession(await reader.read(input));
      if (options.submissionKind === "Additional" && session.validation.orderType !== "DineIn")
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      if ((await options.history.resolveOperation(session.paymentOperationReference)) !== null)
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const preparation = await prepareCustomerSessionPayment(options, {
        input,
        session,
        selectionReference,
        tip,
      });
      if (
        JSON.stringify(parseCheckoutSession(await reader.read(input))) !== JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      return preparation;
    },
    async create(value: unknown) {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        checkoutSessionReference: string;
      };
      let selectionReference: string, tip: Money;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
          "selectionReference",
          "tip",
        ]);
        input = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        };
        selectionReference = String(parseOrderingReference(raw.selectionReference));
        tip = createMoney(raw.tip as Money);
        if (
          tip.currencyCode !== "CAD" ||
          tip.amountMinor < 0n ||
          tip.amountMinor > 9223372036854775807n
        )
          throw new Error("invalid tip");
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      const session = parseCheckoutSession(await reader.read(input));
      if (options.submissionKind === "Additional" && session.validation.orderType !== "DineIn")
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const sameSession = (value: unknown) => {
        if (JSON.stringify(parseCheckoutSession(value)) !== JSON.stringify(session))
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      };
      async function pay(preparation: OrderPaymentPreparationEvidence, recovering = false) {
        const ports = options.payment({
          credentials: {
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
          },
          session,
          preparation,
        });
        const command = {
          paymentOperationReference: session.paymentOperationReference,
          submissionReference: session.submissionReference,
          cartReference: session.validation.cartReference,
          expectedCartVersion: session.validation.cartVersion,
          quoteReference: session.validation.quoteReference,
          tipSelectionReference: selectionReference,
          requestedAt: preparation.committedAt,
        };
        const result = await createPaymentIntentCreationService({
          ...ports,
          ordering: {
            preparePayment: async (request) => {
              if (recovering) throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
              const { paymentOperationReference: _operation, ...expected } = command;
              void _operation;
              for (const key of Object.keys(expected) as (keyof typeof expected)[])
                if (request[key] !== expected[key])
                  throw new CheckoutSessionServiceError("INTENT_CONFLICT");
              return preparation;
            },
          },
        }).create(command);
        const record = parsePaymentIntentCreationRecord(result.record);
        if (
          String(record.intent.paymentOperationReference) !== session.paymentOperationReference ||
          String(record.intent.preparation.submissionReference) !== session.submissionReference
        )
          throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
        sameSession(await reader.read(input));
        return Object.freeze({ status: result.status, record, session });
      }
      const existingValue = await options.history.resolveOperation(
        session.paymentOperationReference,
      );
      if (existingValue !== null) {
        const existing = parsePaymentIntentCreationRecord(existingValue);
        if (
          String(existing.intent.paymentOperationReference) !== session.paymentOperationReference ||
          existing.intent.preparation.tip.amountMinor !== tip.amountMinor ||
          existing.intent.preparation.tip.currencyCode !== tip.currencyCode
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        // Service verifies original request digest/selection ID and current authority again.
        // Its original-operation path does not call ordering, admission or Provider.
        return pay(existing.intent.preparation, true);
      }
      const preparation = await prepareCustomerSessionPayment(options, {
        input,
        session,
        selectionReference,
        tip,
      });
      sameSession(await reader.read(input));
      return pay(preparation);
    },
    /**
     * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): after a declined card, open the next attempt on this
     * checkout's existing payment (same order batch, amount and payment window). Never submits an
     * Order, records a tip or starts a payment clock.
     */
    async retry(value: unknown) {
      return existingAttempt(value, "retry");
    },
    /**
     * WP-2423 abandoned payment: the guest who started paying for this checkout comes back (reload,
     * another tab of the same guest session) to the same payment while its window is open. Returns
     * the latest attempt as stored; never opens an attempt, records a tip or contacts the Provider.
     */
    async resume(value: unknown) {
      return existingAttempt(value, "resume");
    },
  });
  async function existingAttempt(value: unknown, mode: "retry" | "resume") {
    {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        checkoutSessionReference: string;
      };
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
        ]);
        input = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        };
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      const session = parseCheckoutSession(await reader.read(input));
      if (options.submissionKind === "Additional" && session.validation.orderType !== "DineIn")
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const existingValue = await options.history.resolveOperation(
        session.paymentOperationReference,
      );
      if (existingValue === null) throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const existing = parsePaymentIntentCreationRecord(existingValue);
      if (
        String(existing.intent.paymentOperationReference) !== session.paymentOperationReference ||
        String(existing.intent.preparation.submissionReference) !== session.submissionReference
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const ports = options.payment({
        credentials: {
          sessionCredential: input.sessionCredential,
          csrfCredential: input.csrfCredential,
        },
        session,
        preparation: existing.intent.preparation,
      });
      const result = await createPaymentIntentCreationService({
        ...ports,
        ordering: {
          preparePayment: async () => {
            throw new CheckoutSessionServiceError("INTENT_CONFLICT");
          },
        },
      })[mode]({
        paymentOperationReference: session.paymentOperationReference,
        submissionReference: session.submissionReference,
        requestedAt: options.access.now(),
      });
      const record = parsePaymentIntentCreationRecord(result.record);
      if (
        String(record.intent.paymentIntentReference) !==
          String(existing.intent.paymentIntentReference) ||
        String(record.intent.paymentOperationReference) !== session.paymentOperationReference
      )
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      if (
        JSON.stringify(parseCheckoutSession(await reader.read(input))) !== JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      return Object.freeze({ status: result.status, record, session });
    }
  }
}

/**
 * The customer payment preparation steps before any Provider call: submit the Order (initial
 * batches), record the tip choice, start the payment clock and build the Payment preparation from
 * owner records. WP-2423 Q7 reuses it for a counter order paid on the Store's card machine.
 */
export async function prepareCustomerSessionPayment(
  options: Pick<
    CustomerSessionPaymentIntentOptions,
    | "resolveSubmission"
    | "submissionKind"
    | "orders"
    | "tips"
    | "inventory"
    | "access"
    | "tenantReference"
    | "nextPreparationReference"
  >,
  context: {
    input: { sessionCredential: string; csrfCredential: string; checkoutSessionReference: string };
    session: CheckoutSession;
    selectionReference: string;
    tip: Money;
  },
): Promise<OrderPaymentPreparationEvidence> {
  const { input, session, selectionReference, tip } = context;
  const sameSession = (value: unknown) => {
    if (JSON.stringify(parseCheckoutSession(value)) !== JSON.stringify(session))
      throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  };
  const submission = options.resolveSubmission
    ? await options.resolveSubmission(session)
    : { kind: options.submissionKind ?? "Initial", orders: options.orders, tips: options.tips };
  if (
    !submission ||
    (submission.kind !== "Initial" && submission.kind !== "Additional") ||
    (submission.kind === "Additional" && session.validation.orderType !== "DineIn") ||
    typeof submission.orders?.create !== "function" ||
    typeof submission.orders?.preparePaymentClock !== "function" ||
    typeof submission.tips?.select !== "function"
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const submissionKind = submission.kind;
  const submit = async () => {
    const submitted = readClosedRecord(
      await submission.orders.create(
        submissionKind === "Additional"
          ? { ...input, tipSelectionReference: selectionReference }
          : input,
      ),
      ["status", "record", "session"],
    );
    sameSession(submitted.session);
  };
  if (submissionKind !== "Additional") await submit();
  const selected = readClosedRecord(
    await submission.tips.select({ ...input, selectionReference, tip }),
    ["status", "record", "session"],
  );
  sameSession(selected.session);
  const selection = parsePaymentTipSelection(selected.record);
  if (
    String(selection.selectionReference) !== selectionReference ||
    String(selection.paymentOperationReference) !== session.paymentOperationReference ||
    selection.tip.amountMinor !== tip.amountMinor ||
    selection.tip.currencyCode !== tip.currencyCode
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  if (submissionKind === "Additional") await submit();
  const sealed = readClosedRecord(await submission.orders.preparePaymentClock(input), [
    "order",
    "clock",
    "session",
  ]);
  sameSession(sealed.session);
  const inventory = await options.inventory.load({
    submissionReference: session.submissionReference,
    actorReference: session.validation.guestSessionReference,
  });
  const preparation = buildCustomerPaymentPreparationSnapshot(
    {
      scope: { ...options.access.scope, tenantReference: options.tenantReference },
      owner: session.validation.orderType === "DineIn" ? "Dining" : "AsapPickup",
      quoteVersion: session.validation.quoteVersion,
      ...(submissionKind === "Additional" ? { submissionKind: "Additional" as const } : {}),
    },
    {
      preparationReference: options.nextPreparationReference(),
      order: sealed.order,
      capacity: sealed.clock,
      selection: selected.record,
      inventory,
    },
  );
  if (
    String(preparation.submissionReference) !== session.submissionReference ||
    String(preparation.sourceCartReference) !== session.validation.cartReference ||
    preparation.sourceCartVersion !== session.validation.cartVersion ||
    String(preparation.quoteReference) !== session.validation.quoteReference ||
    String(preparation.guestSessionReference) !== session.validation.guestSessionReference
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  return preparation;
}
