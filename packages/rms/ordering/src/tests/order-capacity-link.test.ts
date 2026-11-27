import { createCapacityLinkedOrderCreationService } from "../application/order-creation-service.js";
import { expect, it } from "vitest";
import {
  parseOrderCapacityLink,
  assertOrderCapacityLinkMatches,
} from "../domain/order-capacity-link.js";
import { createPostgresCapacityLinkedOrderCreationRepository } from "../infrastructure/persistence/order-creation-store.js";
import { orderWriteFixture, orderCapacityLinkFixture } from "./order-creation-store.fixture.js";
it("binds the exact Dining commitment to the original Order and Checkout evidence", () => {
  const f = orderWriteFixture({ dineIn: true }),
    link = orderCapacityLinkFixture(f);
  expect(() =>
    assertOrderCapacityLinkMatches(link, f.request.record, f.request.checkoutValidationEvidence),
  ).not.toThrow();
  expect(Object.isFrozen(link)).toBe(true);
});
it.each([
  "commitmentReference",
  "ownerContextReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "cartReference",
  "quoteReference",
  "guestSessionReference",
] as const)("rejects a substituted %s", (key) => {
  const f = orderWriteFixture({ dineIn: true }),
    link = orderCapacityLinkFixture(f);
  const changed = parseOrderCapacityLink({
    ...link,
    [key]: "01902402-0000-7000-8000-000000000999",
  });
  expect(() =>
    assertOrderCapacityLinkMatches(changed, f.request.record, f.request.checkoutValidationEvidence),
  ).toThrow();
});
it("rejects a different owner snapshot or a commitment that expires before Checkout", () => {
  const f = orderWriteFixture({ dineIn: true }),
    link = orderCapacityLinkFixture(f);
  for (const patch of [
    { ownerSnapshotDigest: "sha256:" + "f".repeat(64) },
    { validUntil: f.request.record.createdAt },
    { cartVersion: 6 },
  ]) {
    expect(() =>
      assertOrderCapacityLinkMatches(
        parseOrderCapacityLink({ ...link, ...patch }),
        f.request.record,
        f.request.checkoutValidationEvidence,
      ),
    ).toThrow();
  }
});
it("does not turn a Pickup Order into a Dining commitment", () => {
  const dining = orderWriteFixture({ dineIn: true }),
    pickup = orderWriteFixture();
  expect(() =>
    assertOrderCapacityLinkMatches(orderCapacityLinkFixture(dining), pickup.request.record),
  ).toThrow();
});
it("rejects unknown fields, unsupported owners and malformed versions", () => {
  const link = orderCapacityLinkFixture(orderWriteFixture({ dineIn: true }));
  for (const patch of [
    { owner: "Inventory" },
    { commitmentVersion: 2 },
    { cartVersion: 0 },
    { extra: true },
  ]) {
    expect(() => parseOrderCapacityLink({ ...link, ...patch })).toThrow();
  }
});
it("does not invoke getters", () => {
  const link = orderCapacityLinkFixture(orderWriteFixture({ dineIn: true }));
  let reads = 0;
  const raw = {
    ...link,
    get ownerSnapshotDigest() {
      reads++;
      return link.ownerSnapshotDigest;
    },
  };
  expect(() => parseOrderCapacityLink(raw)).toThrow();
  expect(reads).toBe(0);
});
it("requires a link and exact fixed scope before opening a transaction", () => {
  const f = orderWriteFixture({ dineIn: true });
  let transactions = 0;
  const runner = {
    run: async () => {
      transactions++;
      throw new Error("unexpected");
    },
  };
  expect(() =>
    createPostgresCapacityLinkedOrderCreationRepository(
      { query: runner, write: runner },
      f.scope,
      undefined,
    ),
  ).toThrow();
  expect(() =>
    createPostgresCapacityLinkedOrderCreationRepository(
      { query: runner, write: runner },
      { ...f.scope, storeReference: "01902402-0000-7000-8000-000000000999" },
      orderCapacityLinkFixture(f),
    ),
  ).toThrow();
  expect(transactions).toBe(0);
});

