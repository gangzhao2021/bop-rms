import type { DomainEventEnvelope } from "@bop/eventing";
import {
  parsePublishingDigest,
  parsePublishingReference,
  parsePublishingVersion,
} from "@bop/publishing";
import { describe, expect, it, vi } from "vitest";
import {
  createNotificationDeliveryAttempt,
  createNotificationPreferenceEvidence,
  createNotificationRequest,
  createNotificationScope,
  createNotificationSuppressionEvidence,
  evaluateNotificationRoute,
  executeNotificationDelivery,
  parseDeliveryAttemptSequence,
  parseNotificationCode,
  parseNotificationDigest,
  parseNotificationInstant,
  parseNotificationReference,
  parseNotificationVersion,
  registerNotificationRequest,
  resolveNotificationDeliveryStatus,
  NotificationContractError,
  NotificationServiceError,
  type NotificationChannel,
  type NotificationDeliveryAttempt,
  type NotificationPorts,
  type NotificationPreferenceEvidence,
  type NotificationRequest,
  type NotificationSuppressionEvidence,
  type RegisterNotificationInput,
} from "../index.js";

const ids = {
  brand: "018f4000-0000-7000-8000-000000000001",
  otherBrand: "018f4000-0000-7000-8000-000000000002",
  store: "018f4000-0000-7000-8000-000000000003",
  event: "018f4000-0000-7000-8000-000000000004",
  correlation: "018f4000-0000-7000-8000-000000000005",
  aggregate: "018f4000-0000-7000-8000-000000000006",
  request: "018f4000-0000-7000-8000-000000000007",
  recipient: "018f4000-0000-7000-8000-000000000008",
  template: "018f4000-0000-7000-8000-000000000009",
  content: "018f4000-0000-7000-8000-00000000000a",
  preference: "018f4000-0000-7000-8000-00000000000b",
  suppressionEmail: "018f4000-0000-7000-8000-00000000000c",
  suppressionSms: "018f4000-0000-7000-8000-00000000000d",
  suppressionPush: "018f4000-0000-7000-8000-00000000000e",
  idempotency: "018f4000-0000-7000-8000-00000000000f",
  attempt1: "018f4000-0000-7000-8000-000000000010",
  attempt2: "018f4000-0000-7000-8000-000000000011",
  destination: "018f4000-0000-7000-8000-000000000012",
  providerAttempt: "018f4000-0000-7000-8000-000000000013",
} as const;

const before = parseNotificationInstant("2026-07-29T19:55:00.000Z");
const at = parseNotificationInstant("2026-07-29T20:00:00.000Z");
const later = parseNotificationInstant("2026-07-29T21:00:00.000Z");
const contentDigest = parsePublishingDigest(`sha256:${"a".repeat(64)}`);

function scope(brandReference: string = ids.brand) {
  return createNotificationScope({
    kind: "Store",
    brandReference: brandReference as never,
    storeReference: ids.store as never,
  });
}

function event(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: ids.event,
    eventType: "ReceiptIssued",
    schemaVersion: 1,
    occurredAt: before,
    producerModule: "@rms/ordering",
    tenantId: ids.brand,
    storeId: ids.store,
    aggregateType: "Order",
    aggregateId: ids.aggregate,
    aggregateVersion: 1n,
    correlationId: ids.correlation,
    actor: { type: "System" },
    payload: { privateOrderDetail: "must-not-enter-notification" },
    redactionClassification: "personal",
    replayMetadata: {},
    ...overrides,
  };
}

function preference(
  purpose: NotificationRequest["purpose"] = "Transactional",
  decision: NotificationPreferenceEvidence["decision"] = "Allow",
  allowedChannels: readonly NotificationChannel[] = ["Email"],
  overrides: Partial<NotificationPreferenceEvidence> = {},
) {
  return createNotificationPreferenceEvidence({
    evidenceReference: parseNotificationReference(ids.preference),
    recipientReference: parseNotificationReference(ids.recipient),
    scope: scope(),
    purpose,
    decision,
    allowedChannels: decision === "Deny" ? [] : allowedChannels,
    version: parseNotificationVersion(1),
    checkedAt: before,
    validUntil: later,
    ...overrides,
  });
}

