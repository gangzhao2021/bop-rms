import { beforeEach, expect, it, vi } from "vitest";
import { createPriceBookDraftAuthorSource } from "./price-book-draft-author-source.js";
const mocks = vi.hoisted(() => ({ event: vi.fn(), operation: vi.fn() }));
vi.mock("@bop/eventing", () => ({ loadOutboxEnvelope: mocks.event }));
const id = (n: number) => "0190ab56-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-14T08:00:00.000Z";
const operation = () => ({
  action: "ReplaceDraft",
  operationReference: id(3),
  aggregate: {
    brandReference: id(1),
    priceBookReference: id(2),
    versionReference: id(4),
    aggregateVersion: 2,
    lifecycle: "Draft",
    createdAt: at,
  },
  event: {
    eventType: "PriceBookDraftReplaced",
    priceBookReference: id(2),
    versionReference: id(4),
    brandReference: id(1),
    aggregateVersion: 2,
    lifecycle: "Draft",
    currencyCode: "CAD",
    snapshotDigest: "sha256:" + "a".repeat(64),
    occurredAt: at,
  },
});
const event = () => ({
  eventId: id(3),
  eventType: "PriceBookDraftReplaced",
  schemaVersion: 1,
  producerModule: "@rms/pricing",
  tenantId: id(1),
  aggregateType: "PriceBook",
  aggregateId: id(2),
  aggregateVersion: 2n,
  occurredAt: at,
  actor: { type: "Actor", actorId: id(5) },
  payload: operation().event,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.operation.mockResolvedValue(operation());
  mocks.event.mockResolvedValue(event());
});
const load = () =>
  createPriceBookDraftAuthorSource({
    brandReference: id(1),
    repository: () => ({ loadCurrentOperation: mocks.operation }),
  }).load({} as never, id(2));
it("resolves latest replacement author from exact immutable event", async () => {
  expect(await load()).toEqual({
    actorReference: id(5),
    operationReference: id(3),
    versionReference: id(4),
    aggregateVersion: 2,
  });
});
it.each(["missing", "scope", "version", "payload", "system", "type"])(
  "denies %s event provenance",
  async (mode) => {
    const value = event();
    if (mode === "missing") mocks.event.mockResolvedValue(null);
    else {
      if (mode === "scope") value.tenantId = id(90);
      if (mode === "version") value.aggregateVersion = 1n;
      if (mode === "payload") value.payload = { ...value.payload, currencyCode: "USD" };
      if (mode === "system") value.actor = { type: "System" } as never;
      if (mode === "type") value.eventType = "PriceBookVersionPublished";
      mocks.event.mockResolvedValue(value);
    }
    expect(await load()).toBeNull();
  },
);
it.each(["missing", "published", "foreign"])(
  "does not infer author from %s operation",
  async (mode) => {
    const value = operation();
    if (mode === "missing") mocks.operation.mockResolvedValue(null);
    else {
      if (mode === "published") value.aggregate.lifecycle = "Published";
      if (mode === "foreign") value.aggregate.brandReference = id(90);
      mocks.operation.mockResolvedValue(value);
    }
    expect(await load()).toBeNull();
    expect(mocks.event).not.toHaveBeenCalled();
  },
);
