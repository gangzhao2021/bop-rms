import { describe, expect, it } from "vitest";
import {
  parseStoreSetupReferenceContent,
  parseStoreSetupReferenceVersion,
  parseStoreSetupReferenceSave,
  parseStoreSetupReferenceResolve,
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferencesCurrent,
  StoreSetupReferenceError,
} from "../contracts/store-setup-reference.js";
import {
  parseStoreBusinessAddress,
  parseStoreBusinessPhone,
  parseStoreBusinessWebsite,
} from "../contracts/public-store-profile.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
const later = "2026-10-05T10:01:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const address = () => ({
  countryCode: "CA",
  regionCode: "ON",
  locality: "Toronto",
  postalCode: "M5V 1A1",
  addressLines: ["100 Synthetic Street"],
});
const contact = () => ({
  contactName: "Synthetic Store Contact",
  businessPhone: "+14165550100",
  website: "https://example.test/",
});
const snapshot = (kind: "Address" | "Contact" = "Address") => ({
  profile: "StoreSetupReferenceVersionV1",
  ...scope,
  kind,
  reference: id(10),
  revision: 1,
  authoredByReference: id(4),
  previousReference: null,
  content: kind === "Address" ? address() : contact(),
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const save = () => ({
  profile: "StoreSetupReferenceSaveV1",
  ...scope,
  actorReference: id(4),
  kind: "Address",
  operationReference: id(5),
  expectedReference: null,
  expectedRevision: 0,
  content: address(),
  purposeCode: "STORE_SETUP_REFERENCE",
});
const receipt = () => ({
  profile: "StoreSetupReferenceReceiptV1",
  ...scope,
  actorReference: id(4),
  kind: "Address",
  operationReference: id(5),
  intentDigest: "sha256:" + "a".repeat(64),
  expectedReference: null,
  expectedRevision: 0,
  outcome: "Committed",
  snapshot: snapshot(),
  auditReference: id(6),
  occurredAt: at,
});
const current = () => ({
  profile: "StoreSetupReferencesCurrentV1",
  ...scope,
  actorReference: id(7),
  address: snapshot(),
  contact: snapshot("Contact"),
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
  businessReferenceValidation: "NotEvaluated",
});
function invalid(work: () => unknown) {
  expect(work).toThrowError(StoreSetupReferenceError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({
      code: "STORE_SETUP_REFERENCE_INPUT_INVALID",
      message: "Store setup reference is unavailable",
    });
  }
}

describe("Store setup controlled address/contact contracts", () => {
  it("reuses public business validators without changing nullable public phone/website", () => {
    expect(parseStoreSetupReferenceContent("Address", address())).toEqual(
      parseStoreBusinessAddress(address()),
    );
    expect(parseStoreBusinessPhone(null)).toBeNull();
    expect(parseStoreBusinessWebsite(null)).toBeNull();
    invalid(() =>
      parseStoreSetupReferenceContent("Contact", { ...contact(), businessPhone: null }),
    );
    expect(parseStoreSetupReferenceContent("Contact", { ...contact(), website: null })).toEqual({
      ...contact(),
      website: null,
    });
  });
  it("detaches and freezes normalized content before caller mutation", () => {
    const original = address();
    const parsed = parseStoreSetupReferenceSave({ ...save(), content: original });
    original.addressLines[0] = "Changed";
    expect(parsed.content).toEqual(address());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.content)).toBe(true);
    expect(
      parseStoreSetupReferenceContent("Contact", {
        ...contact(),
        contactName: "  Synthetic Contact  ",
      }),
    ).toMatchObject({ contactName: "Synthetic Contact" });
  });
  it("preserves stable creation time while the authorized next writer creates a new reference", () => {
    const v = parseStoreSetupReferenceVersion({
      ...snapshot(),
      reference: id(11),
      revision: 2,
      previousReference: id(10),
      authoredByReference: id(8),
      updatedAt: later,
    });
    const r = parseStoreSetupReferenceReceipt({
      ...receipt(),
      actorReference: id(8),
      expectedReference: id(10),
      expectedRevision: 1,
      snapshot: v,
      occurredAt: later,
    });
    expect(r.snapshot).toMatchObject({
      reference: id(11),
      previousReference: id(10),
      createdAt: at,
      authoredByReference: id(8),
      revision: 2,
    });
  });
  it("current read permits a historical author distinct from the verified current reader", () => {
    const view = parseStoreSetupReferencesCurrent(current());
    expect(view.actorReference).toBe(id(7));
    expect(view.address?.authoredByReference).toBe(id(4));
    expect(view.businessReferenceValidation).toBe("NotEvaluated");
  });
  it("resolve contains only exact original identity and digest, not business content", () => {
    const { content: unusedContent, ...command } = save();
    void unusedContent;
    const resolved = parseStoreSetupReferenceResolve({
      ...command,
      profile: "StoreSetupReferenceResolveV1",
      intentDigest: receipt().intentDigest,
    });
    expect(Object.hasOwn(resolved, "content")).toBe(false);
    invalid(() => parseStoreSetupReferenceResolve({ ...resolved, content: address() }));
  });
  it("abandonment has no snapshot and does not claim successful configuration", () => {
    expect(
      parseStoreSetupReferenceReceipt({ ...receipt(), outcome: "Abandoned", snapshot: null })
        .snapshot,
    ).toBeNull();
    invalid(() => parseStoreSetupReferenceReceipt({ ...receipt(), outcome: "Abandoned" }));
    invalid(() => parseStoreSetupReferenceReceipt({ ...receipt(), snapshot: null }));
  });
  it.each([
    { expectedReference: id(10), expectedRevision: 0 },
    { expectedReference: null, expectedRevision: 1 },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedReference: id(10), expectedRevision: 2147483647 },
    { purposeCode: "STORE_SETUP_DRAFT" },
    { kind: "Unknown" },
    { operationReference: "unrestricted-id" },
  ])("rejects malformed or exhausted save identity %j", (patch) =>
    invalid(() => parseStoreSetupReferenceSave({ ...save(), ...patch })),
  );
  it.each([
    { revision: 0 },
    { revision: 2 },
    { previousReference: id(10) },
    { updatedAt: "2026-10-05T09:00:00.000Z" },
    { createdAt: "2026-10-05T09:00:00.000Z" },
    { dataClassification: "Public" },
  ])("rejects inconsistent original version metadata %j", (patch) =>
    invalid(() => parseStoreSetupReferenceVersion({ ...snapshot(), ...patch })),
  );
  it.each([
    { authoredByReference: id(8) },
    { storeReference: id(8) },
    { tenantReference: id(8) },
    { brandReference: id(8) },
    { kind: "Contact", content: contact() },
    { revision: 2, previousReference: id(9) },
  ])("rejects committed receipt/snapshot tuple mismatch %j", (patch) =>
    invalid(() =>
      parseStoreSetupReferenceReceipt({ ...receipt(), snapshot: { ...snapshot(), ...patch } }),
    ),
  );
  it("rejects reused reference for successor content", () =>
    invalid(() =>
      parseStoreSetupReferenceReceipt({
        ...receipt(),
        expectedReference: id(10),
        expectedRevision: 1,
        snapshot: { ...snapshot(), revision: 2, previousReference: id(10) },
      }),
    ));
  it.each([
    { businessReferenceValidation: "Valid" },
    { validUntil: at },
    { validUntil: "2026-10-05T10:00:05.001Z" },
    { address: { ...snapshot(), storeReference: id(8) } },
    { address: snapshot("Contact") },
    { observedAt: "2026-10-05T09:59:59.999Z" },
  ])("rejects unavailable current lease/source meaning %j", (patch) =>
    invalid(() => parseStoreSetupReferencesCurrent({ ...current(), ...patch })),
  );
  it.each([
    "https://example.test/?secret=1",
    "https://example.test/#fragment",
    "https://user:password@example.test/",
    "http://example.test/",
    "https://example.test",
    "not-a-url",
  ])("rejects unsafe or noncanonical website %s", (website) =>
    invalid(() => parseStoreSetupReferenceContent("Contact", { ...contact(), website })),
  );
  it.each(["", " ", "<Contact>", "Contact\nName", "Contact\u200bName", "x".repeat(121)])(
    "rejects unsafe contact name",
    (contactName) =>
      invalid(() => parseStoreSetupReferenceContent("Contact", { ...contact(), contactName })),
  );
  it.each(["4165550100", "+1 4165550100", "", "+0000"])(
    "rejects malformed business phone %s",
    (businessPhone) =>
      invalid(() => parseStoreSetupReferenceContent("Contact", { ...contact(), businessPhone })),
  );
  it("rejects extra keys/accessors without invoking getters", () => {
    invalid(() =>
      parseStoreSetupReferenceContent("Contact", {
        ...contact(),
        email: "do-not-store@example.test",
      }),
    );
    let called = false;
    const value = { ...save() };
    Object.defineProperty(value, "content", {
      enumerable: true,
      get: () => {
        called = true;
        return address();
      },
    });
    invalid(() => parseStoreSetupReferenceSave(value));
    expect(called).toBe(false);
    invalid(() => parseStoreSetupReferenceSave({ ...save(), tenantContext: scope }));
  });
  it("rejects sparse/decorated address lines and bounded oversized documents", () => {
    const sparse = new Array(1);
    invalid(() =>
      parseStoreSetupReferenceContent("Address", { ...address(), addressLines: sparse }),
    );
    const lines = ["Synthetic Street"];
    Object.defineProperty(lines, "extra", { value: "extra", enumerable: true });
    invalid(() =>
      parseStoreSetupReferenceContent("Address", { ...address(), addressLines: lines }),
    );
    invalid(() =>
      parseStoreSetupReferenceContent("Address", {
        ...address(),
        addressLines: Array(10001).fill("x"),
      }),
    );
    invalid(() =>
      parseStoreSetupReferenceContent("Contact", { ...contact(), contactName: "x".repeat(17000) }),
    );
  });
  it("rejects noncanonical/missing digest and time formats", () => {
    for (const intentDigest of [
      "a".repeat(64),
      "sha256:" + "A".repeat(64),
      "sha256:" + "a".repeat(63),
    ])
      invalid(() => parseStoreSetupReferenceReceipt({ ...receipt(), intentDigest }));
    invalid(() =>
      parseStoreSetupReferenceReceipt({ ...receipt(), occurredAt: "2026-10-05T10:00:00Z" }),
    );
  });
});