function suppression(
  channel: NotificationChannel,
  decision: NotificationSuppressionEvidence["decision"] = "Clear",
  overrides: Partial<NotificationSuppressionEvidence> = {},
) {
  const refs = {
    Email: ids.suppressionEmail,
    SMS: ids.suppressionSms,
    Push: ids.suppressionPush,
  };
  return createNotificationSuppressionEvidence({
    evidenceReference: parseNotificationReference(refs[channel]),
    recipientReference: parseNotificationReference(ids.recipient),
    scope: scope(),
    purpose: "Transactional",
    channel,
    decision,
    reasonCode: decision === "Suppressed" ? parseNotificationCode("RECIPIENT_SUPPRESSED") : null,
    checkedAt: before,
    validUntil: later,
    ...overrides,
  });
}

function request(options?: {
  purpose?: NotificationRequest["purpose"];
  requestedChannels?: readonly NotificationChannel[];
  preference?: NotificationPreferenceEvidence;
  suppressions?: readonly NotificationSuppressionEvidence[];
  overrides?: Partial<NotificationRequest>;
}) {
  const purpose = options?.purpose ?? "Transactional";
  const requestedChannels = options?.requestedChannels ?? ["Email"];
  const preferenceValue = options?.preference ?? preference(purpose);
  const suppressions =
    options?.suppressions ??
    requestedChannels.map((channel) => suppression(channel, "Clear", { purpose }));
  const route = evaluateNotificationRoute({
    purpose,
    requestedChannels,
    preferenceDecision: preferenceValue.decision,
    preferredChannels: preferenceValue.allowedChannels,
    suppressions,
  });
  const record = createNotificationRequest({
    requestReference: parseNotificationReference(ids.request),
    deduplicationDigest: parseNotificationDigest(`sha256:${"b".repeat(64)}`),
    notificationCode: parseNotificationCode("TRANSACTION_RECEIPT"),
    source: {
      eventReference: parseNotificationReference(ids.event),
      eventType: "ReceiptIssued",
      producerModule: "@rms/ordering",
      occurredAt: before,
      correlationReference: parseNotificationReference(ids.correlation),
    },
    recipientReference: parseNotificationReference(ids.recipient),
    scope: scope(),
    purpose,
    priority: "Normal",
    requestedChannels,
    template: {
      templateReference: parsePublishingReference(ids.template),
      templateVersion: parsePublishingVersion(1),
      contentReference: parsePublishingReference(ids.content),
      contentDigest,
      locale: "en-CA",
    },
    outcome: route.outcome,
    routedChannels: route.channels,
    suppressionReason: route.outcome === "Suppressed" ? route.reason : null,
    requestedAt: at,
    ...options?.overrides,
  });
  return { record, preference: preferenceValue, suppressions };
}

function ports(options?: {
  registerFailure?: boolean;
  appendFailure?: boolean;
  adapter?: "Accepted" | "Rejected" | "Unknown" | "Throw" | "Extra";
  destination?: "Resolved" | "Unavailable";
}) {
  const registrations: unknown[] = [];
  const attempts: NotificationDeliveryAttempt[] = [];
  const adapter = {
    deliver: vi.fn(async () => {
      if (options?.adapter === "Throw") throw new Error("synthetic provider detail");
      if (options?.adapter === "Extra")
        return {
          outcome: "Accepted" as const,
          providerAttemptReference: parseNotificationReference(ids.providerAttempt),
          rawProviderPayload: "must-not-cross-adapter-boundary",
        };
      const outcome = options?.adapter ?? "Accepted";
      return outcome === "Accepted"
        ? {
            outcome,
            providerAttemptReference: parseNotificationReference(ids.providerAttempt),
          }
        : { outcome, providerAttemptReference: null };
    }),
  };
  const value: NotificationPorts = {
    unitOfWork: {
      registerRequest: vi.fn(async (input) => {
        if (options?.registerFailure) throw new Error("synthetic transaction failure");
        registrations.push(input);
      }),
      appendAttempt: vi.fn(async (input) => {
        if (options?.appendFailure) throw new Error("synthetic append failure");
        attempts.push(input.attempt);
      }),
    },
    destinations: {
      resolve: vi.fn(async () =>
        options?.destination === "Unavailable"
          ? { outcome: "Unavailable" as const, reason: "DESTINATION_UNAVAILABLE" as const }
          : {
              outcome: "Resolved" as const,
              destinationReference: parseNotificationReference(ids.destination),
            },
      ),
    },
    adapters: { Email: adapter, SMS: adapter, Push: adapter },
  };
  return { value, registrations, attempts, adapter };
}

