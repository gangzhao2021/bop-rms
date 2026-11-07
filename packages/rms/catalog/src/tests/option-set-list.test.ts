import { describe, it, expect } from "vitest";
import {
  CatalogOptionSetListError,
  parseOptionSetListRequest,
  parseOptionSetListView,
} from "../contracts/option-set-list.js";
const id = (n: number) => "01902421-7400-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T00:00:00.000Z";
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
  sort: "updatedAt",
  direction: "DESC",
  limit: 25,
  cursor: null,
});
const item = () => ({
  optionSetReference: id(1),
  internalCode: "SYNTHETIC",
  lifecycle: "Draft",
  aggregateVersion: 1,
  draftVersionReference: id(2),
  createdAt: at,
  updatedAt: at,
  name: "Synthetic",
  nameLocale: "en-CA",
  localeFallback: true,
  selectionRule: {
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 1,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 1,
  },
  optionCount: 1,
  activeOptionCount: 0,
  productBindingCount: 0,
  recordedPricingReference: { status: "Unknown" },
  recordedConsumptionReference: { status: "Known", present: false },
  recordedConflict: { status: "Unknown" },
  publishingStatus: { status: "Unavailable" },
  referenceEligibility: "NotEvaluated",
});
const view = () => ({
  projection: {
    name: "catalog_option_set_search_v1",
    version: 1,
    asOfUtc: at,
    stale: false,
    partial: true,
    sourceGeneration: "sha256:" + "a".repeat(64),
  },
  scope: {
    tenantReference: id(10),
    brandReference: id(11),
    storeReference: id(12),
    actorReference: id(13),
  },
  locale: "fr-CA",
  items: [item()],
  hasMore: false,
  nextCursor: null,
});
describe("ordinary Option List public boundary", () => {
  it("retains explicit locale and Unknown legacy presence without a publication claim", () => {
    const parsed = parseOptionSetListRequest(request()),
      result = parseOptionSetListView(view());
    expect(parsed.locale).toBe("fr-CA");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(result.items[0]?.selectionRule)).toBe(true);
    expect(result.items[0]?.recordedPricingReference).toEqual({ status: "Unknown" });
    expect(result.projection.partial).toBe(true);
    expect(result.projection.sourceGeneration).toBe("sha256:" + "a".repeat(64));
  });
  it.each([
    { locale: undefined },
    { locale: "wrong_locale" },
    { limit: 0 },
    { limit: 101 },
    { search: " trailing " },
    { search: "\u0000" },
    { sort: "DROP" },
    { direction: "up" },
    { includeArchived: 1 },
    { hasPricingReference: "false" },
    { publishingStatus: "NeverPublished" },
    { cursor: "" },
    { selectionType: "Radio" },
    { lifecycle: "Published" },
  ])("rejects malformed filters %j", (change) => {
    expect(() => parseOptionSetListRequest({ ...request(), ...change })).toThrow(
      CatalogOptionSetListError,
    );
  });
  it("requires every key and refuses unknown fields/getters/prototype/sparse arrays", () => {
    const { locale, ...missing } = request();
    void locale;
    expect(() => parseOptionSetListRequest(missing)).toThrow();
    expect(() => parseOptionSetListRequest({ ...request(), actorReference: id(9) })).toThrow();
    const getter = { ...request() };
    Object.defineProperty(getter, "locale", {
      enumerable: true,
      get() {
        throw Error("must not execute");
      },
    });
    expect(() => parseOptionSetListRequest(getter)).toThrow();
    expect(() => parseOptionSetListRequest(Object.create(request()))).toThrow();
    const sparse = view();
    sparse.items = new Array(1);
    expect(() => parseOptionSetListView(sparse)).toThrow();
  });
  it.each([
    { publishingStatus: { status: "Published" } },
    { referenceEligibility: "Ready" },
    { recordedPricingReference: { status: "Unknown", present: false } },
    { recordedConflict: { status: "Known", present: null } },
    { activeOptionCount: 2 },
    { aggregateVersion: 0 },
    { updatedAt: "2026-10-03T00:00:00.000Z" },
    { name: "" },
    { selectionRule: { ...item().selectionRule, maximumSelection: -1 } },
  ])("refuses invented or invalid list facts %j", (change) => {
    expect(() => parseOptionSetListView({ ...view(), items: [{ ...item(), ...change }] })).toThrow(
      CatalogOptionSetListError,
    );
  });
  it.each([
    "a".repeat(64),
    "sha256:" + "A".repeat(64),
    "sha256:" + "a".repeat(63),
    "sha512:" + "a".repeat(64),
  ])("rejects malformed prefixed source generation %s", (generation) => {
    expect(() =>
      parseOptionSetListView({
        ...view(),
        projection: { ...view().projection, sourceGeneration: generation },
      }),
    ).toThrow(CatalogOptionSetListError);
  });
  it("rejects duplicate IDs and inconsistent pagination metadata", () => {
    expect(() => parseOptionSetListView({ ...view(), items: [item(), item()] })).toThrow();
    expect(() => parseOptionSetListView({ ...view(), hasMore: true })).toThrow();
  });
});
