import { beforeEach, expect, it, vi } from "vitest";
import { createPostgresProductWholeScopeReplacementStore } from "../infrastructure/persistence/product-whole-scope-replacement-store.js";
import {
  createPostgresProductPublicationStore,
  type ProductPublicationStoreOptions,
  type ProductPublicationWriteResult,
} from "../infrastructure/persistence/product-publication-store.js";
import {
  productPublicationCheckCodes,
  type ProductPublicationCommand,
} from "../contracts/product-publication.js";
vi.mock("../infrastructure/persistence/product-publication-store.js", async (original) => ({
  ...(await original<
    typeof import("../infrastructure/persistence/product-publication-store.js")
  >()),
  createPostgresProductPublicationStore: vi.fn(),
}));
const id = (n: number) => `01902440-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-09-30T21:00:00.000Z",
  until = "2026-09-30T21:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
function commands() {
  const common = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    expectedPublicationVersion: 2,
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_REPLACEMENT",
  };
  return {
    publish: {
      ...common,
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(8),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      action: "Publish",
      successorDraftVersionReference: id(10),
      replacementVersionReference: null,
    },
    supersede: {
      ...common,
      actorReference: id(4),
      actorKind: "System",
      operationReference: id(9),
      versionReference: id(7),
      expectedProductAggregateVersion: 8,
      action: "Supersede",
      successorDraftVersionReference: null,
      replacementVersionReference: id(6),
    },
  };
}
beforeEach(() => vi.mocked(createPostgresProductPublicationStore).mockReset());
function fixture(journalUntil = until) {
  let clock = at,
    finalDenial = false,
    lateExpiry = false;
  const actions: string[] = [],
    tx = { query: vi.fn() },
    statuses: ("Applied" | "Replayed")[] = ["Applied", "Applied"];
  const authority = (kind: string) => ({
    holdUntilTransactionCompletes: vi.fn(async () => {
      actions.push("final:" + kind);
      if (finalDenial) throw new Error("synthetic denial");
      if (lateExpiry) clock = until;
    }),
  });
  const owner = (actor: number, kind: string) => ({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(actor),
    authority: authority(kind),
    sources: {
      async withHeldCurrentFacts<T>(
        _tx: unknown,
        input: { command: ProductPublicationCommand },
        work: (facts: unknown) => Promise<T>,
      ) {
        const c = input.command;
        return work({
          now: at,
          validation: {
            evidenceReference: id(20),
            productAggregateVersion: c.expectedProductAggregateVersion,
            contentDigest: hash,
            configurationDigest: hash,
            scopeDigest: hash,
            periodDigest: hash,
            policyReference: id(21),
            policyVersion: 1,
            approvalPolicy: "NotRequired",
            checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
            warningAcknowledgement: null,
            checkedAt: at,
            validUntil: until,
          },
          approval: null,
        });
      },
      withHeldScopePolicy: vi.fn(),
    },
    audit: { create: vi.fn() },
  });
  const publish = owner(3, "User"),
    supersede = owner(4, "System"),
    run = vi.fn(async <T>(work: (current: typeof tx) => Promise<T>) => work(tx));
  vi.mocked(createPostgresProductPublicationStore).mockImplementation((options) => ({
    async execute(raw) {
      const c = raw as ProductPublicationCommand;
      actions.push(c.action);
      const status = statuses[c.action === "Publish" ? 0 : 1] ?? "Applied";
      // Explicit owning-writer dispatch mock, not persistence/validation evidence.
      const result = {
        status,
        publication: {
          state: c.action === "Publish" ? "Published" : "Superseded",
          versionReference: c.versionReference,
          supersededByVersionReference: c.replacementVersionReference,
        },
        aggregate: {
          aggregateVersion: c.expectedProductAggregateVersion + 1,
          draft: { versionReference: id(10) },
        },
        scopeJournalStatus: "Recorded",
        scopeJournal: { plan: { observedAt: at }, validUntil: journalUntil },
      } as unknown as ProductPublicationWriteResult;
      if (status === "Replayed") return result;
      return options.transactions.run((current) =>
        options.sources.withHeldCurrentFacts(
          current,
          { command: c } as Parameters<
            ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"]
          >[1],
          async () => result,
        ),
      );
    },
  }));
  const options = {
    publish,
    supersede,
    clock: { now: () => clock },
    transactions: { run },
  } as unknown as Parameters<typeof createPostgresProductWholeScopeReplacementStore>[0];
  const store = createPostgresProductWholeScopeReplacementStore(options);
  return {
    store,
    options,
    publish,
    supersede,
    actions,
    run,
    statuses,
    tx,
    expire: () => {
      lateExpiry = true;
    },
    deny: () => {
      finalDenial = true;
    },
    setClock: (value: string) => {
      clock = value;
    },
  };
}
it("dispatches both existing owners in one exact transaction and rechecks both contexts", async () => {
  const f = fixture(),
    r = await f.store.execute(commands());
  expect(r).toMatchObject({ status: "Applied", eligibility: "NotEvaluated" });
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.actions).toEqual(["Publish", "Supersede", "final:User", "final:System"]);
});
it("recovers both original operations without a renewed lease or paired receipt", async () => {
  const f = fixture();
  f.statuses.fill("Replayed");
  f.setClock("2026-10-01T21:00:00.000Z");
  expect(await f.store.execute(commands())).toMatchObject({ status: "Replayed" });
});
it.each([0, 1])("refuses mixed recovery %s rather than committing a half", async (index) => {
  const f = fixture();
  f.statuses[index] = "Replayed";
  await expect(f.store.execute(commands())).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
});
it.each([
  "root",
  "scope",
  "actor",
  "replacement",
  "operation",
  "instant",
  "version",
  "successor",
  "action",
  "extra",
])("rejects incompatible pair %s before starting a transaction", async (mode) => {
  const f = fixture(),
    c = commands();
  if (mode === "root") c.supersede.expectedProductAggregateVersion = 9;
  if (mode === "scope")
    Object.assign(c.supersede, {
      scopeSet: [{ level: "Store", reference: id(99), channelCodes: [], orderTypeCodes: [] }],
    });
  if (mode === "actor") c.supersede.actorKind = "User";
  if (mode === "replacement") c.supersede.replacementVersionReference = id(99);
  if (mode === "operation") c.supersede.operationReference = c.publish.operationReference;
  if (mode === "instant") c.supersede.occurredAt = until;
  if (mode === "version") c.supersede.versionReference = c.publish.versionReference;
  if (mode === "successor") c.publish.successorDraftVersionReference = c.supersede.versionReference;
  if (mode === "action") c.publish.action = "SchedulePublish";
  await expect(
    f.store.execute(mode === "extra" ? { ...c, validation: {} } : c),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["publish", "supersede"])("rejects %s accessor without executing it", async (key) => {
  const f = fixture(),
    getter = vi.fn();
  await expect(
    f.store.execute(Object.defineProperty(commands(), key, { get: getter })),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "actorReference"])(
  "refuses changed %s context",
  async (key) => {
    const f = fixture(),
      c = commands();
    Object.assign(c.publish, { [key]: id(99) });
    await expect(f.store.execute(c)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  },
);
it("refuses final permission withdrawal after both dispatches", async () => {
  const f = fixture();
  f.deny();
  await expect(f.store.execute(commands())).rejects.toThrow();
  expect(f.actions.slice(0, 2)).toEqual(["Publish", "Supersede"]);
});
it("retains first original lease across both operations and final authority", async () => {
  const f = fixture();
  f.expire();
  await expect(f.store.execute(commands())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.actions.slice(0, 2)).toEqual(["Publish", "Supersede"]);
});
it("captures original owners and configuration before options replacement", async () => {
  const f = fixture();
  Object.assign(f.options.publish, {
    actorReference: id(99),
    authority: { holdUntilTransactionCompletes: vi.fn() },
  });
  await expect(f.store.execute(commands())).resolves.toMatchObject({ status: "Applied" });
  expect(f.publish.authority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(f.actions).toContain("final:User");
});
it("rejects a runner replacing the completed result", async () => {
  const f = fixture();
  f.run.mockImplementation(async (work) => {
    await work(f.tx);
    return {} as never;
  });
  await expect(f.store.execute(commands())).rejects.toThrow();
});
it("rejects missing actual policy and current System facts before dispatch", () => {
  const f = fixture();
  for (const replacement of [
    {
      ...f.options,
      publish: {
        ...f.options.publish,
        sources: { withHeldCurrentFacts: f.options.publish.sources.withHeldCurrentFacts },
      },
    },
    { ...f.options, supersede: { ...f.options.supersede, sources: {} } },
  ])
    expect(() => createPostgresProductWholeScopeReplacementStore(replacement as never)).toThrow();
});

it("keeps the shorter original journal deadline after both writes", async () => {
  const short = "2026-09-30T21:00:01.000Z",
    f = fixture(short);
  f.publish.authority.holdUntilTransactionCompletes.mockImplementation(async () => {
    f.setClock(short);
  });
  await expect(f.store.execute(commands())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.actions.slice(0, 2)).toEqual(["Publish", "Supersede"]);
});
it("refuses a second outer callback even if the runner catches its failure", async () => {
  const f = fixture();
  f.run.mockImplementation(async (work) => {
    const result = await work(f.tx);
    try {
      await work(f.tx);
    } catch {
      /* deliberately defective synthetic runner */
    }
    return result;
  });
  await expect(f.store.execute(commands())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.actions.filter((action) => action === "Publish")).toHaveLength(1);
});
