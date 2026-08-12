import {
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationReference,
} from "../contracts/notification.js";

export interface NormalizedSesEvent {
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly recipientReference: NotificationReference;
  readonly purpose: "Transactional";
  readonly eventType: "Delivered" | "HardBounce" | "SoftBounce" | "Complaint";
  readonly occurredAt: string;
  readonly acceptedAt: string;
  readonly retentionPolicyReference: NotificationReference;
}

export class SesSnsEventError extends Error {
  readonly code:
    | "SES_SNS_INPUT_INVALID"
    | "SES_SNS_SIGNATURE_INVALID"
    | "SES_SNS_TOPIC_DENIED"
    | "SES_SNS_RECIPIENT_DENIED"
    | "SES_SNS_COMMIT_FAILED";
  constructor(code: SesSnsEventError["code"]) {
    super("SES event is unavailable");
    this.name = "SesSnsEventError";
    this.code = code;
  }
}

export interface SesSnsEventPorts {
  readonly signatures: {
    verifyVersion2(input: {
      readonly signingCertificateUrl: string;
      readonly canonicalMessage: string;
      readonly signature: string;
    }): Promise<boolean>;
  };
  readonly recipients: {
    resolveTransactional(input: {
      readonly destination: string;
      readonly providerMessageId: string;
    }): Promise<{
      readonly recipientReference: NotificationReference;
      readonly purpose: "Transactional";
    } | null>;
  };
  readonly inbox: {
    acceptAndApply(input: {
      readonly event: NormalizedSesEvent;
      readonly suppression: "None" | "Immediate";
      readonly createOperationalCase: boolean;
    }): Promise<"Accepted" | "Duplicate">;
  };
  readonly subscriptions: {
    confirmExactTopic(input: { readonly topicArn: string; readonly token: string }): Promise<void>;
  };
}

type Envelope = Readonly<{
  Type: "Notification" | "SubscriptionConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "2";
  Signature: string;
  SigningCertURL: string;
  Token?: string;
  SubscribeURL?: string;
}>;

const snsId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const providerId = /^[A-Za-z0-9._-]{1,160}$/u;
const signature = /^[A-Za-z0-9+/]{40,2048}={0,2}$/u;
const email = /^[^\s@\r\n]{1,64}@[A-Za-z0-9.-]{1,190}$/u;