function registrationInput(
  value = request(),
  overrides: Partial<RegisterNotificationInput> = {},
): RegisterNotificationInput {
  return {
    eventEnvelope: event(),
    request: value.record,
    preferenceEvidence: value.preference,
    suppressionEvidence: value.suppressions,
    idempotencyKey: parseNotificationReference(ids.idempotency),
    ...overrides,
  };
}

describe("Notification request and routing", () => {
  it("registers Event metadata without retaining source payload", async () => {
    const fixture = request();
    const adapter = ports();
    const result = await registerNotificationRequest(registrationInput(fixture), adapter.value);
    expect(result).toMatchObject({
      outcome: "Accepted",
      routedChannels: ["Email"],
      source: { eventReference: ids.event, eventType: "ReceiptIssued" },
    });
    expect(JSON.stringify(result)).not.toContain("privateOrderDetail");
    expect(adapter.registrations).toHaveLength(1);
    expect(adapter.adapter.deliver).not.toHaveBeenCalled();
  });

  it("forwards exact deduplication and immutable evidence references", async () => {
    const fixture = request();
    const adapter = ports();
    await registerNotificationRequest(registrationInput(fixture), adapter.value);
    expect(adapter.registrations[0]).toMatchObject({
      idempotencyKey: ids.idempotency,
      request: {
        deduplicationDigest: `sha256:${"b".repeat(64)}`,
        recipientReference: ids.recipient,
      },
      preferenceEvidenceReference: ids.preference,
      suppressionEvidenceReferences: [ids.suppressionEmail],
    });
  });

  it("rejects source Event and exact Tenant mismatches", async () => {
    const fixture = request();
    const { storeId: omittedStoreId, ...eventWithoutStore } = event();
    expect(omittedStoreId).toBe(ids.store);
    for (const eventEnvelope of [
      event({ eventId: ids.aggregate }),
      event({ tenantId: ids.otherBrand }),
      eventWithoutStore,
    ])
      await expect(
        registerNotificationRequest(registrationInput(fixture, { eventEnvelope }), ports().value),
      ).rejects.toMatchObject({ code: "NOTIFICATION_REQUEST_INVALID" });
  });

  it("keeps transactional and marketing preference evidence separate", async () => {
    const fixture = request();
    await expect(
      registerNotificationRequest(
        registrationInput(fixture, {
          preferenceEvidence: preference("Marketing"),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_EVIDENCE_DENIED" });
  });

  it("fails closed on stale, missing, duplicate, or wrong-scope suppression evidence", async () => {
    const fixture = request();
    const firstSuppression = fixture.suppressions.at(0);
    if (firstSuppression === undefined) throw new Error("synthetic suppression missing");
    const cases: readonly NotificationSuppressionEvidence[][] = [
      [],
      [firstSuppression, firstSuppression],
      [
        suppression("Email", "Clear", {
          scope: scope(ids.otherBrand),
        }),
      ],
      [
        suppression("Email", "Clear", {
          validUntil: at,
        }),
      ],
    ];
    for (const suppressionEvidence of cases)
      await expect(
        registerNotificationRequest(
          registrationInput(fixture, { suppressionEvidence }),
          ports().value,
        ),
      ).rejects.toMatchObject({ code: "NOTIFICATION_EVIDENCE_DENIED" });
  });

  it("suppresses marketing even with allow evidence", async () => {
    const marketingPreference = preference("Marketing", "Allow", ["Email"]);
    const fixture = request({
      purpose: "Marketing",
      preference: marketingPreference,
      suppressions: [suppression("Email", "Clear", { purpose: "Marketing" })],
    });
    const result = await registerNotificationRequest(registrationInput(fixture), ports().value);
    expect(result).toMatchObject({
      outcome: "Suppressed",
      routedChannels: [],
      suppressionReason: "MARKETING_DISABLED",
    });
  });

  it("keeps SMS and Push disabled while preserving adapter contracts", async () => {
    const value = preference("Transactional", "Allow", ["SMS", "Push"]);
    const fixture = request({
      requestedChannels: ["SMS", "Push"],
      preference: value,
      suppressions: [suppression("SMS"), suppression("Push")],
    });
    const adapter = ports();
    const result = await registerNotificationRequest(registrationInput(fixture), adapter.value);
    expect(result.suppressionReason).toBe("CHANNEL_DISABLED");
    expect(adapter.adapter.deliver).not.toHaveBeenCalled();
  });

  it("respects preference denial and active Email suppression", async () => {
    const denied = preference("Transactional", "Deny");
    const preferenceFixture = request({ preference: denied });
    expect(
      await registerNotificationRequest(registrationInput(preferenceFixture), ports().value),
    ).toMatchObject({ suppressionReason: "PREFERENCE_DENIED" });

    const suppressedFixture = request({
      suppressions: [suppression("Email", "Suppressed")],
    });
    expect(
      await registerNotificationRequest(registrationInput(suppressedFixture), ports().value),
    ).toMatchObject({ suppressionReason: "CHANNEL_SUPPRESSED" });
  });

  it("rejects unknown request fields and maps commit failure to bounded denial", async () => {
    const fixture = request();
    const input = registrationInput(fixture) as RegisterNotificationInput & {
      renderedBody?: string;
    };
    input.renderedBody = "must-not-enter-core";
    await expect(registerNotificationRequest(input, ports().value)).rejects.toEqual(
      new NotificationServiceError("NOTIFICATION_REQUEST_INVALID"),
    );
    await expect(
      registerNotificationRequest(
        registrationInput(fixture),
        ports({ registerFailure: true }).value,
      ),
    ).rejects.toEqual(new NotificationServiceError("NOTIFICATION_REQUEST_COMMIT_FAILED"));
  });

  it("rejects a request timestamp before its source Event", () => {
    expect(() =>
      request({
        overrides: {
          requestedAt: parseNotificationInstant("2026-07-29T19:54:00.000Z"),
        },
      }),
    ).toThrow(NotificationContractError);
  });
});

describe("Notification delivery attempts", () => {
  it("submits only opaque normalized adapter input and appends Accepted", async () => {
    const fixture = request();
    const adapter = ports();
    const attempt = await executeNotificationDelivery(
      {
        request: fixture.record,
        attemptReference: parseNotificationReference(ids.attempt1),
        channel: "Email",
        previousAttempt: null,
        idempotencyKey: parseNotificationReference(ids.idempotency),
        attemptedAt: at,
      },
      adapter.value,
    );
    expect(attempt).toMatchObject({
      sequence: 1,
      outcome: "Accepted",
      providerAttemptReference: ids.providerAttempt,
      destinationReference: ids.destination,
    });
    expect(adapter.adapter.deliver).toHaveBeenCalledWith({
      requestReference: ids.request,
      attemptReference: ids.attempt1,
      channel: "Email",
      destinationReference: ids.destination,
      templateReference: ids.template,
      templateVersion: 1,
      contentReference: ids.content,
      contentDigest,
      locale: "en-CA",
      idempotencyKey: ids.idempotency,
    });
    expect(JSON.stringify(adapter.adapter.deliver.mock.calls[0])).not.toContain("@");
  });

  it("records adapter throw or malformed provider payload as Unknown", async () => {
    const fixture = request();
    for (const adapterMode of ["Throw", "Extra"] as const) {
      const adapter = ports({ adapter: adapterMode });
      const result = await executeNotificationDelivery(
        {
          request: fixture.record,
          attemptReference: parseNotificationReference(ids.attempt1),
          channel: "Email",
          previousAttempt: null,
          idempotencyKey: parseNotificationReference(ids.idempotency),
          attemptedAt: at,
        },
        adapter.value,
      );
      expect(result).toMatchObject({
        outcome: "Unknown",
        providerAttemptReference: null,
      });
    }
  });

  it("creates an immutable next sequence for explicit resend", async () => {
    const fixture = request();
    const first = createNotificationDeliveryAttempt({
      attemptReference: parseNotificationReference(ids.attempt1),
      requestReference: fixture.record.requestReference,
      channel: "Email",
      sequence: parseDeliveryAttemptSequence(1),
      destinationReference: parseNotificationReference(ids.destination),
      outcome: "Unknown",
      providerAttemptReference: null,
      attemptedAt: at,
    });
    const adapter = ports();
    const second = await executeNotificationDelivery(
      {
        request: fixture.record,
        attemptReference: parseNotificationReference(ids.attempt2),
        channel: "Email",
        previousAttempt: first,
        idempotencyKey: parseNotificationReference(ids.idempotency),
        attemptedAt: later,
      },
      adapter.value,
    );
    expect(first).toMatchObject({ sequence: 1, outcome: "Unknown" });
    expect(second).toMatchObject({ sequence: 2, outcome: "Accepted" });
    expect(resolveNotificationDeliveryStatus(ids.request, [first, second])).toBe("AdapterAccepted");
  });

  it("denies delivery for suppressed routes, disabled channels, or resend after Accepted", async () => {
    const accepted = request();
    const prior = createNotificationDeliveryAttempt({
      attemptReference: parseNotificationReference(ids.attempt1),
      requestReference: accepted.record.requestReference,
      channel: "Email",
      sequence: parseDeliveryAttemptSequence(1),
      destinationReference: parseNotificationReference(ids.destination),
      outcome: "Accepted",
      providerAttemptReference: parseNotificationReference(ids.providerAttempt),
      attemptedAt: at,
    });
    const suppressed = request({ preference: preference("Transactional", "Deny") });
    for (const input of [
      {
        request: suppressed.record,
        attemptReference: parseNotificationReference(ids.attempt1),
        channel: "Email" as const,
        previousAttempt: null,
        idempotencyKey: parseNotificationReference(ids.idempotency),
        attemptedAt: at,
      },
      {
        request: accepted.record,
        attemptReference: parseNotificationReference(ids.attempt1),
        channel: "SMS" as const,
        previousAttempt: null,
        idempotencyKey: parseNotificationReference(ids.idempotency),
        attemptedAt: at,
      },
      {
        request: accepted.record,
        attemptReference: parseNotificationReference(ids.attempt2),
        channel: "Email" as const,
        previousAttempt: prior,
        idempotencyKey: parseNotificationReference(ids.idempotency),
        attemptedAt: later,
      },
    ])
      await expect(executeNotificationDelivery(input, ports().value)).rejects.toMatchObject({
        code: "NOTIFICATION_DELIVERY_DENIED",
      });
  });

  it("rejects an attempt timestamp before the request", async () => {
    const fixture = request();
    await expect(
      executeNotificationDelivery(
        {
          request: fixture.record,
          attemptReference: parseNotificationReference(ids.attempt1),
          channel: "Email",
          previousAttempt: null,
          idempotencyKey: parseNotificationReference(ids.idempotency),
          attemptedAt: before,
        },
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_DELIVERY_DENIED" });
  });

  it("fails closed when destination is unavailable without calling adapter", async () => {
    const fixture = request();
    const adapter = ports({ destination: "Unavailable" });
    await expect(
      executeNotificationDelivery(
        {
          request: fixture.record,
          attemptReference: parseNotificationReference(ids.attempt1),
          channel: "Email",
          previousAttempt: null,
          idempotencyKey: parseNotificationReference(ids.idempotency),
          attemptedAt: at,
        },
        adapter.value,
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_DESTINATION_UNAVAILABLE" });
    expect(adapter.adapter.deliver).not.toHaveBeenCalled();
  });

  it("maps atomic append failure to bounded denial", async () => {
    const fixture = request();
    await expect(
      executeNotificationDelivery(
        {
          request: fixture.record,
          attemptReference: parseNotificationReference(ids.attempt1),
          channel: "Email",
          previousAttempt: null,
          idempotencyKey: parseNotificationReference(ids.idempotency),
          attemptedAt: at,
        },
        ports({ appendFailure: true }).value,
      ),
    ).rejects.toEqual(new NotificationServiceError("NOTIFICATION_ATTEMPT_COMMIT_FAILED"));
  });

  it("queries only contiguous immutable attempt history", () => {
    expect(resolveNotificationDeliveryStatus(ids.request, [])).toBe("NotAttempted");
    const invalid = createNotificationDeliveryAttempt({
      attemptReference: parseNotificationReference(ids.attempt2),
      requestReference: parseNotificationReference(ids.request),
      channel: "Email",
      sequence: parseDeliveryAttemptSequence(2),
      destinationReference: parseNotificationReference(ids.destination),
      outcome: "Unknown",
      providerAttemptReference: null,
      attemptedAt: at,
    });
    expect(() => resolveNotificationDeliveryStatus(ids.request, [invalid])).toThrow(
      NotificationContractError,
    );
  });
});
