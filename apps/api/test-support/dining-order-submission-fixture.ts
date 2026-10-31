import { createHash } from "node:crypto";
import { createGuestSessionCredentialProvider, createGuestSessionRecord } from "@bop/identity";
import {
  parseDiningSession,
  parseDiningParticipant,
  parseDiningIdentityAdmission,
  parseDiningTableStartEvidence,
  parseQrTableContextEvidence,
  type DiningCheckoutCommitment,
} from "@rms/dining";
import {
  createCustomerDiningCheckoutComposition,
  createCustomerDiningSubmissionPreparation,
  type CustomerDiningCheckoutCompositionOptions,
} from "../src/customer-dining-checkout-composition.js";
import {
  createCustomerDiningOrderSubmissionComposition,
  type CustomerDiningOrderSubmissionOptions,
} from "../src/customer-dining-order-submission-composition.js";
import { orderWriteFixture } from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import {
  parseCartQuoteAttachment,
  createOrderNumberAllocation,
  type OrderCreationRecord,
  type OrderCapacityLink,
} from "@rms/ordering";
export const id = (n: number) => "01902402-0000-7000-8000-" + n.toString().padStart(12, "0");
export const at = "2026-09-10T12:00:00.000Z";
export function fixture(observedAt = at) {
  const shift = (value: string) =>
    new Date(Date.parse(value) + Date.parse(observedAt) - Date.parse(at)).toISOString();
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const sessionCredential = credentials.generateCredential("Session"),
    csrfCredential = credentials.generateCredential("Csrf");
  const record = createGuestSessionRecord({
    session: {
      sessionReference: id(9),
      status: "Active",
      version: 2,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(40),
      publicTableReference: id(41),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(42),
      qrRevocationVersion: 1,
      diningState: "DiningBound",
      diningSessionReference: id(4),
      diningParticipantReference: id(8),
      createdAt: shift("2026-09-10T11:00:00.000Z"),
      lastSeenAt: shift("2026-09-10T11:00:00.000Z"),
      idleExpiresAt: shift("2026-09-10T15:00:00.000Z"),
      absoluteExpiresAt: shift("2026-09-11T11:00:00.000Z"),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: id(43),
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
    operationReference: id(44),
    operationIntentHash: credentials.hashOperationIntent("synthetic dining binding"),
  });
  const session = parseDiningSession({
    diningSessionReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(6),
    tableAssignmentVersion: 7,
    phase: "Active",
    version: 5,
    startedByActorReference: id(20),
    startedAt: shift("2026-09-10T11:00:00.000Z"),
    hostParticipantReference: id(8),
  });
  const participant = parseDiningParticipant({
    participantReference: id(8),
    diningSessionReference: id(4),
    status: "Active",
    version: 1,
    joinedAt: shift("2026-09-10T11:01:00.000Z"),
    leftAt: null,
  });
  const admission = parseDiningIdentityAdmission({
    admissionReference: id(30),
    diningSessionReference: id(4),
    participantReference: id(8),
    storeReference: id(3),
    tableReference: id(6),
    tableAssignmentVersion: 7,
    operationReference: id(31),
    operationIntentHash: "a".repeat(64),
    status: "Consumed",
    version: 2,
    issuedAt: participant.joinedAt,
    consumedAt: shift("2026-09-10T11:01:01.000Z"),
  });
  const context = parseQrTableContextEvidence({
    publicStoreReference: id(40),
    publicTableReference: id(41),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(6),
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: "Active",
    assignmentState: "Active",
    channel: "DineIn",
    qrState: "Enabled",
    revocationVersion: 1,
    contextEvidenceReference: id(45),
    validUntil: shift("2026-09-10T12:10:00.000Z"),
  });
  let stored: DiningCheckoutCommitment | null = null,
    writes = 0,
    available = true;
  let instant = observedAt;
  const options: CustomerDiningCheckoutCompositionOptions = {
    scope: { brandReference: id(2), storeReference: id(3) },
    now: () => instant,
    session: {
      credentials,
      binding: { validate: async () => "Current" },
      store: {
        create: async ({ record }) => record,
        resolve: async (hash) => (available && hash === record.sessionSelectorHash ? record : null),
        touchInteractive: async () => null,
        revoke: async () => null,
        resolveOperation: async () => null,
        rotate: async () => {
          throw new Error("unexpected rotation");
        },
      },
    },
    contexts: { resolve: async () => context },
    dining: {
      hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
      current: {
        readCurrent: async (request) => ({
          session,
          participant,
          admission,
          table: parseDiningTableStartEvidence({
            brandReference: id(2),
            storeReference: id(3),
            tableReference: id(6),
            assignmentVersion: 7,
            tableState: "Eligible",
            activeDiningSessionReference: id(4),
            observedAt: request.observedAt,
          }),
        }),
      },
      repository: {
        load: async (reference) => (stored?.commitmentReference === reference ? stored : null),
        append: async ({ record }) => {
          if (stored !== null) throw new Error("synthetic unique submission conflict");
          stored = record;
          writes++;
          return { status: "Created", record, version: 1 };
        },
      },
      audit: {
        create: async ({ record, observedAt }) => ({
          auditId: id(60),
          brandId: id(2),
          storeId: id(3),
          actor: { type: "System" },
          actionCode: "DINING_CHECKOUT_PREPARE",
          targetType: "DiningCheckoutCommitment",
          targetId: record.commitmentReference,
          reasonCode: "AUTHORIZED_DINING_CHECKOUT",
          correlationId: id(61),
          occurredAt: observedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
  };
  const input = {
    sessionCredential,
    csrfCredential,
    intent: {
      commitmentReference: id(10),
      cartReference: id(11),
      cartVersion: 3,
      quoteReference: id(12),
      submissionReference: id(13),
      orderReference: id(14),
      orderBatchReference: id(15),
      paymentOperationReference: id(16),
      sourceValidUntil: shift("2026-09-10T12:05:00.000Z"),
    },
  };
  return {
    options,
    identityRecord: record,
    input,
    credentials,
    writes: () => writes,
    loadSubmission: async (reference: string) =>
      stored?.submissionReference === reference ? stored : null,
    setTime: (value: string) => {
      instant = value;
    },
    revoke: () => {
      available = false;
    },
    service: () => createCustomerDiningCheckoutComposition(options),
  };
}

export function submissionFixture(observedAt = at) {
  const f = fixture(observedAt);
  let generated = 0;
  const service = createCustomerDiningSubmissionPreparation({
    ...f.options,
    submissions: { loadSubmission: f.loadSubmission },
    references: { generate: () => id(100 + generated++) },
  });
  const input = {
    sessionCredential: f.input.sessionCredential,
    csrfCredential: f.input.csrfCredential,
    intent: {
      submissionReference: f.input.intent.submissionReference,
      cartReference: f.input.intent.cartReference,
      cartVersion: f.input.intent.cartVersion,
      quoteReference: f.input.intent.quoteReference,
      sourceValidUntil: f.input.intent.sourceValidUntil,
    },
  };
  return { ...f, submission: service, submissionInput: input, generated: () => generated };
}

export function orderSubmissionFixture(observedAt = at) {
  const f = submissionFixture(observedAt);
  const sample = orderWriteFixture({ at: observedAt, dineIn: true });
  const mapping = new Map<string, string>([
    [sample.scope.brandReference, id(2)],
    [sample.scope.storeReference, id(3)],
    [sample.cart.cartReference, id(11)],
    [sample.request.record.guestSessionReference, id(9)],
    [String(sample.cart.diningSessionReference), id(4)],
    [String(sample.cart.items[0]?.addedByParticipantReference), id(8)],
    [sample.request.checkoutValidationEvidence.quoteReference, id(12)],
  ]);
  const map = (v: unknown): unknown => {
    if (typeof v === "string") return mapping.get(v) ?? v;
    if (Array.isArray(v)) return v.map(map);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, map(v)]));
    return v;
  };
  const source = map(sample) as typeof sample;
  const item = source.request.record.items[0];
  if (item === undefined) throw new Error("missing synthetic item");
  const quote = parseCartQuoteAttachment({
    operationReference: id(200),
    operationIntentHash: "sha256:" + "a".repeat(64),
    guestSessionReference: id(9),
    cartReference: id(11),
    brandReference: id(2),
    storeReference: id(3),
    cartVersion: source.cart.aggregateVersion,
    quoteReference: id(12),
    quoteVersion: 1,
    quoteInputDigest: item.pricing.quoteInputDigest,
    currencyCode: "CAD",
    currencyMetadataVersion: item.pricing.currencyMetadataVersion,
    currencyMetadataVersionReference: item.pricing.currencyMetadataVersionReference,
    subtotal: item.pricing.subtotal,
    discount: item.pricing.discount,
    tax: item.pricing.tax,
    fee: item.pricing.fee,
    total: item.pricing.total,
    lines: [
      {
        lineReference: item.cartItemReference,
        sellableReference: item.catalog.sellableReference,
        productVersionReference: item.catalog.productVersionReference,
        menuVersionReference: item.catalog.menuVersionReference,
        quantity: item.pricing.quantity,
      },
    ],
    warnings: [],
    quoteCreatedAt: item.pricing.quotedAt,
    quoteExpiresAt: new Date(Date.parse(observedAt) + 4 * 60 * 1000).toISOString(),
    attachedAt: item.pricing.quotedAt,
    idempotencyExpiresAt: new Date(
      Date.parse(item.pricing.quotedAt) + 24 * 60 * 60 * 1000,
    ).toISOString(),
  });
  let saved: OrderCreationRecord | null = null,
    savedLink: OrderCapacityLink | null = null;
  let writes = 0,
    sourceReads = 0,
    catalogCalls = 0,
    reference = 300,
    loseAck = false;
  const options: CustomerDiningOrderSubmissionOptions = {
    preparation: {
      ...f.options,
      submissions: { loadSubmission: f.loadSubmission },
      references: { generate: () => id(reference++) },
    },
    checkout: {
      repository: {
        loadCart: async () => {
          sourceReads++;
          return source.cart;
        },
        loadQuote: async () => {
          sourceReads++;
          return quote;
        },
      },
      references: { hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex") },
      catalog: {
        validateSelection: async (request) => {
          catalogCalls++;
          const attached = source.cart.items[0]?.catalogSelectionEvidence;
          if (attached === undefined || attached === null)
            throw new Error("missing synthetic selection");
          return {
            status: "Accepted",
            ...request,
            menuVersionReference: attached.menuVersionReference as never,
            productVersionReference: attached.productVersionReference as never,
            catalogChannelCode: attached.catalogChannelCode,
            catalogOrderTypeCode: attached.catalogOrderTypeCode,
            ruleEvidence: attached.ruleEvidence as never,
            validatedAt: request.observedAt,
          };
        },
      },
    },
    ordering: {
      source: {
        load: async () => ({
          cart: source.cart,
          lines: source.request.record.items.map((item) => ({
            cartItemReference: item.cartItemReference,
            catalog: item.catalog,
            pricing: item.pricing,
          })),
        }),
      },
      businessDate: { resolve: async () => source.request.businessDateResolution },
      audit: {
        create: async (request) => ({
          ...source.request.audit,
          auditId: id(reference++),
          targetId: request.order.orderReference,
          occurredAt: request.observedAt,
        }),
      },
      references: {
        generate: () => id(reference++),
        hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
        equals: (a, b) => a === b,
      },
    },
    repository: (link) => ({
      resolveSubmission: async () => saved,
      resolveCapacityLink: async () => savedLink,
      commit: async (request) => {
        if (saved !== null) return { status: "Existing", record: saved };
        saved = {
          ...request.record,
          orderNumberAllocation: createOrderNumberAllocation({
            orderReference: request.record.order.orderReference,
            allocatedAt: request.record.createdAt,
            sequence: 1n,
            businessDateResolution: request.businessDateResolution,
          }),
        };
        savedLink = link;
        writes++;
        if (loseAck) throw new Error("synthetic acknowledgement loss");
        return { status: "Created", record: saved };
      },
    }),
  };
  const input = {
    sessionCredential: f.input.sessionCredential,
    csrfCredential: f.input.csrfCredential,
    submissionReference: f.input.intent.submissionReference,
    cartReference: id(11),
    expectedCartVersion: source.cart.aggregateVersion,
    quoteReference: id(12),
  };
  return {
    ...f,
    options,
    orderInput: input,
    orderService: () => createCustomerDiningOrderSubmissionComposition(options),
    orderWrites: () => writes,
    sourceReads: () => sourceReads,
    catalogCalls: () => catalogCalls,
    savedLink: () => savedLink,
    loseAck: () => {
      loseAck = true;
    },
  };
}
