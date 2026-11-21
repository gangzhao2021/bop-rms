import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePricingProductPublicationReferenceRequestV2,
  parsePriceBookReferenceSourceRequest,
  buildProductPublicationPriceBookReferenceSourceSnapshotV2,
  buildProductPublicationOptionPriceReferenceSourceSnapshotV2,
  buildProductPublicationPromotionReferenceSourceSnapshotV2,
  buildProductPublicationConfigurationReferenceSourceSnapshotV2,
  parseProductPublicationPriceBookReferenceSourceSnapshotV2,
  parseProductPublicationOptionPriceReferenceSourceSnapshotV2,
  parseProductPublicationPromotionReferenceSourceSnapshotV2,
  parseProductPublicationConfigurationReferenceSourceSnapshotV2,
  createPostgresProductPublicationPriceBookReferenceSourceV2,
  createPostgresProductPublicationOptionPriceReferenceSourceV2,
  createPostgresProductPublicationPromotionReferenceSourceV2,
  createPostgresProductPublicationConfigurationReferenceSourceV2,
  buildPriceBookReferenceSourceSnapshot,
  buildOptionPriceReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
  type ProductPublicationConfigurationReferenceSourceOptionsV2,
  type PriceQuoteQueryTransaction,
  type PricingProductPublicationReferenceRequestV2,
} from "../index.js";
import {
  at,
  fixture,
  id,
  request as legacyRequest,
} from "./configuration-reference-matches.fixture.js";

const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const digest = (letter = "a") => "sha256:" + letter.repeat(64);
const until = new Date(Date.parse(at) + 5000).toISOString();
const request = (actorKind: "User" | "System" = "User") =>
  parsePricingProductPublicationReferenceRequestV2({
    profile: "PricingProductPublicationReferenceRequestV2",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    actorKind,
    operationReference: id(3),
    productReference: id(10),
    versionReference: id(1001),
    originalIntentDigest: digest(),
    replacementIntentDigest: digest("b"),
    aggregateSnapshotDigest: digest("c"),
    currentPublicationDigest: null,
    observedAt: at,
    validUntil: until,
  });
