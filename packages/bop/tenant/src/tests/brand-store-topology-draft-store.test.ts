import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresBrandStoreTopologyDraftStore,
  type BrandStoreTopologyDraftStoreOptions,
  type BrandStoreTopologyDraftTransaction,
} from "../infrastructure/persistence/brand-store-topology-draft-store.js";
import { parseTenantStoreReferenceSnapshot } from "../contracts/store-reference-source.js";
import { parseBrandStoreTopologySave } from "../contracts/brand-store-topology-operation.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical(Object.getOwnPropertyDescriptor(value, k)?.value)}`,
      )
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Invalid canonical input");
  return result;
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
interface Database {
  revisions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  lifecycle: string;
}
function fixture(
  database: Database = { revisions: [], operations: [], lifecycle: "Active" },
  actorReference = id(3),
) {
  const fixed = { tenantReference: id(1), brandReference: id(2), actorReference };
  let now = at,
    next = 100,
    lease = until,
    denied = false,
    advancing = false,
    normalizeCallbacks = false;
  let actualRoster: ReturnType<typeof parseTenantStoreReferenceSnapshot> | undefined,
    beforeRoster: (() => Promise<void>) | undefined;
  const guards: { guard: () => Promise<void>; final: () => void }[] = [],
    events: string[] = [],
    audits: unknown[] = [];
  const rosterCalls =
    vi.fn<
      (
        actual: BrandStoreTopologyDraftTransaction,
        input: Readonly<typeof fixed & { observedAt: string; validUntil: string }>,
      ) => void
    >();
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (
      sql.startsWith("SELECT set_config") ||
      sql.startsWith("SELECT pg_advisory") ||
      sql.startsWith("SET CONSTRAINTS")
    )
      return { rows: [] };
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("FROM bop_tenant.brand WHERE"))
      return {
        rows: [
          {
            brand_id: id(2),
            lifecycle: database.lifecycle,
            version: "1",
            updated_at: at,
            precise: true,
          },
        ],
      };
    if (sql.startsWith("INSERT INTO bop_tenant.brand_store_topology_draft_revision")) {
      events.push("revision");
      const snapshot = JSON.parse(String(values[8]));
      database.revisions.push({
        tenant_id: values[0],
        brand_id: values[1],
        draft_id: values[2],
        revision: String(values[3]),
        operation_id: values[4],
        actor_id: values[5],
        audit_id: values[6],
        snapshot_digest: values[7],
        snapshot_json: snapshot,
        created_at: values[9],
        updated_at: values[10],
        precise: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.brand_store_topology_draft_operation")) {
      events.push("operation");
      database.operations.push({
        tenant_id: values[0],
        brand_id: values[1],
        operation_id: values[2],
        actor_id: values[3],
        expected_revision: String(values[4]),
        intent_digest: values[5],
        outcome: values[6],
        result_revision: values[7] === null ? null : String(values[7]),
        result_draft_id: values[8],
        snapshot_digest: values[9],
        command_json: values[10] === null ? null : JSON.parse(String(values[10])),
        audit_id: values[11],
        occurred_at: values[12],
        precise: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM bop_tenant.brand_store_topology_draft_operation"))
      return {
        rows: database.operations.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.operation_id === values[2],
        ),
      };
    if (sql.includes("FROM bop_tenant.brand_store_topology_draft_revision")) {
      const scoped = database.revisions.filter(
        (row) => row.tenant_id === values[0] && row.brand_id === values[1],
      );
      if (sql.includes("count(*)"))
        return {
          rows: [
            {
              count: String(scoped.length),
              bytes: String(
                scoped.reduce(
                  (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.snapshot_json)),
                  0,
                ),
              ),
            },
          ],
        };
      if (sql.includes("AND revision=$3"))
        return {
          rows: scoped.filter(
            (row) => row.revision === String(values[2]) && row.operation_id === values[3],
          ),
        };
      if (sql.includes("DESC")) return { rows: [...scoped].reverse().slice(0, 1) };
      return { rows: scoped };
    }
    throw new Error("Unexpected controlled SQL branch");
  });
  const tx: BrandStoreTopologyDraftTransaction = { query };
  const options: BrandStoreTopologyDraftStoreOptions = {
    ...fixed,
    transaction: tx,
    originalObservedAt: at,
    originalValidUntil: until,
    clock: {
      now: () => {
        if (advancing) now = new Date(Date.parse(now) + 1).toISOString();
        return now;
      },
    },
    registerBeforeCommit: vi.fn((_actual, guard, final) => {
      events.push("register");
      guards.push({ guard, final });
    }),
    authority: {
      holdUntilTransactionCompletes: vi.fn(async (actual, input) => {
        expect(actual).toBe(tx);
        expect(input.tenantReference).toBe(id(1));
        expect(input.brandReference).toBe(id(2));
        expect(input.actorReference).toBe(actorReference);
        expect(input.permission).toBe("organization.manage");
        expect(input.purposeCode).toBe("BRAND_STORE_TOPOLOGY_DRAFT");
        if (denied) {
          const { BrandStoreTopologyError } =
            await import("../contracts/brand-store-topology-operation.js");
          throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
        }
        return { validUntil: lease };
      }),
    },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      audits.push(input);
      events.push("audit");
    }),
    withCurrentStoreReferences: async <T>(
      actual: BrandStoreTopologyDraftTransaction,
      input: Readonly<typeof fixed & { observedAt: string; validUntil: string }>,
      work: (roster: ReturnType<typeof parseTenantStoreReferenceSnapshot>) => Promise<T>,
    ) => {
      rosterCalls(actual, input);
      expect(actual).toBe(tx);
      events.push("roster");
      await beforeRoster?.();
      try {
        return await work(
          actualRoster ??
            parseTenantStoreReferenceSnapshot({
              profile: "TenantStoreReferenceV1",
              brandReference: id(2),
              brandLifecycle: "Active",
              brandVersion: "1",
              generation: "1",
              referenceCount: "1",
              originalIntentDigest: hash("controlled request"),
              observedAt: input.observedAt,
              references: [
                {
                  storeReference: id(9),
                  lifecycle: "Suspended",
                  version: "1",
                  createdAt: at,
                  updatedAt: at,
                },
              ],
            }),
        );
      } catch (error) {
        if (normalizeCallbacks)
          throw new Error("Controlled Tenant owner normalization", { cause: error });
        throw error;
      }
    },
  };
  const store = createPostgresBrandStoreTopologyDraftStore(options);
  const command = (operation = 10, revision = 0) =>
    parseBrandStoreTopologySave({
      profile: "BrandStoreTopologySaveV1",
      ...fixed,
      operationReference: id(operation),
      expectedRevision: revision,
      content: {
        profile: "BrandStoreTopologyDraftV1",
        tenantReference: id(1),
        brandReference: id(2),
        draftReference: id(4),
        selectors: [{ kind: "Region", reference: id(5), code: "NORTH", name: "North" }],
        assignments: [{ storeReference: id(9), selectorReference: id(5) }],
      },
    });
  const resolve = (
    operation = 10,
    revision = 0,
    intentDigest = hash(canonical(command(operation, revision))),
  ) => ({
    profile: "BrandStoreTopologyResolveV1",
    ...fixed,
    operationReference: id(operation),
    expectedRevision: revision,
    intentDigest,
  });
  return {
    database,
    store,
    options,
    tx,
    query,
    guards,
    events,
    audits,
    command,
    resolve,
    rosterCalls,
    normalizeCallbacks() {
      normalizeCallbacks = true;
    },
    roster(value: ReturnType<typeof parseTenantStoreReferenceSnapshot>) {
      actualRoster = value;
    },
    beforeRoster(work: () => Promise<void>) {
      beforeRoster = work;
    },
    clock(value: string) {
      now = value;
    },
    advance() {
      advancing = true;
    },
    deny() {
      denied = true;
    },
    lease(value: string) {
      lease = value;
    },
    async finish() {
      for (const g of guards) await g.guard();
      for (const g of guards) g.final();
      events.push("commit");
      return store.assertFinalized(tx);
    },
  };
}
describe("Topology Draft borrowed transaction source (controlled SQL/Audit transport, no native IAM proof)", () => {
  it("saves an actual parsed complete roster binding, original Audit and mutually paired rows before real host completion", async () => {
    const f = fixture(),
      command = f.command(),
      receipt = await f.store.save(command);
    expect(f.events).toEqual(["register", "roster", "revision", "audit", "operation"]);
    expect(receipt.outcome).toBe("Committed");
    expect(receipt.snapshot?.content).toEqual(command.content);
    expect(f.audits[0]).toMatchObject({
      intentDigest: hash(canonical(command)),
      mode: "Save",
      purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
    });
    expect(f.audits[0]).not.toHaveProperty("content");
    const snapshot = receipt.snapshot;
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error("Expected controlled saved snapshot");
    const { snapshotDigest, ...body } = snapshot;
    expect(snapshotDigest).toBe(hash(canonical(body)));
    expect(await f.finish()).toBe(until);
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.startsWith("SET CONSTRAINTS bop_tenant.brand_store_topology_revision_coherence"),
      ),
    ).toBe(true);
  });
  it("supports advancing actual clock and returns the shortest original lease", async () => {
    const f = fixture();
    f.advance();
    f.lease("2026-10-06T10:00:02.000Z");
    await f.store.save(f.command());
    expect(await f.finish()).toBe("2026-10-06T10:00:02.000Z");
  });
  it("preserves stable Draft identity/create time and original author while allowing a different current reader", async () => {
    const first = fixture();
    const original = await first.store.save(first.command());
    await first.finish();
    const second = fixture(first.database, id(8));
    second.clock("2026-10-06T10:00:01.000Z");
    const saved = await second.store.save(second.command(11, 1));
    expect(saved.snapshot?.revision).toBe(2);
    expect(saved.snapshot?.createdAt).toBe(original.snapshot?.createdAt);
    expect(saved.snapshot?.actorReference).toBe(id(8));
    await second.finish();
    const reader = fixture(first.database);
    reader.clock("2026-10-06T10:00:02.000Z");
    const current = await reader.store.readCurrent(),
      history = await reader.store.readHistory();
    expect(current.actorReference).toBe(id(3));
    expect(current.current?.actorReference).toBe(id(8));
    expect(history.map((r) => r.actorReference)).toEqual([id(3), id(8)]);
    expect(reader.rosterCalls).not.toHaveBeenCalled();
    expect(reader.audits).toEqual([]);
    await reader.finish();
  });
  it("replays exact original immutable receipt after successor and Archive without today's roster", async () => {
    const seed = fixture(),
      command = seed.command(),
      original = await seed.store.save(command);
    await seed.finish();
    const successor = fixture(seed.database);
    successor.clock("2026-10-06T10:00:01.000Z");
    await successor.store.save(successor.command(11, 1));
    await successor.finish();
    seed.database.lifecycle = "Archived";
    const replay = fixture(seed.database);
    replay.clock("2026-10-06T10:00:02.000Z");
    expect(await replay.store.save(command)).toEqual(original);
    expect(replay.rosterCalls).not.toHaveBeenCalled();
    expect(replay.audits).toEqual([]);
    await replay.finish();
    const fresh = fixture(seed.database);
    fresh.clock("2026-10-06T10:00:02.000Z");
    await expect(fresh.store.save(fresh.command(12, 2))).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
    });
  });
  it("durably resolves absence as Abandoned and matching late Save returns that same original", async () => {
    const first = fixture(),
      command = first.command(),
      receipt = await first.store.resolve(first.resolve());
    expect(receipt.outcome).toBe("Abandoned");
    expect(receipt.snapshot).toBeNull();
    await first.finish();
    const late = fixture(first.database);
    expect(await late.store.save(command)).toEqual(receipt);
    expect(late.rosterCalls).not.toHaveBeenCalled();
    expect(late.database.revisions).toHaveLength(0);
    expect(late.audits).toEqual([]);
    await late.finish();
  });
  it("resolves committed original without requalifying old Store assignments", async () => {
    const seed = fixture(),
      receipt = await seed.store.save(seed.command());
    await seed.finish();
    const f = fixture(seed.database);
    expect(await f.store.resolve(f.resolve())).toEqual(receipt);
    expect(f.rosterCalls).not.toHaveBeenCalled();
    await f.finish();
  });
  it("rejects changed original content, wrong actor and changed expected revision", async () => {
    const seed = fixture();
    await seed.store.save(seed.command());
    await seed.finish();
    const changed = fixture(seed.database);
    const command = changed.command();
    await expect(
      changed.store.save({ ...command, content: { ...command.content, assignments: [] } }),
    ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT" });
    const actor = fixture(seed.database, id(8));
    await expect(actor.store.resolve(actor.resolve())).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
    });
    const revision = fixture(seed.database);
    await expect(
      revision.store.resolve(revision.resolve(10, 1, hash(canonical(seed.command())))),
    ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT" });
  });
  it("refuses CAS and Draft identity changes before Audit allocation", async () => {
    const f = fixture();
    await expect(f.store.save(f.command(10, 1))).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT",
    });
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
    const seed = fixture();
    await seed.store.save(seed.command());
    await seed.finish();
    const next = fixture(seed.database),
      command = next.command(11, 1);
    await expect(
      next.store.save({ ...command, content: { ...command.content, draftReference: id(50) } }),
    ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" });
    expect(next.audits).toEqual([]);
  });
  it("rejects actual foreign or unknown Store roster facts and swallowed reentry", async () => {
    for (const brandReference of [id(2), id(50)]) {
      const f = fixture();
      f.roster(
        parseTenantStoreReferenceSnapshot({
          profile: "TenantStoreReferenceV1",
          brandReference,
          brandLifecycle: "Active",
          brandVersion: "1",
          generation: "0",
          referenceCount: "0",
          originalIntentDigest: hash("scope"),
          observedAt: at,
          references: [],
        }),
      );
      await expect(f.store.save(f.command())).rejects.toThrow();
      expect(f.audits).toEqual([]);
      expect(f.events).toContain("roster");
    }
    const reentry = fixture();
    reentry.beforeRoster(async () => {
      await reentry.store.readCurrent().catch(() => undefined);
    });
    await expect(reentry.store.save(reentry.command())).rejects.toThrow();
    expect(reentry.events).not.toContain("revision");
  });
  it("refuses same-transaction Brand changes at its final guard while a new request may read Archived identity", async () => {
    const f = fixture();
    await f.store.readCurrent();
    f.database.lifecycle = "Archived";
    await expect(f.finish()).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT",
    });
    expect(f.events).not.toContain("commit");
    const reader = fixture(f.database);
    expect((await reader.store.readCurrent()).current).toBeNull();
    await reader.finish();
  });
  it("reobserves complete actual Store roster facts at COMMIT and refuses same-transaction generation drift", async () => {
    const f = fixture();
    await f.store.save(f.command());
    f.normalizeCallbacks();
    f.roster(
      parseTenantStoreReferenceSnapshot({
        profile: "TenantStoreReferenceV1",
        brandReference: id(2),
        brandLifecycle: "Active",
        brandVersion: "1",
        generation: "2",
        referenceCount: "1",
        originalIntentDigest: hash("fresh request"),
        observedAt: at,
        references: [
          {
            storeReference: id(9),
            lifecycle: "Active",
            version: "2",
            createdAt: at,
            updatedAt: at,
          },
        ],
      }),
    );
    await expect(f.finish()).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT",
    });
    expect(f.events.filter((e) => e === "roster")).toHaveLength(2);
    expect(f.events).not.toContain("commit");
  });
  it("checks initial/late current permission and original expiry with no successful COMMIT", async () => {
    const initial = fixture();
    initial.deny();
    await expect(initial.store.readCurrent()).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
    });
    expect(initial.query).not.toHaveBeenCalled();
    const late = fixture();
    await late.store.readCurrent();
    late.deny();
    await expect(late.finish()).rejects.toMatchObject({
      code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
    });
    expect(late.events).not.toContain("commit");
    const expired = fixture();
    await expired.store.readCurrent();
    expired.clock(until);
    await expect(expired.finish()).rejects.toThrow();
  });
  it("final rereads full current/history and actual original tuples, refusing tamper", async () => {
    const seed = fixture();
    await seed.store.save(seed.command());
    await seed.finish();
    const f = fixture(seed.database);
    await f.store.readCurrent();
    await f.store.readHistory();
    const row = seed.database.revisions[0];
    if (!row) throw new Error("Expected controlled revision");
    row.snapshot_digest = hash("tampered");
    await expect(f.finish()).rejects.toThrow();
    const original = fixture();
    await original.store.resolve(original.resolve());
    const operationRow = original.database.operations[0];
    if (!operationRow) throw new Error("Expected controlled original operation");
    operationRow.audit_id = id(99);
    await expect(original.finish()).rejects.toThrow();
  });
  it("rejects captured query/scope drift, foreign final host, early finalization and later reads", async () => {
    const query = fixture();
    await query.store.readCurrent();
    query.tx.query = async () => ({ rows: [] });
    await expect(query.finish()).rejects.toThrow();
    const scope = fixture();
    await scope.store.readCurrent();
    Object.defineProperty(scope.options, "actorReference", { value: id(50) });
    await expect(scope.finish()).rejects.toThrow();
    const foreign = fixture();
    await foreign.store.readCurrent();
    expect(() => foreign.store.assertFinalized({ query: async () => ({ rows: [] }) })).toThrow();
    const early = fixture();
    expect(() => early.store.assertFinalized(early.tx)).toThrow();
    await expect(early.store.readCurrent()).rejects.toThrow();
    const final = fixture();
    await final.store.readCurrent();
    await final.finish();
    await expect(final.store.readHistory()).rejects.toThrow();
  });
  it("refuses history overflow and imprecise actual SQL timestamps", async () => {
    const seed = fixture();
    await seed.store.save(seed.command());
    await seed.finish();
    const row = seed.database.revisions[0];
    if (!row) throw new Error("Expected controlled revision");
    const overflow = fixture({
      ...seed.database,
      revisions: Array.from({ length: 1001 }, () => row),
    });
    await expect(overflow.store.readHistory()).rejects.toThrow();
    row.precise = false;
    await expect(fixture(seed.database).store.readCurrent()).rejects.toThrow();
  });
});
