import {
  createCustomerOrderNotificationAttempt,
  createCustomerOrderNotificationOutcome,
  type CustomerOrderMessage,
  type CustomerOrderMessageChannel,
  type CustomerOrderMessagePurpose,
  type CustomerOrderMessagingConfiguration,
  type CustomerOrderNotificationRecordPort,
} from "../contracts/customer-order-message.js";
import { renderReceiptEmail, type ReceiptEmailInput } from "./receipt-email-renderer.js";
import {
  NotificationContractError,
  parseNotificationInstant,
  parseNotificationReference,
} from "../contracts/notification.js";

export interface CustomerOrderNotificationInput {
  readonly purpose: CustomerOrderMessagePurpose;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly orderNumber: string;
  /** The Store's public display name (the only business text in the message). */
  readonly storeDisplayName: string;
  /** The contact the customer gave for this order, read from Ordering just before sending. */
  readonly contact: { readonly channel: "Phone" | "Email"; readonly value: string };
  readonly contactDetailsReference: string;
  readonly contactDetailsVersion: number;
  /**
   * An out-of-band order link (IDR-0031), or null. Prefer `mintOrderLink`, which mints only after
   * the attempt is durably recorded. Only the delivered message ever holds it; it is never recorded.
   */
  readonly orderLink: string | null;
  /**
   * Mints the one-time order link for this attempt, immediately before the send (IDR-0027 r1:
   * "a resume token is minted only immediately before an Attempt"). Null or a failure sends the
   * message without a link: the order number alone still lets staff find the order.
   */
  readonly mintOrderLink?: (attemptReference: string) => Promise<string | null>;
}

export type CustomerOrderNotificationResult =
  | { readonly status: "NotConfigured" }
  | { readonly status: "AlreadyRecorded" }
  | { readonly status: "Suppressed"; readonly notificationReference: string }
  | {
      readonly status: "Accepted" | "Rejected" | "Unknown";
      readonly notificationReference: string;
    };

const phone = /^\+[1-9][0-9]{6,14}$/u;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const orderNumber = /^[1-9][0-9]{0,18}$/u;
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};
const plain = (value: string, max: number) =>
  value.length >= 1 &&
  value.length <= max &&
  value === value.normalize("NFC").trim() &&
  !/[\p{Cc}\p{Cf}<>]/u.test(value)
    ? value
    : fail();

/** Plain-language text in the customer's terms: the Store's name and the order number only. */
export function renderCustomerOrderMessage(input: {
  readonly purpose: CustomerOrderMessagePurpose;
  readonly channel: CustomerOrderMessageChannel;
  readonly storeDisplayName: string;
  readonly orderNumber: string;
  readonly orderLink: string | null;
}): { readonly subject: string | null; readonly text: string } {
  if (input.purpose === "ReceiptEmail") return fail();
  const store = plain(input.storeDisplayName, 120);
  if (!orderNumber.test(input.orderNumber)) return fail();
  if (input.orderLink !== null && !/^https:\/\/[^\s]+$/u.test(input.orderLink)) return fail();
  const link =
    input.orderLink === null
      ? ""
      : ` Open your order (the link works once, for 30 minutes): ${input.orderLink}`;
  const text =
    input.purpose === "OrderPlaced"
      ? `${store}: we have your order ${input.orderNumber}. We'll let you know when it's ready.${link}`
      : `${store}: your order ${input.orderNumber} is ready. Show this order number at the pickup counter.${link}`;
  const subject =
    input.channel === "Sms"
      ? null
      : input.purpose === "OrderPlaced"
        ? `${store}: order ${input.orderNumber} received`
        : `${store}: order ${input.orderNumber} is ready`;
  return Object.freeze({ subject, text });
}

/**
 * WP-2423 Q10: order messages to the customer's own contact. With no provider for the contact's
 * channel the feature is inactive: nothing is rendered, sent or recorded, and callers keep the
 * related UI hidden. With a provider: one attempt per Order and purpose is appended before the
 * send, then its outcome (a timeout is `Unknown` and is not retried blindly).
 */