const omit = (value: object, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
function graphs() {
  const old = fixture();
  return {
    books: {
      observedAt: at,
      references: old.priceBooks.references.map((v) => ({
        reference: omit(v, ["isCurrentVersion", "temporalStatus"]),
        precise: true,
      })),
    },
    options: {
      observedAt: at,
      references: old.optionPrices.roots.flatMap<unknown>((root) => {
        const versions = old.optionPrices.versions.filter(
          (v) => v.ruleReference === root.ruleReference,
        );
        return versions.length
          ? versions.map((v) => ({
              root,
              version: omit(v, ["ruleReference", "isCurrentVersion", "temporalStatus"]),
              precise: true,
            }))
          : [{ root, version: null, precise: true }];
      }),
    },
    promotions: {
      observedAt: at,
      references: old.promotions.roots.flatMap<unknown>((root) => {
        const versions = old.promotions.versions.filter(
          (v) => v.promotionReference === root.promotionReference,
        );
        return versions.length
          ? versions.map((v) => ({
              root,
              version: omit(v, [
                "promotionReference",
                "isCurrentVersion",
                "temporalStatus",
                "catalogReferenceMode",
              ]),
              precise: true,
            }))
          : [{ root, version: null, precise: true }];
      }),
    },
  };
}
function sourceInput(r = request(), populated = true) {
  const g = graphs(),
    empty = { observedAt: at, references: [] };
  return {
    generation: populated ? "4" : "0",
    priceBooks: buildProductPublicationPriceBookReferenceSourceSnapshotV2(
      populated ? g.books : empty,
      r,
      at,
    ),
    optionPrices: buildProductPublicationOptionPriceReferenceSourceSnapshotV2(
      populated ? g.options : empty,
      r,
      at,
    ),
    promotions: buildProductPublicationPromotionReferenceSourceSnapshotV2(
      populated ? g.promotions : empty,
      r,
      at,
    ),
  };
}
function adapter({
  actorKind = "User",
  populated = false,
  missingGeneration = false,
}: { actorKind?: "User" | "System"; populated?: boolean; missingGeneration?: boolean } = {}) {
  let now = at,
    deny = false,
    head: unknown = {
      generation: missingGeneration ? null : populated ? "4" : "0",
      has_source: populated,
    },
    corrupt = false;
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  const hold = vi.fn(
    async (
      actual: PriceQuoteQueryTransaction,
      input: { readonly request: PricingProductPublicationReferenceRequestV2 },
    ) => {
      expect(actual).toBe(tx);
      expect(input.request).toEqual(request(actorKind));
      if (deny) throw new Error("private permission detail");
    },
  );
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("SELECT g.generation")) return { rows: [head] };
    if (sql.includes("jsonb_build_object")) {
      if (corrupt) return { rows: [{ source: { observedAt: at } }] };
      const g = graphs();
      const graph = sql.includes("FROM rms_pricing.price_entry e ")
        ? g.books
        : sql.includes("FROM rms_pricing.option_price_rule ")
          ? g.options
          : g.promotions;
      return { rows: [{ source: populated ? graph : { observedAt: at, references: [] } }] };
    }
    return { rows: [] };
  });
  const tx: PriceQuoteQueryTransaction = { query };
  const run = async <T>(work: (actual: PriceQuoteQueryTransaction) => Promise<T>): Promise<T> =>
    work(tx);
  const options: ProductPublicationConfigurationReferenceSourceOptionsV2 = {
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    actorKind,
    transactions: { run },
    clock: { now: () => now },
    registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      hooks.push({ guard, final });
    },
    authority: { holdUntilTransactionCompletes: hold },
    priceBookAuthority: { holdUntilTransactionCompletes: hold },
    optionPriceAuthority: { holdUntilTransactionCompletes: hold },
    promotionAuthority: { holdUntilTransactionCompletes: hold },
  };
  return {
    store: createPostgresProductPublicationConfigurationReferenceSourceV2(options),
    options,
    tx,
    query,
    hold,
    hooks,
    setNow(v: string) {
      now = v;
    },
    setHead(v: unknown) {
      head = v;
    },
    setDenied() {
      deny = true;
    },
    setCorrupt() {
      corrupt = true;
    },
    async commit() {
      for (const h of hooks) await h.guard();
      for (const h of hooks) h.final();
    },
  };
}

