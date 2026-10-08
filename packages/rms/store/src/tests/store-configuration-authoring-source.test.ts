import { describe, it, expect, vi } from "vitest";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import { StoreConfigurationAdministrationServiceError } from "../application/store-configuration-administration-service.js";
import {
  createPostgresStoreConfigurationAuthoringSource,
  createPostgresStoreConfigurationHistorySource,
  storeConfigurationHistoryRequiredFields,
  type StoreConfigurationHistorySourceOptions,
} from "../infrastructure/persistence/configuration-authoring-store.js";
const brand = "01902501-0000-7000-8000-000000000001",
  store = "01902501-0000-7000-8000-000000000002",
  at = "2026-10-05T10:00:00.000Z";
describe("owning configuration head barrier", () => {
  it("keeps legacy/default reads SHARE and takes actual writer barrier before fresh head CAS", async () => {
    for (const mode of [undefined, "Read", "Write"] as const) {
      const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
          void sql;
          void values;
          return { rows: [] };
        }),
        authorize = vi.fn(async () => true),
        source = createPostgresStoreConfigurationAuthoringSource({
          brandReference: brand,
          storeReference: store,
          authorize,
          ...(mode === undefined ? {} : { mode }),
        });
      expect(await source({ query }, at)).toBeNull();
      expect(query.mock.calls[1]?.[0]).toBe(
        mode === "Write"
          ? "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE ROW EXCLUSIVE MODE"
          : "LOCK TABLE rms_store.store_configuration_authoring_operation IN SHARE MODE",
      );
      expect(authorize).toHaveBeenCalledTimes(2);
    }
  });
  it("does not acquire the barrier when authority refuses", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(
      createPostgresStoreConfigurationAuthoringSource({
        brandReference: brand,
        storeReference: store,
        mode: "Write",
        authorize: async () => false,
      })({ query }, at),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects getter admission and captured mode replacement", async () => {
    let invoked = false;
    const options = { brandReference: brand, storeReference: store, authorize: async () => true };
    Object.defineProperty(options, "mode", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "Write";
      },
    });
    expect(() => createPostgresStoreConfigurationAuthoringSource(options)).toThrow();
    expect(invoked).toBe(false);
    const changed = {
        brandReference: brand,
        storeReference: store,
        mode: "Write" as const,
        authorize: async () => true,
      },
      source = createPostgresStoreConfigurationAuthoringSource(changed);
    Object.defineProperty(changed, "mode", { value: "Read", enumerable: true });
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(source({ query }, at)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(query).not.toHaveBeenCalled();
  });
});

