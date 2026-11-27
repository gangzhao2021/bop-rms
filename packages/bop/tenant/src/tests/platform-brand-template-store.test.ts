import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createPostgresPlatformBrandTemplateStore,
  type PlatformBrandTemplateStoreOptions,
  type PlatformBrandTemplateTransaction,
} from "../infrastructure/persistence/platform-brand-template-store.js";
import {
  parsePlatformBrandTemplateSave,
  platformBrandTemplateIntentDigest,
  type PlatformBrandTemplateRevision,
  type PlatformBrandTemplateReceipt,
} from "../contracts/platform-brand-template.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(Object.getOwnPropertyDescriptor(v, k)?.value)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const scope = {
  kind: "Platform" as const,
  actorReference: id(1),
  purposeCode: "PLATFORM_BRAND_TEMPLATE" as const,
};
const content = {
  code: "BRAND_STANDARD",
  name: "Brand standard",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
};
const command = (op = id(2)) =>
  parsePlatformBrandTemplateSave({
    profile: "PlatformBrandTemplateSaveV1",
    ...scope,
    operationReference: op,
    templateReference: null,
    expectedHead: null,
    content,
  });
/** Actual source queries/parsers over controlled SQL transport. No native rollback,
 * real Platform permission source, Session, publication or runtime proof is claimed. */
