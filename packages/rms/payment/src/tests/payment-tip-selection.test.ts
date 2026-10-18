import {
  createPaymentTipSelectionService,
  type PaymentTipSelectionPorts,
} from "../application/payment-tip-selection-service.js";
import type { PaymentTipSelection } from "../application/payment-tip-selection.js";
import { describe, it, expect } from "vitest";
import {
  parsePaymentTipSelection,
  samePaymentTipSelection,
} from "../application/payment-tip-selection.js";
import { createPostgresPaymentTipSelectionStore } from "../infrastructure/persistence/payment-tip-selection-store.js";
const id = (n: number) => "01902402-0000-7000-8000-" + n.toString().padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
const record = () => ({
  selectionReference: id(1),
  paymentOperationReference: id(2),
  submissionReference: id(3),
  cartReference: id(4),
  cartVersion: 1,
  quoteReference: id(5),
  guestSessionReference: id(6),
  brandReference: id(7),
  storeReference: id(8),
  tip: { amountMinor: 125n, currencyCode: "CAD" },
  selectedAt: at,
});
describe("explicit immutable Payment tip selection", () => {
  it("preserves exact minor units including explicit zero", () => {
    expect(parsePaymentTipSelection(record()).tip.amountMinor).toBe(125n);
    expect(
      parsePaymentTipSelection({ ...record(), tip: { amountMinor: 0n, currencyCode: "CAD" } }).tip
        .amountMinor,
    ).toBe(0n);
    const input = record(),
      parsed = parsePaymentTipSelection(input);
    input.tip.amountMinor = 999n;
    expect(parsed.tip.amountMinor).toBe(125n);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    null,
    undefined,
    { amountMinor: -1n, currencyCode: "CAD" },
    { amountMinor: 1.25, currencyCode: "CAD" },
    { amountMinor: 1n, currencyCode: "USD" },
    { amountMinor: 9223372036854775808n, currencyCode: "CAD" },
  ])("rejects unavailable or invalid money %s", (tip) => {
    expect(() => parsePaymentTipSelection({ ...record(), tip })).toThrow();
  });
  it("does not equate changed payer, quote, operation or selection time", () => {
    const original = parsePaymentTipSelection(record());
    for (const changed of [
      { guestSessionReference: id(9) },
      { quoteReference: id(9) },
      { paymentOperationReference: id(9) },
      { selectedAt: "2026-09-10T12:00:01.000Z" },
    ])
      expect(
        samePaymentTipSelection(original, parsePaymentTipSelection({ ...record(), ...changed })),
      ).toBe(false);
  });
  it("rejects executable fields without invoking them", () => {
    let called = false;
    const value = Object.defineProperty(record(), "tip", {
      enumerable: true,
      get() {
        called = true;
        return {};
      },
    });
    expect(() => parsePaymentTipSelection(value)).toThrow();
    expect(called).toBe(false);
  });
  it("redacts underlying driver failure", async () => {
    const store = createPostgresPaymentTipSelectionStore(
      {
        async run() {
          throw new Error("synthetic driver detail");
        },
      },
      { brandReference: id(7), storeReference: id(8) },
      { now: () => at },
    );
    await expect(store.load(id(1))).rejects.toMatchObject({
      code: "PAYMENT_TIP_UNAVAILABLE",
      message: "payment tip selection is unavailable",
    });
  });
});

