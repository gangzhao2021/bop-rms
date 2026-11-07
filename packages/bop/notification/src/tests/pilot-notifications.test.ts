import { describe, expect, it, vi } from "vitest";
import {
  createCustomerOrderMessaging,
  createCustomerOrderNotificationService,
  createDeliveryFeedbackEndpoint,
  createSesSnsEventService,
  parseCustomerOrderMessagingSettings,
  SesSnsEventError,
  type CustomerOrderMessage,
  type CustomerOrderMessageProviderPort,
  type CustomerOrderNotificationAttempt,
  type CustomerOrderNotificationOutcome,
  type SesSnsEventPorts,
} from "../index.js";

const id = (n: number) => `0190aa20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const order = {
  purpose: "PickupReady" as const,
  brandReference: id(1),
  storeReference: id(2),
  orderReference: id(3),
  orderNumber: "12",
  storeDisplayName: "DEMO Store",
  contact: { channel: "Email" as const, value: "guest@example.test" },
  contactDetailsReference: id(4),
  contactDetailsVersion: 1,
  orderLink: null,
};

function setup(options: { suppressed?: boolean } = {}) {
  const attempts: CustomerOrderNotificationAttempt[] = [];
  const outcomes: CustomerOrderNotificationOutcome[] = [];
  const events: string[] = [];
  const sent: CustomerOrderMessage[] = [];
  const email: CustomerOrderMessageProviderPort = {
    channel: "Email",
    send: vi.fn(async (message: CustomerOrderMessage) => {
      events.push("send");
      sent.push(message);
      return { outcome: "Accepted" as const, providerMessageReference: "ses-1" };
    }),
  };
  let n = 100;
  const service = createCustomerOrderNotificationService({
    messaging: { sms: null, email },
    records: {
      async appendAttempt(attempt) {
        events.push("attempt");
        if (
          attempts.some(
            (a) => a.orderReference === attempt.orderReference && a.purpose === attempt.purpose,
          )
        )
          return "Exists";
        attempts.push(attempt);
        return "Created";
      },
      async appendOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
    clock: { now: () => "2026-10-20T12:00:00.000Z" },
    references: { generateNotification: () => id(n++) },
    suppression: { isSuppressed: async () => options.suppressed === true },
  });
  return { service, attempts, outcomes, events, sent, email };
}

describe("DEC-PILOT-NOTIFICATIONS customer order messages", () => {
  it("mints the one-time link only after the attempt is recorded and puts it in the message", async () => {
    const t = setup();
    const mintOrderLink = vi.fn(async (attempt: string) => {
      t.events.push("mint:" + attempt);
      return `https://order.example.test/resume#t=${"A".repeat(43)}`;
    });
    await expect(t.service.notify({ ...order, mintOrderLink })).resolves.toMatchObject({
      status: "Accepted",
    });
    expect(t.events).toEqual(["attempt", `mint:${id(100)}`, "send"]);
    expect(t.sent[0]?.text).toContain("/resume#t=");
    expect(JSON.stringify([t.attempts, t.outcomes])).not.toContain("resume#t=");
  });

  it("sends without a link when minting fails or the sibling limit is reached", async () => {
    const t = setup();
    await t.service.notify({
      ...order,
      mintOrderLink: async () => {
        throw new Error("down");
      },
    });
    expect(t.sent[0]?.text).not.toContain("resume");
    expect(t.sent[0]?.text).toContain("your order 12 is ready");
  });

  it("never mints for a replayed trigger", async () => {
    const t = setup();
    await t.service.notify(order);
    const mintOrderLink = vi.fn(async () => null);
    await expect(t.service.notify({ ...order, mintOrderLink })).resolves.toEqual({
      status: "AlreadyRecorded",
    });
    expect(mintOrderLink).not.toHaveBeenCalled();
  });

  it("does not message a suppressed address and records the decision without the address", async () => {
    const t = setup({ suppressed: true });
    await expect(t.service.notify(order)).resolves.toMatchObject({ status: "Suppressed" });
    expect(t.email.send).not.toHaveBeenCalled();
    expect(t.outcomes).toMatchObject([{ outcome: "Rejected", providerMessageReference: null }]);
    expect(JSON.stringify([t.attempts, t.outcomes])).not.toContain("guest@");
  });

  it("emails the issued receipt once with the owned HTML template", async () => {
    const t = setup();
    const input = {
      brandReference: id(1),
      storeReference: id(2),
      orderReference: id(3),
      email: "guest@example.test",
      contactDetailsReference: id(4),
      contactDetailsVersion: 1,
      receipt: {
        locale: "en-CA" as const,
        storeDisplayName: "DEMO Store",
        orderNumber: "12",
        issuedAt: "2026-10-20T11:59:00.000Z",
        lines: [
          { displayName: "Latte", quantity: 1, amountMinor: 500n, currencyCode: "CAD" as const },
        ],
        subtotalMinor: 500n,
        taxMinor: 65n,
        tipMinor: 0n,
        totalMinor: 565n,
        currencyCode: "CAD" as const,
      },
    };
    await expect(t.service.sendReceiptEmail(input)).resolves.toMatchObject({ status: "Accepted" });
    await expect(t.service.sendReceiptEmail(input)).resolves.toEqual({ status: "AlreadyRecorded" });
    expect(t.attempts).toMatchObject([{ purpose: "ReceiptEmail", channel: "Email" }]);
    expect(t.sent[0]?.subject).toBe("Your receipt is ready");
    expect(t.sent[0]?.html).toContain("<table");
    expect(t.sent[0]?.text).toContain("CA$5.65");
  });

  it("rejects a receipt purpose through the order-message path", async () => {
    const t = setup();
    await expect(t.service.notify({ ...order, purpose: "ReceiptEmail" })).rejects.toThrow();
    expect(t.attempts).toEqual([]);
  });
});

