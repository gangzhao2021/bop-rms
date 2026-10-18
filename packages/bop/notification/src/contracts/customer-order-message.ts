import {
  NotificationContractError,
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationReference,
} from "./notification.js";

/**
 * WP-2423 Q10: messages to a customer about their own order, sent only to the contact the customer
 * gave for that order and for that stated purpose. Transactional; never marketing.
 */
export const customerOrderMessagePurposes = ["OrderPlaced", "PickupReady"] as const;
export type CustomerOrderMessagePurpose = (typeof customerOrderMessagePurposes)[number];
export type CustomerOrderMessageChannel = "Sms" | "Email";

/** One rendered message for one recipient. Exists only in memory between render and send. */
export interface CustomerOrderMessage {
  readonly channel: CustomerOrderMessageChannel;
  readonly destination: string;
  readonly subject: string | null;
  readonly text: string;
  /** Provider idempotency key (the notification reference; carries no customer data). */
  readonly idempotencyKey: NotificationReference;
}

/**
 * Provider adapter port (SMS or email account). The account, sender identity and credentials are an
 * external gate; until one is configured the port is absent and nothing is sent or recorded.
 * `Accepted` means the provider took the message, not that it was delivered or read.
 */
export interface CustomerOrderMessageProviderPort {
  readonly channel: CustomerOrderMessageChannel;
  send(
    message: CustomerOrderMessage,
  ): Promise<
    | { readonly outcome: "Accepted"; readonly providerMessageReference: string }
    | { readonly outcome: "Rejected" }
  >;
}

export interface CustomerOrderMessagingConfiguration {
  readonly sms: CustomerOrderMessageProviderPort | null;
  readonly email: CustomerOrderMessageProviderPort | null;
}

/** Append-only attempt evidence: never the destination, the name or the message text. */
export interface CustomerOrderNotificationAttempt {
  readonly notificationReference: NotificationReference;
  readonly brandReference: NotificationReference;
  readonly storeReference: NotificationReference;
  readonly orderReference: NotificationReference;
  readonly purpose: CustomerOrderMessagePurpose;
  readonly channel: CustomerOrderMessageChannel;
  /** Which checkout details record held the contact (Ordering's record; the value stays there). */
  readonly contactDetailsReference: NotificationReference;
  readonly contactDetailsVersion: number;
  readonly createdAt: string;
}

export interface CustomerOrderNotificationOutcome {
  readonly notificationReference: NotificationReference;
  readonly brandReference: NotificationReference;
  readonly storeReference: NotificationReference;
  readonly outcome: "Accepted" | "Rejected" | "Unknown";
  /** Opaque provider id for support; never contains the destination. */
  readonly providerMessageReference: string | null;
  readonly recordedAt: string;
}

export interface CustomerOrderNotificationRecordPort {
  /** At most one attempt per Order and purpose: a retry of the trigger never sends twice. */
  appendAttempt(attempt: CustomerOrderNotificationAttempt): Promise<"Created" | "Exists">;
  appendOutcome(outcome: CustomerOrderNotificationOutcome): Promise<void>;
}

const providerReferencePattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_INPUT_INVALID");
};

export function createCustomerOrderNotificationAttempt(
  value: CustomerOrderNotificationAttempt,
): CustomerOrderNotificationAttempt {
  if (
    !customerOrderMessagePurposes.includes(value.purpose) ||
    (value.channel !== "Sms" && value.channel !== "Email") ||
    !Number.isSafeInteger(value.contactDetailsVersion) ||
    value.contactDetailsVersion < 1
  )
    return fail();
  return Object.freeze({
    notificationReference: parseNotificationReference(value.notificationReference),
    brandReference: parseNotificationReference(value.brandReference),
    storeReference: parseNotificationReference(value.storeReference),
    orderReference: parseNotificationReference(value.orderReference),
    purpose: value.purpose,
    channel: value.channel,
    contactDetailsReference: parseNotificationReference(value.contactDetailsReference),
    contactDetailsVersion: value.contactDetailsVersion,
    createdAt: parseNotificationInstant(value.createdAt),
  });
}

export function createCustomerOrderNotificationOutcome(
  value: CustomerOrderNotificationOutcome,
): CustomerOrderNotificationOutcome {
  if (
    !["Accepted", "Rejected", "Unknown"].includes(value.outcome) ||
    (value.outcome === "Accepted") !== (value.providerMessageReference !== null) ||
    (value.providerMessageReference !== null &&
      !providerReferencePattern.test(value.providerMessageReference))
  )
    return fail();
  return Object.freeze({
    notificationReference: parseNotificationReference(value.notificationReference),
    brandReference: parseNotificationReference(value.brandReference),
    storeReference: parseNotificationReference(value.storeReference),
    outcome: value.outcome,
    providerMessageReference: value.providerMessageReference,
    recordedAt: parseNotificationInstant(value.recordedAt),
  });
}