export function createCustomerOrderNotificationService(ports: {
  readonly messaging: CustomerOrderMessagingConfiguration;
  readonly records: CustomerOrderNotificationRecordPort;
  readonly clock: { now(): string };
  readonly references: { generateNotification(): string };
  /** Addresses that hard-bounced or complained are never messaged again (IDR-0027 r1). */
  readonly suppression?: {
    isSuppressed(channel: CustomerOrderMessageChannel, destination: string): Promise<boolean>;
  };
}) {
  const provider = (channel: CustomerOrderMessageChannel) =>
    channel === "Sms" ? ports.messaging.sms : ports.messaging.email;
  const outcomeOf = (
    attempt: { notificationReference: string; brandReference: string; storeReference: string },
    outcome: "Accepted" | "Rejected" | "Unknown",
    providerMessageReference: string | null,
  ) =>
    createCustomerOrderNotificationOutcome({
      notificationReference: parseNotificationReference(attempt.notificationReference),
      brandReference: parseNotificationReference(attempt.brandReference),
      storeReference: parseNotificationReference(attempt.storeReference),
      outcome,
      providerMessageReference,
      recordedAt: parseNotificationInstant(ports.clock.now()),
    });

  /** Attempt first, then suppression check, optional one-time link, send and outcome. */
  async function deliver(input: {
    readonly purpose: CustomerOrderMessagePurpose;
    readonly channel: CustomerOrderMessageChannel;
    readonly destination: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly orderReference: string;
    readonly contactDetailsReference: string;
    readonly contactDetailsVersion: number;
    readonly render: (link: string | null) => {
      readonly subject: string | null;
      readonly text: string;
      readonly html: string | null;
    };
    readonly orderLink: string | null;
    readonly mintOrderLink?: (attemptReference: string) => Promise<string | null>;
  }): Promise<CustomerOrderNotificationResult> {
    const adapter = provider(input.channel);
    if (adapter === null) return Object.freeze({ status: "NotConfigured" });
    if (adapter.channel !== input.channel) return fail();
    if (!(input.channel === "Sms" ? phone : email).test(input.destination)) return fail();
    // Render once before anything is recorded so invalid content never creates an attempt.
    input.render(input.orderLink);
    const attempt = createCustomerOrderNotificationAttempt({
      notificationReference: parseNotificationReference(ports.references.generateNotification()),
      brandReference: parseNotificationReference(input.brandReference),
      storeReference: parseNotificationReference(input.storeReference),
      orderReference: parseNotificationReference(input.orderReference),
      purpose: input.purpose,
      channel: input.channel,
      contactDetailsReference: parseNotificationReference(input.contactDetailsReference),
      contactDetailsVersion: input.contactDetailsVersion,
      createdAt: parseNotificationInstant(ports.clock.now()),
    });
    if ((await ports.records.appendAttempt(attempt)) === "Exists")
      return Object.freeze({ status: "AlreadyRecorded" });
    if (
      ports.suppression &&
      (await ports.suppression.isSuppressed(input.channel, input.destination))
    ) {
      await ports.records.appendOutcome(outcomeOf(attempt, "Rejected", null));
      return Object.freeze({
        status: "Suppressed",
        notificationReference: attempt.notificationReference,
      });
    }
    let link = input.orderLink;
    if (link === null && input.mintOrderLink) {
      try {
        link = await input.mintOrderLink(attempt.notificationReference);
      } catch {
        link = null;
      }
    }
    let content;
    try {
      content = input.render(link);
    } catch {
      content = input.render(null);
    }
    const message: CustomerOrderMessage = Object.freeze({
      channel: input.channel,
      destination: input.destination,
      subject: content.subject,
      text: content.text,
      ...(content.html === null ? {} : { html: content.html }),
      idempotencyKey: attempt.notificationReference,
    });
    let outcome: "Accepted" | "Rejected" | "Unknown";
    let providerMessageReference: string | null = null;
    try {
      const sent = await adapter.send(message);
      outcome = sent.outcome;
      if (sent.outcome === "Accepted") providerMessageReference = sent.providerMessageReference;
    } catch {
      // A timeout or transport failure after submission may still deliver: never resend blindly.
      outcome = "Unknown";
    }
    let recorded;
    try {
      recorded = outcomeOf(attempt, outcome, providerMessageReference);
    } catch {
      // A malformed provider reference is not stored; the attempt's result stays Unknown.
      outcome = "Unknown";
      recorded = outcomeOf(attempt, outcome, null);
    }
    await ports.records.appendOutcome(recorded);
    return Object.freeze({
      status: outcome,
      notificationReference: attempt.notificationReference,
    });
  }

  return Object.freeze({
    /** Which channels can actually send now (drives whether any related UI is shown). */
    availability() {
      return Object.freeze({
        sms: ports.messaging.sms !== null,
        email: ports.messaging.email !== null,
      });
    },
    async notify(input: CustomerOrderNotificationInput): Promise<CustomerOrderNotificationResult> {
      if (input.purpose === "ReceiptEmail") return fail();
      const channel: CustomerOrderMessageChannel =
        input.contact.channel === "Phone" ? "Sms" : "Email";
      return deliver({
        purpose: input.purpose,
        channel,
        destination: input.contact.value,
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        orderReference: input.orderReference,
        contactDetailsReference: input.contactDetailsReference,
        contactDetailsVersion: input.contactDetailsVersion,
        orderLink: input.orderLink,
        ...(input.mintOrderLink === undefined ? {} : { mintOrderLink: input.mintOrderLink }),
        render: (link) => ({
          ...renderCustomerOrderMessage({
            purpose: input.purpose,
            channel,
            storeDisplayName: input.storeDisplayName,
            orderNumber: input.orderNumber,
            orderLink: link,
          }),
          html: null,
        }),
      });
    },
    /**
     * The receipt the customer asked to have emailed at checkout ("Email my receipt"), once per
     * Order: the issued receipt rendered by the owned, escaped, tracking-free template.
     */
    async sendReceiptEmail(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly email: string;
      readonly contactDetailsReference: string;
      readonly contactDetailsVersion: number;
      readonly receipt: ReceiptEmailInput;
    }): Promise<CustomerOrderNotificationResult> {
      return deliver({
        purpose: "ReceiptEmail",
        channel: "Email",
        destination: input.email,
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        orderReference: input.orderReference,
        contactDetailsReference: input.contactDetailsReference,
        contactDetailsVersion: input.contactDetailsVersion,
        orderLink: null,
        render: () => {
          const rendered = renderReceiptEmail(input.receipt);
          return { subject: rendered.subject, text: rendered.text, html: rendered.html };
        },
      });
    },
  });
}
