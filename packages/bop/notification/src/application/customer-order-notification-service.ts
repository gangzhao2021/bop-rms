import {
  createCustomerOrderNotificationAttempt,
  createCustomerOrderNotificationOutcome,
  type CustomerOrderMessage,
  type CustomerOrderMessageChannel,
  type CustomerOrderMessagePurpose,
  type CustomerOrderMessagingConfiguration,
  type CustomerOrderNotificationRecordPort,
} from "../contracts/customer-order-message.js";
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
   * An out-of-band order link minted immediately before this attempt (IDR-0031), or null. Only the
   * delivered message ever holds it; it is never recorded.
   */
  readonly orderLink: string | null;
}

export type CustomerOrderNotificationResult =
  | { readonly status: "NotConfigured" }
  | { readonly status: "AlreadyRecorded" }
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
  const store = plain(input.storeDisplayName, 120);
  if (!orderNumber.test(input.orderNumber)) return fail();
  if (input.orderLink !== null && !/^https:\/\/[^\s]+$/u.test(input.orderLink)) return fail();
  const link = input.orderLink === null ? "" : ` See your order: ${input.orderLink}`;
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
}) {
  const provider = (channel: CustomerOrderMessageChannel) =>
    channel === "Sms" ? ports.messaging.sms : ports.messaging.email;
  return Object.freeze({
    /** Which channels can actually send now (drives whether any related UI is shown). */
    availability() {
      return Object.freeze({
        sms: ports.messaging.sms !== null,
        email: ports.messaging.email !== null,
      });
    },
    async notify(input: CustomerOrderNotificationInput): Promise<CustomerOrderNotificationResult> {
      const channel: CustomerOrderMessageChannel =
        input.contact.channel === "Phone" ? "Sms" : "Email";
      const adapter = provider(channel);
      if (adapter === null) return Object.freeze({ status: "NotConfigured" });
      if (adapter.channel !== channel) return fail();
      if (!(channel === "Sms" ? phone : email).test(input.contact.value)) return fail();
      const rendered = renderCustomerOrderMessage({
        purpose: input.purpose,
        channel,
        storeDisplayName: input.storeDisplayName,
        orderNumber: input.orderNumber,
        orderLink: input.orderLink,
      });
      const attempt = createCustomerOrderNotificationAttempt({
        notificationReference: parseNotificationReference(ports.references.generateNotification()),
        brandReference: parseNotificationReference(input.brandReference),
        storeReference: parseNotificationReference(input.storeReference),
        orderReference: parseNotificationReference(input.orderReference),
        purpose: input.purpose,
        channel,
        contactDetailsReference: parseNotificationReference(input.contactDetailsReference),
        contactDetailsVersion: input.contactDetailsVersion,
        createdAt: parseNotificationInstant(ports.clock.now()),
      });
      if ((await ports.records.appendAttempt(attempt)) === "Exists")
        return Object.freeze({ status: "AlreadyRecorded" });
      const message: CustomerOrderMessage = Object.freeze({
        channel,
        destination: input.contact.value,
        subject: rendered.subject,
        text: rendered.text,
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
        recorded = createCustomerOrderNotificationOutcome({
          notificationReference: attempt.notificationReference,
          brandReference: attempt.brandReference,
          storeReference: attempt.storeReference,
          outcome,
          providerMessageReference,
          recordedAt: parseNotificationInstant(ports.clock.now()),
        });
      } catch {
        // A malformed provider reference is not stored; the attempt's result stays Unknown.
        outcome = "Unknown";
        recorded = createCustomerOrderNotificationOutcome({
          notificationReference: attempt.notificationReference,
          brandReference: attempt.brandReference,
          storeReference: attempt.storeReference,
          outcome,
          providerMessageReference: null,
          recordedAt: parseNotificationInstant(ports.clock.now()),
        });
      }
      await ports.records.appendOutcome(recorded);
      return Object.freeze({
        status: outcome,
        notificationReference: attempt.notificationReference,
      });
    },
  });
}
