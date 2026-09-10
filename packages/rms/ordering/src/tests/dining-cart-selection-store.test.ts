import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDiningCartSelectionStore,
  type DiningCartSelectionStoreOptions,
} from "../infrastructure/persistence/dining-cart-selection-store.js";
import {
  decideInitialDiningCartSelection,
  parseDiningCartSelectionReceipt,
} from "../domain/dining-cart-selection.js";
import type { CartQueryTransactionRunner } from "../infrastructure/persistence/cart-query-store.js";

const id = (n: number) => `018f2316-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T12:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const scope = { brandReference: id(1), storeReference: id(2) };
const command = {
  ...scope,
  operationReference: id(10),
  diningSessionReference: id(3),
  guestSessionReference: id(4),
  participantReference: id(5),
  observedAt: at,
};
const policy = () => ({
  policyVersionReference: id(7),
  policyDigest: `sha256:${"a".repeat(64)}`,
  idleTimeoutSeconds: 3600,
  absoluteTimeoutSeconds: 7200,
  validFrom: at,
  validUntil: later(86400),
});
function receipt() {
  return {
    ...scope,
    operationReference: id(10),
    diningSessionReference: id(3),
    guestSessionReference: id(4),
    participantReference: id(5),
    action: "Create",
    cartReference: id(6),
    cartVersion: 1,
    occurredAt: at,
    expiresAt: later(86400),
  };
}
function cart() {
  return decideInitialDiningCartSelection({
    ...scope,
    diningSessionReference: id(3),
    guestSessionReference: id(4),
    participantReference: id(5),
    observedAt: at,
    history: [],
    creation: { cartReference: id(6), sourceChannel: "Qr", policy: policy() },
  }).cart;
}
type AuditDescriptor = Parameters<DiningCartSelectionStoreOptions["audit"]>[0];
function audit(d: AuditDescriptor) {
  return {
    auditId: id(20),
    brandId: d.brandReference,
    storeId: d.storeReference,
    actor: { type: "System" },
    actionCode: `ORDERING_DINING_CART_${d.action.toUpperCase()}`,
    targetType: "OrderingCart",
    targetId: d.cartReference,
    reasonCode: "AUTHORIZED_CART_SELECTION",
    correlationId: d.operationReference,
    occurredAt: d.occurredAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}
function fixture(
  settings: {
    prior?: unknown;
    headers?: unknown[];
    existing?: unknown;
    onQuery?: (sql: string, values: readonly unknown[]) => void | Promise<void>;
    changeAudit?: (value: ReturnType<typeof audit>) => unknown;
    policy?: ReturnType<typeof policy>;
  } = {},
) {
  let clock = at;
  let lastAudit: ReturnType<typeof audit> | null = null;
  const generateReference = vi.fn(() => id(6));
  const auditFactory = vi.fn((d: AuditDescriptor) => {
    lastAudit = audit(d);
    return settings.changeAudit ? settings.changeAudit(lastAudit) : lastAudit;
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    await settings.onQuery?.(sql, values);
    if (sql.includes("FROM rms_ordering.dining_cart_operation"))
      return { rows: settings.prior === undefined ? [] : [{ receipt: settings.prior }] };
    if (sql.includes("LIMIT 2 FOR SHARE")) return { rows: settings.headers ?? [] };
    if (sql.startsWith("SELECT jsonb_build_object("))
      return { rows: [{ cart: settings.existing ?? cart() }] };
    if (sql.startsWith("INSERT INTO rms_ordering.cart\n"))
      return { rows: [{ cart_id: values[0] }] };
    if (sql.startsWith("INSERT INTO rms_ordering.dining_cart_operation"))
      return { rows: [{ operation_id: values[2] }] };
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: at }] };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "2" }] };
    return { rows: [] };
  });
  const entered = vi.fn();
  const runner: CartQueryTransactionRunner = {
    async run(action) {
      entered();
      return action({ query });
    },
  };
  const options = {
    scope: { ...scope },
    sourceChannel: "Qr" as const,
    policy: settings.policy ?? policy(),
    generateReference,
    now: () => clock,
    audit: auditFactory,
  };
  const store = createPostgresDiningCartSelectionStore(runner, options);
  return {
    store,
    query,
    entered,
    options,
    generateReference,
    auditFactory,
    setClock: (value: string) => {
      clock = value;
    },
    lastAudit: () => lastAudit,
  };
}
const writes = (f: ReturnType<typeof fixture>) =>
  f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO rms_ordering"));

describe("atomic initial Dining Cart owner adapter", () => {
  it("creates Cart, minimal receipt and public Audit inside one ordered owner transaction", async () => {
    const f = fixture();
    expect(await f.store.select(command)).toEqual(receipt());
    expect(f.entered).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([
      [id(1), id(2)],
      [`ordering.dining-cart.operation:${id(1)}:${id(2)}:${id(10)}`],
      [`ordering.dining-cart.session:${id(1)}:${id(2)}:${id(3)}`],
    ]);
    expect(writes(f)).toHaveLength(2);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith("INSERT INTO platform_audit.audit_record"),
      )?.[1],
    ).toContain("ORDERING_DINING_CART_CREATE");
    expect(f.generateReference).toHaveBeenCalledTimes(1);
    expect(f.auditFactory).toHaveBeenCalledTimes(1);
  });
  it("selects another Participant's existing Cart unchanged and without generating or writing a Cart", async () => {
    const existing = { ...cart(), aggregateVersion: 4 };
    const f = fixture({ headers: [{ cartReference: id(6), cartVersion: 4 }], existing });
    expect(
      await f.store.select({
        ...command,
        guestSessionReference: id(11),
        participantReference: id(12),
      }),
    ).toMatchObject({
      action: "Select",
      cartReference: id(6),
      cartVersion: 4,
      guestSessionReference: id(11),
      participantReference: id(12),
    });
    expect(f.generateReference).not.toHaveBeenCalled();
    expect(writes(f)).toHaveLength(1);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE rms_ordering"))).toBe(false);
    expect(existing.createdByActorReference).toBe(id(4));
  });
  it("recovers the original historical receipt after Cart/policy expiry without another effect", async () => {
    const f = fixture({ prior: receipt(), policy: { ...policy(), validUntil: later(60) } });
    f.setClock(later(8000));
    const result = await f.store.select({ ...command, observedAt: later(8000) });
    expect(result).toEqual(receipt());
    expect(Object.isFrozen(result)).toBe(true);
    expect(writes(f)).toHaveLength(0);
    expect(f.generateReference).not.toHaveBeenCalled();
    expect(f.auditFactory).not.toHaveBeenCalled();
    expect(f.query.mock.calls).toHaveLength(4);
  });
  it.each([
    "operationReference",
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "guestSessionReference",
    "participantReference",
  ])("rejects changed original %s", async (key) => {
    const f = fixture({ prior: { ...receipt(), [key]: id(99) } });
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
    expect(writes(f)).toHaveLength(0);
  });
  it("rejects exact 24-hour operation expiry", async () => {
    const f = fixture({ prior: receipt() });
    f.setClock(later(86400));
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });
  it.each([{ cartVersion: 2 }, { action: "Other" }, { expiresAt: later(1) }, { extra: true }])(
    "rejects malformed original receipt",
    async (change) => {
      const f = fixture({ prior: { ...receipt(), ...change } });
      await expect(f.store.select(command)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each([
    {
      headers: [
        { cartReference: id(6), cartVersion: 1 },
        { cartReference: id(8), cartVersion: 1 },
      ],
    },
    { headers: [{ cartReference: id(6), cartVersion: 2 }], existing: cart() },
    {
      headers: [{ cartReference: id(6), cartVersion: 1 }],
      existing: { ...cart(), storeReference: id(99) },
    },
  ])("denies ambiguous or substituted owner history", async (settings) => {
    const f = fixture(settings);
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(writes(f)).toHaveLength(0);
  });
  it.each(["Expired", "Abandoned", "Legacy"])("does not replace %s history", async (kind) => {
    const c = cart();
    const lifecycle =
      kind === "Legacy"
        ? null
        : kind === "Abandoned"
          ? {
              ...c.lifecycle,
              status: "Abandoned",
              terminalAt: at,
              terminalReason: "CUSTOMER_ABANDONED",
            }
          : c.lifecycle;
    const f = fixture({
      headers: [{ cartReference: id(6), cartVersion: 1 }],
      existing: { ...c, lifecycle },
    });
    if (kind === "Expired") f.setClock(later(3600));
    await expect(f.store.select(command)).rejects.toMatchObject({
      code:
        kind === "Legacy"
          ? "CART_LIFECYCLE_UNAVAILABLE"
          : kind === "Expired"
            ? "CART_EXPIRED"
            : "CART_ABANDONED",
    });
    expect(writes(f)).toHaveLength(0);
  });
  it.each([
    null,
    { ...command, extra: true },
    { ...command, storeReference: id(99) },
    { ...command, participantReference: "invalid" },
  ])("rejects malformed command before entering SQL", async (value) => {
    const f = fixture();
    await expect(f.store.select(value as never)).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(f.entered).not.toHaveBeenCalled();
  });
  it.each([
    { targetId: id(99) },
    { correlationId: id(99) },
    { actionCode: "WRONG" },
    { beforeSummary: {} },
    { correctsAuditId: id(99) },
    { actor: { type: "User", reference: id(99) } },
  ])("denies invalid Audit before owner writes", async (change) => {
    const f = fixture({ changeAudit: (value) => ({ ...value, ...change }) });
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(writes(f)).toHaveLength(0);
  });
  it("captures command and options before the first await", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      onQuery: async (sql) => {
        if (sql.startsWith("SELECT set_config")) await gate;
      },
    });
    const value = { ...command };
    const pending = f.store.select(value);
    value.guestSessionReference = id(99);
    value.operationReference = id(99);
    f.options.scope.storeReference = id(99);
    f.options.policy.idleTimeoutSeconds = 1;
    f.options.generateReference = vi.fn(() => id(99));
    if (!release) throw new Error("synthetic gate missing");
    release();
    expect(await pending).toEqual(receipt());
    expect(writes(f)[0]?.[1]).toContain(3600);
  });
  it("freezes captured Audit fields across later SQL awaits", async () => {
    const f = fixture({
      onQuery: (sql) => {
        if (!sql.startsWith("INSERT INTO rms_ordering.cart\n")) return;
        const value = f.lastAudit();
        if (!value) throw new Error("synthetic Audit missing");
        value.targetId = id(99);
        value.actor.type = "Service";
        value.retentionPolicyCode = "OTHER";
      },
    });
    await f.store.select(command);
    const values = f.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO platform_audit.audit_record"),
    )?.[1];
    expect(values?.[3]).toBe("System");
    expect(values?.[7]).toBe(id(6));
    expect(values?.[16]).toBe("AUDIT_DEFAULT");
  });
  it("rejects accessor Audit without invoking it", async () => {
    const getter = vi.fn(() => id(20));
    const f = fixture({
      changeAudit: (value) => {
        Object.defineProperty(value, "auditId", { get: getter });
        return value;
      },
    });
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(writes(f)).toHaveLength(0);
  });
  it("rechecks policy after the Audit callback", async () => {
    const f = fixture({
      policy: { ...policy(), validUntil: later(1) },
      changeAudit: (value) => {
        f.setClock(later(1));
        return value;
      },
    });
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_LIFECYCLE_UNAVAILABLE",
    });
    expect(writes(f)).toHaveLength(0);
  });
  it("bounds driver failure and leaves rollback to its one transaction runner", async () => {
    const f = fixture({
      onQuery: (sql) => {
        if (sql.startsWith("UPDATE platform_audit"))
          throw new Error("synthetic restricted driver detail");
      },
    });
    const error = await f.store.select(command).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
  it("rejects backward clocks before a transaction", async () => {
    const f = fixture();
    f.setClock(later(-1));
    await expect(f.store.select(command)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.entered).not.toHaveBeenCalled();
  });
});

describe("minimal Dining Cart selection receipts", () => {
  it("captures a closed frozen historical receipt", () => {
    const input = receipt();
    const parsed = parseDiningCartSelectionReceipt(input);
    input.cartReference = id(99);
    expect(parsed.cartReference).toBe(id(6));
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    { cartVersion: 0 },
    { cartVersion: 2 },
    { cartVersion: 2_147_483_648 },
    { cartVersion: 1.1 },
    { expiresAt: later(86399) },
    { participantReference: "invalid" },
    { extra: true },
  ])("rejects noncanonical receipt", (change) => {
    expect(() => parseDiningCartSelectionReceipt({ ...receipt(), ...change })).toThrowError(
      expect.objectContaining({ code: "CART_INPUT_INVALID" }),
    );
  });
});
