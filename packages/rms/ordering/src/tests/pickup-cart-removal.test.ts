import { createHash } from "node:crypto";
import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import { createPickupCartRemovalService } from "../application/pickup-cart-removal-service.js";
import type {
  CartItemOperationAction,
  CartItemOperationRecord,
} from "../application/ports/cart-item-command-ports.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";
const id = (n: number) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  sellable: id(7),
  option: id(8),
  item: id(9),
  operation: id(10),
  secondOperation: id(11),
  thirdOperation: id(12),
  audit: id(13),
  correlation: id(14),
  diningSession: id(15),
  participant: id(16),
  otherParticipant: id(17),
  otherSession: id(18),
  menuVersion: id(19),
  productVersion: id(20),
  binding: id(21),
  optionSetVersion: id(22),
};
const createdAt = "2026-08-02T14:00:00.000Z";
const requestedAt = "2026-08-02T14:01:00.000Z";

function guest(overrides: Partial<GuestSession> = {}): GuestSession {
  return {
    sessionReference: ids.session,
    status: "Active",
    version: 1,
    brandReference: ids.brand,
    storeReference: ids.store,
    publicStoreReference: ids.publicStore,
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: ids.qr,
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-02T13:00:00.000Z" as never,
    lastSeenAt: createdAt as never,
    idleExpiresAt: "2026-08-02T18:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-03T13:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  } as GuestSession;
}

function cart(overrides: Partial<CartAggregate> = {}): CartAggregate {
  return parseCartAggregate({
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: ids.session,
    aggregateVersion: 1,
    createdAt,
    updatedAt: createdAt,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [],
    ...overrides,
  });
}

function audit(action: CartItemOperationAction, at = requestedAt): AppendAuditRecordInput {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    storeId: ids.store,
    actor: { type: "System" },
    actionCode: `ORDERING_CART_ITEM_${action.toUpperCase()}`,
    targetType: "OrderingCart",
    targetId: ids.cart,
    reasonCode: "AUTHORIZED_CART_MUTATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}

const input = {
  sessionCredential: "a".repeat(43),
  csrfCredential: "b".repeat(43),
  cartReference: ids.cart,
  cartItemReference: ids.item,
  operationReference: ids.operation,
  expectedAggregateVersion: 1,
};
function setup() {
  let current = cart({
    items: [
      {
        cartItemReference: ids.item,
        cartReference: ids.cart,
        sellableReference: ids.sellable,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: null,
        addedByActorReference: ids.session,
        addedByParticipantReference: null,
        addedAt: createdAt,
      },
    ] as never,
  });
  const history = new Map<string, CartItemOperationRecord>();
  const authorize = vi.fn(
    async (value: { sessionCredential: unknown; csrfCredential: unknown }) => {
      if (
        value.sessionCredential !== input.sessionCredential ||
        value.csrfCredential !== input.csrfCredential
      )
        throw new Error("synthetic denial");
      return guest();
    },
  );
  const binding = vi.fn(async (): Promise<CartAggregate | null> => current);
  const load = vi.fn(async () => current);
  const commit = vi.fn(
    async (value: { record: CartItemOperationRecord; expectedAggregateVersion: number }) => {
      if (value.expectedAggregateVersion !== current.aggregateVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      current = value.record.result;
      history.set(value.record.operationReference, value.record);
      return value.record;
    },
  );
  const metadata = vi.fn((value: { observedAt: string }) => audit("Remove", value.observedAt));
  const now = vi.fn(() => requestedAt);
  const service = createPickupCartRemovalService({
    scope: { brandReference: ids.brand, storeReference: ids.store },
    sessions: { authorize },
    binding: { current: binding },
    repository: { load, commit, resolveOperation: async (ref) => history.get(ref) ?? null },
    references: {
      hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
    },
    audit: metadata,
    now,
  });
  return {
    service,
    authorize,
    binding,
    load,
    commit,
    metadata,
    now,
    history,
    current: () => current,
  };
}
describe("authorized Pickup removal", () => {
  it("reauthorizes every retry and retains one removal/history with a minimal receipt", async () => {
    const f = setup();
    const first = await f.service.remove(input);
    expect(first).toEqual({
      status: "Applied",
      cartReference: ids.cart,
      cartItemReference: ids.item,
      aggregateVersion: 2,
    });
    f.now.mockReturnValue("2026-08-02T14:02:00.000Z");
    expect(await f.service.remove(input)).toEqual({ ...first, status: "AlreadyApplied" });
    expect(f.authorize).toHaveBeenCalledTimes(4);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.history.size).toBe(1);
    expect(f.current().items).toEqual([]);
  });
  it.each([
    null,
    { ...input, requestedAt },
    { ...input, expectedAggregateVersion: 0 },
    { ...input, expectedAggregateVersion: 1.2 },
    { ...input, csrfCredential: "bad" },
    Object.defineProperty({ ...input }, "cartReference", {
      get() {
        throw new Error("must not evaluate");
      },
    }),
  ])("rejects malformed input before effects", async (value) => {
    const f = setup();
    await expect(f.service.remove(value)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("denies wrong CSRF before binding and arbitrary Cart loading", async () => {
    const f = setup();
    await expect(
      f.service.remove({ ...input, csrfCredential: "c".repeat(43) }),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.binding).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });
  it.each([{ storeReference: id(90) }, { channel: "DineIn" }, { idleExpiresAt: createdAt }])(
    "denies invalid current Session",
    async (value) => {
      const f = setup();
      f.authorize.mockResolvedValue(guest(value as never));
      await expect(f.service.remove(input)).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.binding).not.toHaveBeenCalled();
    },
  );
  it.each(["revoke", "qr", "session"])(
    "denies intervening %s change before mutation",
    async (mode) => {
      const f = setup();
      f.authorize.mockResolvedValueOnce(guest());
      if (mode === "revoke") f.authorize.mockRejectedValueOnce(new Error("synthetic revocation"));
      else
        f.authorize.mockResolvedValueOnce(
          guest(mode === "qr" ? { qrRevocationVersion: 2 } : { sessionReference: id(90) as never }),
        );
      await expect(f.service.remove(input)).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.load).not.toHaveBeenCalled();
      expect(f.metadata).not.toHaveBeenCalled();
    },
  );
  it("hides foreign Cart before lookup or Audit", async () => {
    const f = setup();
    await expect(f.service.remove({ ...input, cartReference: id(90) })).rejects.toMatchObject({
      code: "CART_UNAVAILABLE",
    });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.metadata).not.toHaveBeenCalled();
  });
  it("bounds inconsistent binding evidence", async () => {
    const f = setup();
    f.binding.mockResolvedValue(cart({ createdByActorReference: id(90) as never }));
    await expect(f.service.remove(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.load).not.toHaveBeenCalled();
  });
  it("uses fresh server time after binding lookup for expiry", async () => {
    const f = setup();
    f.now.mockReturnValueOnce(requestedAt).mockReturnValue("2026-08-02T15:01:00.000Z");
    await expect(f.service.remove(input)).rejects.toMatchObject({ code: "CART_EXPIRED" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("rejects backward clock before mutation", async () => {
    const f = setup();
    f.now.mockReturnValueOnce(requestedAt).mockReturnValue(createdAt);
    await expect(f.service.remove(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("retains version and own-item guards", async () => {
    const f = setup();
    await expect(f.service.remove({ ...input, expectedAggregateVersion: 2 })).rejects.toMatchObject(
      { code: "CART_VERSION_CONFLICT" },
    );
    f.load.mockResolvedValue(
      cart({ items: [{ ...f.current().items[0], addedByActorReference: id(90) }] as never }),
    );
    await expect(f.service.remove(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("does not write when Audit evidence is unavailable", async () => {
    const f = setup();
    f.metadata.mockImplementation(() => {
      throw new Error("synthetic metadata unavailable");
    });
    await expect(f.service.remove(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.commit).not.toHaveBeenCalled();
  });
});