function application() {
  let stored: PaymentTipSelection | null = null;
  let instant = at,
    denied = false,
    freshDenied = false,
    revision = 1;
  let loseAck = false,
    failWrite = false,
    revokeAfterWrite = false;
  let writes = 0,
    audits = 0;
  const authActions: string[] = [];
  const fixture = record();
  const {
    selectedAt: _at,
    guestSessionReference: _guest,
    brandReference: _brand,
    storeReference: _store,
    ...command
  } = fixture;
  void _at;
  void _guest;
  void _brand;
  void _store;
  const ports: PaymentTipSelectionPorts = {
    scope: { brandReference: id(7), storeReference: id(8) },
    clock: { now: () => instant },
    authorization: {
      async authorize(request) {
        authActions.push(request.action);
        if (denied || (freshDenied && request.action === "SelectPaymentTip")) return null;
        return {
          brandReference: id(7),
          storeReference: id(8),
          guestSessionReference: id(6),
          sessionVersion: revision,
          validUntil: "2026-09-10T13:00:00.000Z",
        };
      },
    },
    repository: {
      async load() {
        return stored;
      },
      async append({ record: value }) {
        writes++;
        if (failWrite) throw new Error("synthetic write failure");
        stored = value;
        if (revokeAfterWrite) denied = true;
        if (loseAck) throw new Error("synthetic response loss");
        return { status: "Created", record: value };
      },
    },
    audit: {
      async create(value) {
        audits++;
        return {
          auditId: id(100),
          brandId: id(7),
          storeId: id(8),
          actor: { type: "System" },
          actionCode: "PAYMENT_TIP_SELECT",
          targetType: "PaymentTipSelection",
          targetId: value.selectionReference,
          reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
          correlationId: id(101),
          occurredAt: value.selectedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        };
      },
    },
  };
  return {
    ports,
    command,
    authActions,
    service: createPaymentTipSelectionService(ports),
    stored: () => stored,
    writes: () => writes,
    audits: () => audits,
    time: (value: string) => {
      instant = value;
    },
    deny: () => {
      denied = true;
    },
    denyFresh: () => {
      freshDenied = true;
    },
    revise: () => {
      revision++;
    },
    loseAck: () => {
      loseAck = true;
    },
    failWrite: () => {
      failWrite = true;
    },
    revokeAfterWrite: () => {
      revokeAfterWrite = true;
    },
  };
}
describe("authorized tip selection application", () => {
  it("selects with server time then recovers the original without new eligibility or Audit", async () => {
    const h = application();
    const first = await h.service.select(h.command);
    expect(first.status).toBe("Created");
    h.time("2026-09-10T12:10:00.000Z");
    h.denyFresh();
    h.authActions.length = 0;
    const replay = await h.service.select(h.command);
    expect(replay.record).toEqual(first.record);
    expect(replay.status).toBe("Existing");
    expect(h.authActions).not.toContain("SelectPaymentTip");
    expect(h.writes()).toBe(1);
    expect(h.audits()).toBe(1);
  });
  it("does not accept changed amount or an injected payer/time on replay", async () => {
    const h = application();
    await h.service.select(h.command);
    await expect(
      h.service.select({ ...h.command, tip: { amountMinor: 126n, currencyCode: "CAD" } }),
    ).rejects.toMatchObject({ code: "PAYMENT_TIP_CONFLICT" });
    await expect(h.service.select({ ...h.command, selectedAt: at })).rejects.toThrow();
    await expect(
      h.service.select({ ...h.command, guestSessionReference: id(9) }),
    ).rejects.toThrow();
    expect(h.writes()).toBe(1);
  });
  it("recovers a committed choice after acknowledgement loss", async () => {
    const h = application();
    h.loseAck();
    const result = await h.service.select(h.command);
    expect(result.status).toBe("Existing");
    expect(result.record).toEqual(h.stored());
    expect(h.writes()).toBe(1);
  });
  it("does not invent recovery after an absent failed write", async () => {
    const h = application();
    h.failWrite();
    await expect(h.service.select(h.command)).rejects.toMatchObject({
      code: "PAYMENT_TIP_UNAVAILABLE",
    });
    expect(h.stored()).toBeNull();
    expect(h.writes()).toBe(1);
  });
  it("denies a revoked actor before lookup", async () => {
    const h = application();
    h.deny();
    h.ports.repository.load = async () => {
      throw new Error("lookup must not run");
    };
    await expect(h.service.select(h.command)).rejects.toMatchObject({
      code: "PAYMENT_TIP_UNAVAILABLE",
    });
    expect(h.writes()).toBe(0);
    expect(h.audits()).toBe(0);
  });
  it("denies fresh selection after current source eligibility is lost", async () => {
    const h = application();
    h.denyFresh();
    await expect(h.service.select(h.command)).rejects.toThrow();
    expect(h.writes()).toBe(0);
    expect(h.audits()).toBe(0);
  });
  it.each(["revision", "expiry"])("does not write after Audit wait changes %s", async (change) => {
    const h = application(),
      audit = h.ports.audit.create;
    h.ports.audit.create = async (value) => {
      const result = await audit(value);
      if (change === "revision") h.revise();
      else h.time("2026-09-10T13:00:00.000Z");
      return result;
    };
    await expect(h.service.select(h.command)).rejects.toThrow();
    expect(h.writes()).toBe(0);
  });
  it("does not return a choice after post-write revocation", async () => {
    const h = application();
    h.revokeAfterWrite();
    await expect(h.service.select(h.command)).rejects.toThrow();
    expect(h.stored()).not.toBeNull();
  });
});