it("rejects a substituted submission before authorization or repository access", async () => {
  const f = orderWriteFixture({ dineIn: true });
  const service = createCapacityLinkedOrderCreationService(
    {} as never,
    orderCapacityLinkFixture(f),
  );
  const command = {
    submissionReference: f.request.record.submissionReference,
    cartReference: f.cart.cartReference,
    expectedCartVersion: f.cart.aggregateVersion,
    quoteReference: f.request.checkoutValidationEvidence.quoteReference,
    requestedAt: f.request.record.createdAt,
  };
  for (const patch of [
    { submissionReference: "01902402-0000-7000-8000-000000000999" },
    { cartReference: "01902402-0000-7000-8000-000000000999" },
    { expectedCartVersion: f.cart.aggregateVersion + 1 },
    { quoteReference: "01902402-0000-7000-8000-000000000999" },
  ])
    await expect(service.create({ ...command, ...patch })).rejects.toMatchObject({
      code: "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
    });
});
it("captures the required owner link and rejects accessor commands without reading them", () => {
  const f = orderWriteFixture({ dineIn: true });
  const service = createCapacityLinkedOrderCreationService(
    {} as never,
    orderCapacityLinkFixture(f),
  );
  let reads = 0;
  expect(() =>
    service.create({
      submissionReference: f.request.record.submissionReference,
      cartReference: f.cart.cartReference,
      expectedCartVersion: f.cart.aggregateVersion,
      get quoteReference() {
        reads++;
        return f.request.checkoutValidationEvidence.quoteReference;
      },
      requestedAt: f.request.record.createdAt,
    }),
  ).toThrow();
  expect(reads).toBe(0);
});

it("binds Pickup to Fulfillment and rejects swapping owner types", () => {
  const f = orderWriteFixture();
  const link = orderCapacityLinkFixture(f);
  expect(link.owner).toBe("Fulfillment");
  expect(() =>
    assertOrderCapacityLinkMatches(link, f.request.record, f.request.checkoutValidationEvidence),
  ).not.toThrow();
  expect(() =>
    assertOrderCapacityLinkMatches(
      parseOrderCapacityLink({ ...link, owner: "Dining" }),
      f.request.record,
    ),
  ).toThrow();
  const dining = orderWriteFixture({ dineIn: true });
  const other = parseOrderCapacityLink({
    ...orderCapacityLinkFixture(dining),
    owner: "Fulfillment",
  });
  expect(() => assertOrderCapacityLinkMatches(other, dining.request.record)).toThrow();
});

it.each([
  { dining: false, channel: "DineIn", diningState: "DiningBound", session: "same" },
  { dining: false, channel: "Pickup", diningState: "ContextOnly", session: "same" },
  { dining: true, channel: "Pickup", diningState: "ContextOnly", session: null },
  { dining: true, channel: "DineIn", diningState: "ContextOnly", session: "same" },
])("rejects incompatible identity before reading order history: %j", async (scenario) => {
  const f = orderWriteFixture({ dineIn: scenario.dining });
  const link = orderCapacityLinkFixture(f);
  let reads = 0;
  const service = createCapacityLinkedOrderCreationService(
    {
      clock: { now: () => f.request.record.createdAt },
      references: { hashIntent: () => "sha256:" + "a".repeat(64) },
      authorization: {
        authorize: async () => ({
          guestSession: {
            sessionReference: link.guestSessionReference,
            brandReference: link.brandReference,
            storeReference: link.storeReference,
            channel: scenario.channel,
            diningState: scenario.diningState,
            diningSessionReference: scenario.session === null ? null : link.ownerContextReference,
          },
        }),
      },
      repository: {
        resolveSubmission: async () => {
          reads++;
          return null;
        },
      },
    } as never,
    link,
  );
  await expect(
    service.create({
      submissionReference: link.submissionReference,
      cartReference: link.cartReference,
      expectedCartVersion: link.cartVersion,
      quoteReference: link.quoteReference,
      requestedAt: f.request.record.createdAt,
    }),
  ).rejects.toMatchObject({ code: "ORDER_CREATE_PERMISSION_DENIED" });
  expect(reads).toBe(0);
});
