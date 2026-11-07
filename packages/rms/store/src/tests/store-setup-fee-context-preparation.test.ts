import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createUnconfiguredStoreSetupDraftContentV2,
  parseStoreSetupDraft,
} from "../contracts/store-setup-draft.js";
import { parseStoreSetupCurrent } from "../contracts/store-setup-operation.js";
import {
  createStoreSetupFeeContextPreparation,
  createStoreSetupFeeContextPreparationFromRecordedRevision,
  parseStoreSetupFeeContextPreparation,
  revalidateStoreSetupFeeContextPreparation,
  storeSetupFeeContextPreparationSemanticallyEqual,
} from "../contracts/store-setup-fee-context-preparation.js";
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
    profile: "StoreSetupDraftV2",
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
      ...createUnconfiguredStoreSetupDraftContentV2(),
      feeContexts: {
        state: "Configured",
        value: [
          {
            chargeType: "ServiceCharge",
            state: "Enabled",
            taxClassificationReference: id(20),
            orderTypes: ["Pickup", "Delivery"],
          },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Unconfigured" },
        ],
      },
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

describe("Store fee context preparation", () => {
  it("projects actual saved states, original full digest and reader-independent provenance without qualification", () => {
    const source = current();
    const value = createStoreSetupFeeContextPreparation(source, references(), at);
    expect(value.feeContexts).toEqual(source.snapshot?.content.feeContexts);
    expect(value.completeness).toBe("Incomplete");
    expect(value.publicationStatus).toBe("NotPublished");
    expect(value.businessReferenceValidation).toBe("NotEvaluated");
    expect(value.sourceSnapshotDigest).toBe(hashIntent(canonicalize(source.snapshot)));
    expect(Object.isFrozen(value.feeContexts)).toBe(true);
  });
  it("keeps fee semantic identity across unrelated saved changes but refuses changed configured intent", () => {
    const value = createStoreSetupFeeContextPreparation(current(), references(), at);
    const other = current(
      2,
      later,
      {},
      { contactReference: { state: "Configured", value: id(21) } },
    );
    expect(revalidateStoreSetupFeeContextPreparation(value, other, references(), later)).toBe(true);
    expect(
      storeSetupFeeContextPreparationSemanticallyEqual(
        value,
        createStoreSetupFeeContextPreparation(other, references(), later),
        references(),
      ),
    ).toBe(true);
    const changed = current(2, later, {}, { feeContexts: { state: "Unconfigured" } });
    expect(revalidateStoreSetupFeeContextPreparation(value, changed, references(), later)).toBe(
      false,
    );
  });
  it("authenticates a structurally recorded revision without calling it current or extending old time", () => {
    const source = current();
    const value = createStoreSetupFeeContextPreparationFromRecordedRevision(
      {
        profile: "StoreSetupRecordedRevisionV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        readerActorReference: id(9),
        snapshot: source.snapshot,
        observedAt: at,
        validUntil: source.validUntil,
        recordingStatus: "Recorded",
      },
      references(),
      at,
    );
    expect(value.sourceRevision).toBe(1);
    expect(() =>
      parseStoreSetupFeeContextPreparation(value, references(), value.validUntil),
    ).toThrow();
  });
  it("reports an overall unconfigured slot as incomplete, not disabled", () => {
    const value = createStoreSetupFeeContextPreparation(
      current(1, at, {}, { feeContexts: { state: "Unconfigured" } }),
      references(),
      at,
    );
    expect(value.feeContexts).toEqual({ state: "Unconfigured" });
    expect(value.completeness).toBe("Incomplete");
    expect(() =>
      parseStoreSetupFeeContextPreparation(
        { ...value, completeness: "CompleteConfiguredContexts" },
        references(),
        at,
      ),
    ).toThrow();
  });
  it("does not allow semantic hash tampering, scope drift or getters", () => {
    const value = createStoreSetupFeeContextPreparation(current(), references(), at);
    expect(() =>
      parseStoreSetupFeeContextPreparation(
        { ...value, semanticDigest: "sha256:" + "a".repeat(64) },
        references(),
        at,
      ),
    ).toThrow();
    expect(() =>
      parseStoreSetupFeeContextPreparation({ ...value, storeReference: id(99) }, references(), at),
    ).toThrow();
    let calls = 0;
    const bad = { ...value };
    Object.defineProperty(bad, "feeContexts", {
      get() {
        calls++;
        return value.feeContexts;
      },
    });
    expect(() => parseStoreSetupFeeContextPreparation(bad, references(), at)).toThrow();
    expect(calls).toBe(0);
  });
});

it("treats V1 absence as incomplete and recognizes only explicitly recorded disabled entries as configured", () => {
  const source = current();
  if (!source.snapshot) throw new Error("Missing source");
  const { feeContexts, ...legacyContent } = source.snapshot.content;
  void feeContexts;
  const legacy = parseStoreSetupCurrent({
    ...source,
    snapshot: { ...source.snapshot, profile: "StoreSetupDraftV1", content: legacyContent },
  });
  const missing = createStoreSetupFeeContextPreparation(legacy, references(), at);
  expect(missing.completeness).toBe("Incomplete");
  expect(missing.feeContexts).toEqual({ state: "Unconfigured" });
  const disabled = current(
    1,
    at,
    {},
    {
      feeContexts: {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Disabled" },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Disabled" },
        ],
      },
    },
  );
  expect(createStoreSetupFeeContextPreparation(disabled, references(), at).completeness).toBe(
    "CompleteConfiguredContexts",
  );
});
