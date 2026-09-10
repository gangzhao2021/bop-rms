import { createHash } from "node:crypto";
import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import { createDiningCartItemService } from "../application/dining-cart-item-service.js";
import type {
  CartItemOperationAction,
  CartItemOperationRecord,
} from "../application/ports/cart-item-command-ports.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}
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
    publicTableReference: id(60),
    channel: "DineIn",
    locale: "en-CA" as never,
    qrReference: ids.qr,
    qrRevocationVersion: 1,
    diningState: "DiningBound",
    diningSessionReference: ids.diningSession,
    diningParticipantReference: ids.participant,
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
    orderType: "DineIn",
    sourceChannel: "Qr",
    diningSessionReference: ids.diningSession,
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
  sellableReference: ids.sellable,
  quantity: 2,
  optionSelections: [],
  customerNote: null,
  operationReference: ids.operation,
  expectedAggregateVersion: 1,
};
function setup() {
  let current = cart();
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
  const now = vi.fn(() => requestedAt);
  const participation = vi.fn(
    async () =>
      ({
        schemaVersion: 1,
        brandReference: ids.brand,
        storeReference: ids.store,
        diningSessionReference: ids.diningSession,
        participantReference: ids.participant,
        tableReference: id(61),
        tableAssignmentVersion: 1,
        diningSessionVersion: 1,
        participantVersion: 1,
        observedAt: now(),
      }) as unknown,
  );
  const historyRead = vi.fn(async (ref: string) => history.get(ref) ?? null);
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
  const metadata = vi.fn((value: { action: CartItemOperationAction; observedAt: string }) =>
    audit(value.action, value.observedAt),
  );
  const generate = vi.fn(() => ids.item);
  const catalog = vi.fn(
    async (
      value: Parameters<
        import("../application/ports/cart-item-command-ports.js").CartItemCommandPorts["catalog"]["validateSelection"]
      >[0],
    ) => ({
      ...value,
      status: "Accepted" as const,
      menuVersionReference: ids.menuVersion as never,
      productVersionReference: ids.productVersion as never,
      catalogChannelCode: "PILOT_CHANNEL" as const,
      catalogOrderTypeCode: "PILOT_ORDER_TYPE" as const,
      ruleEvidence: [],
      validatedAt: value.observedAt,
    }),
  );
  const service = createDiningCartItemService({
    scope: { brandReference: ids.brand, storeReference: ids.store },
    sessions: { authorize },
    participation: { resolve: participation },
    repository: (scope) => {
      expect(scope).toEqual({
        brandReference: ids.brand,
        storeReference: ids.store,
        diningSessionReference: ids.diningSession,
        guestSessionReference: ids.session,
        cartReference: ids.cart,
      });
      return { load, commit, resolveOperation: historyRead };
    },
    catalog: { validateSelection: catalog },
    references: {
      generate,
      hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
    },
    audit: metadata,
    now,
  });
  return {
    service,
    catalog,
    generate,
    authorize,
    participation,
    historyRead,
    load,
    commit,
    metadata,
    now,
    history,
    current: () => current,
  };
}

