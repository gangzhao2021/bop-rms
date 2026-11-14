import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceResolve,
  parseBrandCatalogSourceRegisteredIdentity,
  parseBrandCatalogSourceScope,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceReceipt,
} from "../contracts/brand-catalog-source.js";

const id = (n: number) => "01902500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-06T12:00:00.000Z";
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const scope = parseBrandCatalogSourceScope({
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
});
const register = () => ({
  profile: "BrandCatalogSourceRegisterV1",
  ...scope,
  operationReference: id(4),
  code: "CATALOGUE",
  label: "Synthetic Catalogue",
});
const identity = () => ({
  profile: "BrandCatalogSourceRegisteredIdentityV1",
  tenantReference: id(1),
  brandReference: id(2),
  sourceReference: id(5),
  code: "CATALOGUE",
  label: "Synthetic Catalogue",
  registeredByReference: id(3),
  operationReference: id(4),
  auditReference: id(6),
  registeredAt: at,
  dataClassification: "ConfigurationMetadata",
});
const current = () => ({
  profile: "BrandCatalogSourceCurrentV1",
  ...scope,
  source: identity(),
  observedAt: at,
  validUntil: plus(5000),
  publicationStatus: "NotEvaluated",
  referenceEligibility: "NotEvaluated",
});
const receipt = () => ({
  profile: "BrandCatalogSourceReceiptV1",
  ...scope,
  operationReference: id(4),
  intentDigest: brandCatalogSourceIntentDigest(register()),
  outcome: "Committed",
  originalCommand: register(),
  source: identity(),
  auditReference: id(6),
  occurredAt: at,
});
const invalid = (run: () => unknown) =>
  expect(run).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

it("canonicalizes operator code/label and hashes the complete parsed original without server allocation", () => {
  const raw = { ...register(), code: " catalogue ", label: " Synthetic Catalogue " };
  const parsed = parseBrandCatalogSourceRegister(raw);
  expect(parsed).toEqual(register());
  expect(brandCatalogSourceIntentDigest(raw)).toBe(
    "sha256:" + sha256Hex(canonicalizeRfc8785(parsed)),
  );
  for (const changed of [
    { ...register(), actorReference: id(7) },
    { ...register(), brandReference: id(7) },
    { ...register(), tenantReference: id(7) },
    { ...register(), operationReference: id(7) },
    { ...register(), code: "OTHER" },
    { ...register(), label: "Other" },
  ])
    expect(brandCatalogSourceIntentDigest(changed)).not.toBe(
      brandCatalogSourceIntentDigest(register()),
    );
  const resolve = {
    profile: "BrandCatalogSourceResolveV1",
    ...scope,
    operationReference: id(4),
    intentDigest: brandCatalogSourceIntentDigest(raw),
  };
  expect(parseBrandCatalogSourceResolve(resolve)).toEqual(resolve);
  invalid(() => parseBrandCatalogSourceResolve({ ...resolve, originalCommand: raw }));
});

it("rejects unsafe operator metadata, unknown keys and non-data object descriptors without executing getters", () => {
  for (const value of ["", " ", "x".repeat(201), "a\nb", "a\u0000b", "a\u0085b"])
    invalid(() => parseBrandCatalogSourceRegister({ ...register(), label: value }));
  expect(
    parseBrandCatalogSourceRegister({ ...register(), label: "x".repeat(200) }).label,
  ).toHaveLength(200);
  for (const value of ["", "a b", "a/b"])
    invalid(() => parseBrandCatalogSourceRegister({ ...register(), code: value }));
  const getter = vi.fn(() => id(1));
  const raw = Object.defineProperty(register(), "tenantReference", {
    get: getter,
    enumerable: true,
  });
  invalid(() => parseBrandCatalogSourceRegister(raw));
  expect(getter).not.toHaveBeenCalled();
  invalid(() => parseBrandCatalogSourceRegister({ ...register(), sourceReference: id(5) }));
  invalid(() =>
    parseBrandCatalogSourceRegister(Object.assign(Object.create({ inherited: true }), register())),
  );
  invalid(() => parseBrandCatalogSourceRegister({ ...register(), [Symbol("unknown")]: true }));
  invalid(() =>
    parseBrandCatalogSourceRegister(
      Object.defineProperty(register(), "label", { value: "Hidden", enumerable: false }),
    ),
  );
  invalid(() => parseBrandCatalogSourceRegister({ ...register(), label: [] }));
});