describe("publication Pricing requests and complete graphs", () => {
  it("keeps V1 closed and canonical snapshot bytes unchanged", () => {
    const g = graphs(),
      old = fixture();
    expect(buildPriceBookReferenceSourceSnapshot(g.books, legacyRequest, at)).toEqual(
      old.priceBooks,
    );
    expect(buildOptionPriceReferenceSourceSnapshot(g.options, legacyRequest, at)).toEqual(
      old.optionPrices,
    );
    expect(buildPromotionReferenceSourceSnapshot(g.promotions, legacyRequest, at)).toEqual(
      old.promotions,
    );
    expect(old.priceBooks.digest).toBe(
      hash({
        request: legacyRequest,
        profile: "PriceBookEntries",
        references: old.priceBooks.references,
      }),
    );
    expect(() => parsePriceBookReferenceSourceRequest(request())).toThrow();
    expect(() => parsePricingProductPublicationReferenceRequestV2(legacyRequest)).toThrow();
  });
  it("retains complete historical and unresolved graphs without tax or sale qualification", () => {
    const r = request(),
      input = sourceInput(r),
      source = buildProductPublicationConfigurationReferenceSourceSnapshotV2(input, r, at);
    expect(parseProductPublicationConfigurationReferenceSourceSnapshotV2(source, r, at)).toEqual(
      source,
    );
    expect(source).toMatchObject({
      coverage: "CompleteStoredReferences",
      taxCoverage: "Unavailable",
      consistency: "StatementSnapshots",
      validUntil: until,
    });
    expect(source.priceBooks.references[0]).toMatchObject({
      lifecycle: "Archived",
      temporalStatus: "Expired",
    });
    expect(source.optionPrices.roots).toHaveLength(2);
    expect(source.promotions.versions.map((v) => v.catalogReferenceMode)).toEqual([
      "ExplicitSellableOrCategory",
      "AllSellables",
      "OrderSubtotal",
    ]);
    expect(Object.isFrozen(source.request)).toBe(true);
    expect(Object.isFrozen(source.optionPrices.versions)).toBe(true);
  });
  it.each([
    "tenantReference",
    "brandReference",
    "actorReference",
    "actorKind",
    "operationReference",
    "productReference",
    "versionReference",
    "originalIntentDigest",
    "replacementIntentDigest",
    "aggregateSnapshotDigest",
    "currentPublicationDigest",
    "observedAt",
    "validUntil",
  ])("rejects source replay under changed %s", (field) => {
    const r = request(),
      source = buildProductPublicationConfigurationReferenceSourceSnapshotV2(sourceInput(r), r, at);
    const changed = field.endsWith("Digest")
      ? digest("f")
      : field === "actorKind"
        ? "System"
        : field === "observedAt"
          ? new Date(Date.parse(at) + 1).toISOString()
          : field === "validUntil"
            ? new Date(Date.parse(at) + 4999).toISOString()
            : id(999);
    const other = parsePricingProductPublicationReferenceRequestV2({ ...r, [field]: changed });
    expect(() =>
      parseProductPublicationConfigurationReferenceSourceSnapshotV2(
        source,
        other,
        other.observedAt,
      ),
    ).toThrow();
  });
  it.each([
    { extra: true },
    { purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" },
    { actorKind: "Service" },
    { currentPublicationDigest: "bad" },
    { validUntil: at },
    { validUntil: new Date(Date.parse(at) + 5001).toISOString() },
  ])("refuses malformed closed request %o", (changed) => {
    expect(() =>
      parsePricingProductPublicationReferenceRequestV2({ ...request(), ...changed }),
    ).toThrow();
  });
  it("does not evaluate a request getter or permit a later SQL observation to renew the original lease", () => {
    const getter = vi.fn(() => id(9)),
      r = request();
    expect(() =>
      parsePricingProductPublicationReferenceRequestV2({
        ...r,
        get tenantReference() {
          return getter();
        },
      }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const later = new Date(Date.parse(at) + 1000).toISOString();
    const source = buildProductPublicationPriceBookReferenceSourceSnapshotV2(
      { observedAt: later, references: [] },
      r,
      later,
    );
    expect(source.validUntil).toBe(until);
    expect(() =>
      parseProductPublicationPriceBookReferenceSourceSnapshotV2(source, r, until),
    ).toThrow();
    expect(() =>
      buildProductPublicationPriceBookReferenceSourceSnapshotV2(
        { observedAt: new Date(Date.parse(at) - 1).toISOString(), references: [] },
        r,
        at,
      ),
    ).toThrow();
  });
  it("rejects forged digest, derived metadata, foreign Brand and incomplete nesting", () => {
    const r = request(),
      g = graphs(),
      input = sourceInput(r);
    expect(() =>
      parseProductPublicationOptionPriceReferenceSourceSnapshotV2(
        { ...input.optionPrices, digest: digest("e") },
        r,
        at,
      ),
    ).toThrow();
    expect(() =>
      parseProductPublicationPromotionReferenceSourceSnapshotV2(
        { ...input.promotions, coverage: "Partial" },
        r,
        at,
      ),
    ).toThrow();
    expect(() =>
      buildProductPublicationConfigurationReferenceSourceSnapshotV2(
        {
          ...input,
          priceBooks: {
            ...input.priceBooks,
            validUntil: new Date(Date.parse(at) + 4000).toISOString(),
          },
        },
        r,
        at,
      ),
    ).toThrow();
    const foreign = { ...r, brandReference: id(999) };
    expect(() =>
      buildProductPublicationPriceBookReferenceSourceSnapshotV2(g.books, foreign, at),
    ).toThrow();
    expect(() =>
      buildProductPublicationOptionPriceReferenceSourceSnapshotV2(g.options, foreign, at),
    ).toThrow();
    expect(() =>
      buildProductPublicationPromotionReferenceSourceSnapshotV2(g.promotions, foreign, at),
    ).toThrow();
    expect(() =>
      buildProductPublicationPriceBookReferenceSourceSnapshotV2(
        { ...g.books, references: Array.from({ length: 1001 }, () => g.books.references[0]) },
        r,
        at,
      ),
    ).toThrow();
  });
});

describe("held publication Pricing source", () => {
  it.each(["User", "System"] as const)(
    "binds %s and the actual transaction through all original-deadline guards",
    async (actorKind) => {
      const a = adapter({ actorKind, populated: true }),
        marker = { value: true };
      await expect(
        a.store.withCurrentSnapshot(request(actorKind), async (source, tx) => {
          expect(tx).toBe(a.tx);
          expect(source.generation).toBe("4");
          expect(source.priceBooks.references).toHaveLength(1);
          expect(source.optionPrices.roots).toHaveLength(2);
          expect(source.promotions.versions).toHaveLength(3);
          expect(source.request.actorKind).toBe(actorKind);
          return marker;
        }),
      ).resolves.toBe(marker);
      await a.commit();
      expect(a.hooks).toHaveLength(4);
      expect(a.hold.mock.calls[0]?.[1]).toMatchObject({
        requiredScope: "FullBrandScope",
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
        actorKind,
      });
      expect(a.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(
        true,
      );
    },
  );
  it("accepts actual virgin empty state but refuses absent generation with a real root", async () => {
    const empty = adapter({ missingGeneration: true });
    await expect(
      empty.store.withCurrentSnapshot(request(), async (s) => s.generation),
    ).resolves.toBe("0");
    await empty.commit();
    const bad = adapter({ missingGeneration: true, populated: true }),
      work = vi.fn(async () => true);
    await expect(bad.store.withCurrentSnapshot(request(), work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    await expect(bad.commit()).rejects.toThrow();
  });
  it.each(["denied", "corrupt"])(
    "early %s remains poisoned if caller catches source failure",
    async (mode) => {
      const a = adapter(),
        work = vi.fn(async () => true);
      if (mode === "denied") a.setDenied();
      else a.setCorrupt();
      await expect(a.store.withCurrentSnapshot(request(), work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
      await expect(a.commit()).rejects.toThrow();
    },
  );
  it("caught same-factory reentry poisons the enclosing consumer and commit", async () => {
    const a = adapter();
    await expect(
      a.store.withCurrentSnapshot(request(), async () => {
        await expect(a.store.withCurrentSnapshot(request(), async () => false)).rejects.toThrow();
        return true;
      }),
    ).rejects.toThrow();
    await expect(a.commit()).rejects.toThrow();
  });
  it.each(["late-denial", "generation", "query-replacement", "clock-rewind", "expiry"])(
    "refuses %s after the consumer",
    async (mode) => {
      const a = adapter();
      await expect(
        a.store.withCurrentSnapshot(request(), async () => {
          if (mode === "late-denial") a.setDenied();
          if (mode === "generation") a.setHead({ generation: "1", has_source: false });
          if (mode === "query-replacement") a.tx.query = async () => ({ rows: [] });
          if (mode === "clock-rewind") a.setNow(new Date(Date.parse(at) - 1).toISOString());
          if (mode === "expiry") a.setNow(until);
          return true;
        }),
      ).rejects.toThrow();
      await expect(a.commit()).rejects.toThrow();
    },
  );
  it("a later awaited guard cannot exhaust an earlier Pricing lease and still commit", async () => {
    const a = adapter();
    let commits = 0;
    await a.store.withCurrentSnapshot(request(), async () => true);
    a.hooks.push({
      guard: async () => {
        await Promise.resolve();
        a.setNow(until);
      },
      final() {
        return;
      },
    });
    await expect(
      (async () => {
        await a.commit();
        commits++;
      })(),
    ).rejects.toThrow();
    expect(commits).toBe(0);
  });
  it("captures factory ports, yet refuses replaced actual transaction query", async () => {
    const a = adapter(),
      replaced = vi.fn(async () => {
        throw new Error("replacement");
      });
    a.options.clock.now = () => until;
    a.options.authority.holdUntilTransactionCompletes = replaced;
    a.options.priceBookAuthority.holdUntilTransactionCompletes = replaced;
    await expect(a.store.withCurrentSnapshot(request(), async () => true)).resolves.toBe(true);
    await a.commit();
    expect(replaced).not.toHaveBeenCalled();
  });
  it.each([
    ["PriceBook", createPostgresProductPublicationPriceBookReferenceSourceV2],
    ["OptionPrice", createPostgresProductPublicationOptionPriceReferenceSourceV2],
    ["Promotion", createPostgresProductPublicationPromotionReferenceSourceV2],
  ] as const)(
    "standalone %s leaf keeps only StatementSnapshot claims and its original final guard",
    async (_label, factory) => {
      const a = adapter();
      const leaf = factory({ ...a.options, authority: { holdUntilTransactionCompletes: a.hold } });
      const s = await leaf.loadSnapshot(request());
      expect(s.consistency).toBe("StatementSnapshot");
      a.setNow(until);
      await expect(a.commit()).rejects.toThrow();
    },
  );
});

it.each([
  ["PriceBook", createPostgresProductPublicationPriceBookReferenceSourceV2],
  ["OptionPrice", createPostgresProductPublicationOptionPriceReferenceSourceV2],
  ["Promotion", createPostgresProductPublicationPromotionReferenceSourceV2],
] as const)(
  "caught %s leaf reentry cannot be swallowed by its authority port",
  async (_label, factory) => {
    const a = adapter();
    let inside = false;
    const authority = {
      async holdUntilTransactionCompletes() {
        if (!inside) {
          inside = true;
          await expect(leaf.loadSnapshot(request())).rejects.toThrow();
        }
      },
    };
    const leaf = factory({ ...a.options, authority });
    await expect(leaf.loadSnapshot(request())).rejects.toThrow();
    await expect(a.commit()).rejects.toThrow();
  },
);
it("final commit rechecks each leaf's fields, even when the composite header is still granted", async () => {
  const a = adapter();
  let denied = false;
  a.options.promotionAuthority.holdUntilTransactionCompletes = async () => {
    if (denied) throw new Error("revoked promotion field");
  };
  const store = createPostgresProductPublicationConfigurationReferenceSourceV2(a.options);
  await store.withCurrentSnapshot(request(), async () => true);
  denied = true;
  await expect(a.commit()).rejects.toThrow();
});
it("requires callback and runner result identity and binds factory scope before any consumer", async () => {
  const a = adapter(),
    work = vi.fn(async () => true);
  await expect(
    a.store.withCurrentSnapshot({ ...request(), tenantReference: id(99) }, work),
  ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(a.hooks).toHaveLength(0);
  const b = adapter();
  const source = createPostgresProductPublicationConfigurationReferenceSourceV2({
    ...b.options,
    transactions: {
      async run<T>(action: (tx: PriceQuoteQueryTransaction) => Promise<T>): Promise<T> {
        await action(b.tx);
        return {} as T;
      },
    },
  });
  await expect(source.withCurrentSnapshot(request(), async () => true)).rejects.toThrow();
  await expect(b.commit()).rejects.toThrow();
});
