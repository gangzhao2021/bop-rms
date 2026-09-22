import { createHash } from "node:crypto";
import { createGuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredCustomerQuoteService,
  type ConfiguredCustomerQuoteOptions,
} from "../application/configured-customer-quote-service.js";
import type { ConfiguredCartQuotePorts } from "../application/configured-cart-quote-service.js";
import type { CartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import { parseCartAggregate } from "../domain/cart.js";
import { fixture, id } from "./configured-cart-quote.fixture.js";

function setup(dining = false) {
  const f = fixture(dining),
    snapshot = f.catalogLines[0]?.snapshot;
  if (snapshot === undefined) throw new Error("synthetic snapshot missing");
  const session = createGuestSession({
    sessionReference: id(65),
    version: 1,
    status: "Active",
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    publicStoreReference: id(80),
    publicTableReference: dining ? id(81) : null,
    channel: f.cart.orderType,
    locale: "en-CA",
    qrReference: id(82),
    qrRevocationVersion: 1,
    diningState: dining ? "DiningBound" : "ContextOnly",
    diningSessionReference: dining ? id(67) : null,
    diningParticipantReference: dining ? id(68) : null,
    createdAt: f.observedAt,
    lastSeenAt: f.observedAt,
    idleExpiresAt: "2026-08-02T20:00:00.000Z",
    absoluteExpiresAt: "2026-08-03T16:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const scope = { brandReference: f.cart.brandReference, storeReference: f.cart.storeReference };
  const command = {
    sessionCredential: "a".repeat(43),
    csrfCredential: "b".repeat(43),
    cartReference: f.cart.cartReference,
    expectedCartVersion: f.cart.aggregateVersion,
    operationReference: id(90),
  };
  const authorize = vi.fn<ConfiguredCustomerQuoteOptions["sessions"]["authorize"]>(
    async (input) => {
      if (
        input.sessionCredential !== command.sessionCredential ||
        input.csrfCredential !== command.csrfCredential
      )
        throw new Error("synthetic authorization denied");
      return session;
    },
  );
  const binding = { current: vi.fn(async () => parseCartAggregate(f.cart)) };
  const originalParticipation = {
    schemaVersion: 1,
    ...scope,
    diningSessionReference: id(67),
    participantReference: id(68),
    tableReference: id(81),
    tableAssignmentVersion: 1,
    diningSessionVersion: 1,
    participantVersion: 1,
    observedAt: f.observedAt,
  };
  const participation = { resolve: vi.fn(async (): Promise<unknown> => originalParticipation) };
  let saved: CartQuoteAttachment<2> | null = null;
  const attach = vi.fn<ConfiguredCartQuotePorts["repository"]["attach"]>(async (input) => {
    saved = input.attachment;
    return saved;
  });
  const pricing = { quoteCart: vi.fn(async () => f.quote) };
  const catalog = { capture: vi.fn(async () => snapshot) };
  const service = createConfiguredCustomerQuoteService({
    scope,
    sessions: { authorize },
    now: () => f.observedAt,
    ...(dining
      ? { orderType: "DineIn" as const, participation }
      : { orderType: "Pickup" as const, binding }),
    pricing,
    catalog,
    pricingChannelCode: f.pricingChannelCode,
    references: {
      hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
    },
    repository: { loadCart: async () => f.cart, resolveOperation: async () => saved, attach },
    audit: (input) => ({
      auditId: id(83),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CART_ATTACH_QUOTE",
      reasonCode: "AUTHORIZED_CART_QUOTE",
      targetType: "OrderingCart",
      targetId: input.cartReference,
      correlationId: id(84),
      occurredAt: input.observedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
  return {
    f,
    command,
    service,
    authorize,
    binding,
    participation,
    originalParticipation,
    pricing,
    catalog,
    attach,
  };
}
describe("configured credential-bound customer entry", () => {
  it.each([false, true])(
    "requires CSRF and preserves original history for Dining=%s",
    async (dining) => {
      const s = setup(dining);
      await expect(
        s.service.attach({ ...s.command, csrfCredential: "x".repeat(43) }),
      ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
      expect(s.pricing.quoteCart).not.toHaveBeenCalled();
      const first = await s.service.attach(s.command);
      expect(first.status).toBe("Attached");
      expect(await s.service.attach(s.command)).toEqual({
        status: "AlreadyAttached",
        attachment: first.attachment,
      });
      expect(s.pricing.quoteCart).toHaveBeenCalledOnce();
      expect(s.attach).toHaveBeenCalledOnce();
      for (const call of s.authorize.mock.calls)
        expect(Object.keys(call[0]).sort()).toEqual([
          "csrfCredential",
          "observedAt",
          "sessionCredential",
        ]);
      const downstream = JSON.stringify(
        [s.pricing.quoteCart.mock.calls, s.catalog.capture.mock.calls, s.attach.mock.calls],
        (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      );
      expect(downstream).not.toContain(s.command.sessionCredential);
      expect(downstream).not.toContain(s.command.csrfCredential);
    },
  );
  it("rejects a replaced current Pickup binding after Pricing", async () => {
    const s = setup();
    s.pricing.quoteCart.mockImplementationOnce(async () => {
      s.binding.current.mockResolvedValue(
        parseCartAggregate({
          ...s.f.cart,
          cartReference: id(99),
          items: s.f.cart.items.map((item) => ({ ...item, cartReference: id(99) })),
        }),
      );
      return s.f.quote;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({ code: "CART_UNAVAILABLE" });
    expect(s.attach).not.toHaveBeenCalled();
  });
  it.each(["tableAssignmentVersion", "diningSessionVersion", "participantVersion"] as const)(
    "rejects changed Dining %s across Pricing",
    async (field) => {
      const s = setup(true);
      s.pricing.quoteCart.mockImplementationOnce(async () => {
        s.participation.resolve.mockResolvedValue({ ...s.originalParticipation, [field]: 2 });
        return s.f.quote;
      });
      await expect(s.service.attach(s.command)).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(s.attach).not.toHaveBeenCalled();
    },
  );
  it("denies absent current Dining participation before reading Pricing", async () => {
    const s = setup(true);
    s.participation.resolve.mockResolvedValue(null);
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.pricing.quoteCart).not.toHaveBeenCalled();
  });
  it.each([false, true])("denies revoked historical disclosure for Dining=%s", async (dining) => {
    const s = setup(dining);
    await s.service.attach(s.command);
    s.authorize.mockRejectedValue(new Error("synthetic revoked"));
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.pricing.quoteCart).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
  });
});
