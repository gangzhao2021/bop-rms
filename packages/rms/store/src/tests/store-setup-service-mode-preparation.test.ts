import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createUnconfiguredStoreSetupDraftContent,
  parseStoreSetupDraft,
} from "../contracts/store-setup-draft.js";
import { parseStoreSetupCurrent } from "../contracts/store-setup-operation.js";
import {
  createStoreSetupServiceModePreparation,
  createStoreSetupServiceModePreparationFromRecordedRevision,
  parseStoreSetupServiceModePreparation,
  revalidateStoreSetupServiceModePreparation,
  storeSetupServiceModePreparationSemanticallyEqual,
} from "../contracts/store-setup-service-mode-preparation.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
const later = "2026-10-05T10:00:10.000Z";
// Controlled digest ports, not held authority or evidence of publication.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalize(Object.getOwnPropertyDescriptor(value, k)?.value)}`,
      )
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Unsupported digest input");
  return text;
}
const hashIntent = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const references = () => ({ canonicalize, hashIntent });
function current(
  revision = 1,
  observedAt = at,
  change: Record<string, unknown> = {},
  content: Record<string, unknown> = {},
) {
  const snapshot = parseStoreSetupDraft({
    profile: "StoreSetupDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(6),
    revision,
    authoredByReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: {
      ...createUnconfiguredStoreSetupDraftContent(),
      enabledServiceModes: { state: "Configured", value: ["Delivery", "Pickup"] },
      ...content,
    },
    createdAt: at,
    updatedAt: observedAt,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
    ...change,
  });
  return parseStoreSetupCurrent({
    profile: "StoreSetupCurrentV1",
    tenantReference: snapshot.tenantReference,
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    readerActorReference: id(9),
    snapshot,
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    businessReferenceValidation: "NotEvaluated",
  });
}
describe("Store setup service mode preparation", () => {
  it("retains full owning provenance, canonical Delivery, and a distinct current reader without qualification", () => {
    const source = current(),
      ports = references(),
      value = createStoreSetupServiceModePreparation(source, ports, at);
    expect(Object.keys(value)).toHaveLength(13);
    expect(value.serviceModes).toEqual(["Pickup", "Delivery"]);
    expect(value.sourceSnapshotDigest).toBe(hashIntent(canonicalize(source.snapshot)));
    expect(value).toMatchObject({
      setupDraftReference: id(6),
      sourceRevision: 1,
      publicationStatus: "NotPublished",
      businessReferenceValidation: "NotEvaluated",
      observedAt: at,
      validUntil: source.validUntil,
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.serviceModes)).toBe(true);
    expect(parseStoreSetupServiceModePreparation(value, ports, at)).toEqual(value);
  });
  it("refuses absent and unconfigured sources rather than choosing default modes", () => {
    const source = current();
    expect(() =>
      createStoreSetupServiceModePreparation({ ...source, snapshot: null }, references(), at),
    ).toThrow(expect.objectContaining({ code: "STORE_SETUP_INCOMPLETE" }));
    expect(() =>
      createStoreSetupServiceModePreparation(
        current(1, at, {}, { enabledServiceModes: { state: "Unconfigured" } }),
        references(),
        at,
      ),
    ).toThrow(expect.objectContaining({ code: "STORE_SETUP_INCOMPLETE" }));
  });
  it("revalidates semantics after an unrelated Tax selection while retaining expired original provenance", () => {
    const ports = references(),
      old = createStoreSetupServiceModePreparation(current(), ports, at),
      original = canonicalize(old);
    const next = current(
      2,
      later,
      {},
      { taxConfigurationReference: { state: "Configured", value: id(20) } },
    );
    const fresh = createStoreSetupServiceModePreparation(next, ports, later);
    expect(fresh.sourceSnapshotDigest).not.toBe(old.sourceSnapshotDigest);
    expect(fresh.semanticDigest).toBe(old.semanticDigest);
    expect(revalidateStoreSetupServiceModePreparation(old, next, ports, later)).toBe(true);
    expect(storeSetupServiceModePreparationSemanticallyEqual(old, fresh, ports)).toBe(true);
    expect(canonicalize(old)).toBe(original);
    expect(() => parseStoreSetupServiceModePreparation(old, ports, later)).toThrow(
      expect.objectContaining({ code: "STORE_SETUP_STATE_INVALID" }),
    );
  });
  it.each([
    { setupDraftReference: id(21) },
    { tenantReference: id(22) },
    { brandReference: id(23) },
    { storeReference: id(24) },
  ])("refuses changed scope or setup identity %j", (change) => {
    const ports = references(),
      original = createStoreSetupServiceModePreparation(current(), ports, at);
    expect(
      revalidateStoreSetupServiceModePreparation(original, current(2, later, change), ports, later),
    ).toBe(false);
  });
  it("refuses changed modes, rollback, and changed immutable provenance at the same revision", () => {
    const ports = references(),
      original = createStoreSetupServiceModePreparation(current(2), ports, at);
    expect(
      revalidateStoreSetupServiceModePreparation(
        original,
        current(3, later, {}, { enabledServiceModes: { state: "Configured", value: ["DineIn"] } }),
        ports,
        later,
      ),
    ).toBe(false);
    expect(
      revalidateStoreSetupServiceModePreparation(original, current(1, later), ports, later),
    ).toBe(false);
    expect(
      revalidateStoreSetupServiceModePreparation(
        original,
        current(
          2,
          later,
          {},
          { taxConfigurationReference: { state: "Configured", value: id(20) } },
        ),
        ports,
        later,
      ),
    ).toBe(false);
  });
  it("rejects expired and future observations, forged semantic hashes, foreign snapshot scope and sparse modes", () => {
    const ports = references(),
      source = current(),
      value = createStoreSetupServiceModePreparation(source, ports, at);
    for (const observation of ["2026-10-05T09:59:59.999Z", source.validUntil])
      expect(() => parseStoreSetupServiceModePreparation(value, ports, observation)).toThrow();
    for (const change of [
      { semanticDigest: `sha256:${"a".repeat(64)}` },
      { sourceSnapshotDigest: "bad" },
      { extra: true },
      { serviceModes: new Array(2) },
      { validUntil: "2026-10-05T10:00:05.001Z" },
    ])
      expect(() =>
        parseStoreSetupServiceModePreparation({ ...value, ...change }, ports, at),
      ).toThrow();
    expect(() =>
      createStoreSetupServiceModePreparation({ ...source, brandReference: id(30) }, ports, at),
    ).toThrow();
  });
  it("does not evaluate accessor fields or unsafe digest port output", () => {
    let touched = false;
    const value = { ...createStoreSetupServiceModePreparation(current(), references(), at) };
    Object.defineProperty(value, "serviceModes", {
      enumerable: true,
      get() {
        touched = true;
        return ["Pickup"];
      },
    });
    expect(() => parseStoreSetupServiceModePreparation(value, references(), at)).toThrow();
    expect(touched).toBe(false);
    expect(() =>
      createStoreSetupServiceModePreparation(
        current(),
        { canonicalize: () => "{}", hashIntent },
        at,
      ),
    ).toThrow();
    expect(() =>
      createStoreSetupServiceModePreparation(
        current(),
        { canonicalize, hashIntent: () => "bad" },
        at,
      ),
    ).toThrow();
    const ports = references();
    ports.canonicalize = (input) => {
      ports.hashIntent = () => `sha256:${"a".repeat(64)}`;
      return canonicalize(input);
    };
    expect(() => createStoreSetupServiceModePreparation(current(), ports, at)).toThrow(
      expect.objectContaining({ code: "STORE_SETUP_STATE_INVALID" }),
    );
  });
});

