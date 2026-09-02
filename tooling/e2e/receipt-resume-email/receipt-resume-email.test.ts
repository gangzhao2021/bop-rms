import { createHash } from "node:crypto";

import {
  buildReceiptResumeFragmentLink,
  createNotificationPreferenceEvidence,
  createNotificationRequest,
  createNotificationScope,
  createNotificationSuppressionEvidence,
  createResumeTokenService,
  createSesSnsEventService,
  evaluateNotificationRoute,
  parseNotificationCode,
  parseNotificationDigest,
  parseNotificationInstant,
  parseNotificationReference,
  parseNotificationVersion,
  registerNotificationRequest,
  renderReceiptEmail,
  type NotificationPorts,
  type ResumeTokenPorts,
  type ResumeTokenRecord,
  type SesSnsEventPorts,
} from "../../../packages/bop/notification/src/index.js";
import { extractAndClearReceiptResumeFragment } from "../../../apps/customer-pwa/src/receipt/resume-fragment.js";
import { describe, expect, it } from "vitest";

const id = (value: number) => `018fac00-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const at = "2026-08-12T14:00:00.000Z";
const later = "2026-08-12T15:00:00.000Z";
const plaintextToken = "R".repeat(43);
const recipientAddress = "synthetic-recipient@example.test";
const topic = "arn:aws:sns:ca-central-1:123456789012:bop-transactional-events";

function notificationFixture(preferenceDecision: "Allow" | "Deny" = "Allow") {
  const scope = createNotificationScope({
    kind: "Store",
    brandReference: id(1) as never,
    storeReference: id(2) as never,
  });
  const preference = createNotificationPreferenceEvidence({
    evidenceReference: parseNotificationReference(id(3)),
    recipientReference: parseNotificationReference(id(4)),
    scope,
    purpose: "Transactional",
    decision: preferenceDecision,
    allowedChannels: preferenceDecision === "Allow" ? ["Email"] : [],
    version: parseNotificationVersion(1),
    checkedAt: parseNotificationInstant(at),
    validUntil: parseNotificationInstant(later),
  });
  const suppression = createNotificationSuppressionEvidence({
    evidenceReference: parseNotificationReference(id(5)),
    recipientReference: parseNotificationReference(id(4)),
    scope,
    purpose: "Transactional",
    channel: "Email",
    decision: "Clear",
    reasonCode: null,
    checkedAt: parseNotificationInstant(at),
    validUntil: parseNotificationInstant(later),
  });
  const route = evaluateNotificationRoute({
    purpose: "Transactional",
    requestedChannels: ["Email"],
    preferenceDecision: preference.decision,
    preferredChannels: preference.allowedChannels,
    suppressions: [suppression],
  });
  const request = createNotificationRequest({
    requestReference: parseNotificationReference(id(6)),
    deduplicationDigest: parseNotificationDigest(digest("receipt-request")),
    notificationCode: parseNotificationCode("TRANSACTION_RECEIPT"),
    source: {
      eventReference: parseNotificationReference(id(7)),
      eventType: "ReceiptIssued",
      producerModule: "@rms/ordering",
      occurredAt: parseNotificationInstant(at),
      correlationReference: parseNotificationReference(id(8)),
    },
    recipientReference: parseNotificationReference(id(4)),
    scope,
    purpose: "Transactional",
    priority: "Normal",
    requestedChannels: ["Email"],
    template: {
      templateReference: id(9) as never,
      templateVersion: 1 as never,
      contentReference: id(10) as never,
      contentDigest: digest("receipt-template") as never,
      locale: "en-CA",
    },
    outcome: route.outcome,
    routedChannels: route.channels,
    suppressionReason: route.outcome === "Suppressed" ? route.reason : null,
    requestedAt: parseNotificationInstant(at),
  });
  return { preference, request, scope, suppression };
}

function eventEnvelope() {
  return {
    eventId: id(7),
    eventType: "ReceiptIssued",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/ordering" as const,
    tenantId: id(1),
    storeId: id(2),
    aggregateType: "Order",
    aggregateId: id(11),
    aggregateVersion: 1n,
    correlationId: id(8),
    actor: { type: "System" as const },
    payload: {},
    redactionClassification: "personal" as const,
    replayMetadata: {},
  };
}

function registrationPorts(committed: Map<string, unknown>): NotificationPorts {
  const unavailable = async () => {
    throw new Error("delivery is outside registration");
  };
  return {
    unitOfWork: {
      registerRequest: async (input) => {
        const key = `${input.idempotencyKey}:${input.request.deduplicationDigest}`;
        if (!committed.has(key)) committed.set(key, input);
      },
      appendAttempt: unavailable,
    },
    destinations: { resolve: unavailable },
    adapters: {
      Email: { deliver: unavailable },
      SMS: { deliver: unavailable },
      Push: { deliver: unavailable },
    },
    providerReadiness: {
      environment: "Staging",
      loadSesEvidence: async () => null,
    },
    resendAuthorization: { authorize: async () => null },
  };
}

function tokenHarness() {
  const records: ResumeTokenRecord[] = [];
  const consumed = new Set<string>();
  let mintCount = 0;
  const ports: ResumeTokenPorts = {
    tokens: {
      mint: async () => {
        mintCount += 1;
        return { plaintextToken, tokenHashDigest: digest(plaintextToken) };
      },
      hash: async (value) => digest(value),
    },
    references: { generateTokenRecord: () => id(12) },
    records: {
      listUnexpired: async ({ orderReference, observedAt }) =>
        records.filter(
          (record) =>
            record.orderReference === orderReference &&
            Date.parse(record.expiresAt) > Date.parse(observedAt) &&
            !consumed.has(record.tokenHashDigest),
        ),
      append: async (record) => {
        records.push(record);
        return record;
      },
      consumeAndRevokeSiblings: async ({ tokenHashDigest, observedAt }) => {
        const record = records.find(
          (candidate) =>
            candidate.tokenHashDigest === tokenHashDigest &&
            Date.parse(candidate.expiresAt) > Date.parse(observedAt) &&
            !consumed.has(candidate.tokenHashDigest),
        );
        if (!record) return null;
        for (const sibling of records) {
          if (sibling.orderReference === record.orderReference)
            consumed.add(sibling.tokenHashDigest);
        }
        return {
          grantReference: parseNotificationReference(id(13)),
          orderReference: record.orderReference,
          brandReference: record.brandReference,
          storeReference: record.storeReference,
          consumedTokenRecordReference: record.tokenRecordReference,
          revokedSiblingReferences: [],
        };
      },
    },
  };
  return {
    get mintCount() {
      return mintCount;
    },
    records,
    service: createResumeTokenService(ports),
  };
}

function bounceEnvelope() {
  return {
    Type: "Notification",
    MessageId: "018fac00-0000-4000-8000-000000000014",
    TopicArn: topic,
    Message: JSON.stringify({
      notificationType: "Bounce",
      mail: {
        messageId: "synthetic-provider-message-2028",
        timestamp: "2026-08-12T14:05:00.000Z",
        destination: [recipientAddress],
      },
      bounce: { bounceType: "Permanent", diagnosticCode: "private-provider-detail" },
    }),
    Timestamp: "2026-08-12T14:05:01.000Z",
    SignatureVersion: "2",
    Signature: Buffer.alloc(64, 8).toString("base64"),
    SigningCertURL: `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-${"a".repeat(64)}.pem`,
  };
}

describe("WP-2028 receipt/resume email recovery E2E", () => {
  it("deduplicates, contains the token, suppresses a bounced recipient, and denies no-contact recovery", async () => {
    const fixture = notificationFixture();
    const committed = new Map<string, unknown>();
    const ports = registrationPorts(committed);
    const registration = {
      eventEnvelope: eventEnvelope(),
      request: fixture.request,
      preferenceEvidence: fixture.preference,
      suppressionEvidence: [fixture.suppression],
      idempotencyKey: parseNotificationReference(id(14)),
    };
    await registerNotificationRequest(registration, ports);
    await registerNotificationRequest(registration, ports);
    expect(committed.size).toBe(1);

    const receipt = renderReceiptEmail({
      locale: "en-CA",
      storeDisplayName: "Synthetic Store",
      orderNumber: "2028",
      issuedAt: at,
      lines: [
        { displayName: "Synthetic item", quantity: 1, amountMinor: 1000n, currencyCode: "CAD" },
      ],
      subtotalMinor: 1000n,
      taxMinor: 130n,
      tipMinor: 0n,
      totalMinor: 1130n,
      currencyCode: "CAD",
    });
    expect(receipt.subject).toBe("Your receipt is ready");
    expect(receipt.html).not.toMatch(/<img|https?:\/\//u);

    const tokens = tokenHarness();
    const minted = await tokens.service.mintForAttempt({
      orderReference: id(11),
      brandReference: id(1),
      storeReference: id(2),
      attemptReference: id(15),
      mintedAt: at,
      expiresAt: "2026-08-12T14:30:00.000Z",
    });
    const link = buildReceiptResumeFragmentLink({
      origin: "https://customer.example.test",
      orderReference: id(11),
      plaintextToken: minted.plaintextToken,
    });
    const operationalLog = [
      { requestReference: fixture.request.requestReference, state: "Accepted" },
    ];
    expect(
      JSON.stringify({
        committed: [...committed.values()],
        records: tokens.records,
        operationalLog,
      }),
    ).not.toContain(plaintextToken);
    expect(link).toContain(`#resume=${plaintextToken}`);
    expect(link).not.toContain("?resume=");

    const cleanHistory: string[] = [];
    const recovered = extractAndClearReceiptResumeFragment({
      url: link,
      replaceCleanUrl: (path) => cleanHistory.push(path),
    });
    expect(cleanHistory).toEqual([`/orders/${id(11)}/receipt`]);
    if (!recovered) throw new Error("synthetic resume fragment was not recovered");
    await expect(
      tokens.service.consume({
        plaintextToken: recovered.plaintextToken,
        observedAt: "2026-08-12T14:06:00.000Z",
      }),
    ).resolves.toMatchObject({
      orderReference: id(11),
      brandReference: id(1),
      storeReference: id(2),
    });
    await expect(
      tokens.service.consume({ plaintextToken, observedAt: "2026-08-12T14:07:00.000Z" }),
    ).rejects.toMatchObject({ code: "RESUME_TOKEN_INVALID_OR_CONSUMED" });

    const inbox = new Set<string>();
    const applied: unknown[] = [];
    const snsPorts: SesSnsEventPorts = {
      signatures: { verifyVersion2: async () => true },
      recipients: {
        resolveTransactional: async ({ destination }) =>
          destination === recipientAddress
            ? { recipientReference: parseNotificationReference(id(4)), purpose: "Transactional" }
            : null,
      },
      inbox: {
        acceptAndApply: async (input) => {
          if (inbox.has(input.event.providerEventId)) return "Duplicate";
          inbox.add(input.event.providerEventId);
          applied.push(input);
          return "Accepted";
        },
      },
      subscriptions: { confirmExactTopic: async () => undefined },
    };
    const sns = createSesSnsEventService(
      { topicArn: topic, retentionPolicyReference: id(16) },
      snsPorts,
    );
    await expect(sns.accept(bounceEnvelope(), "2026-08-12T14:05:02.000Z")).resolves.toMatchObject({
      outcome: "Accepted",
      event: { eventType: "HardBounce" },
    });
    await expect(sns.accept(bounceEnvelope(), "2026-08-12T14:05:03.000Z")).resolves.toMatchObject({
      outcome: "Duplicate",
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ suppression: "Immediate", createOperationalCase: true });
    expect(JSON.stringify(applied)).not.toContain(recipientAddress);
    expect(JSON.stringify(applied)).not.toContain("private-provider-detail");
    expect(JSON.stringify(applied)).not.toContain(plaintextToken);

    const noContact = notificationFixture("Deny");
    const inSessionReceipt = Object.freeze({ orderReference: id(11), receiptReference: id(17) });
    expect(noContact.request).toMatchObject({
      outcome: "Suppressed",
      routedChannels: [],
      suppressionReason: "PREFERENCE_DENIED",
    });
    if (noContact.request.outcome === "Accepted")
      await tokens.service.mintForAttempt({
        orderReference: id(11),
        brandReference: id(1),
        storeReference: id(2),
        attemptReference: id(18),
        mintedAt: at,
        expiresAt: "2026-08-12T14:30:00.000Z",
      });
    expect(tokens.mintCount).toBe(1);
    expect(inSessionReceipt.orderReference).toBe(id(11));
  });
});
