import { expect, it, vi } from "vitest";
import {
  matchOptionDraftPriceReferenceMetadata as match,
  buildConfigurationReferenceSourceSnapshot,
  buildPriceBookReferenceSourceSnapshot,
  buildOptionPriceReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
} from "../index.js";
const id = (n: number) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
function row(
  rootOverrides: Record<string, unknown> = {},
  versionOverrides: Record<string, unknown> = {},
) {
  return {
    root: {
      ruleReference: id(4),
      brandReference: id(1),
      bindingReference: id(5),
      optionReference: id(6),
      aggregateVersion: "2",
      currentVersionReference: id(7),
      rootCreatedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...rootOverrides,
    },
    version: {
      versionReference: id(7),
      versionNumber: "2",
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      lifecycle: "Published",
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      timeZone: "UTC",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      ...versionOverrides,
    },
    precise: true,
  };
}

function snapshot(rows: unknown[] = [row()]) {
  const empty = { observedAt: at, references: [] };
  return buildConfigurationReferenceSourceSnapshot(
    {
      generation: "1",
      priceBooks: buildPriceBookReferenceSourceSnapshot(empty, request, at),
      optionPrices: buildOptionPriceReferenceSourceSnapshot(
        { observedAt: at, references: rows },
        request,
        at,
      ),
      promotions: buildPromotionReferenceSourceSnapshot(empty, request, at),
    },
    request,
    at,
  );
}
const target = () => ({
  profile: "CurrentFullOptionDraftPricePinsV1",
  brandReference: id(1),
  optionSetReference: id(100),
  versionReference: id(101),
  sourceDigest: "sha256:" + "b".repeat(64),
  contentDigest: "sha256:" + "c".repeat(64),
  configurationDigest: "sha256:" + "d".repeat(64),
  optionPins: [{ optionReference: id(6), ruleReference: id(4), versionReference: id(7) }],
});
it("matches exact current Published metadata while leaving binding/scope/amounts unqualified", () => {
  const r = match(target(), snapshot(), request, at, at);
  expect(r.references[0]?.status).toBe("CurrentPublishedMetadata");
  expect(r.decision).toBe("PassForMetadata");
  expect(r.bindingMembership).toBe("NotEvaluated");
  expect(r.priceAmounts).toBe("NotEvaluated");
  expect(r.eligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(r.references)).toBe(true);
  expect(r.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it.each(["rule", "version", "option"])(
  "missing/mismatched %s yields hard metadata error",
  (key) => {
    const t = target();
    if (key === "rule")
      t.optionPins[0] = { optionReference: id(6), ruleReference: id(999), versionReference: id(7) };
    if (key === "version")
      t.optionPins[0] = { optionReference: id(6), ruleReference: id(4), versionReference: id(999) };
    if (key === "option")
      t.optionPins[0] = { optionReference: id(999), ruleReference: id(4), versionReference: id(7) };
    const r = match(t, snapshot(), request, at, at);
    expect(r.decision).toBe("HardError");
    expect(r.references[0]?.status).toBe(
      { rule: "MissingRule", version: "MissingVersion", option: "WrongOption" }[key],
    );
  },
);
it.each(["Draft", "Archived"])("stored %s is not Published metadata", (lifecycle) => {
  const r = match(target(), snapshot([row({}, { lifecycle })]), request, at, at);
  expect(r.references[0]?.status).toBe("NotPublished");
});
it("historical pin cannot replace current head", () => {
  const r = match(target(), snapshot([row({ currentVersionReference: null })]), request, at, at);
  expect(r.references[0]?.status).toBe("NotCurrent");
});
it.each(["Future", "Expired"])("current observed period %s refuses metadata", (mode) => {
  const period =
    mode === "Future" ? { effectiveFrom: "2026-10-01T00:00:00.000Z" } : { effectiveUntil: at };
  const r = match(target(), snapshot([row({}, period)]), request, at, at);
  expect(r.references[0]?.status).toBe("NotEffective");
});
it("proposed activation at exclusive end refuses metadata", () => {
  const end = "2026-09-29T12:00:10.000Z";
  const r = match(target(), snapshot([row({}, { effectiveUntil: end })]), request, at, end);
  expect(r.references[0]?.status).toBe("ActivationOutsidePeriod");
});
it("empty references still parse complete owning source and remain unqualified", () => {
  const t = { ...target(), optionPins: [] };
  expect(match(t, snapshot([]), request, at, at).decision).toBe("PassForMetadata");
  expect(() => match(t, { ...snapshot([]), coverage: "Partial" }, request, at, at)).toThrowError(
    expect.objectContaining({ code: "PRICING_REFERENCE_MATCH_UNAVAILABLE" }),
  );
});
it.each(["brandReference", "profile", "sourceDigest"])("invalid %s refuses", (key) => {
  const t = { ...target(), [key]: "invalid" };
  expect(() => match(t, snapshot(), request, at, at)).toThrow();
});
it("duplicate/oversize pins, extra Ready and getters refuse", () => {
  const t = target(),
    pin = t.optionPins[0];
  if (!pin) throw new Error("synthetic pin absent");
  for (const pins of [
    [pin, pin],
    Array.from({ length: 101 }, (_, n) => ({ ...pin, optionReference: id(1000 + n) })),
  ])
    expect(() => match({ ...t, optionPins: pins }, snapshot(), request, at, at)).toThrow();
  expect(() => match({ ...t, Ready: true }, snapshot(), request, at, at)).toThrow();
  const getter = vi.fn(() => t.optionPins);
  Object.defineProperty(t, "optionPins", { get: getter, enumerable: true });
  expect(() => match(t, snapshot(), request, at, at)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("mutating delivered caller pins cannot change immutable output", () => {
  const t = target(),
    r = match(t, snapshot(), request, at, at);
  t.optionPins[0] = { optionReference: id(900), ruleReference: id(901), versionReference: id(902) };
  expect(r.references[0]?.optionReference).toBe(id(6));
  expect(Object.isFrozen(r.references[0])).toBe(true);
});

const originalClock = () => ({
  profile: "OptionPublicationOriginalClockV1",
  operationReference: request.operationReference,
  catalogIntentDigest: request.catalogIntentDigest,
  observedAt: at,
  validUntil: "2026-09-29T12:00:05.000Z",
});
it("accepts immediate original activation during a forward current read without changing actual effective checks", () => {
  const now = "2026-09-29T12:00:01.000Z";
  const value = match(target(), snapshot(), request, now, at, originalClock());
  expect(value.references[0]?.status).toBe("CurrentPublishedMetadata");
  expect(value.originalPublicationClock).toEqual(originalClock());
  expect(value.activationAt).toBe(at);
  expect(() => match(target(), snapshot(), request, now, at)).toThrow();
  const expired = snapshot([row({}, { effectiveUntil: "2026-09-29T12:00:00.500Z" })]);
  expect(match(target(), expired, request, now, at, originalClock()).references[0]?.status).toBe(
    "NotEffective",
  );
});
it.each([
  { profile: "Other" },
  { operationReference: id(99) },
  { catalogIntentDigest: "sha256:" + "f".repeat(64) },
  { observedAt: "2026-09-29T12:00:02.000Z" },
  { validUntil: "2026-09-29T12:00:01.000Z", observedAt: "2026-09-29T11:59:56.000Z" },
  { validUntil: "2026-09-29T12:00:05.001Z" },
  { extra: true },
])("rejects rebound or invalid original publication clock %#", (patch) => {
  expect(() =>
    match(target(), snapshot(), request, "2026-09-29T12:00:01.000Z", at, {
      ...originalClock(),
      ...patch,
    }),
  ).toThrow();
});
it("refuses clock accessors without invoking them and keeps original expiry exclusive", () => {
  const getter = vi.fn(() => at);
  const clock = Object.defineProperty(originalClock(), "observedAt", {
    enumerable: true,
    get: getter,
  });
  expect(() => match(target(), snapshot(), request, at, at, clock)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    match(target(), snapshot(), request, "2026-09-29T12:00:05.000Z", at, originalClock()),
  ).toThrow();
  expect(() =>
    match(target(), snapshot(), request, at, "2026-09-29T11:59:59.999Z", originalClock()),
  ).toThrow();
});
