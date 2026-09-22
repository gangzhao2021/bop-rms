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
  return Object.freeze({
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
      sameSession(await reader.read(input));
      return pay(preparation);
    },
  });
}