it("detaches and freezes nested committed identity and original facts", () => {
  const raw = receipt(),
    result = parseBrandCatalogSourceReceipt(raw);
  raw.originalCommand.label = "Changed";
  raw.source.label = "Changed";
  expect(result.originalCommand?.label).toBe("Synthetic Catalogue");
  expect(result.source?.label).toBe("Synthetic Catalogue");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.originalCommand)).toBe(true);
  expect(Object.isFrozen(result.source)).toBe(true);
  expect(parseBrandCatalogSourceRegisteredIdentity(identity())).toEqual(identity());
});

it("requires every committed original, identity, Audit, Actor, scope, intent and time to agree", () => {
  const raw = receipt();
  for (const patch of [
    { actorReference: id(7) },
    { tenantReference: id(7) },
    { brandReference: id(7) },
    { operationReference: id(7) },
    { intentDigest: "sha256:" + "0".repeat(64) },
    { auditReference: id(7) },
    { occurredAt: plus(1) },
    { originalCommand: null },
    { source: null },
    { outcome: "Unknown" },
    { qualification: "Approved" },
  ])
    invalid(() => parseBrandCatalogSourceReceipt({ ...raw, ...patch }));
  for (const patch of [
    { tenantReference: id(7) },
    { brandReference: id(7) },
    { registeredByReference: id(7) },
    { operationReference: id(7) },
    { auditReference: id(7) },
    { registeredAt: plus(1) },
    { code: "OTHER" },
    { label: "Other" },
    { dataClassification: "Public" },
  ])
    invalid(() => parseBrandCatalogSourceReceipt({ ...raw, source: { ...identity(), ...patch } }));
  invalid(() =>
    parseBrandCatalogSourceReceipt({ ...raw, originalCommand: { ...register(), label: "Other" } }),
  );
});

it("preserves scalar Abandoned intent without inventing the unknown original or source", () => {
  const abandoned = {
    ...receipt(),
    outcome: "Abandoned",
    originalCommand: null,
    source: null,
    intentDigest: "sha256:" + "a".repeat(64),
  };
  expect(parseBrandCatalogSourceReceipt(abandoned)).toEqual(abandoned);
  invalid(() => parseBrandCatalogSourceReceipt({ ...abandoned, originalCommand: register() }));
  invalid(() => parseBrandCatalogSourceReceipt({ ...abandoned, source: identity() }));
});

it("binds current Reader independently from the historical registrant and refuses stale or positive eligibility envelopes", () => {
  const reader = parseBrandCatalogSourceScope({ ...scope, actorReference: id(7) });
  const raw = { ...current(), actorReference: id(7) };
  expect(
    parseBrandCatalogSourceCurrent(raw, reader, plus(4999)).source?.registeredByReference,
  ).toBe(id(3));
  expect(parseBrandCatalogSourceCurrent({ ...raw, source: null }, reader, at).source).toBeNull();
  invalid(() => parseBrandCatalogSourceCurrent(raw, scope, at));
  invalid(() => parseBrandCatalogSourceCurrent(raw, reader, plus(-1)));
  invalid(() => parseBrandCatalogSourceCurrent(raw, reader, plus(5000)));
  for (const patch of [
    { validUntil: plus(5001) },
    { validUntil: at },
    { observedAt: plus(1) },
    { publicationStatus: "Published" },
    { referenceEligibility: "Eligible" },
    { productReference: id(9) },
    { source: { ...identity(), brandReference: id(8) } },
    { source: { ...identity(), tenantReference: id(8) } },
    { source: { ...identity(), registeredAt: plus(1) } },
  ])
    invalid(() => parseBrandCatalogSourceCurrent({ ...raw, ...patch }, reader, at));
});

it("binds the exact requested real source identity and permits actual absence", () => {
  const raw = {
    ...current(),
    profile: "BrandCatalogSourceExactV1",
    requestedSourceReference: id(5),
  };
  expect(parseBrandCatalogSourceExact(raw, scope, id(5), at).source?.sourceReference).toBe(id(5));
  expect(
    parseBrandCatalogSourceExact({ ...raw, source: null }, scope, id(5), at).source,
  ).toBeNull();
  invalid(() => parseBrandCatalogSourceExact(raw, scope, id(8), at));
  invalid(() =>
    parseBrandCatalogSourceExact(
      { ...raw, source: { ...identity(), sourceReference: id(8) } },
      scope,
      id(5),
      at,
    ),
  );
  invalid(() => parseBrandCatalogSourceCurrent(raw, scope, at));
});