function fixture() {
  const db = {
    revisions: [] as PlatformBrandTemplateRevision[],
    operations: new Map<string, PlatformBrandTemplateReceipt>(),
    clock: at,
    allowed: true,
    isolation: "read committed",
    onHold: null as null | (() => Promise<void>),
    badDigest: false,
  };
  const hash = (v: unknown) => "sha256:" + createHash("sha256").update(canonical(v)).digest("hex");
  const row = (r: PlatformBrandTemplateRevision) => ({
    template_id: r.templateReference,
    version_id: r.templateVersionReference,
    revision: String(r.revision),
    code: r.content.code,
    actor_id: r.authoredByReference,
    operation_id: r.operationReference,
    audit_id: r.auditReference,
    content_digest: r.contentDigest,
    source_digest: r.sourceDigest,
    snapshot_json: r,
    precise: true,
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_revision")) {
      db.revisions.push(JSON.parse(String(values[9])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_operation")) {
      const receipt = JSON.parse(String(values[10])) as PlatformBrandTemplateReceipt;
      db.operations.set(String(values[0]) + ":" + values[2], receipt);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT current_setting('transaction_isolation')"))
      return { rows: [{ isolation: db.isolation }] };
    if (sql.startsWith("SELECT actor_id,purpose_code")) {
      const receipt = db.operations.get(String(values[0]) + ":" + values[2]);
      return {
        rows: receipt
          ? [
              {
                actor_id: receipt.actorReference,
                purpose_code: receipt.purposeCode,
                operation_id: receipt.operationReference,
                intent_digest: receipt.intentDigest,
                receipt_json: receipt,
                receipt_digest: db.badDigest ? "sha256:" + "a".repeat(64) : hash(receipt),
                precise: true,
              },
            ]
          : [],
      };
    }
    if (sql.startsWith("SELECT template_id FROM"))
      return {
        rows: db.revisions
          .filter((r) => r.content.code === values[0] && r.templateReference !== values[1])
          .slice(0, 1)
          .map((r) => ({ template_id: r.templateReference })),
      };
    if (sql.includes("SELECT DISTINCT ON(template_id)")) {
      const latest = new Map<string, PlatformBrandTemplateRevision>();
      for (const r of db.revisions) {
        const prior = latest.get(r.templateReference);
        if (!prior || r.revision > prior.revision) latest.set(r.templateReference, r);
      }
      return {
        rows: [...latest.values()]
          .filter(
            (r) =>
              values[0] === null ||
              r.content.code > String(values[0]) ||
              (r.content.code === values[0] && r.templateReference > String(values[1])),
          )
          .sort((a, b) =>
            a.content.code < b.content.code
              ? -1
              : a.content.code > b.content.code
                ? 1
                : a.templateReference < b.templateReference
                  ? -1
                  : 1,
          )
          .slice(0, Number(values[2]))
          .map(row),
      };
    }
    if (sql.startsWith("SELECT template_id,version_id")) {
      let selected = sql.includes("WHERE version_id")
        ? db.revisions.filter((r) => r.templateVersionReference === values[0])
        : db.revisions.filter(
            (r) =>
              r.templateReference === values[0] &&
              (values[1] === undefined || values[1] === null || r.revision < Number(values[1])),
          );
      selected = selected
        .sort((a, b) => b.revision - a.revision)
        .slice(0, sql.includes("LIMIT 3") ? 3 : 1);
      return { rows: selected.map(row) };
    }
    return { rows: [] };
  });
  const tx: PlatformBrandTemplateTransaction = { query };
  const guards: { guard: () => Promise<void>; final: () => void }[] = [];
  let allocated = 100;
  const options: PlatformBrandTemplateStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => db.clock },
    originalObservedAt: at,
    originalValidUntil: until,
    references: {
      canonicalize: canonical,
      hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
      nextReference: vi.fn(() => id(allocated++)),
    },
    authority: {
      holdUntilTransactionCompletes: vi.fn(async (actual, input) => {
        expect(actual).toBe(tx);
        expect(input.kind).toBe("Platform");
        expect(input).not.toHaveProperty("brandReference");
        if (db.onHold) await db.onHold();
        if (!db.allowed) throw new Error("controlled denied");
        return { validUntil: until };
      }),
    },
    appendAudit: vi.fn(async (actual, input) => {
      expect(actual).toBe(tx);
      expect(input.actorReference).toBe(scope.actorReference);
    }),
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
  };
  const store = createPostgresPlatformBrandTemplateStore(options);
  const finalize = async () => {
    for (const g of guards) await g.guard();
    for (const g of guards) g.final();
    store.assertFinalized();
  };
  return { db, options, store, query, guards, finalize };
}
it("saves actual immutable global content with operation arbitration before IDs and retained final guards", async () => {
  const f = fixture(),
    receipt = await f.store.save(command());
  expect(receipt).toMatchObject({
    outcome: "Committed",
    snapshot: { recordKind: "AuthoredContent", content },
  });
  expect(receipt.snapshot).not.toHaveProperty("brandReference");
  expect(f.db.revisions).toHaveLength(1);
  expect(f.options.references.nextReference).toHaveBeenCalledTimes(3);
  const sql = f.query.mock.calls.map(([sql]) => sql),
    admission = sql.indexOf("SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)");
  expect(admission).toBeGreaterThan(0);
  expect(f.query.mock.calls[admission]?.[1]).toEqual([
    scope.actorReference,
    command().operationReference,
  ]);
  expect(sql.findIndex((s) => s.startsWith("INSERT INTO"))).toBeGreaterThan(admission);
  expect(sql.some((s) => s.startsWith("LOCK TABLE"))).toBe(false);
  await f.finalize();
  expect(sql.some((s) => s.includes("bop.brand_id','',true"))).toBe(true);
});
it("replays the exact original without allocations/Audit and rejects same op changed intent", async () => {
  const f = fixture(),
    input = command(),
    first = await f.store.save(input),
    allocated = vi.mocked(f.options.references.nextReference).mock.calls.length,
    audits = vi.mocked(f.options.appendAudit).mock.calls.length;
  expect(await f.store.save(input)).toEqual(first);
  expect(vi.mocked(f.options.references.nextReference).mock.calls).toHaveLength(allocated);
  expect(vi.mocked(f.options.appendAudit).mock.calls).toHaveLength(audits);
  await expect(
    f.store.save({ ...input, content: { ...content, name: "Different" } }),
  ).rejects.toMatchObject({ code: "PLATFORM_TEMPLATE_INTENT_CONFLICT" });
});
it("writes absent original Abandoned and permanently fences a delayed Save", async () => {
  const f = fixture(),
    input = command(),
    original = {
      profile: "PlatformBrandTemplateResolveV1",
      ...scope,
      operationReference: input.operationReference,
      intentDigest: platformBrandTemplateIntentDigest(input, f.options.references),
    },
    receipt = await f.store.resolve(original);
  expect(receipt).toMatchObject({ outcome: "Abandoned", snapshot: null, originalCommand: null });
  expect(f.db.revisions).toHaveLength(0);
  expect(f.options.references.nextReference).toHaveBeenCalledTimes(1);
  expect(await f.store.resolve(original)).toEqual(receipt);
  await expect(f.store.save(input)).rejects.toMatchObject({
    code: "PLATFORM_TEMPLATE_VERSION_CONFLICT",
  });
  expect(f.options.references.nextReference).toHaveBeenCalledTimes(1);
});
it("performs owner CAS and code uniqueness before fresh allocation", async () => {
  const f = fixture(),
    first = await f.store.save(command());
  expect(first.snapshot).not.toBeNull();
  const r = first.snapshot;
  if (!r) throw new Error("fixture");
  const count = vi.mocked(f.options.references.nextReference).mock.calls.length;
  await expect(f.store.save(command(id(6)))).rejects.toMatchObject({
    code: "PLATFORM_TEMPLATE_VERSION_CONFLICT",
  });
  expect(f.options.references.nextReference).toHaveBeenCalledTimes(count);
  const g = fixture();
  g.db.operations = new Map(f.db.operations);
  g.db.revisions = [r];
  await expect(
    g.store.save({
      ...command(id(7)),
      templateReference: r.templateReference,
      expectedHead: {
        revision: r.revision,
        templateVersionReference: r.templateVersionReference,
        sourceDigest: "sha256:" + "b".repeat(64),
      },
    }),
  ).rejects.toMatchObject({ code: "PLATFORM_TEMPLATE_VERSION_CONFLICT" });
  expect(g.options.references.nextReference).not.toHaveBeenCalled();
});
it("creates a new immutable revision and preserves original content history rather than overwrite", async () => {
  const f = fixture(),
    first = await f.store.save(command()),
    r = first.snapshot;
  if (!r) throw new Error("fixture");
  const second = await f.store.save({
    ...command(id(6)),
    templateReference: r.templateReference,
    expectedHead: {
      revision: 1,
      templateVersionReference: r.templateVersionReference,
      sourceDigest: r.sourceDigest,
    },
    content: { ...content, name: "Revised standard" },
  });
  expect(second.snapshot).toMatchObject({
    revision: 2,
    supersedesVersionReference: r.templateVersionReference,
    content: { name: "Revised standard" },
  });
  expect(f.db.revisions[0]?.content.name).toBe("Brand standard");
  const current = await f.store.current({ templateReference: r.templateReference }),
    exact = await f.store.exact({ templateVersionReference: r.templateVersionReference }),
    history = await f.store.history({
      templateReference: r.templateReference,
      beforeRevision: null,
    });
  expect(current.current).toEqual(second.snapshot);
  expect(exact.snapshot).toEqual(r);
  expect(history.entries.map((e) => e.revision)).toEqual([2, 1]);
  expect(history.publication).toBe("NotEvaluated");
  await f.finalize();
});
it("rechecks held owner row and original bytes before COMMIT", async () => {
  const f = fixture();
  await f.store.save(command());
  f.db.badDigest = true;
  await expect(f.guards[0]?.guard()).rejects.toMatchObject({
    code: "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
  });
  expect(() => f.store.assertFinalized()).toThrow();
});
it("permission withdrawal refuses before write and before finalization", async () => {
  const f = fixture();
  f.db.allowed = false;
  await expect(f.store.save(command())).rejects.toThrow();
  expect(f.options.references.nextReference).not.toHaveBeenCalled();
  expect(f.options.appendAudit).not.toHaveBeenCalled();
  const g = fixture();
  await g.store.save(command());
  g.db.allowed = false;
  await expect(g.guards[0]?.guard()).rejects.toThrow();
  expect(() => g.store.assertFinalized()).toThrow();
});
it("retains the original finite deadline at the last synchronous preCOMMIT seal", async () => {
  const f = fixture();
  await f.store.save(command());
  await f.guards[0]?.guard();
  f.db.clock = until;
  expect(() => f.guards[0]?.final()).toThrow();
  expect(() => f.store.assertFinalized()).toThrow();
});
it("does not overturn completed COMMIT finalization when wall clock later advances", async () => {
  const f = fixture();
  await f.store.save(command());
  await f.finalize();
  const count = f.query.mock.calls.length;
  f.db.clock = "2026-10-07T10:00:00.000Z";
  expect(() => f.store.assertFinalized()).not.toThrow();
  expect(f.query).toHaveBeenCalledTimes(count);
});
it("rejects port/query drift and poisoned reentry even if the caller catches it", async () => {
  const f = fixture();
  f.options.references.nextReference = () => id(999);
  await expect(f.store.save(command())).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  g.db.onHold = async () => {
    g.db.onHold = null;
    await g.store.current({ templateReference: id(30) }).catch(() => undefined);
  };
  await expect(g.store.save(command())).rejects.toThrow();
  expect(g.options.references.nextReference).not.toHaveBeenCalled();
});
it("requires READ COMMITTED and original Actor identity without foreign private SQL", async () => {
  const f = fixture();
  f.db.isolation = "repeatable read";
  await expect(f.store.save(command())).rejects.toThrow();
  expect(f.options.references.nextReference).not.toHaveBeenCalled();
  const g = fixture();
  await expect(g.store.save({ ...command(), actorReference: id(9) })).rejects.toMatchObject({
    code: "PLATFORM_TEMPLATE_PERMISSION_DENIED",
  });
  expect(g.query).not.toHaveBeenCalled();
  expect(
    f.query.mock.calls.every(
      ([sql]) =>
        !sql.includes("bop_identity.") &&
        !sql.includes("bop_publishing.") &&
        !sql.includes("bop_permission."),
    ),
  ).toBe(true);
});
it("reads another author's committed source using the actual current Reader and read-only admission", async () => {
  const author = fixture(),
    receipt = await author.store.save(command()),
    snapshot = receipt.snapshot;
  if (!snapshot) throw new Error("fixture");
  const reader = fixture();
  reader.db.revisions = [snapshot];
  reader.db.operations = new Map(author.db.operations);
  const store = createPostgresPlatformBrandTemplateStore({
    ...reader.options,
    actorReference: id(9),
  });
  const current = await store.current({ templateReference: snapshot.templateReference });
  expect(current.actorReference).toBe(id(9));
  expect(current.current?.authoredByReference).toBe(id(1));
  expect(
    reader.query.mock.calls.some(
      ([sql, values]) =>
        sql === "SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)" &&
        values[0] === id(9) &&
        values[1] === null,
    ),
  ).toBe(true);
  const requests = vi.mocked(reader.options.authority.holdUntilTransactionCompletes).mock.calls;
  expect(
    requests.every(
      ([, r]) => r.permission === "platform.brand-template.read" && r.actorReference === id(9),
    ),
  ).toBe(true);
  await expect(
    store.resolve({
      profile: "PlatformBrandTemplateResolveV1",
      ...scope,
      operationReference: receipt.operationReference,
      intentDigest: receipt.intentDigest,
    }),
  ).rejects.toMatchObject({ code: "PLATFORM_TEMPLATE_PERMISSION_DENIED" });
});
it("refuses a borrowed query replacement before further read admission", async () => {
  const f = fixture();
  f.options.transaction.query = async () => ({ rows: [] });
  await expect(f.store.current({ templateReference: id(50) })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("a source lease can shorten but cannot renew the original finite window", async () => {
  const f = fixture();
  vi.mocked(f.options.authority.holdUntilTransactionCompletes).mockResolvedValue({
    validUntil: "2026-10-06T10:00:01.000Z",
  });
  await f.store.current({ templateReference: id(50) });
  f.db.clock = "2026-10-06T10:00:01.000Z";
  await expect(f.guards[0]?.guard()).rejects.toThrow();
  const g = fixture();
  vi.mocked(g.options.authority.holdUntilTransactionCompletes).mockResolvedValue({
    validUntil: "2027-10-06T10:00:00.000Z",
  });
  const current = await g.store.current({ templateReference: id(50) });
  expect(current.validUntil).toBe(until);
});
it("pages three large valid revisions without applying the single-row bound to SQL lookahead", async () => {
  const f = fixture();
  const largeContent = {
    ...content,
    overrideAllowedFieldCodes: Array.from(
      { length: 100 },
      (_, i) => "A" + String(i).padStart(63, "0"),
    ),
    hardRequirementFieldCodes: Array.from(
      { length: 100 },
      (_, i) => "H" + String(i).padStart(63, "0"),
    ),
  };
  let receipt = await f.store.save({ ...command(), content: largeContent });
  for (const op of [id(6), id(7)]) {
    const prior = receipt.snapshot;
    if (!prior) throw new Error("fixture");
    receipt = await f.store.save({
      ...command(op),
      templateReference: prior.templateReference,
      expectedHead: {
        revision: prior.revision,
        templateVersionReference: prior.templateVersionReference,
        sourceDigest: prior.sourceDigest,
      },
      content: largeContent,
    });
  }
  const latest = receipt.snapshot;
  if (!latest) throw new Error("fixture");
  expect(new TextEncoder().encode(JSON.stringify(f.db.revisions)).length).toBeGreaterThan(32768);
  const first = await f.store.history({
    templateReference: latest.templateReference,
    beforeRevision: null,
  });
  expect(first.entries.map((r) => r.revision)).toEqual([3, 2]);
  expect(first.nextBeforeRevision).toBe(2);
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(32768);
  const second = await f.store.history({
    templateReference: latest.templateReference,
    beforeRevision: first.nextBeforeRevision,
  });
  expect(second.entries.map((r) => r.revision)).toEqual([1]);
  expect(second.nextBeforeRevision).toBeNull();
  await f.finalize();
});
it("still rejects an oversized individual SQL row before exposing history", async () => {
  const f = fixture(),
    receipt = await f.store.save(command()),
    snapshot = receipt.snapshot;
  if (!snapshot) throw new Error("fixture");
  f.db.revisions = [{ ...snapshot, content: { ...snapshot.content, name: "a".repeat(32768) } }];
  await expect(
    f.store.history({ templateReference: snapshot.templateReference, beforeRevision: null }),
  ).rejects.toMatchObject({
    code: "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
  });
  expect(() => f.store.assertFinalized()).toThrow();
});
it.each(["sparse", "accessor", "extra key"])(
  "rejects %s SQL page arrays without evaluating getters",
  async (kind) => {
    const f = fixture(),
      originalQuery = f.query.getMockImplementation();
    if (!originalQuery) throw new Error("fixture");
    let accessed = false;
    const damaged: Record<string, unknown>[] = new Array<Record<string, unknown>>(1);
    if (kind === "accessor")
      Object.defineProperty(damaged, "0", {
        enumerable: true,
        get() {
          accessed = true;
          return {};
        },
      });
    if (kind === "extra key") {
      damaged[0] = {};
      Object.defineProperty(damaged, "extra", { value: true, enumerable: true });
    }
    f.query.mockImplementation(async (sql, values) =>
      sql.startsWith("SELECT template_id,version_id")
        ? { rows: damaged }
        : originalQuery(sql, values),
    );
    await expect(
      f.store.history({ templateReference: id(50), beforeRevision: null }),
    ).rejects.toMatchObject({
      code: "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
    });
    expect(accessed).toBe(false);
  },
);

it("discovers latest actual Template heads in stable code keyset pages with real source pins", async () => {
  const f = fixture();
  for (const [op, code] of [
    [50, "Z_LAST"],
    [51, "A_FIRST"],
    [52, "M_MIDDLE"],
  ] as const)
    await f.store.save({ ...command(id(op)), content: { ...content, code, name: code } });
  const first = await f.store.list({ after: null, limit: 2 });
  expect(first.items.map((r) => r.code)).toEqual(["A_FIRST", "M_MIDDLE"]);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toEqual({
    code: first.items[1]?.code,
    templateReference: first.items[1]?.templateReference,
  });
  expect(first.publication).toBe("NotEvaluated");
  const second = await f.store.list({ after: first.nextCursor, limit: 2 });
  expect(second.items.map((r) => r.code)).toEqual(["Z_LAST"]);
  expect(second.nextCursor).toBeNull();
  expect(second.hasMore).toBe(false);
  expect(
    f.query.mock.calls.find(([sql]) => sql.includes("SELECT DISTINCT ON(template_id)"))?.[1],
  ).toEqual([null, null, 3]);
  for (const item of first.items) {
    const source = f.db.revisions.find(
      (r) => r.templateVersionReference === item.templateVersionReference,
    );
    expect(source?.sourceDigest).toBe(item.sourceDigest);
    expect(source?.authoredByReference).toBe(item.authoredByReference);
  }
  expect(
    vi
      .mocked(f.options.authority.holdUntilTransactionCompletes)
      .mock.calls.some(
        ([, input]) => input.mode === "Read" && input.permission === "platform.brand-template.read",
      ),
  ).toBe(true);
  await f.finalize();
});
it("lists only latest immutable revision per family and supports empty/max bounded pages", async () => {
  const f = fixture(),
    saved = await f.store.save(command()),
    prior = saved.snapshot;
  if (!prior) throw new Error("fixture");
  await f.store.save({
    ...command(id(50)),
    templateReference: prior.templateReference,
    expectedHead: {
      revision: prior.revision,
      templateVersionReference: prior.templateVersionReference,
      sourceDigest: prior.sourceDigest,
    },
    content: { ...content, name: "Updated real name" },
  });
  const page = await f.store.list({ after: null, limit: 20 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ name: "Updated real name", revision: 2 });
  const empty = await f.store.list({
    after: { code: "ZZZ", templateReference: id(999) },
    limit: 20,
  });
  expect(empty.items).toEqual([]);
  expect(empty.hasMore).toBe(false);
  await f.finalize();
});
it("refuses list without genuine original receipt or when permission is withdrawn before COMMIT", async () => {
  const f = fixture();
  await f.store.save(command());
  f.db.operations.clear();
  await expect(f.store.list({ after: null, limit: 20 })).rejects.toThrow();
  const g = fixture();
  await g.store.save(command());
  await g.store.list({ after: null, limit: 20 });
  g.db.allowed = false;
  await expect(g.guards[0]?.guard()).rejects.toThrow();
  expect(() => g.store.assertFinalized()).toThrow();
});
it("poisons caught invalid list input and detects changed list rows at final guard", async () => {
  const f = fixture();
  await f.store.list({ after: null, limit: 20 });
  await expect(f.store.list({ after: null, limit: 21 })).rejects.toThrow();
  await expect(f.guards[0]?.guard()).rejects.toThrow();
  const g = fixture();
  await g.store.save(command());
  await g.store.list({ after: null, limit: 20 });
  g.db.revisions = [];
  await expect(g.guards[0]?.guard()).rejects.toThrow();
});