const topic = "arn:aws:sns:ca-central-1:123456789012:bop-transactional-events";
const cert = `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-${"a".repeat(64)}.pem`;
const sesEvent = (eventType: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventType,
    mail: {
      messageId: "ses-1",
      timestamp: "2026-10-20T12:00:00.000Z",
      destination: ["guest@example.test"],
      tags: { notification: [id(100)] },
    },
    ...extra,
  });
const envelope = (message: string, extra: Record<string, unknown> = {}) => ({
  Type: "Notification",
  MessageId: "018faa00-0000-4000-8000-000000000001",
  TopicArn: topic,
  Subject: "Amazon SES Email Event Notification",
  Message: message,
  Timestamp: "2026-10-20T12:00:30.000Z",
  SignatureVersion: "2",
  Signature: Buffer.alloc(64, 7).toString("base64"),
  SigningCertURL: cert,
  UnsubscribeURL: "https://sns.ca-central-1.amazonaws.com/?Action=Unsubscribe&x=y",
  ...extra,
});
function feedback(overrides: Partial<SesSnsEventPorts> = {}) {
  const canonical: string[] = [];
  const accepted: unknown[] = [];
  const ports: SesSnsEventPorts = {
    signatures: {
      verifyVersion2: vi.fn(async ({ canonicalMessage }) => {
        canonical.push(canonicalMessage);
        return true;
      }),
    },
    recipients: {
      resolveTransactional: vi.fn(async () => ({
        recipientReference: id(100) as never,
        purpose: "Transactional" as const,
        suppressionDigest: `hmac-sha256:v1:${"0".repeat(64)}`,
      })),
    },
    inbox: {
      acceptAndApply: vi.fn(async (input) => {
        accepted.push(input);
        return "Accepted" as const;
      }),
    },
    subscriptions: { confirmExactTopic: vi.fn(async () => undefined) },
    ...overrides,
  };
  return { ports, canonical, accepted };
}

describe("DEC-PILOT-NOTIFICATIONS SES feedback (real SNS envelope shape)", () => {
  it("accepts configuration-set events with Subject and UnsubscribeURL, signing Subject", async () => {
    const f = feedback();
    const service = createSesSnsEventService(
      { topicArn: topic, retentionPolicyReference: id(9) },
      f.ports,
    );
    const result = await service.accept(
      envelope(sesEvent("Bounce", { bounce: { bounceType: "Permanent" } })),
      "2026-10-20T12:01:00.000Z",
    );
    expect(result).toMatchObject({ outcome: "Accepted", event: { eventType: "HardBounce" } });
    expect(f.canonical[0]).toContain("Subject\nAmazon SES Email Event Notification\n");
    expect(f.canonical[0]).not.toContain("UnsubscribeURL");
    expect(f.accepted[0]).toMatchObject({
      suppression: "Immediate",
      suppressionDigest: `hmac-sha256:v1:${"0".repeat(64)}`,
    });
    expect(JSON.stringify(f.accepted)).not.toContain("guest@");
  });

  it("acknowledges send/delay events without storing anything", async () => {
    const f = feedback();
    const service = createSesSnsEventService(
      { topicArn: topic, retentionPolicyReference: id(9) },
      f.ports,
    );
    await expect(
      service.accept(envelope(sesEvent("Send")), "2026-10-20T12:01:00.000Z"),
    ).resolves.toEqual({
      outcome: "Ignored",
    });
    expect(f.ports.inbox.acceptAndApply).not.toHaveBeenCalled();
  });

  it("asks SNS to redeliver when storage is unavailable", async () => {
    const f = feedback({
      recipients: {
        resolveTransactional: async () => {
          throw new Error("db down");
        },
      },
    });
    const service = createSesSnsEventService(
      { topicArn: topic, retentionPolicyReference: id(9) },
      f.ports,
    );
    await expect(
      service.accept(
        envelope(sesEvent("Complaint", { complaint: {} })),
        "2026-10-20T12:01:00.000Z",
      ),
    ).rejects.toEqual(new SesSnsEventError("SES_SNS_COMMIT_FAILED"));
  });

  it("maps outcomes to HTTP for SNS: forged 403, storage 503, unknown message 200", async () => {
    const clock = { now: () => "2026-10-20T12:01:00.000Z" };
    const body = JSON.stringify(envelope(sesEvent("Delivery")));
    const ok = createDeliveryFeedbackEndpoint(
      { topicArn: topic, retentionPolicyReference: id(9) },
      feedback().ports,
      clock,
    );
    await expect(ok.handle({ body, messageTypeHeader: "Notification" })).resolves.toEqual({
      status: 200,
      body: { outcome: "Accepted" },
    });
    await expect(
      ok.handle({ body, messageTypeHeader: "SubscriptionConfirmation" }),
    ).resolves.toMatchObject({
      status: 400,
    });
    await expect(ok.handle({ body: "not json", messageTypeHeader: null })).resolves.toMatchObject({
      status: 400,
    });
    const forged = createDeliveryFeedbackEndpoint(
      { topicArn: topic, retentionPolicyReference: id(9) },
      feedback({ signatures: { verifyVersion2: async () => false } }).ports,
      clock,
    );
    await expect(forged.handle({ body, messageTypeHeader: null })).resolves.toMatchObject({
      status: 403,
    });
    const unknown = createDeliveryFeedbackEndpoint(
      { topicArn: topic, retentionPolicyReference: id(9) },
      feedback({ recipients: { resolveTransactional: async () => null } }).ports,
      clock,
    );
    await expect(unknown.handle({ body, messageTypeHeader: null })).resolves.toEqual({
      status: 200,
      body: { outcome: "Ignored" },
    });
    const down = createDeliveryFeedbackEndpoint(
      { topicArn: topic, retentionPolicyReference: id(9) },
      feedback({
        inbox: {
          acceptAndApply: async () => {
            throw new Error("db down");
          },
        },
      }).ports,
      clock,
    );
    await expect(down.handle({ body, messageTypeHeader: null })).resolves.toMatchObject({
      status: 503,
    });
  });
});

