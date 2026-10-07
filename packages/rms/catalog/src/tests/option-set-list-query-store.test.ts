import { describe, it, expect, vi } from "vitest";
import { CatalogError } from "../contracts/product.js";
import {
  createPostgresOptionSetListQueryStore,
  type OptionSetListAuthority,
  type OptionSetListTransaction,
} from "../infrastructure/persistence/option-set-list-query-store.js";
const id = (n: number) => "01902421-7400-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T00:00:00.000Z",
  until = "2026-10-04T00:00:05.000Z";
const request = () => ({
  locale: "fr-CA",
  search: null,
  lifecycle: null,
  selectionType: null,
  includeArchived: false,
  hasProductBinding: null,
  hasPricingReference: null,
  hasConsumptionReference: null,
  hasConflict: null,
  missingTranslationLocale: null,
  publishingStatus: null,
  sort: "internalCode",
  direction: "ASC",
  limit: 1,
  cursor: null,
});
const row = (n: number) => ({
  optionSetReference: id(n),
  brandReference: id(2),
  internalCode: "SYNTHETIC_" + n,
  lifecycle: "Draft",
  aggregateVersion: 1,
  createdAt: at,
  updatedAt: at,
  draftVersionReference: id(n + 100),
  draftUpdatedAt: at,
  defaultLocale: "en-CA",
  localizedNames: { "en-CA": "Synthetic " + n, "fr-CA": "Synthétique " + n },
  displayStyle: "MultiChoice",
  minimumSelection: 0,
  maximumSelection: 1,
  allowRepeatedOption: false,
  perOptionMaximumQuantity: 1,
  maximumTotalQuantity: 1,
  options: [
    {
      optionReference: id(n + 200),
      stableCode: "CHOICE_" + n,
      localizedNames: { "en-CA": "Choice " + n },
      lifecycle: "Draft",
    },
  ],
  productBindingCount: 0,
  pricingPresent: false,
  consumptionPresent: false,
  conflictPresent: false,
  coherent: true,
});
function fixture(initial: unknown[] = [row(10), row(11), row(12)]) {
  let data = initial,
    clock = at,
    allowed = true,
    skipGuard = false,
    skipFinal = false,
    repeatGuard = false,
    compatible = true,
    rowsMissing = false,
    beforeCommit: (() => void) | null = null,
    afterRead: (() => void) | null = null;
  const entries = new WeakMap<object, { guard: () => Promise<void>; final: () => void }[]>();
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("set_config")) expect(values.length).toBeGreaterThan(0);
    if (sql.includes("transaction_isolation"))
      return { rows: [{ compatible }], rowCount: 1, command: "SELECT" };
    if (sql.includes("coalesce(jsonb_agg")) {
      if (afterRead) afterRead();
      return {
        rows: rowsMissing ? [] : [{ asOfUtc: at, items: data }],
        rowCount: 1,
        command: "SELECT",
      };
    }
    return { rows: [], rowCount: 0, command: "SELECT" };
  });
  const hold = vi.fn<OptionSetListAuthority["holdUntilTransactionCompletes"]>(
    async (_tx, input) => {
      expect(Object.getOwnPropertyDescriptor(_tx, "query")?.value).toBeDefined();
      expect(input.requiredPermissions).toEqual(["catalog.manage", "catalog.option_set.read"]);
      expect(input.purposeCode).toBe("CATALOG_OPTION_SET_LIST");
      expect(input.capability).toBe("catalog.cat_optionset_list");
      expect(input.request.locale).toBeDefined();
      if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { observedAt: input.observedAt, validUntil: until };
    },
  );
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    cursorKey: new Uint8Array(32).fill(7),
    clock: { now: () => clock },
    originalValidUntil: until,
    authority: { holdUntilTransactionCompletes: hold },
    transactions: {
      async run<T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
        const tx = { query },
          registered: { guard: () => Promise<void>; final: () => void }[] = [];
        entries.set(tx, registered);
        const result = await work(tx);
        beforeCommit?.();
        if (!skipGuard)
          for (const entry of registered) {
            await entry.guard();
            if (repeatGuard) await entry.guard();
          }
        if (!skipFinal) for (const entry of registered) entry.final();
        return result;
      },
    },
    registerBeforeCommit: async (tx: object, guard: () => Promise<void>, final: () => void) => {
      const registered = entries.get(tx);
      expect(registered).toBeDefined();
      if (!registered) throw Error("missing host");
      registered.push({ guard, final });
      return undefined;
    },
  };
  const make = (change: Partial<typeof options> = {}) =>
    createPostgresOptionSetListQueryStore({ ...options, ...change });
  return {
    make,
    query,
    hold,
    options,
    setData: (next: unknown[]) => {
      data = next;
    },
    deny: () => {
      allowed = false;
    },
    advance: (next: string) => {
      clock = next;
    },
    beforeCommit: (hook: () => void) => {
      beforeCommit = hook;
    },
    afterRead: (hook: () => void) => {
      afterRead = hook;
    },
    skipGuard: () => {
      skipGuard = true;
    },
    skipFinal: () => {
      skipFinal = true;
    },
    repeatGuard: () => {
      repeatGuard = true;
    },
    badRegister: () => {
      Object.defineProperty(options, "registerBeforeCommit", { value: async () => true });
    },
    badIsolation: () => {
      compatible = false;
    },
    missingPacket: () => {
      rowsMissing = true;
    },
  };
}
describe("actual owning live Option authoring list", () => {
  it("returns current source/locale facts with encrypted stable keyset pages", async () => {
    const f = fixture(),
      store = f.make(),
      first = await store.load(request());
    expect(first.items.map((i) => i.internalCode)).toEqual(["SYNTHETIC_10"]);
    expect(first.items[0]?.name).toBe("Synthétique 10");
    expect(first.projection.name).toBe("catalog_option_set_search_v1");
    expect(first.items[0]?.referenceEligibility).toBe("NotEvaluated");
    const cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    if (!cursor) throw Error("missing cursor");
    expect(cursor.startsWith("os1.")).toBe(true);
    expect(Buffer.from(cursor.slice(4), "base64url").toString("utf8")).not.toContain(id(10));
    const second = await store.load({ ...request(), cursor });
    expect(second.items[0]?.internalCode).toBe("SYNTHETIC_11");
    const last = await store.load({ ...request(), cursor: second.nextCursor });
    expect(last.items[0]?.internalCode).toBe("SYNTHETIC_12");
    expect(last.nextCursor).toBeNull();
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes("LOCK TABLE rms_catalog.option_set")),
    ).toBe(true);
    expect(f.hold).toHaveBeenCalledTimes(9);
  });
  it("keeps caller-transaction results tentative until the actual async and final host guards", async () => {
    const f = fixture(),
      store = f.make();
    let original: OptionSetListTransaction | undefined;
    const result = await f.options.transactions
      .run(async (tx) => {
        original = tx;
        const tentative = await store.loadInTransaction(tx, request());
        expect(tentative.items).toHaveLength(1);
        expect(() => store.assertFinalized(tx)).toThrow();
        return tentative;
      })
      .catch((error) => error);
    // An attempted premature completion assertion poisons that original host.
    expect(result).toMatchObject({ code: "DependencyUnavailable" });
    const good = fixture(),
      owner = good.make();
    const committed = await good.options.transactions.run(async (tx) => {
      original = tx;
      return owner.loadInTransaction(tx, request());
    });
    expect(committed.items).toHaveLength(1);
    expect(original).toBeDefined();
    if (!original) throw Error("missing original transaction");
    const committedTransaction = original;
    expect(() => owner.assertFinalized(committedTransaction)).not.toThrow();
    expect(() => owner.assertFinalized({ query: good.query })).toThrow();
  });
  it("uses actual configured defaultLocale for absent requested translation", async () => {
    const source = { ...row(10), localizedNames: { "en-CA": "Actual default" } },
      f = fixture([source]),
      result = await f.make().load(request());
    expect(result.items[0]).toMatchObject({
      name: "Actual default",
      nameLocale: "en-CA",
      localeFallback: true,
    });
  });
  it("prioritizes exact Option code then honors selected sort and stable tie", async () => {
    const f = fixture([row(12), row(10), row(11)]),
      result = await f.make().load({ ...request(), search: "CHOICE_11", limit: 100 });
    expect(result.items[0]?.internalCode).toBe("SYNTHETIC_11");
    const names = fixture([
      { ...row(11), localizedNames: { "en-CA": "Same" } },
      { ...row(10), localizedNames: { "en-CA": "Same" } },
    ]);
    expect(
      (
        await names.make().load({ ...request(), sort: "name", direction: "DESC", limit: 100 })
      ).items.map((i) => i.optionSetReference),
    ).toEqual([id(10), id(11)]);
  });
  it("searches legitimate Option translations without inventing the Set default locale on Options", async () => {
    const source = {
      ...row(10),
      options: [{ ...row(10).options[0], localizedNames: { "fr-CA": "Choix réel" } }],
    };
    expect(
      (
        await fixture([source])
          .make()
          .load({ ...request(), search: "Choix" })
      ).items,
    ).toHaveLength(1);
  });
  it("supports owning selection, binding, recorded references and missing-translation filters", async () => {
    const f = fixture([
      {
        ...row(10),
        pricingPresent: true,
        consumptionPresent: true,
        conflictPresent: true,
        productBindingCount: 2,
        localizedNames: { "en-CA": "Synthetic" },
      },
    ]);
    const result = await f
      .make()
      .load({
        ...request(),
        hasPricingReference: true,
        hasConsumptionReference: true,
        hasConflict: true,
        hasProductBinding: true,
        selectionType: "MultiChoice",
        missingTranslationLocale: "fr-CA",
      });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.recordedPricingReference).toEqual({ status: "Known", present: true });
    expect((await f.make().load({ ...request(), hasPricingReference: false })).items).toHaveLength(
      0,
    );
  });
  it("excludes Archived roots unless explicitly included", async () => {
    const f = fixture([{ ...row(10), lifecycle: "Archived" }]);
    expect((await f.make().load(request())).items).toHaveLength(0);
    expect(
      (await f.make().load({ ...request(), includeArchived: true, lifecycle: "Archived" })).items,
    ).toHaveLength(1);
  });
  it("does not convert legacy NULL into absent reference or conflict facts", async () => {
    const f = fixture([
      { ...row(10), pricingPresent: null, consumptionPresent: null, conflictPresent: null },
    ]);
    expect((await f.make().load(request())).items[0]?.recordedPricingReference).toEqual({
      status: "Unknown",
    });
    for (const change of [
      { hasPricingReference: false },
      { hasConsumptionReference: true },
      { hasConflict: false },
    ])
      await expect(f.make().load({ ...request(), ...change })).rejects.toMatchObject({
        code: "DependencyUnavailable",
      });
  });
  it.each(["Draft", "InReview", "Approved", "Published", "Archived"])(
    "refuses unsupported current PublishingStatus %s",
    async (publishingStatus) => {
      await expect(
        fixture()
          .make()
          .load({ ...request(), publishingStatus }),
      ).rejects.toMatchObject({ code: "DependencyUnavailable" });
    },
  );
  it("rejects cursor tamper and all scope/filter/locale substitutions", async () => {
    const f = fixture(),
      first = await f.make().load(request()),
      cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    if (!cursor) throw Error("missing cursor");
    await expect(
      f
        .make()
        .load({
          ...request(),
          cursor: cursor.slice(0, 4) + (cursor[4] === "A" ? "B" : "A") + cursor.slice(5),
        }),
    ).rejects.toMatchObject({ code: "Invalid" });
    for (const change of [
      { locale: "en-CA" },
      { search: "Synthetic" },
      { sort: "name" },
      { includeArchived: true },
      { direction: "DESC" },
      { limit: 2 },
    ])
      await expect(f.make().load({ ...request(), ...change, cursor })).rejects.toMatchObject({
        code: "Invalid",
      });
    for (const change of [
      { actorReference: id(99) },
      { storeReference: id(99) },
      { tenantReference: id(99) },
      { cursorKey: new Uint8Array(32).fill(8) },
    ])
      await expect(f.make(change).load({ ...request(), cursor })).rejects.toMatchObject({
        code: "Invalid",
      });
  });
  it("marks unchanged-clock root/version/token edits stale without hashing full editor content", async () => {
    for (const change of [
      { aggregateVersion: 2 },
      { draftVersionReference: id(999) },
      { localizedNames: { "en-CA": "Changed" } },
      { options: [{ ...row(10).options[0], stableCode: "CHANGED" }] },
    ]) {
      const f = fixture(),
        cursor = (await f.make().load(request())).nextCursor;
      f.setData([{ ...row(10), ...change }, row(11), row(12)]);
      await expect(f.make().load({ ...request(), cursor })).rejects.toMatchObject({
        code: "Stale",
      });
    }
    const f = fixture();
    await f.make().load(request());
    expect(
      f.query.mock.calls.find(([sql]) => sql.includes("coalesce(jsonb_agg"))?.[0],
    ).not.toContain("snapshot_json");
  });
  it.each([
    { coherent: false },
    { draftVersionReference: null },
    { defaultLocale: null },
    { brandReference: id(99) },
    { aggregateVersion: 0 },
    { localizedNames: {} },
    { displayStyle: "Unsupported" },
    { updatedAt: "2026-10-04T00:00:01.000Z" },
  ])("rejects source corruption and retains missing-Draft roots %j", async (change) => {
    await expect(
      fixture([{ ...row(10), ...change }])
        .make()
        .load(request()),
    ).rejects.toMatchObject({ code: "DependencyUnavailable" });
  });
  it("rejects incompatible isolation, missing source, absent/short cursor key", async () => {
    const isolation = fixture();
    isolation.badIsolation();
    await expect(isolation.make().load(request())).rejects.toMatchObject({
      code: "DependencyUnavailable",
    });
    const packet = fixture();
    packet.missingPacket();
    await expect(packet.make().load(request())).rejects.toMatchObject({
      code: "DependencyUnavailable",
    });
    expect(() => fixture().make({ cursorKey: new Uint8Array(31) })).toThrow();
  });
  it("refuses substituted, expired or unclosed authority proof", async () => {
    for (const mode of ["extra", "wrongClock", "expired"] as const) {
      const f = fixture();
      f.hold.mockImplementation(async (tx, input) => {
        expect(tx).toBeDefined();
        return mode === "extra"
          ? Object.assign({ observedAt: input.observedAt, validUntil: until }, { extra: true })
          : {
              observedAt: mode === "wrongClock" ? "2026-10-03T23:59:59.000Z" : input.observedAt,
              validUntil: mode === "expired" ? at : until,
            };
      });
      await expect(f.make().load(request())).rejects.toMatchObject({
        code: "DependencyUnavailable",
      });
    }
  });
  it("rechecks actual authority on before-COMMIT withdrawal", async () => {
    const f = fixture();
    f.beforeCommit(f.deny);
    await expect(f.make().load(request())).rejects.toMatchObject({ code: "Denied" });
  });
  it("refuses source latency and original lease expiry", async () => {
    const f = fixture();
    f.afterRead(() => f.advance(until));
    await expect(f.make().load(request())).rejects.toMatchObject({ code: "DependencyUnavailable" });
    await expect(
      fixture().make({ originalValidUntil: "2026-10-04T00:00:06.000Z" }).load(request()),
    ).rejects.toMatchObject({ code: "DependencyUnavailable" });
  });
  it("captures actual ports/key and refuses swallowed reentry or query substitution", async () => {
    const captured = fixture(),
      store = captured.make();
    captured.options.cursorKey.fill(9);
    Object.defineProperty(captured.options.authority, "holdUntilTransactionCompletes", {
      value: async () => {
        throw Error("replacement must not run");
      },
    });
    expect((await store.load(request())).items).toHaveLength(1);
    const recursive = fixture(),
      recursiveStore = recursive.make();
    recursive.hold.mockImplementation(async (tx, input) => {
      expect(tx).toBeDefined();
      await recursiveStore.load(request()).catch(() => undefined);
      return { observedAt: input.observedAt, validUntil: until };
    });
    await expect(recursiveStore.load(request())).rejects.toMatchObject({
      code: "DependencyUnavailable",
    });
    const substituted = fixture();
    substituted.hold.mockImplementation(async (tx, input) => {
      Object.defineProperty(tx, "query", { value: async () => ({ rows: [] }) });
      return { observedAt: input.observedAt, validUntil: until };
    });
    await expect(substituted.make().load(request())).rejects.toMatchObject({
      code: "DependencyUnavailable",
    });
  });
  it("requires exact async guard registration/completion and synchronous final assertion", async () => {
    for (const control of ["skipGuard", "skipFinal", "repeatGuard", "badRegister"] as const) {
      const f = fixture();
      f[control]();
      await expect(f.make().load(request())).rejects.toMatchObject({
        code: "DependencyUnavailable",
      });
    }
  });
});