describe("current-authorized Dining item commands", () => {
  it("adds, updates and removes only the participant's item with immutable attribution", async () => {
    const f = setup();
    const added = await f.service.add(input);
    expect(added).toEqual({
      status: "Applied",
      cartReference: ids.cart,
      cartItemReference: ids.item,
      aggregateVersion: 2,
    });
    expect(f.current().items[0]).toMatchObject({
      addedByActorReference: ids.session,
      addedByParticipantReference: ids.participant,
    });
    const { sellableReference: _sellable, ...rest } = input;
    void _sellable;
    await f.service.update({
      ...rest,
      cartItemReference: ids.item,
      expectedAggregateVersion: 2,
      quantity: 3,
      operationReference: ids.secondOperation,
    });
    expect(f.current().items[0]).toMatchObject({
      quantity: 3,
      addedByActorReference: ids.session,
      addedByParticipantReference: ids.participant,
      addedAt: requestedAt,
    });
    await f.service.remove({
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
      cartReference: ids.cart,
      cartItemReference: ids.item,
      expectedAggregateVersion: 3,
      operationReference: ids.thirdOperation,
    });
    expect(f.current().items).toEqual([]);
    expect(f.history.size).toBe(3);
    expect(f.commit).toHaveBeenCalledTimes(3);
    for (const [request] of f.authorize.mock.calls)
      expect(request.csrfCredential).toBe(input.csrfCredential);
  });
  it("denies invalid CSRF before any Cart or historical access", async () => {
    const f = setup();
    await expect(f.service.add({ ...input, csrfCredential: "z".repeat(43) })).rejects.toMatchObject(
      { code: "CART_PERMISSION_DENIED" },
    );
    expect(f.load).not.toHaveBeenCalled();
    expect(f.historyRead).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("denies revoked participation before original-operation replay", async () => {
    const f = setup();
    await f.service.add(input);
    f.load.mockClear();
    f.historyRead.mockClear();
    f.participation.mockResolvedValue(null);
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.historyRead).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("rechecks authority after Cart load before history", async () => {
    const f = setup();
    f.load.mockImplementation(async () => {
      f.participation.mockResolvedValue(null);
      return f.current();
    });
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.historyRead).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("denies a membership version change during Catalog before commit", async () => {
    const f = setup();
    const catalog = required(f.catalog.getMockImplementation());
    f.catalog.mockImplementation(async (request) => {
      const result = await catalog(request);
      const receipt = (await f.participation()) as Record<string, unknown>;
      f.participation.mockResolvedValue({ ...receipt, participantVersion: 2 });
      return result;
    });
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.history.size).toBe(0);
  });
  it("withholds a committed result after revocation and recovers the original without duplicate effects", async () => {
    const f = setup();
    const member = await f.participation();
    const commit = required(f.commit.getMockImplementation());
    f.commit.mockImplementation(async (command) => {
      const saved = await commit(command);
      f.participation.mockResolvedValue(null);
      return saved;
    });
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.history.size).toBe(1);
    expect(f.current().aggregateVersion).toBe(2);
    f.participation.mockResolvedValue(member);
    expect(await f.service.add(input)).toMatchObject({
      status: "AlreadyApplied",
      aggregateVersion: 2,
    });
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(1);
  });
  it.each(["update", "remove"] as const)("denies foreign participant %s", async (action) => {
    const f = setup();
    await f.service.add(input);
    const foreign = parseCartAggregate({
      ...f.current(),
      items: f
        .current()
        .items.map((item) => ({ ...item, addedByParticipantReference: ids.otherParticipant })),
    });
    f.load.mockResolvedValue(foreign);
    const common = {
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
      cartReference: ids.cart,
      cartItemReference: ids.item,
      operationReference: ids.secondOperation,
      expectedAggregateVersion: 2,
    };
    await expect(
      f.service[action](
        action === "remove"
          ? common
          : { ...common, quantity: 3, optionSelections: [], customerNote: null },
      ),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("preserves expected-version conflicts", async () => {
    const f = setup();
    await expect(f.service.add({ ...input, expectedAggregateVersion: 2 })).rejects.toMatchObject({
      code: "CART_VERSION_CONFLICT",
    });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("captures mutable configuration before authorization awaits", async () => {
    const f = setup();
    const original = required(f.authorize.getMockImplementation());
    const mutable = {
      ...input,
      optionSelections: [{ optionReference: ids.option, quantity: 1 }],
      customerNote: "Synthetic note",
    };
    f.authorize.mockImplementation(async (request) => {
      mutable.quantity = 8;
      mutable.customerNote = "Changed";
      required(mutable.optionSelections[0]).quantity = 9;
      return original(request);
    });
    await f.service.add(mutable);
    expect(f.current().items[0]).toMatchObject({
      quantity: 2,
      customerNote: "Synthetic note",
      optionSelections: [{ optionReference: ids.option, quantity: 1 }],
    });
  });
  it("captures and freezes audit metadata before repository awaits", async () => {
    const f = setup();
    const mutable = { ...audit("Add") };
    f.metadata.mockReturnValue(mutable);
    const load = required(f.load.getMockImplementation());
    f.load.mockImplementation(async () => {
      mutable.reasonCode = "CHANGED";
      return load();
    });
    await f.service.add(input);
    const saved = f.commit.mock.calls[0]?.[0] as unknown as { audit: AppendAuditRecordInput };
    expect(saved.audit.reasonCode).toBe("AUTHORIZED_CART_MUTATION");
    expect(Object.isFrozen(saved.audit)).toBe(true);
    expect(Object.isFrozen(saved.audit.actor)).toBe(true);
  });
  it("rejects a foreign-session aggregate without historical reads", async () => {
    const f = setup();
    f.load.mockResolvedValue(cart({ diningSessionReference: id(90) as never }));
    await expect(f.service.add(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.historyRead).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("bounds raw dependency errors", async () => {
    const f = setup();
    f.load.mockRejectedValue(new Error("synthetic private detail"));
    const error = await f.service.add(input).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
  it("rejects Cart expiry during Catalog before a write", async () => {
    const f = setup();
    const catalog = required(f.catalog.getMockImplementation());
    f.catalog.mockImplementation(async (request) => {
      const selected = await catalog(request);
      f.now.mockReturnValue("2026-08-02T15:00:00.000Z");
      return selected;
    });
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_EXPIRED" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("allows original operation reconciliation after Cart expiry without another write", async () => {
    const f = setup();
    await f.service.add(input);
    f.now.mockReturnValue("2026-08-02T16:00:00.000Z");
    expect(await f.service.add(input)).toMatchObject({ status: "AlreadyApplied" });
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("retains one winner for concurrent edits of the same expected version", async () => {
    const f = setup();
    const results = await Promise.allSettled([
      f.service.add(input),
      f.service.add({ ...input, operationReference: ids.secondOperation }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CART_VERSION_CONFLICT" },
    });
    expect(f.history.size).toBe(1);
    expect(f.current().items).toHaveLength(1);
  });
  it.each([{ unexpected: true }, { quantity: 0 }, { optionSelections: [null] }])(
    "rejects malformed closed inputs before authority",
    async (extra) => {
      const f = setup();
      await expect(f.service.add({ ...input, ...extra })).rejects.toMatchObject({
        code: "CART_INPUT_INVALID",
      });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.load).not.toHaveBeenCalled();
    },
  );
  it("bounds malformed saved history and rejects foreign participant history", async () => {
    const f = setup();
    await f.service.add(input);
    const prior = required(f.history.get(ids.operation));
    f.history.set(ids.operation, {
      ...prior,
      result: {
        ...prior.result,
        items: prior.result.items.map((item) => ({
          ...item,
          addedByParticipantReference: ids.otherParticipant as never,
        })),
      },
    });
    await expect(f.service.add(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    f.history.set(ids.operation, { ...prior, expiresAt: "invalid" as never });
    await expect(f.service.add(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});
