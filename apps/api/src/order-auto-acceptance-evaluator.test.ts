import { describe, expect, it, vi } from "vitest";
import { createOrderAutoAcceptanceEvaluator } from "./order-auto-acceptance-evaluator.js";

const id = (n: number) => "0190b1d0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const event = {
  eventId: id(10),
  eventType: "PaymentSucceeded",
  schemaVersion: 1,
  occurredAt: "2026-11-05T12:00:00.000Z",
  producerModule: "@rms/payment",
  tenantId: scope.brandReference,
  storeId: scope.storeReference,
  aggregateType: "PaymentIntent",
  aggregateId: id(11),
  aggregateVersion: 2n,
  correlationId: id(12),
  causationId: id(13),
  actor: { type: "System" },
  payload: {
    paymentTransactionReference: id(14),
    paymentIntentReference: id(11),
    paymentAttemptReference: id(15),
    orderReference: id(16),
    amountMinor: "1500",
    currencyCode: "CAD",
    evidenceKind: "Captured",
    terminalOccurredAt: "2026-11-05T12:00:00.000Z",
  },
  redactionClassification: "payment",
  replayMetadata: { replaySafe: true },
};

/** Only what `prepare` touches: the setting read and the savepoints around the operating read. */
function harness(input: {
  settingRows: readonly Record<string, unknown>[];
  readOperating?: () => Promise<unknown>;
  authorize?: () => Promise<boolean>;
  failSetting?: unknown;
}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("order_auto_acceptance_setting") && input.failSetting !== undefined)
      throw input.failSetting;
    return {
      rows: sql.includes("order_auto_acceptance_setting") ? input.settingRows : [],
      rowCount: 0,
    };
  });
  const tx = { query } as never;
  const report = vi.fn();
  const readOperating = vi.fn(input.readOperating ?? (async () => null));
  const evaluator = createOrderAutoAcceptanceEvaluator({
    scope,
    authorize: input.authorize ?? (async () => true),
    reference: () => id(99),
    now: () => "2026-11-05T12:00:05.000Z",
    workflowActorReference: id(4),
    quoteVersion: 2,
    captured: {} as never,
    context: {} as never,
    additionalContext: {} as never,
    workflow: () => ({ purposeCode: "OrderFulfillment", workflowVersionReference: id(5) }),
    readOperating: readOperating as never,
    audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
    report,
  });
  return { evaluator, tx, query, statements, report, readOperating };
}
const on = [
  {
    version: 2,
    pickup: true,
    dine_in: false,
    occurred_at: "2026-11-05T10:00:00.000Z",
  },
];

describe("DEC-PAID-ORDER-AUTO-ACCEPT evaluator", () => {
  it("a Store with the switch off pays one read and nothing else happens", async () => {
    const f = harness({ settingRows: [] });
    expect(await f.evaluator.prepare(f.tx, event)).toBeNull();
    expect(f.readOperating).not.toHaveBeenCalled();
    expect(f.statements.filter((sql) => sql.includes("SELECT version"))).toHaveLength(1);
    expect(await f.evaluator.apply(f.tx, event, null)).toBe("NotApplicable");
  });

  it("only a successful payment is looked at", async () => {
    const f = harness({ settingRows: on });
    expect(await f.evaluator.prepare(f.tx, { ...event, eventType: "PaymentFailed" })).toBeNull();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("reads the Store's status in a savepoint it always rolls back, with a short lock wait", async () => {
    const f = harness({
      settingRows: on,
      readOperating: async () => ({ state: "Open", availableServiceModes: ["Pickup"] }),
    });
    const prepared = await f.evaluator.prepare(f.tx, event);
    expect(prepared?.operating?.state).toBe("Open");
    const order = f.statements.filter((sql) => /order_auto_acceptance_operating|lock_timeout/u.test(sql));
    expect(order).toEqual([
      "SAVEPOINT order_auto_acceptance_operating",
      "SET LOCAL lock_timeout='250ms'",
      "ROLLBACK TO SAVEPOINT order_auto_acceptance_operating",
      "RELEASE SAVEPOINT order_auto_acceptance_operating",
    ]);
  });

  it("a status that can't be read counts as not open and leaves the transaction usable", async () => {
    const f = harness({
      settingRows: on,
      readOperating: async () => {
        throw new Error("aborted");
      },
    });
    const prepared = await f.evaluator.prepare(f.tx, event);
    expect(prepared?.operating).toBeNull();
    expect(f.statements).toContain("ROLLBACK TO SAVEPOINT order_auto_acceptance_operating");
    expect(f.report).not.toHaveBeenCalled();
  });

  it("a failing read never fails the payment outcome: rolled back, and reported once per payment", async () => {
    const f = harness({ settingRows: [], failSetting: new Error("boom") });
    expect(await f.evaluator.prepare(f.tx, event)).toBeNull();
    expect(await f.evaluator.prepare(f.tx, event)).toBeNull();
    expect(f.statements).toContain("ROLLBACK TO SAVEPOINT order_auto_acceptance");
    expect(f.report).toHaveBeenCalledTimes(1);
  });

  it("a lock conflict is a quiet skip; the wait workload tries again", async () => {
    const f = harness({ settingRows: [], failSetting: Object.assign(new Error("x"), { code: "55P03" }) });
    expect(await f.evaluator.prepare(f.tx, event)).toBeNull();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("no authority, nothing read", async () => {
    const f = harness({ settingRows: on, authorize: async () => false });
    expect(await f.evaluator.prepare(f.tx, event)).toBeNull();
    expect(f.statements.some((sql) => sql.includes("order_auto_acceptance_setting"))).toBe(false);
  });
});
