import { describe, expect, it } from "vitest";
import {
  CatalogError,
  parseMenuCategoryBindings,
  parseReviewedMenuContent,
  parsePublishedMenuSnapshot,
  createMenuReviewContent,
  type ReviewedMenuContent,
  type CatalogReference,
} from "../index.js";
const id = (n: number) =>
  `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as CatalogReference;
const packet = () => [{ sectionReference: id(1), categoryReferences: [id(4), id(3)] }];
const sections = [id(1)];
function content(): ReviewedMenuContent {
  return {
    brandReference: id(10),
    menuReference: id(11),
    menuVersionReference: id(12),
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic menu" },
    storeReferences: [],
    channelCodes: ["WEB" as never],
    orderTypeCodes: ["PICKUP" as never],
    sections: [
      {
        sectionReference: id(1),
        internalCode: "SECTION" as never,
        localizedNames: { "en-CA": "Synthetic section" },
        sortOrder: 0,
        sellables: [],
      },
    ],
  };
}
describe("internal reviewed Menu Category bindings", () => {
  it("keeps legacy absence distinct from complete empty section coverage", () => {
    expect(Object.hasOwn(parseReviewedMenuContent(content()), "categoryBindings")).toBe(false);
    const empty = parseReviewedMenuContent({
      ...content(),
      categoryBindings: [{ sectionReference: id(1), categoryReferences: [] }],
    });
    expect(empty.categoryBindings).toEqual([{ sectionReference: id(1), categoryReferences: [] }]);
    expect(
      parseReviewedMenuContent({ ...content(), sections: [], categoryBindings: [] })
        .categoryBindings,
    ).toEqual([]);
    expect(() =>
      parseReviewedMenuContent({
        ...content(),
        categoryBindings: undefined,
      } as unknown as ReviewedMenuContent),
    ).toThrow(CatalogError);
  });
  it("canonicalizes, copies and freezes the complete packet", () => {
    const input = packet();
    const parsed = parseMenuCategoryBindings(input, sections);
    input[0]?.categoryReferences.push(id(9));
    expect(parsed).toEqual([{ sectionReference: id(1), categoryReferences: [id(3), id(4)] }]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(Object.isFrozen(parsed[0]?.categoryReferences)).toBe(true);
    expect(
      parseMenuCategoryBindings(
        [{ sectionReference: id(2), categoryReferences: [] }, ...packet()],
        [id(2), id(1)],
      ).map((entry) => entry.sectionReference),
    ).toEqual([id(1), id(2)]);
  });
  it.each([
    null,
    {},
    [],
    [null],
    [packet()[0], packet()[0]],
    [{ sectionReference: id(2), categoryReferences: [] }],
    [{ sectionReference: id(1), categoryReferences: [id(3), id(3)] }],
    [{ sectionReference: id(1), categoryReferences: ["invalid"] }],
    [{ sectionReference: id(1), categoryReferences: [], brandReference: id(10) }],
    [{ sectionReference: id(1), categoryReferences: [], permission: "catalog.manage" }],
    [{ sectionReference: id(1), categoryReferences: null }],
  ])("rejects incomplete, duplicate, foreign or forged input %j", (input) => {
    expect(() => parseMenuCategoryBindings(input, sections)).toThrow(CatalogError);
  });
  it("rejects getters, sparse arrays, symbols and hostile proxies without reading accessors", () => {
    let called = 0;
    const getter = {
      sectionReference: id(1),
      get categoryReferences() {
        called++;
        return [];
      },
    };
    const indexed: unknown[] = [];
    Object.defineProperty(indexed, "0", {
      enumerable: true,
      get() {
        called++;
        return packet()[0];
      },
    });
    const symbolic = [...packet()];
    Object.defineProperty(symbolic, Symbol(), { value: true });
    for (const input of [
      [getter],
      indexed,
      new Array(1),
      symbolic,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("private");
          },
        },
      ),
    ])
      expect(() => parseMenuCategoryBindings(input, sections)).toThrow(CatalogError);
    const review = {
      ...content(),
      get categoryBindings() {
        called++;
        return packet();
      },
    };
    expect(() => parseReviewedMenuContent(review)).toThrow(CatalogError);
    expect(called).toBe(0);
  });
  it("bounds per-section and total reference budgets", () => {
    expect(() =>
      parseMenuCategoryBindings(
        Array.from({ length: 10001 }, (_, n) => ({
          sectionReference: id(n),
          categoryReferences: [],
        })),
        [],
      ),
    ).toThrow(CatalogError);
    expect(() =>
      parseMenuCategoryBindings(
        [
          {
            sectionReference: id(1),
            categoryReferences: Array.from({ length: 10001 }, (_, n) => id(n)),
          },
        ],
        sections,
      ),
    ).toThrow(CatalogError);
    const entries = Array.from({ length: 6 }, (_, n) => ({
      sectionReference: id(n),
      categoryReferences: Array.from({ length: 10000 }, (_, k) => id(k)),
    }));
    expect(() =>
      parseMenuCategoryBindings(
        entries,
        entries.map((entry) => entry.sectionReference),
      ),
    ).toThrow(CatalogError);
  });
  it("binds immutable review digest to complete Category facts and preserves legacy digest", () => {
    const base = {
      lifecycleReference: id(20),
      configurationDigest: `sha256:${"a".repeat(64)}`,
      createdByActorReference: id(21),
      createdAt: "2026-09-28T12:00:00.000Z",
    };
    const legacy = createMenuReviewContent({ ...base, content: content() });
    const known = createMenuReviewContent({
      ...base,
      content: parseReviewedMenuContent({ ...content(), categoryBindings: packet() }),
    });
    const empty = createMenuReviewContent({
      ...base,
      content: {
        ...content(),
        categoryBindings: [{ sectionReference: id(1), categoryReferences: [] }],
      },
    });
    expect(known.snapshotDigest).not.toBe(legacy.snapshotDigest);
    expect(known.snapshotDigest).not.toBe(empty.snapshotDigest);
    expect(empty.snapshotDigest).not.toBe(legacy.snapshotDigest);
    expect(createMenuReviewContent({ ...base, content: legacy.content })).toEqual(legacy);
    expect(createMenuReviewContent({ ...base, content: known.content })).toEqual(known);
  });
  it("excludes internal Category bindings from public Customer snapshots", () => {
    const parsed = parsePublishedMenuSnapshot({
      ...content(),
      categoryBindings: packet(),
      releaseReference: id(30),
      snapshotDigest: `sha256:${"b".repeat(64)}` as never,
      timeZone: "UTC",
      effectiveFrom: "2026-09-28T12:00:00.000Z" as never,
      effectiveUntil: null,
    } as Parameters<typeof parsePublishedMenuSnapshot>[0]);
    expect(Object.hasOwn(parsed, "categoryBindings")).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(id(3));
    expect(parsed.sections[0]?.sectionReference).toBe(id(1));
  });
});