describe("DEC-PILOT-NOTIFICATIONS provider configuration", () => {
  const ses = {
    provider: "ses",
    region: "ca-central-1",
    fromAddress: "orders@mail.example.test",
    fromDisplayName: "DEMO Store",
    configurationSetName: "bop-transactional",
    feedbackTopicArn: topic,
  };
  it("is disabled when the file is absent or says disabled", () => {
    for (const value of [
      null,
      { schemaVersion: 1, email: { provider: "disabled" }, sms: { provider: "disabled" } },
    ]) {
      const settings = parseCustomerOrderMessagingSettings(value);
      const messaging = createCustomerOrderMessaging(settings, { readSecret: () => "" });
      expect([messaging.email, messaging.sms, messaging.snsPort]).toEqual([null, null, null]);
    }
  });

  it("builds SES and SNS adapters with local fakes and keys read only by file name", async () => {
    const settings = parseCustomerOrderMessagingSettings({
      schemaVersion: 1,
      email: {
        ...ses,
        accessKeyIdFile: "aws-access-key-id",
        secretAccessKeyFile: "aws-secret-access-key",
      },
      sms: { provider: "sns", region: "ca-central-1", originationNumber: "+18885550100" },
      customerOrigin: "https://order.example.test",
      contactDigestKeyFile: "notification-digest-key",
    });
    const readSecret = vi.fn((name: string) =>
      name === "aws-access-key-id"
        ? "SYNTHETICTESTKEYID00"
        : "secret/EXAMPLE+value0000000000000000",
    );
    const sendEmail = vi.fn(async () => ({ MessageId: "ses-9" }));
    const publish = vi.fn(async () => ({ MessageId: "sns-9" }));
    const messaging = createCustomerOrderMessaging(settings, {
      readSecret,
      transports: { ses: { sendEmail }, sns: { publish, confirmSubscription: async () => ({}) } },
    });
    expect(messaging.email?.channel).toBe("Email");
    expect(messaging.sms?.channel).toBe("Sms");
    await messaging.sms?.send({
      channel: "Sms",
      destination: "+14165550123",
      subject: null,
      text: "DEMO Store: your order 12 is ready.",
      idempotencyKey: id(1) as never,
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ schemaVersion: 1, email: { ...ses } }, "a sending channel without a digest key"],
    [
      { schemaVersion: 1, email: { ...ses, accessKeyIdFile: "a" }, contactDigestKeyFile: "k" },
      "half a credential pair",
    ],
    [
      { schemaVersion: 1, email: { ...ses, region: "us-east-1" }, contactDigestKeyFile: "k" },
      "a region outside Canada",
    ],
    [
      { schemaVersion: 1, sms: { provider: "twilio" }, contactDigestKeyFile: "k" },
      "an unknown provider",
    ],
    [{ schemaVersion: 1, customerOrigin: "http://order.example.test" }, "a non-HTTPS link origin"],
    [
      {
        schemaVersion: 1,
        email: { ...ses, accessKeyIdFile: "../etc/passwd", secretAccessKeyFile: "b" },
        contactDigestKeyFile: "k",
      },
      "a path as secret file",
    ],
  ] as [unknown, string][])("refuses %j (%s)", (value) => {
    expect(() => parseCustomerOrderMessagingSettings(value)).toThrow();
  });
});
