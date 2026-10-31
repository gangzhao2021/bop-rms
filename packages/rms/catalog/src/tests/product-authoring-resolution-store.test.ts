import { afterEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import {
  parseCatalogProductAuthoringResolutionCommand,
  type CatalogProductAuthoringResolution,
} from "../contracts/product-authoring-resolution.js";
import {
  createPostgresProductAuthoringResolutionStore,
  type ProductAuthoringResolutionStoreOptions,
} from "../infrastructure/persistence/product-authoring-resolution-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const id = (n: number) => "019a2421-0016-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function fixture(action: "Create" | "ReplaceDraft" = "Create") {
  const command = parseCatalogProductAuthoringResolutionCommand({
    profile: "CatalogProductAuthoringResolutionCommandV1",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    action,
    operationReference: id(4),
    productReference: action === "Create" ? null : id(5),
    expectedAggregateVersion: action === "Create" ? null : 7,
  });
  const aggregate = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: action === "Create" ? 1 : 8,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic Product" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const state = {
    time: Date.parse(at),
    committed: true,
    deny: false,
    actor: id(3),
    corrupt: false,
    fence: null as CatalogProductAuthoringResolution | null,
    insertCount: 1,
    swallowed: false,
    expireAtLock: false,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      if (state.expireAtLock && sql.includes("pg_advisory")) state.time += 5000;
      let result: unknown[] = [];
      if (sql.includes("transaction_isolation")) result = [{ isolation: "read committed" }];
      else if (sql.includes("FROM rms_catalog.product_operation_record r"))
        result = state.committed
          ? [
              {
                action_code: action,
                intent_digest: "sha256:" + "1".repeat(64),
                product_id: id(5),
                result_aggregate_version: aggregate.aggregateVersion,
                occurred_at: new Date(at),
                actor_id: state.actor,
                snapshot_digest: digest(aggregate),
                aggregate,
                coherent: !state.corrupt,
              },
            ]
          : [];
      else if (sql.startsWith("SELECT command_json"))
        result = state.fence ? [{ command: state.fence.command, resolution: state.fence }] : [];
      else if (sql.startsWith("INSERT INTO rms_catalog.product_authoring")) {
        state.fence = JSON.parse(String(values[8])) as CatalogProductAuthoringResolution;
        return { rows: [], rowCount: state.insertCount };
      }
      return { rows: result as Row[], rowCount: result.length };
    },
  };
  const authority = vi.fn<
    ProductAuthoringResolutionStoreOptions["authority"]["holdUntilTransactionCompletes"]
  >(async () => {
    if (state.deny) throw Error("Synthetic admission revoked");
  });
  const options: ProductAuthoringResolutionStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => new Date(state.time).toISOString() },
    authority: { holdUntilTransactionCompletes: authority },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
    transactions: {
      async run(work) {
        const old = state.fence;
        guards.length = 0;
        try {
          let result;
          try {
            result = await work(tx);
          } catch (error) {
            if (!state.swallowed) throw error;
            for (const entry of guards) await entry.guard();
            throw Error("Poisoned work incorrectly allowed commit", { cause: error });
          }
          for (const entry of guards) await entry.guard();
          for (const entry of guards) entry.final();
          return result;
        } catch (error) {
          state.fence = old;
          throw error;
        }
      },
    },
    audit: {
      create({ resolution }) {
        return {
          auditId: id(90),
          brandId: id(2),
          actor: { type: "User", reference: id(3) },
          actionCode: "CATALOG_PRODUCT_AUTHORING_OPERATION_ABANDONED",
          targetType: "ProductAuthoringOperation",
          targetId: id(4),
          reasonCode: "ORIGINAL_OPERATION_ABANDONED",
          correlationId: id(91),
          occurredAt: resolution.recordedAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC",
          retentionPolicyVersion: 1,
        };
      },
    },
  };
  return {
    state,
    calls,
    guards,
    authority,
    options,
    tx,
    command,
    create: () => createPostgresProductAuthoringResolutionStore(options),
  };
}
it.each(["Create", "ReplaceDraft"] as const)(
  "resolves original committed %s without new Product mutation or full content",
  async (action) => {
    const s = fixture(action),
      result = await s.create().execute(s.command);
    expect(result).toMatchObject({
      outcome: "Committed",
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: action === "Create" ? 1 : 8,
    });
    expect(s.calls.filter((call) => call.sql.startsWith("INSERT"))).toEqual([]);
    expect(
      s.calls.filter((call) => call.sql.includes("pg_advisory")).map((call) => call.values[0]),
    ).toEqual(["CatalogProductSource:" + id(2), "CatalogProductOperation:" + id(2) + ":" + id(4)]);
    expect(s.authority.mock.calls.length).toBeGreaterThanOrEqual(3);
  },
);
it.each(["Create", "ReplaceDraft"] as const)(
  "durably fences absent %s and replays the identical abandonment",
  async (action) => {
    const s = fixture(action);
    s.state.committed = false;
    const first = await s.create().execute(s.command),
      second = await s.create().execute(s.command);
    expect(first.outcome).toBe("Abandoned");
    expect(second).toEqual(first);
    expect(s.calls.filter((call) => call.sql.startsWith("INSERT"))).toHaveLength(1);
    if (action === "Create") expect(first.productReference).toBeNull();
  },
);
it.each(["Actor", "Coherence", "Scope"])(
  "refuses conflicting original %s without exposing content",
  async (mode) => {
    const s = fixture();
    if (mode === "Actor") s.state.actor = id(99);
    if (mode === "Coherence") s.state.corrupt = true;
    const command = mode === "Scope" ? { ...s.command, tenantReference: id(99) } : s.command;
    await expect(s.create().execute(command)).rejects.toThrow();
    expect(s.state.fence).toBeNull();
  },
);
it("caught denial poisons borrowed transaction and never writes abandonment", async () => {
  const s = fixture();
  s.state.committed = false;
  s.state.deny = true;
  s.state.swallowed = true;
  await expect(s.create().execute(s.command)).rejects.toThrow();
  expect(s.state.fence).toBeNull();
});
it("late revocation rolls back the newly written fence", async () => {
  const s = fixture();
  s.state.committed = false;
  s.authority.mockImplementation(async () => {
    if (s.state.fence) throw Error("Synthetic late revocation");
  });
  await expect(s.create().execute(s.command)).rejects.toThrow();
  expect(s.state.fence).toBeNull();
});
it("exclusive original expiry after lock acquisition refuses a terminal claim", async () => {
  const s = fixture();
  s.state.expireAtLock = true;
  await expect(s.create().execute(s.command)).rejects.toThrow();
  expect(s.state.fence).toBeNull();
});
it("zero-row abandonment insert is not success and rolls back", async () => {
  const s = fixture();
  s.state.committed = false;
  s.state.insertCount = 0;
  await expect(s.create().execute(s.command)).rejects.toThrow();
  expect(s.state.fence).toBeNull();
});
