import { createHash } from "node:crypto";
import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import { createPickupCartItemService } from "../application/pickup-cart-item-service.js";
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

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing synthetic fixture");
  return value;
}

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
  const metadata = vi.fn((value: { action: "Add" | "Update"; observedAt: string }) =>
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
  const now = vi.fn(() => requestedAt);
  const service = createPickupCartItemService({
    scope: { brandReference: ids.brand, storeReference: ids.store },
    sessions: { authorize },
    binding: { current: binding },
    repository: { load, commit, resolveOperation: async (ref) => history.get(ref) ?? null },
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
    binding,
    load,
    commit,
    metadata,
    now,
    history,
    current: () => current,
  };
}

const update = {
  sessionCredential: input.sessionCredential,
  csrfCredential: input.csrfCredential,
  cartReference: ids.cart,
  cartItemReference: ids.item,
  operationReference: ids.secondOperation,
  expectedAggregateVersion: 2,
  quantity: 3,
  optionSelections: [],
  customerNote: null,
};
describe("authorized Pickup item writes", () => {
  it("adds and updates once while replaying original receipts after advancement", async () => {
    const f = setup();
    const first = await f.service.add(input);
    expect(first).toEqual({
      status: "Applied",
      cartReference: ids.cart,
      cartItemReference: ids.item,
      aggregateVersion: 2,
    });
    expect(await f.service.update(update)).toMatchObject({
      status: "Applied",
      aggregateVersion: 3,
    });
    expect(await f.service.add(input)).toEqual({ ...first, status: "AlreadyApplied" });
    expect(await f.service.update(update)).toMatchObject({
      status: "AlreadyApplied",
      aggregateVersion: 3,
    });
    expect(f.current().items[0]?.quantity).toBe(3);
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect(f.history.size).toBe(2);
    expect(
      f.authorize.mock.calls.every(([value]) => value.csrfCredential === input.csrfCredential),
    ).toBe(true);
    expect(f.metadata.mock.calls.map(([v]) => v.action)).toEqual([
      "Add",
      "Update",
      "Add",
      "Update",
    ]);
  });
  it("rejects changed replay intent without revalidating Catalog", async () => {
    const f = setup();
    await f.service.add(input);
    await expect(f.service.add({ ...input, quantity: 4 })).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
    expect(f.catalog).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledOnce();
  });
  it.each(["sessionCredential", "csrfCredential"])(
    "denies incorrect %s before reads",
    async (key) => {
      const f = setup();
      await expect(f.service.add({ ...input, [key]: "c".repeat(43) })).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.binding).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
  it.each([
    { brandReference: ids.item },
    { storeReference: ids.item },
    { channel: "DineIn" },
    { sessionReference: ids.otherSession },
    { publicStoreReference: ids.item },
    { qrReference: ids.item },
    { qrRevocationVersion: 2 },
  ])("denies session drift %j", async (drift) => {
    const f = setup();
    f.authorize.mockResolvedValueOnce(guest()).mockResolvedValueOnce(guest(drift as never));
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("reauthorizes after binding lookup", async () => {
    const f = setup();
    f.authorize.mockResolvedValueOnce(guest()).mockRejectedValueOnce(new Error());
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.load).not.toHaveBeenCalled();
  });
  it.each([null, cart({ cartReference: ids.item as never })])(
    "requires the exact current binding",
    async (bound) => {
      const f = setup();
      f.binding.mockResolvedValue(bound);
      await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_UNAVAILABLE" });
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );
  it("rejects backwards server time", async () => {
    const f = setup();
    f.now.mockReturnValueOnce(requestedAt).mockReturnValueOnce(createdAt);
    await expect(f.service.add(input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it.each([{}, { createdByActorReference: ids.otherSession }, { aggregateVersion: 0 }])(
    "redacts malformed or foreign loaded state",
    async (change) => {
      const f = setup();
      f.load.mockResolvedValue(
        (Object.keys(change).length ? { ...cart(), ...change } : {}) as never,
      );
      await expect(f.service.add(input)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
  it("rejects stale versions before Catalog and allocation", async () => {
    const f = setup();
    await expect(f.service.add({ ...input, expectedAggregateVersion: 2 })).rejects.toMatchObject({
      code: "CART_VERSION_CONFLICT",
    });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("requires explicit Catalog acceptance", async () => {
    const f = setup();
    f.catalog.mockResolvedValue({ status: "Rejected", reason: "OPTION_NOT_ENABLED" } as never);
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_SELECTION_INVALID" });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("rejects an elapsed lifecycle before Catalog", async () => {
    const f = setup();
    f.now.mockReturnValue("2026-08-02T15:01:00.000Z");
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_EXPIRED" });
    expect(f.catalog).not.toHaveBeenCalled();
  });
  it.each([
    { extra: true },
    { quantity: 0 },
    { optionSelections: new Array(1) },
    {
      optionSelections: [
        { optionReference: ids.option, quantity: 1 },
        { optionReference: ids.option, quantity: 1 },
      ],
    },
  ])("closes malformed input %j before I/O", async (change) => {
    const f = setup();
    await expect(f.service.add({ ...input, ...change })).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("never evaluates input accessors", async () => {
    const f = setup();
    const getter = vi.fn(() => 2);
    const value = { ...input };
    Object.defineProperty(value, "quantity", { enumerable: true, get: getter });
    await expect(f.service.add(value)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("owns selected option values before awaiting authorization", async () => {
    const f = setup();
    const value = { ...input, optionSelections: [{ optionReference: ids.option, quantity: 1 }] };
    const pending = f.service.add(value);
    value.quantity = 9;
    const selected = value.optionSelections[0];
    if (selected === undefined) throw new Error("missing synthetic selection");
    selected.quantity = 8;
    await pending;
    expect(f.current().items[0]).toMatchObject({
      quantity: 2,
      optionSelections: [{ optionReference: ids.option, quantity: 1 }],
    });
  });
  it("isolates concurrent denied and authorized request credentials", async () => {
    const f = setup();
    const results = await Promise.allSettled([
      f.service.add(input),
      f.service.add({
        ...input,
        csrfCredential: "c".repeat(43),
        operationReference: ids.thirdOperation,
      }),
    ]);
    expect(results.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.history.has(ids.thirdOperation)).toBe(false);
  });
  it("rechecks authority immediately before persistence after item allocation", async () => {
    const f = setup();
    f.generate.mockImplementationOnce(() => {
      f.authorize.mockRejectedValue(new Error("synthetic denial"));
      return ids.item;
    });
    await expect(f.service.add(input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(f.catalog).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.history.size).toBe(0);
  });

  describe.each(["Add", "Update"] as const)("%s await boundaries", (action) => {
    async function fixture() {
      const f = setup();
      if (action === "Update") await f.service.add(input);
      f.commit.mockClear();
      f.catalog.mockClear();
      return {
        ...f,
        run: () => (action === "Add" ? f.service.add(input) : f.service.update(update)),
      };
    }
    it.each(["revoke", "version", "expiry", "backwards", "invalid"])(
      "denies %s after Catalog waits without writing",
      async (change) => {
        const f = await fixture();
        const validate = required(f.catalog.getMockImplementation());
        f.catalog.mockImplementationOnce(async (selection) => {
          const result = await validate(selection);
          if (change === "revoke") f.authorize.mockRejectedValue(new Error("synthetic denial"));
          if (change === "version") f.authorize.mockResolvedValue(guest({ version: 2 }));
          if (change === "expiry") f.now.mockReturnValue("2026-08-02T18:00:00.000Z");
          if (change === "backwards") f.now.mockReturnValue(createdAt);
          if (change === "invalid") f.now.mockReturnValue("invalid");
          return result;
        });
        await expect(f.run()).rejects.toMatchObject({
          code: ["backwards", "invalid"].includes(change)
            ? "CART_DEPENDENCY_UNAVAILABLE"
            : "CART_PERMISSION_DENIED",
        });
        expect(f.commit).not.toHaveBeenCalled();
      },
    );
    it.each([-1, 0, 1])("checks original Cart expiry at offset %i", async (offset) => {
      const f = await fixture();
      const expiry = Date.parse(required(f.current().lifecycle).idleExpiresAt);
      const validate = required(f.catalog.getMockImplementation());
      f.catalog.mockImplementationOnce(async (selection) => {
        const result = await validate(selection);
        f.now.mockReturnValue(new Date(expiry + offset).toISOString());
        return result;
      });
      if (offset < 0) {
        await expect(f.run()).resolves.toMatchObject({ status: "Applied" });
        expect(f.commit).toHaveBeenCalledOnce();
      } else {
        await expect(f.run()).rejects.toMatchObject({ code: "CART_EXPIRED" });
        expect(f.commit).not.toHaveBeenCalled();
      }
    });
    it("denies expiry during the authorization await", async () => {
      const f = await fixture();
      const validate = required(f.catalog.getMockImplementation());
      f.catalog.mockImplementationOnce(async (selection) => {
        const result = await validate(selection);
        f.authorize.mockImplementation(async () => {
          f.now.mockReturnValue("2026-08-02T18:00:00.000Z");
          return guest();
        });
        return result;
      });
      await expect(f.run()).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
      expect(f.commit).not.toHaveBeenCalled();
    });
    it("denies after commit and recovers the original result without another write", async () => {
      const f = await fixture();
      const persist = required(f.commit.getMockImplementation());
      f.commit.mockImplementationOnce(async (command) => {
        const saved = await persist(command);
        f.authorize.mockRejectedValue(new Error("synthetic denial"));
        return saved;
      });
      await expect(f.run()).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
      f.authorize.mockResolvedValue(guest());
      f.now.mockReturnValue("2026-08-02T16:00:00.000Z");
      await expect(f.run()).resolves.toMatchObject({ status: "AlreadyApplied" });
      expect(f.commit).toHaveBeenCalledOnce();
      expect(f.catalog).toHaveBeenCalledOnce();
    });
    it("denies result disclosure when history lookup revokes current authority", async () => {
      const f = await fixture();
      await f.run();
      const lookup = f.history.get.bind(f.history);
      vi.spyOn(f.history, "get").mockImplementation((key) => {
        f.authorize.mockRejectedValue(new Error("synthetic denial"));
        return lookup(key);
      });
      await expect(f.run()).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
      expect(f.commit).toHaveBeenCalledOnce();
      expect(f.catalog).toHaveBeenCalledOnce();
    });
    it("checks lifecycle after the owner load before Catalog", async () => {
      const f = await fixture();
      f.load.mockImplementationOnce(async () => {
        const loaded = f.current();
        f.now.mockReturnValue(required(loaded.lifecycle).idleExpiresAt);
        return loaded;
      });
      await expect(f.run()).rejects.toMatchObject({ code: "CART_EXPIRED" });
      expect(f.catalog).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();
    });
  });
});
