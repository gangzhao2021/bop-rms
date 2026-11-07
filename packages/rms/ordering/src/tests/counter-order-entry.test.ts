import { describe, expect, it } from "vitest";
import {
  CounterOrderEntryError,
  createPostgresCounterOrderEntryStore,
  isGuestCartChannel,
  parseCounterOrderEntryRecord,
} from "../index.js";

const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const entry = (overrides: Record<string, unknown> = {}) => ({
  brandReference: id(1),
  storeReference: id(2),
  operationReference: id(3),
  intentHash: `sha256:${"a".repeat(64)}`,
  actorReference: id(4),
  guestSessionReference: id(5),
  cartReference: id(6),
  tipSelectionReference: id(7),
  recordedAfterOutage: false,
  createdAt: "2026-10-13T18:00:00.000Z",
  auditReference: id(8),
  ...overrides,
});

describe("counter (Pos) pickup carts — WP-2423 Q7", () => {
  it("guest services serve a counter cart for pickup only", () => {
    expect(isGuestCartChannel("Pickup", "Qr")).toBe(true);
    expect(isGuestCartChannel("DineIn", "Web")).toBe(true);
    expect(isGuestCartChannel("Pickup", "Pos")).toBe(true);
    // Staff dine-in ordering is a later slice; the Api channel is never a guest's.
    expect(isGuestCartChannel("DineIn", "Pos")).toBe(false);
    expect(isGuestCartChannel(undefined, "Pos")).toBe(false);
    expect(isGuestCartChannel("Pickup", "Api")).toBe(false);
  });

  it("parses the staff record of a counter order", () => {
    const parsed = parseCounterOrderEntryRecord(entry({ recordedAfterOutage: true }));
    expect(parsed.recordedAfterOutage).toBe(true);
    expect(parsed.tipSelectionReference).toBe(id(7));
    expect(() => parseCounterOrderEntryRecord(entry({ recordedAfterOutage: "yes" }))).toThrow(
      CounterOrderEntryError,
    );
    expect(() => parseCounterOrderEntryRecord(entry({ intentHash: "x" }))).toThrow(
      CounterOrderEntryError,
    );
    expect(() => parseCounterOrderEntryRecord({ ...entry(), extra: 1 })).toThrow(
      CounterOrderEntryError,
    );
  });

  it("replays the same staff command and refuses a different one under its operation", async () => {
    const stored: Record<string, unknown>[] = [];
    const audits: unknown[] = [];
    const tx = {
      async query(sql: string, values: readonly unknown[]) {
        if (sql.startsWith("SELECT set_config") || sql.startsWith("SELECT pg_advisory"))
          return { rows: [] };
        if (sql.includes("INSERT INTO rms_ordering.counter_order_entry")) {
          const [brand, store, operation, hash, actor, guest, cart, tip, outage, at, audit] =
            values as string[];
          stored.push({
            brandReference: brand,
            storeReference: store,
            operationReference: operation,
            intentHash: hash,
            actorReference: actor,
            guestSessionReference: guest,
            cartReference: cart,
            tipSelectionReference: tip,
            recordedAfterOutage: outage,
            createdAt: at,
            auditReference: audit,
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM rms_ordering.counter_order_entry e WHERE"))
          return {
            rows: stored
              .filter((row) => row.operationReference === values[2])
              .map((record) => ({ record })),
          };
        if (sql.includes("audit")) {
          audits.push(sql);
          return { rows: [{ previous_hash: null, sequence: "0" }], rowCount: 1 };
        }
        throw new Error("unexpected " + sql);
      },
    };
    const store = createPostgresCounterOrderEntryStore({
      brandReference: id(1),
      storeReference: id(2),
      authorize: async () => true,
    });
    // An existing record is replayed without writing again.
    stored.push(entry());
    const replay = await store.record(tx, parseCounterOrderEntryRecord(entry()));
    expect(replay.status).toBe("AlreadyRecorded");
    expect(stored).toHaveLength(1);
    await expect(
      store.record(
        tx,
        parseCounterOrderEntryRecord(entry({ intentHash: `sha256:${"b".repeat(64)}` })),
      ),
    ).rejects.toMatchObject({ code: "COUNTER_ORDER_IDEMPOTENCY_CONFLICT" });
    await expect(
      createPostgresCounterOrderEntryStore({
        brandReference: id(1),
        storeReference: id(2),
        authorize: async () => false,
      }).loadByOperation(tx, id(3)),
    ).rejects.toBeInstanceOf(CounterOrderEntryError);
  });
});
