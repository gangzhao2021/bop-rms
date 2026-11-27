import { describe, expect, it, vi } from "vitest";
import {
  createSesSnsEventService,
  readVerifiedSesFeedbackRoute,
  SesSnsEventError,
  type SesSnsEventPorts,
} from "../index.js";

const id = (n: number) => `018faa00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const topic = "arn:aws:sns:ca-central-1:123456789012:bop-transactional-events";
const signature = Buffer.alloc(64, 7).toString("base64");
const cert = `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-${"a".repeat(64)}.pem`;
const receivedAt = "2026-08-12T14:01:00.000Z";

function sesMessage(
  notificationType: "Delivery" | "Bounce" | "Complaint",
  bounceType = "Permanent",
) {
  return JSON.stringify({
    notificationType,
    mail: {
      messageId: "synthetic-provider-message-1",
      timestamp: "2026-08-12T14:00:00.000Z",
      destination: ["synthetic-recipient@example.test"],
      source: "ignored-provider-field@example.test",
    },
    ...(notificationType === "Bounce"
      ? { bounce: { bounceType, diagnosticCode: "must-not-persist" } }
      : {}),
    ...(notificationType === "Complaint" ? { complaint: { complaintFeedbackType: "abuse" } } : {}),
  });
}

function notification(message = sesMessage("Bounce")) {
  return {
    Type: "Notification",
    MessageId: "018faa00-0000-4000-8000-000000000001",
    TopicArn: topic,
    Message: message,
    Timestamp: "2026-08-12T14:00:30.000Z",
    SignatureVersion: "2",
    Signature: signature,
    SigningCertURL: cert,
  };
}

function subscription() {
  return {
    Type: "SubscriptionConfirmation",
    MessageId: "018faa00-0000-4000-8000-000000000002",
    TopicArn: topic,
    Message: "You have chosen to subscribe.",
    Timestamp: "2026-08-12T14:00:30.000Z",
    SignatureVersion: "2",
    Signature: signature,
    SigningCertURL: cert,
    Token: "T".repeat(43),
    SubscribeURL:
      "https://sns.ca-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=synthetic-placeholder",
  };
}

function harness(options: { verified?: boolean; recipient?: boolean; duplicate?: boolean } = {}) {
  const accepted: unknown[] = [];
  const ports: SesSnsEventPorts = {
    signatures: { verifyVersion2: vi.fn(async () => options.verified !== false) },
    recipients: {
      resolveTransactional: vi.fn(async () =>
        options.recipient === false
          ? null
          : { recipientReference: id(1) as never, purpose: "Transactional" as const },
      ),
    },
    inbox: {
      acceptAndApply: vi.fn(async (input) => {
        accepted.push(input);
        return options.duplicate ? ("Duplicate" as const) : ("Accepted" as const);
      }),
    },
    subscriptions: { confirmExactTopic: vi.fn(async () => undefined) },
  };
  const service = createSesSnsEventService(
    { topicArn: topic, retentionPolicyReference: id(2) },
    ports,
  );
  return { service, ports, accepted };
}

describe("SES SNS event authentication and privacy", () => {
  it.each([
    ["Permanent", "HardBounce", "Immediate", true],
    ["Transient", "SoftBounce", "None", false],
  ] as const)(
    "normalizes %s bounce with bounded suppression",
    async (bounceType, eventType, suppression, createOperationalCase) => {
      const test = harness();
      const result = await test.service.accept(
        notification(sesMessage("Bounce", bounceType)),
        receivedAt,
      );
      expect(result).toMatchObject({ outcome: "Accepted", event: { eventType } });
      expect(test.accepted[0]).toMatchObject({ suppression, createOperationalCase });
      expect(JSON.stringify(test.accepted)).not.toContain("synthetic-recipient@example.test");
      expect(JSON.stringify(test.accepted)).not.toContain("diagnosticCode");
    },
  );

  it("applies immediate suppression and case intent for Complaint", async () => {
    const test = harness({ duplicate: true });
    await expect(
      test.service.accept(notification(sesMessage("Complaint")), receivedAt),
    ).resolves.toMatchObject({ outcome: "Duplicate", event: { eventType: "Complaint" } });
    expect(test.accepted[0]).toMatchObject({
      suppression: "Immediate",
      createOperationalCase: true,
    });
  });

  it("rejects forged signature before recipient resolution or Inbox", async () => {
    const test = harness({ verified: false });
    await expect(test.service.accept(notification(), receivedAt)).rejects.toEqual(
      new SesSnsEventError("SES_SNS_SIGNATURE_INVALID"),
    );
    expect(test.ports.recipients.resolveTransactional).not.toHaveBeenCalled();
    expect(test.ports.inbox.acceptAndApply).not.toHaveBeenCalled();
  });

  it.each([
    { ...notification(), SignatureVersion: "1" },
    { ...notification(), TopicArn: "arn:aws:sns:us-east-1:123456789012:wrong" },
    { ...notification(), SigningCertURL: "https://attacker.invalid/cert.pem" },
  ])("rejects invalid envelope before mutation %#", async (envelope) => {
    const test = harness();
    await expect(test.service.accept(envelope, receivedAt)).rejects.toBeInstanceOf(
      SesSnsEventError,
    );
    expect(test.ports.inbox.acceptAndApply).not.toHaveBeenCalled();
  });

  it("confirms only the exact signed Topic through the scoped port and never follows SubscribeURL", async () => {
    const test = harness();
    await expect(test.service.accept(subscription(), receivedAt)).resolves.toEqual({
      outcome: "SubscriptionConfirmed",
    });
    expect(test.ports.subscriptions.confirmExactTopic).toHaveBeenCalledWith({
      topicArn: topic,
      token: "T".repeat(43),
    });
    expect(
      JSON.stringify(
        (test.ports.subscriptions.confirmExactTopic as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain("SubscribeURL");
  });
});

describe("batch 34: which Store an SNS delivery is for, at an installation of several Stores", () => {
  const tagged = (tags: unknown) =>
    JSON.stringify({
      ...JSON.parse(sesMessage("Bounce")),
      mail: { ...JSON.parse(sesMessage("Bounce")).mail, tags },
    });
  it("verifies the signature first, then reads the signed topic and configuration set", async () => {
    const verifyVersion2 = vi.fn(async () => true);
    const other = "arn:aws:sns:ca-central-1:123456789012:another-store-events";
    await expect(
      readVerifiedSesFeedbackRoute(
        {
          ...notification(tagged({ "ses:configuration-set": ["store-two"], purpose: ["x"] })),
          TopicArn: other,
        },
        { verifyVersion2 },
      ),
    ).resolves.toEqual({
      type: "Notification",
      topicArn: other,
      configurationSetName: "store-two",
    });
    expect(verifyVersion2).toHaveBeenCalledTimes(1);
    expect(verifyVersion2).toHaveBeenCalledWith(
      expect.objectContaining({
        signingCertificateUrl: cert,
        signature,
      }),
    );
    // No tag, or not exactly one well-formed name: no configuration set.
    for (const message of [
      sesMessage("Bounce"),
      tagged({ "ses:configuration-set": ["a", "b"] }),
      tagged(["x"]),
      "not json",
    ])
      expect(
        (await readVerifiedSesFeedbackRoute(notification(message), { verifyVersion2 }))
          .configurationSetName,
      ).toBeNull();
    await expect(readVerifiedSesFeedbackRoute(subscription(), { verifyVersion2 })).resolves.toEqual(
      {
        type: "SubscriptionConfirmation",
        topicArn: topic,
        configurationSetName: null,
      },
    );
  });
  it("refuses a forged, unverifiable or malformed delivery before reading its message", async () => {
    for (const verifyVersion2 of [
      vi.fn(async () => false),
      vi.fn(async () => Promise.reject(new Error("x"))),
    ])
      await expect(
        readVerifiedSesFeedbackRoute(notification(), { verifyVersion2 }),
      ).rejects.toEqual(new SesSnsEventError("SES_SNS_SIGNATURE_INVALID"));
    const verifyVersion2 = vi.fn(async () => true);
    await expect(
      readVerifiedSesFeedbackRoute(
        { ...notification(), TopicArn: "arn:aws:sns:us-east-1:1:x" },
        { verifyVersion2 },
      ),
    ).rejects.toEqual(new SesSnsEventError("SES_SNS_TOPIC_DENIED"));
    await expect(
      readVerifiedSesFeedbackRoute({ ...notification(), Signature: "!" }, { verifyVersion2 }),
    ).rejects.toEqual(new SesSnsEventError("SES_SNS_INPUT_INVALID"));
    expect(verifyVersion2).not.toHaveBeenCalled();
  });
});