function recordedRevision() {
  const source = current();
  return {
    profile: "StoreSetupRecordedRevisionV1",
    tenantReference: source.tenantReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    readerActorReference: id(40),
    snapshot: source.snapshot,
    observedAt: later,
    validUntil: "2026-10-05T10:00:15.000Z",
    recordingStatus: "Recorded",
  };
}
describe("Store service mode recorded revision preparation", () => {
  it("retains the actual old snapshot and digest under a fresh historical read lease", () => {
    const recorded = recordedRevision();
    const ports = references();
    const original = createStoreSetupServiceModePreparation(current(), ports, at);
    const historical = createStoreSetupServiceModePreparationFromRecordedRevision(
      recorded,
      ports,
      later,
    );
    expect(historical.sourceRevision).toBe(1);
    expect(historical.sourceSnapshotDigest).toBe(original.sourceSnapshotDigest);
    expect(historical.semanticDigest).toBe(original.semanticDigest);
    expect(historical).toMatchObject({
      observedAt: later,
      validUntil: recorded.validUntil,
      publicationStatus: "NotPublished",
      businessReferenceValidation: "NotEvaluated",
    });
    expect(historical.serviceModes).toEqual(["Pickup", "Delivery"]);
    expect(recorded.snapshot?.updatedAt).toBe(at);
  });
  it("keeps recorded history separate from genuine current creation and revalidation", () => {
    const recorded = recordedRevision();
    const ports = references();
    const original = createStoreSetupServiceModePreparation(current(), ports, at);
    expect(() => createStoreSetupServiceModePreparation(recorded, ports, later)).toThrow();
    expect(() =>
      revalidateStoreSetupServiceModePreparation(original, recorded, ports, later),
    ).toThrow();
    expect(() =>
      createStoreSetupServiceModePreparationFromRecordedRevision(current(), ports, at),
    ).toThrow();
    expect(() =>
      createStoreSetupServiceModePreparationFromRecordedRevision(
        { ...recorded, recordingStatus: "Current" },
        ports,
        later,
      ),
    ).toThrow();
  });
  it("rejects foreign scope, absent snapshot, future saved time and expired old observation", () => {
    const recorded = recordedRevision();
    for (const change of [
      { tenantReference: id(41) },
      { brandReference: id(42) },
      { storeReference: id(43) },
      { snapshot: null },
      { readerActorReference: "invalid" },
      { extra: true },
      { observedAt: "2026-10-05T09:59:59.999Z" },
      { validUntil: "2026-10-05T10:00:15.001Z" },
    ]) {
      expect(() =>
        createStoreSetupServiceModePreparationFromRecordedRevision(
          { ...recorded, ...change },
          references(),
          later,
        ),
      ).toThrow();
    }
    expect(() =>
      createStoreSetupServiceModePreparationFromRecordedRevision(
        { ...recorded, observedAt: at, validUntil: "2026-10-05T10:00:05.000Z" },
        references(),
        later,
      ),
    ).toThrow();
    expect(() =>
      createStoreSetupServiceModePreparationFromRecordedRevision(
        recorded,
        references(),
        recorded.validUntil,
      ),
    ).toThrow();
  });
});
