import { expect, it } from "vitest";
import {
  parseCatalogOptionSetHistoryRequest,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoricalDraftRequest,
  parseCatalogOptionSetHistoricalFrozenRequest,
} from "../contracts/option-set-history.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T00:00:00.000Z",
  until = "2026-10-05T00:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = () => ({
  optionSetReference: id(1),
  expectedAggregateVersion: null,
  before: null,
  limit: 2,
});
const entry = (kind = "DraftSnapshot") => ({
  resultAggregateVersion: 2,
  operationReference: id(9),
  kind,
  action: "Publish",
  occurredAt: at,
  availability: "Complete",
  versionReference: id(kind === "FrozenSeal" ? 2 : 3),
  sourceAggregateVersion: kind === "FrozenSeal" ? 1 : 2,
  sourceDigest: digest,
  contentDigest: digest,
  configurationDigest: digest,
  recordDigest: kind === "FrozenSeal" ? digest : null,
});
const result = () => ({
  profile: "CatalogOptionSetHistoryV1",
  tenantReference: id(10),
  brandReference: id(11),
  optionSetReference: id(1),
  currentAggregateVersion: 2,
  entries: [entry("FrozenSeal"), entry()],
  nextBefore: null,
  observedAt: at,
  validUntil: until,
  publicationStatus: "NotEvaluated",
});
it("retains independent old Frozen and successor Draft entries for one original Publish", () => {
  const value = parseCatalogOptionSetHistoryResult(result(), request());
  expect(value.entries.map((e) => [e.kind, e.versionReference, e.sourceAggregateVersion])).toEqual([
    ["FrozenSeal", id(2), 1],
    ["DraftSnapshot", id(3), 2],
  ]);
  expect(value.publicationStatus).toBe("NotEvaluated");
  expect(Object.isFrozen(value.entries)).toBe(true);
});
it.each([0, 51, 1.5, NaN])("rejects invalid bounded history limit %s", (limit) => {
  expect(() => parseCatalogOptionSetHistoryRequest({ ...request(), limit })).toThrow();
});
it("requires captured revision on continuation and never accepts a free cursor", () => {
  const before = { resultAggregateVersion: 2, operationReference: id(9), kind: "DraftSnapshot" };
  expect(() => parseCatalogOptionSetHistoryRequest({ ...request(), before })).toThrow();
  expect(
    parseCatalogOptionSetHistoryRequest({ ...request(), expectedAggregateVersion: 2, before })
      .before,
  ).toEqual(before);
  expect(() => parseCatalogOptionSetHistoryRequest({ ...request(), cursor: "unowned" })).toThrow();
});
it.each([
  "order",
  "duplicate",
  "future",
  "root",
  "next",
  "availability",
  "digest",
  "published",
  "frozenRevision",
])("refuses incoherent %s history results", (kind) => {
  const r = result(),
    first = r.entries[0];
  if (!first) throw Error("Missing controlled first header");
  if (kind === "order") r.entries.reverse();
  if (kind === "duplicate") r.entries = [entry(), entry()];
  if (kind === "future") first.occurredAt = until;
  if (kind === "root") r.currentAggregateVersion = 1;
  if (kind === "next")
    Object.assign(r, {
      nextBefore: { resultAggregateVersion: 2, operationReference: id(99), kind: "DraftSnapshot" },
    });
  if (kind === "availability") first.availability = "UnavailableLegacy";
  if (kind === "digest") first.sourceDigest = "not-a-digest";
  if (kind === "published") r.publicationStatus = "Published";
  if (kind === "frozenRevision") first.sourceAggregateVersion = 2;
  expect(() => parseCatalogOptionSetHistoryResult(r, request())).toThrow();
});
it("preserves missing legacy content explicitly without fabricated version or digest", () => {
  const r = result();
  Object.assign(r, {
    entries: [
      {
        resultAggregateVersion: 1,
        operationReference: id(8),
        kind: "OperationOnly",
        action: "Create",
        occurredAt: at,
        availability: "UnavailableLegacy",
        versionReference: null,
        sourceAggregateVersion: null,
        sourceDigest: null,
        contentDigest: null,
        configurationDigest: null,
        recordDigest: null,
      },
    ],
  });
  expect(parseCatalogOptionSetHistoryResult(r, request()).entries[0]).toMatchObject({
    availability: "UnavailableLegacy",
    kind: "OperationOnly",
    versionReference: null,
  });
});
it("rejects request accessors without invoking them", () => {
  let calls = 0;
  const r = request();
  Object.defineProperty(r, "limit", {
    enumerable: true,
    get() {
      calls++;
      return 2;
    },
  });
  expect(() => parseCatalogOptionSetHistoryRequest(r)).toThrow();
  expect(calls).toBe(0);
});
it("pins historical Draft to operation and revision as well as version and every digest", () => {
  const r = {
    optionSetReference: id(1),
    operationReference: id(9),
    versionReference: id(3),
    resultAggregateVersion: 2,
    expectedSourceDigest: digest,
    expectedContentDigest: digest,
    expectedConfigurationDigest: digest,
  };
  expect(parseCatalogOptionSetHistoricalDraftRequest(r)).toEqual(r);
  const { operationReference, ...missing } = r;
  void operationReference;
  expect(() => parseCatalogOptionSetHistoricalDraftRequest(missing)).toThrow();
  expect(() =>
    parseCatalogOptionSetHistoricalDraftRequest({ ...r, resultAggregateVersion: 0 }),
  ).toThrow();
});

it("requires the complete Frozen original tuple and record digest without free kind or Published claim", () => {
  const selected = {
    optionSetReference: id(1),
    operationReference: id(9),
    versionReference: id(2),
    resultAggregateVersion: 2,
    expectedSourceDigest: digest,
    expectedContentDigest: digest,
    expectedConfigurationDigest: digest,
    expectedRecordDigest: digest,
  };
  expect(parseCatalogOptionSetHistoricalFrozenRequest(selected)).toEqual(selected);
  const { expectedRecordDigest, ...missing } = selected;
  void expectedRecordDigest;
  expect(() => parseCatalogOptionSetHistoricalFrozenRequest(missing)).toThrow();
  expect(() =>
    parseCatalogOptionSetHistoricalFrozenRequest({ ...selected, kind: "Published" }),
  ).toThrow();
  expect(() =>
    parseCatalogOptionSetHistoricalFrozenRequest({ ...selected, expectedRecordDigest: "invalid" }),
  ).toThrow();
  let reads = 0;
  expect(() =>
    parseCatalogOptionSetHistoricalFrozenRequest({
      ...selected,
      get expectedRecordDigest() {
        reads++;
        return digest;
      },
    }),
  ).toThrow();
  expect(reads).toBe(0);
});
