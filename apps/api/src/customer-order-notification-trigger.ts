import { loadOrderCustomerSummary, loadOrderPickupContact } from "@rms/ordering";

interface Transaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}

/** Structural port of `@bop/notification` createCustomerOrderNotificationService().notify. */
export interface CustomerOrderNotifyPort {
  notify(input: {
    readonly purpose: "OrderPlaced" | "PickupReady";
    readonly brandReference: string;
    readonly storeReference: string;
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly storeDisplayName: string;
    readonly contact: { readonly channel: "Phone" | "Email"; readonly value: string };
    readonly contactDetailsReference: string;
    readonly contactDetailsVersion: number;
    readonly orderLink: string | null;
    readonly mintOrderLink?: (attemptReference: string) => Promise<string | null>;
  }): Promise<{ readonly status: string }>;
  availability(): { readonly sms: boolean; readonly email: boolean };
}

export type CustomerOrderNotificationTriggerResult =
  | { readonly status: "Skipped"; readonly reason: "NotPickup" | "NoContact" | "ChannelInactive" }
  | { readonly status: string };

/**
 * WP-2423 Q10: turns "payment succeeded" and "kitchen order ready" into a message to the pickup
 * customer's own contact. Composition only: Ordering owns the contact and order number, Store the
 * public name, Notification the send and its evidence. When the contact's channel has no provider
 * (the pilot today) nothing is read beyond the contact and nothing is sent or recorded.
 */
export function createCustomerOrderNotificationTrigger(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly transactions: { run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> };
  readonly storeDisplayName: (transaction: Transaction) => Promise<string | null>;
  readonly notification: CustomerOrderNotifyPort;
  /**
   * DEC-PILOT-NOTIFICATIONS R1: mints the IDR-0031 one-time order link for one attempt, called by
   * Notification only after the attempt is durably recorded and just before the send.
   */
  readonly orderLink?: (input: {
    readonly orderReference: string;
    readonly attemptReference: string;
  }) => Promise<string | null>;
}) {
  async function handle(
    purpose: "OrderPlaced" | "PickupReady",
    orderReference: string,
  ): Promise<CustomerOrderNotificationTriggerResult> {
    const ready = options.notification.availability();
    if (!ready.sms && !ready.email)
      return Object.freeze({ status: "Skipped", reason: "ChannelInactive" });
    const facts = await options.transactions.run(async (transaction) => {
      const summary = await loadOrderCustomerSummary(transaction, options.scope, orderReference);
      if (summary === null || summary.orderType !== "Pickup") return { skip: "NotPickup" as const };
      const contact = await loadOrderPickupContact(transaction, options.scope, orderReference);
      if (contact.status !== "Available") return { skip: "NoContact" as const };
      if (!(contact.channel === "Phone" ? ready.sms : ready.email))
        return { skip: "ChannelInactive" as const };
      const storeDisplayName = await options.storeDisplayName(transaction);
      if (storeDisplayName === null)
        throw new Error("CUSTOMER_ORDER_NOTIFICATION_STORE_UNAVAILABLE");
      return { summary, contact, storeDisplayName };
    });
    if ("skip" in facts) return Object.freeze({ status: "Skipped", reason: facts.skip });
    return options.notification.notify({
      purpose,
      brandReference: options.scope.brandReference,
      storeReference: options.scope.storeReference,
      orderReference,
      orderNumber: facts.summary.orderNumber,
      storeDisplayName: facts.storeDisplayName,
      contact: { channel: facts.contact.channel, value: facts.contact.value },
      contactDetailsReference: facts.contact.detailsReference,
      contactDetailsVersion: facts.contact.detailsVersion,
      orderLink: null,
      ...(options.orderLink === undefined
        ? {}
        : {
            mintOrderLink: (attemptReference: string) =>
              (options.orderLink as NonNullable<typeof options.orderLink>)({
                orderReference,
                attemptReference,
              }),
          }),
    });
  }
  return Object.freeze({
    /** Consumer of `PaymentSucceeded` (payload.orderReference): "we have your order". */
    onPaymentSucceeded: (payload: { readonly orderReference: string }) =>
      handle("OrderPlaced", payload.orderReference),
    /** Consumer of `KitchenOrderReady` (payload.orderReference): "your order is ready". */
    onKitchenOrderReady: (payload: { readonly orderReference: string }) =>
      handle("PickupReady", payload.orderReference),
  });
}