function fail(code: SesSnsEventError["code"]): never {
  throw new SesSnsEventError(code);
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("SES_SNS_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
      return fail("SES_SNS_INPUT_INVALID");
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function parseEnvelope(value: unknown, topicArn: string): Envelope {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("SES_SNS_INPUT_INVALID");
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "Type");
  if (!typeDescriptor || !("value" in typeDescriptor)) return fail("SES_SNS_INPUT_INVALID");
  const type = typeDescriptor.value;
  const fields =
    type === "SubscriptionConfirmation"
      ? [
          "Type",
          "MessageId",
          "TopicArn",
          "Message",
          "Timestamp",
          "SignatureVersion",
          "Signature",
          "SigningCertURL",
          "Token",
          "SubscribeURL",
        ]
      : [
          "Type",
          "MessageId",
          "TopicArn",
          "Message",
          "Timestamp",
          "SignatureVersion",
          "Signature",
          "SigningCertURL",
        ];
  const raw = exact(value, fields);
  if (
    (raw.Type !== "Notification" && raw.Type !== "SubscriptionConfirmation") ||
    raw.TopicArn !== topicArn
  )
    return fail("SES_SNS_TOPIC_DENIED");
  if (
    raw.SignatureVersion !== "2" ||
    typeof raw.MessageId !== "string" ||
    !snsId.test(raw.MessageId) ||
    typeof raw.Message !== "string" ||
    raw.Message.length > 65_536 ||
    typeof raw.Signature !== "string" ||
    !signature.test(raw.Signature)
  )
    return fail("SES_SNS_INPUT_INVALID");
  parseNotificationInstant(raw.Timestamp);
  if (
    typeof raw.SigningCertURL !== "string" ||
    !/^https:\/\/sns\.ca-central-1\.amazonaws\.com\/SimpleNotificationService-[A-Za-z0-9_-]{32,128}\.pem$/u.test(
      raw.SigningCertURL,
    )
  )
    return fail("SES_SNS_INPUT_INVALID");
  if (raw.Type === "SubscriptionConfirmation") {
    if (
      typeof raw.Token !== "string" ||
      !/^[A-Za-z0-9_-]{20,2048}$/u.test(raw.Token) ||
      typeof raw.SubscribeURL !== "string" ||
      !raw.SubscribeURL.startsWith("https://sns.ca-central-1.amazonaws.com/")
    )
      return fail("SES_SNS_INPUT_INVALID");
  }
  return raw as unknown as Envelope;
}

function canonical(envelope: Envelope): string {
  const pairs =
    envelope.Type === "Notification"
      ? [
          ["Message", envelope.Message],
          ["MessageId", envelope.MessageId],
          ["Timestamp", envelope.Timestamp],
          ["TopicArn", envelope.TopicArn],
          ["Type", envelope.Type],
        ]
      : [
          ["Message", envelope.Message],
          ["MessageId", envelope.MessageId],
          ["SubscribeURL", envelope.SubscribeURL ?? ""],
          ["Timestamp", envelope.Timestamp],
          ["Token", envelope.Token ?? ""],
          ["TopicArn", envelope.TopicArn],
          ["Type", envelope.Type],
        ];
  return `${pairs.map(([key, value]) => `${key}\n${value}\n`).join("")}`;
}

function parseSesMessage(message: string) {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return fail("SES_SNS_INPUT_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("SES_SNS_INPUT_INVALID");
  const raw = value as Record<string, unknown>;
  if (
    !["Delivery", "Bounce", "Complaint"].includes(String(raw.notificationType)) ||
    raw.mail === null ||
    typeof raw.mail !== "object" ||
    Array.isArray(raw.mail)
  )
    return fail("SES_SNS_INPUT_INVALID");
  const mail = raw.mail as Record<string, unknown>;
  if (
    typeof mail.messageId !== "string" ||
    !providerId.test(mail.messageId) ||
    typeof mail.timestamp !== "string" ||
    !Array.isArray(mail.destination) ||
    mail.destination.length !== 1 ||
    typeof mail.destination[0] !== "string" ||
    !email.test(mail.destination[0])
  )
    return fail("SES_SNS_INPUT_INVALID");
  const occurredAt = parseNotificationInstant(mail.timestamp);
  let eventType: NormalizedSesEvent["eventType"];
  if (raw.notificationType === "Delivery") eventType = "Delivered";
  else if (raw.notificationType === "Complaint") eventType = "Complaint";
  else {
    if (raw.bounce === null || typeof raw.bounce !== "object" || Array.isArray(raw.bounce))
      return fail("SES_SNS_INPUT_INVALID");
    const bounceType = (raw.bounce as Record<string, unknown>).bounceType;
    if (bounceType !== "Permanent" && bounceType !== "Transient")
      return fail("SES_SNS_INPUT_INVALID");
    eventType = bounceType === "Permanent" ? "HardBounce" : "SoftBounce";
  }
  return Object.freeze({
    providerMessageId: mail.messageId,
    destination: mail.destination[0],
    occurredAt,
    eventType,
  });
}

export function createSesSnsEventService(
  config: {
    readonly topicArn: string;
    readonly retentionPolicyReference: string;
  },
  ports: SesSnsEventPorts,
) {
  const rawConfig = exact(config, ["topicArn", "retentionPolicyReference"]);
  if (
    typeof rawConfig.topicArn !== "string" ||
    !/^arn:aws:sns:ca-central-1:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/u.test(rawConfig.topicArn)
  )
    return fail("SES_SNS_TOPIC_DENIED");
  const topicArn = rawConfig.topicArn;
  const retentionPolicyReference = parseNotificationReference(rawConfig.retentionPolicyReference);
  return Object.freeze({
    async accept(value: unknown, acceptedAtValue: unknown) {
      const acceptedAt = parseNotificationInstant(acceptedAtValue);
      const envelope = parseEnvelope(value, topicArn);
      let verified: boolean;
      try {
        verified = await ports.signatures.verifyVersion2({
          signingCertificateUrl: envelope.SigningCertURL,
          canonicalMessage: canonical(envelope),
          signature: envelope.Signature,
        });
      } catch {
        return fail("SES_SNS_SIGNATURE_INVALID");
      }
      if (!verified) return fail("SES_SNS_SIGNATURE_INVALID");
      if (envelope.Type === "SubscriptionConfirmation") {
        try {
          await ports.subscriptions.confirmExactTopic({
            topicArn,
            token: envelope.Token ?? "",
          });
        } catch {
          return fail("SES_SNS_COMMIT_FAILED");
        }
        return Object.freeze({ outcome: "SubscriptionConfirmed" as const });
      }
      const message = parseSesMessage(envelope.Message);
      let recipient;
      try {
        recipient = await ports.recipients.resolveTransactional({
          destination: message.destination,
          providerMessageId: message.providerMessageId,
        });
      } catch {
        recipient = null;
      }
      if (!recipient || recipient.purpose !== "Transactional")
        return fail("SES_SNS_RECIPIENT_DENIED");
      const event: NormalizedSesEvent = Object.freeze({
        providerEventId: envelope.MessageId,
        providerMessageId: message.providerMessageId,
        recipientReference: parseNotificationReference(recipient.recipientReference),
        purpose: "Transactional",
        eventType: message.eventType,
        occurredAt: message.occurredAt,
        acceptedAt,
        retentionPolicyReference,
      });
      const immediate = event.eventType === "HardBounce" || event.eventType === "Complaint";
      let outcome;
      try {
        outcome = await ports.inbox.acceptAndApply({
          event,
          suppression: immediate ? "Immediate" : "None",
          createOperationalCase: immediate,
        });
      } catch {
        return fail("SES_SNS_COMMIT_FAILED");
      }
      if (outcome !== "Accepted" && outcome !== "Duplicate") return fail("SES_SNS_COMMIT_FAILED");
      return Object.freeze({ outcome, event });
    },
  });
}
