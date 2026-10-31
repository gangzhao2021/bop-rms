import { createHash } from "node:crypto";
import { createGuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredCartQuoteService,
  type ConfiguredCartQuotePorts,
} from "../application/configured-cart-quote-service.js";
import type { CartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import { fixture, id } from "./configured-cart-quote.fixture.js";

function setup(dining = false) {
  const f = fixture(dining);
  const snapshot = f.catalogLines[0]?.snapshot;
  if (snapshot === undefined) throw new Error("synthetic Catalog fixture missing");
  let at: string = f.observedAt;
  let saved: CartQuoteAttachment<2> | null = null;
  let permitted = true;
  let cart = f.cart;
  let guest = createGuestSession({
    sessionReference: id(65),
    version: 1,
    status: "Active",
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    publicStoreReference: id(80),
    publicTableReference: dining ? id(81) : null,
    channel: dining ? "DineIn" : "Pickup",
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
  const authorize = vi.fn<ConfiguredCartQuotePorts["authorization"]["authorize"]>(async (input) =>
    permitted
      ? {
          guestSession: guest,
          audit: {
            auditId: id(83),
            brandId: f.cart.brandReference,
            storeId: f.cart.storeReference,
            actor: { type: "System" },
            actionCode: "ORDERING_CART_ATTACH_QUOTE",
            targetType: "OrderingCart",
            targetId: f.cart.cartReference,
            reasonCode: "AUTHORIZED_CART_QUOTE",
            correlationId: id(84),
            occurredAt: input.observedAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        }
      : null,
  );
  const quoteCart = vi.fn<ConfiguredCartQuotePorts["pricing"]["quoteCart"]>(async () => f.quote);
  const capture = vi.fn<ConfiguredCartQuotePorts["catalog"]["capture"]>(async () => ({
    ...snapshot,
    capturedAt: at,
  }));
  const loadCart = vi.fn(async () => cart);
  const resolveOperation = vi.fn(async () => saved);
  const persist: ConfiguredCartQuotePorts["repository"]["attach"] = async (input) => {
    saved = input.attachment;
    return saved;
  };
  const attach = vi.fn(persist);
  const service = createConfiguredCartQuoteService({
    authorization: { authorize },
    pricing: { quoteCart },
    catalog: { capture },
    references: {
      hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
    },
    repository: { loadCart, resolveOperation, attach },
    pricingChannelCode: f.pricingChannelCode,
    now: () => at,
  });
  const command = {
    cartReference: f.cart.cartReference,
    expectedCartVersion: f.cart.aggregateVersion,
    operationReference: id(90),
    requestedAt: f.observedAt,
  };
  return {
    f,
    snapshot,
    service,
    command,
    authorize,
    quoteCart,
    capture,
    loadCart,
    resolveOperation,
    attach,
    persist,
    advance: (value: string) => {
      at = value;
    },
    permit: (value: boolean) => {
      permitted = value;
    },
    replaceCart: (value: typeof cart) => {
      cart = value;
    },
    replaceGuest: (value: Record<string, unknown>) => {
      guest = createGuestSession({ ...guest, ...value });
    },
  };
}

describe("configured current-authorized Cart quote", () => {
  it.each([false, true])("attaches exact option pricing for Dining=%s", async (dining) => {
    const s = setup(dining);
    const result = await s.service.attach(s.command);
    expect(result).toMatchObject({
      status: "Attached",
      attachment: {
        quoteVersion: 2,
        total: s.f.quote.total,
        cartVersion: s.command.expectedCartVersion,
        guestSessionReference: id(65),
        attachedAt: s.f.observedAt,
      },
    });
    expect(s.quoteCart).toHaveBeenCalledWith(
      expect.objectContaining({
        orderType: dining ? "DineIn" : "Pickup",
        lines: [
          expect.objectContaining({
            optionSelections: [{ optionReference: id(63), quantity: 3 }],
          }),
        ],
      }),
      { operationReference: id(90), guestSessionReference: id(65) },
    );
    expect(s.capture).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
  });

  it("recovers original operation after Quote expiry without repricing or renewing retention", async () => {
    const s = setup();
    const first = await s.service.attach(s.command);
    s.advance(s.f.quote.expiresAt);
    expect(await s.service.attach(s.command)).toEqual({
      status: "AlreadyAttached",
      attachment: first.attachment,
    });
    expect(s.quoteCart).toHaveBeenCalledOnce();
    expect(s.capture).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
  });

  it.each(["Cart", "history", "Pricing", "Catalog"] as const)(
    "denies authority loss during %s",
    async (stage) => {
      const s = setup();
      if (stage === "Cart")
        s.loadCart.mockImplementationOnce(async () => {
          s.permit(false);
          return s.f.cart;
        });
      if (stage === "history")
        s.resolveOperation.mockImplementationOnce(async () => {
          s.permit(false);
          return null;
        });
      if (stage === "Pricing")
        s.quoteCart.mockImplementationOnce(async () => {
          s.permit(false);
          return s.f.quote;
        });
      if (stage === "Catalog")
        s.capture.mockImplementationOnce(async () => {
          s.permit(false);
          return s.snapshot;
        });
      await expect(s.service.attach(s.command)).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(s.attach).not.toHaveBeenCalled();
    },
  );

  it("refuses changed Guest version during Pricing", async () => {
    const s = setup();
    s.quoteCart.mockImplementationOnce(async () => {
      s.replaceGuest({ version: 2 });
      return s.f.quote;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.attach).not.toHaveBeenCalled();
  });

  it("refuses a foreign Dining session even when the cart creator matches", async () => {
    const s = setup(true);
    s.replaceGuest({ diningSessionReference: id(99) });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.quoteCart).not.toHaveBeenCalled();
  });

  it("rejects Cart edits during Catalog capture before persistence", async () => {
    const s = setup();
    s.capture.mockImplementationOnce(async () => {
      s.replaceCart({ ...s.f.cart, aggregateVersion: s.f.cart.aggregateVersion + 1 });
      return s.snapshot;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_VERSION_CONFLICT",
    });
    expect(s.attach).not.toHaveBeenCalled();
  });

  it("refuses a mismatched Catalog binding before persistence", async () => {
    const s = setup();
    const snapshot = s.snapshot;
    s.capture.mockResolvedValue({
      ...snapshot,
      options: snapshot.options.map((option) => ({ ...option, bindingReference: id(99) })),
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
    expect(s.attach).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-08-02T16:05:00.000Z", "CART_QUOTE_EXPIRED"],
    ["2026-08-02T17:00:00.000Z", "CART_EXPIRED"],
    ["2026-08-02T15:59:59.999Z", "CART_DEPENDENCY_UNAVAILABLE"],
  ])("rechecks clocks after Pricing at %s", async (at, code) => {
    const s = setup();
    s.quoteCart.mockImplementationOnce(async () => {
      if (at === undefined) throw new Error("synthetic clock missing");
      s.advance(at);
      return s.f.quote;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({ code });
    expect(s.attach).not.toHaveBeenCalled();
  });

  it.each(["lost acknowledgement", "post-write authorization loss"])(
    "recovers %s without duplicate effects",
    async (mode) => {
      const s = setup();
      s.attach.mockImplementationOnce(async (input) => {
        const saved = await s.persist(input);
        if (mode === "lost acknowledgement")
          throw new Error("synthetic lost commit acknowledgement");
        s.permit(false);
        return saved;
      });
      await expect(s.service.attach(s.command)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      s.permit(true);
      expect((await s.service.attach(s.command)).status).toBe("AlreadyAttached");
      expect(s.attach).toHaveBeenCalledOnce();
      expect(s.quoteCart).toHaveBeenCalledOnce();
    },
  );

  it("reauthorizes original history and rejects a different operation intent", async () => {
    const s = setup();
    const first = await s.service.attach(s.command);
    await expect(
      s.service.attach({ ...s.command, operationReference: id(91) }),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
    s.resolveOperation.mockImplementationOnce(async () => {
      s.permit(false);
      return first.attachment;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.attach).toHaveBeenCalledOnce();
  });

  it("refuses original history when Guest expires during replay authorization", async () => {
    const s = setup();
    const first = await s.service.attach(s.command);
    s.advance("2026-08-03T15:59:59.999Z");
    s.replaceGuest({
      lastSeenAt: "2026-08-03T15:00:00.000Z",
      idleExpiresAt: "2026-08-03T19:00:00.000Z",
    });
    const authorize = s.authorize.getMockImplementation();
    if (authorize === undefined) throw new Error("synthetic authority missing");
    s.authorize.mockImplementation(async (input) => {
      const result = await authorize(input);
      if (s.loadCart.mock.calls.length >= 5) s.advance(first.attachment.idempotencyExpiresAt);
      return result;
    });
    await expect(s.service.attach(s.command)).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(s.attach).toHaveBeenCalledOnce();
  });
});