it("refuses a Read mode changed to a getter during actual authorization without invoking it", async () => {
  let invoked = false;
  const options = {
    brandReference: brand,
    storeReference: store,
    authorize: async () => {
      Object.defineProperty(options, "mode", {
        enumerable: true,
        get: () => {
          invoked = true;
          return "Read";
        },
      });
      return true;
    },
  };
  const source = createPostgresStoreConfigurationAuthoringSource(options),
    query = vi.fn(async () => ({ rows: [] }));
  await expect(source({ query }, at)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(invoked).toBe(false);
});

const ref = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const historicalConfiguration = () =>
  createStoreConfigurationVersion({
    configurationReference: ref(20),
    brandReference: brand,
    storeReference: store,
    configurationVersion: 1,
    lifecycle: "Draft",
    source: "StoreOverride",
    brandBaseVersionReference: ref(21),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: ref(22),
    contactReference: ref(23),
    receiptReference: ref(24),
    taxConfigurationReference: ref(25),
    paymentConfigurationReference: ref(26),
    capacityConfigurationReference: null,
    enabledServiceModes: ["Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: ref(10),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
const historyRow = (n: number) => ({
  sequence_number: String(n),
  operation_id: ref(100 + n),
  command_type: "Validate",
  configuration_json: historicalConfiguration(),
  intent_digest: "sha256:" + "a".repeat(64),
  actor_reference: ref(10),
  purpose_code: "STORE_CONFIGURATION",
  audit_reference: ref(200 + n),
  occurred_at: at,
  expected_version: "1",
  configuration_id: ref(20),
  configuration_version: "1",
  lifecycle: "Draft",
  data_classification: "ConfigurationMetadata",
});
function historyFixture() {
  const state = { clock: at, until: "2026-10-05T10:00:05.000Z", allowed: true };
  const table = [historyRow(5), historyRow(4), historyRow(3), historyRow(2), historyRow(1)];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => ({
    rows: sql.includes("ORDER BY o.sequence_number")
      ? table
          .filter((row) => values[2] === null || Number(row.sequence_number) < Number(values[2]))
          .slice(0, 3)
      : [],
  }));
  const tx = { query },
    checks: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        actual: StoreConfigurationHistorySourceOptions["transaction"],
        request: Parameters<
          StoreConfigurationHistorySourceOptions["authority"]["holdUntilTransactionCompletes"]
        >[1],
      ) => {
        expect(actual).toBe(tx);
        expect(request).toMatchObject({
          tenantReference: ref(7),
          brandReference: brand,
          storeReference: store,
          actorReference: ref(8),
          permission: "store.service.read",
          purposeCode: "STORE_CONFIGURATION_HISTORY",
          requiredFields: storeConfigurationHistoryRequiredFields,
        });
        if (!state.allowed)
          throw new StoreConfigurationAdministrationServiceError(
            "STORE_CONFIGURATION_PERMISSION_DENIED",
          );
        return { validUntil: state.until };
      },
    ),
  };
  const options = {
    tenantReference: ref(7),
    brandReference: brand,
    storeReference: store,
    readerActorReference: ref(8),
    transaction: tx,
    clock: { now: () => state.clock },
    originalObservedAt: at,
    originalValidUntil: state.until,
    canonicalize: (value: unknown) => JSON.stringify(value),
    authority,
    registerBeforeCommit: async (
      actual: StoreConfigurationHistorySourceOptions["transaction"],
      guard: () => Promise<void>,
      final: () => void,
    ) => {
      expect(actual).toBe(tx);
      checks.push(guard);
      finals.push(final);
    },
  };
  const source = createPostgresStoreConfigurationHistorySource(options);
  const finalize = async () => {
    for (const guard of checks) await guard();
    for (const final of finals) final();
    return source.assertFinalized(tx);
  };
  return { state, table, query, tx, checks, finals, authority, options, source, finalize };
}
describe("held owning immutable Store configuration history", () => {
  it("pages every recorded operation with two complete entries and a truthful probe cursor", async () => {
    let before: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const f = historyFixture(),
        page = await f.source.readPage({ beforeSequence: before });
      seen.push(...page.entries.map((entry) => entry.sequenceNumber));
      expect(page.entries.length).toBeLessThanOrEqual(2);
      expect(page.readerActorReference).toBe(ref(8));
      expect(page.entries.every((entry) => entry.actorReference === ref(10))).toBe(true);
      expect(
        page.entries.every((entry) => entry.configuration.authoredByReference === ref(10)),
      ).toBe(true);
      before = page.nextBeforeSequence;
      await f.finalize();
      expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
    }
    expect(seen).toEqual([5, 4, 3, 2, 1]);
    expect(before).toBeNull();
  });
  it("returns an empty page without inventing a configuration or next cursor", async () => {
    const f = historyFixture();
    f.table.length = 0;
    const page = await f.source.readPage({ beforeSequence: null });
    expect(page.entries).toEqual([]);
    expect(page.nextBeforeSequence).toBeNull();
    await f.finalize();
  });
  it("rejects closed cursor getters, extras, fractional and nonpositive values before queries", async () => {
    for (const value of [
      { beforeSequence: 0 },
      { beforeSequence: 1.5 },
      { beforeSequence: null, extra: true },
    ]) {
      const f = historyFixture();
      await expect(f.source.readPage(value)).rejects.toThrow();
      expect(f.query).not.toHaveBeenCalled();
    }
    const f = historyFixture();
    let called = false;
    const value = {};
    Object.defineProperty(value, "beforeSequence", {
      enumerable: true,
      get: () => {
        called = true;
        return null;
      },
    });
    await expect(f.source.readPage(value)).rejects.toThrow();
    expect(called).toBe(false);
  });
  it("retains historical metadata and stored intent without requalifying current references", async () => {
    const f = historyFixture();
    const first = f.table[0];
    if (!first) throw new Error("fixture row absent");
    first.occurred_at = "2026-10-05T10:00:00.001Z";
    f.state.clock = "2026-10-05T10:00:00.002Z";
    const page = await f.source.readPage({ beforeSequence: null });
    expect(page.entries[0]?.occurredAt).toBe(first.occurred_at);
    expect(page.entries[0]?.configuration.updatedAt).toBe(at);
    expect(page.entries[0]?.intentDigest).toBe(first.intent_digest);
    expect(Object.isFrozen(page.entries)).toBe(true);
    await f.finalize();
  });
  it("refuses a changed immutable page before COMMIT", async () => {
    const f = historyFixture();
    await f.source.readPage({ beforeSequence: null });
    const row = f.table[0];
    if (!row) throw new Error("fixture row absent");
    row.audit_reference = ref(999);
    await expect(f.finalize()).rejects.toThrow();
  });
  it("reacquires current history permission before COMMIT without requiring author equality", async () => {
    const f = historyFixture();
    await f.source.readPage({ beforeSequence: null });
    f.state.allowed = false;
    await expect(f.finalize()).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_PERMISSION_DENIED",
    });
  });
  it("keeps the shortest held lease and refuses expiry at final assertion", async () => {
    const f = historyFixture();
    f.state.until = "2026-10-05T10:00:01.000Z";
    expect((await f.source.readPage({ beforeSequence: null })).validUntil).toBe(f.state.until);
    for (const guard of f.checks) await guard();
    f.state.clock = f.state.until;
    expect(() => {
      for (const final of f.finals) final();
    }).toThrow();
  });
  it("refuses changed authority ports and poisoned source reuse", async () => {
    const f = historyFixture();
    await f.source.readPage({ beforeSequence: null });
    Object.defineProperty(f.options.clock, "now", { value: () => at });
    await expect(f.finalize()).rejects.toThrow();
    await expect(f.source.readPage({ beforeSequence: null })).rejects.toThrow();
  });
  it.each([null, "invalid"])(
    "rejects an unrepresentable stored time %s with its owning dependency error rather than rounding or hiding its history row",
    async (occurredAt) => {
      const f = historyFixture(),
        row = f.table[0];
      if (!row) throw new Error("fixture row absent");
      Object.defineProperty(row, "occurred_at", { value: occurredAt, enumerable: true });
      await expect(f.source.readPage({ beforeSequence: null })).rejects.toMatchObject({
        code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      });
      const statement = f.query.mock.calls.find(([sql]) =>
        sql.includes("ORDER BY o.sequence_number"),
      )?.[0];
      expect(statement).toContain("CASE WHEN occurred_at=date_trunc('milliseconds',occurred_at)");
      expect(statement).toContain("ELSE NULL END occurred_at");
      expect(statement).not.toContain("AND occurred_at=date_trunc");
      expect(f.table).toHaveLength(5);
    },
  );
  it("rejects future operation time and mismatched stored scope without dropping records", async () => {
    const future = historyFixture(),
      row = future.table[0];
    if (!row) throw new Error("fixture row absent");
    row.occurred_at = "2026-10-05T10:00:00.001Z";
    await expect(future.source.readPage({ beforeSequence: null })).rejects.toThrow();
    const foreign = historyFixture(),
      other = foreign.table[0];
    if (!other) throw new Error("fixture row absent");
    other.configuration_json = createStoreConfigurationVersion({
      ...other.configuration_json,
      storeReference: ref(999),
    });
    await expect(foreign.source.readPage({ beforeSequence: null })).rejects.toThrow();
  });
});
