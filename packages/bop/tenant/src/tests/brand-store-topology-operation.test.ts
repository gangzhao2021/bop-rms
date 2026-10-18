import { describe, expect, it } from "vitest";
import {
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyDraftRevision,
  parseBrandStoreTopologyCurrent,
  parseBrandStoreTopologyOperationReceipt,
} from "../contracts/brand-store-topology-operation.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const digest = `sha256:${"a".repeat(64)}`;
function draft() {
  return {
    profile: "BrandStoreTopologyDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    draftReference: id(4),
    selectors: [{ kind: "Region", reference: id(5), code: "NORTH", name: "North region" }],
    assignments: [{ storeReference: id(6), selectorReference: id(5) }],
  };
}
function save() {
  return {
    profile: "BrandStoreTopologySaveV1",
    ...scope,
    operationReference: id(7),
    expectedRevision: 0,
    content: draft(),
  };
}
function revision() {
  return {
    profile: "BrandStoreTopologyDraftRevisionV1",
    ...scope,
    revision: 1,
    content: draft(),
    snapshotDigest: digest,
    operationReference: id(7),
    auditReference: id(8),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
function receipt() {
  return {
    profile: "BrandStoreTopologyOperationV1",
    ...scope,
    operationReference: id(7),
    expectedRevision: 0,
    intentDigest: digest,
    outcome: "Committed",
    snapshot: revision(),
    auditReference: id(8),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
function current() {
  return {
    profile: "BrandStoreTopologyCurrentV1",
    ...scope,
    actorReference: id(9),
    current: revision(),
    observedAt: at,
    validUntil: "2026-10-06T10:00:05.000Z",
  };
}
describe("Brand Store topology original operation contracts", () => {
  it("detaches explicit intent and admits incomplete empty Draft without lifecycle defaults", () => {
    const input = save(),
      parsed = parseBrandStoreTopologySave(input);
    const selector = input.content.selectors[0];
    if (!selector) throw new Error("Missing controlled selector");
    selector.name = "Changed";
    expect(parsed.content.selectors[0]?.name).toBe("North region");
    expect(Object.isFrozen(parsed.content.assignments[0])).toBe(true);
    expect(Object.keys(parsed)).toHaveLength(7);
    expect(
      parseBrandStoreTopologySave({
        ...save(),
        content: { ...draft(), selectors: [], assignments: [] },
      }).content.assignments,
    ).toEqual([]);
    expect(parsed).not.toHaveProperty("approval");
  });
  it("resolves only original pins and hash with no content", () => {
    const { content, ...original } = save();
    void content;
    const parsed = parseBrandStoreTopologyResolve({
      ...original,
      profile: "BrandStoreTopologyResolveV1",
      intentDigest: digest,
    });
    expect(parsed.expectedRevision).toBe(0);
    expect(parsed).not.toHaveProperty("content");
    expect(() => parseBrandStoreTopologyResolve({ ...parsed, content: draft() })).toThrow();
    expect(() =>
      parseBrandStoreTopologyResolve({ ...parsed, intentDigest: "a".repeat(64) }),
    ).toThrow();
  });
  it.each([
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2147483647 },
    { expectedRevision: NaN },
    { actorReference: "invalid" },
    { content: { ...draft(), tenantReference: id(30) } },
    { content: { ...draft(), brandReference: id(31) } },
    { approved: true },
  ])("rejects invalid expected pins or foreign content %j", (change) => {
    expect(() => parseBrandStoreTopologySave({ ...save(), ...change })).toThrow(
      expect.objectContaining({ code: "BRAND_STORE_TOPOLOGY_INPUT_INVALID" }),
    );
  });
  it("admits exact committed tuple and durable Abandoned with no invented result", () => {
    const parsed = parseBrandStoreTopologyOperationReceipt(receipt());
    expect(parsed.snapshot?.revision).toBe(parsed.expectedRevision + 1);
    expect(Object.keys(parseBrandStoreTopologyDraftRevision(revision()))).toHaveLength(12);
    expect(Object.keys(parsed)).toHaveLength(12);
    expect(
      parseBrandStoreTopologyOperationReceipt({
        ...receipt(),
        outcome: "Abandoned",
        snapshot: null,
      }).snapshot,
    ).toBeNull();
    expect(() =>
      parseBrandStoreTopologyOperationReceipt({ ...receipt(), outcome: "Abandoned" }),
    ).toThrow();
    expect(() =>
      parseBrandStoreTopologyOperationReceipt({ ...receipt(), snapshot: null }),
    ).toThrow();
  });
  it.each([
    { actorReference: id(40) },
    { tenantReference: id(41) },
    { brandReference: id(42) },
    { operationReference: id(43) },
    { auditReference: id(44) },
    { revision: 2 },
    { updatedAt: "2026-10-06T10:00:00.001Z" },
  ])("refuses altered committed snapshot tuple %j", (change) => {
    expect(() =>
      parseBrandStoreTopologyOperationReceipt({
        ...receipt(),
        snapshot: { ...revision(), ...change },
      }),
    ).toThrow();
  });
  it("preserves original author separately from current reader and checks fresh five-second observation", () => {
    const value = parseBrandStoreTopologyCurrent(current(), at);
    expect(value.actorReference).toBe(id(9));
    expect(value.current?.actorReference).toBe(id(3));
    expect(parseBrandStoreTopologyCurrent({ ...current(), current: null }, at).current).toBeNull();
    for (const now of ["2026-10-06T09:59:59.999Z", current().validUntil])
      expect(() => parseBrandStoreTopologyCurrent(current(), now)).toThrow();
    expect(() =>
      parseBrandStoreTopologyCurrent({ ...current(), validUntil: "2026-10-06T10:00:05.001Z" }, at),
    ).toThrow();
    expect(() =>
      parseBrandStoreTopologyCurrent({ ...current(), brandReference: id(50) }, at),
    ).toThrow();
    expect(() =>
      parseBrandStoreTopologyCurrent(
        { ...current(), current: { ...revision(), updatedAt: "2026-10-06T10:00:00.001Z" } },
        at,
      ),
    ).toThrow();
  });
  it("refuses corrupted immutable history times, hashes, classifications and nested drafts", () => {
    for (const change of [
      { revision: 0 },
      { createdAt: "2026-10-06T10:00:01.000Z" },
      { snapshotDigest: "bad" },
      { dataClassification: "Public" },
      { content: { ...draft(), assignments: new Array(1) } },
      { content: { ...draft(), extra: true } },
    ])
      expect(() => parseBrandStoreTopologyDraftRevision({ ...revision(), ...change })).toThrow();
  });
  it("never executes accessor fields and refuses prototype, symbol or extra input", () => {
    let touched = false;
    const input = save();
    Object.defineProperty(input, "content", {
      enumerable: true,
      get() {
        touched = true;
        return draft();
      },
    });
    expect(() => parseBrandStoreTopologySave(input)).toThrow();
    expect(touched).toBe(false);
    const nested = draft();
    Object.defineProperty(nested, "selectors", {
      enumerable: true,
      get() {
        touched = true;
        return [];
      },
    });
    expect(() => parseBrandStoreTopologySave({ ...save(), content: nested })).toThrow();
    expect(touched).toBe(false);
    expect(() => parseBrandStoreTopologySave(Object.assign(Object.create({}), save()))).toThrow();
    expect(() => parseBrandStoreTopologySave({ ...save(), [Symbol("extra")]: true })).toThrow();
  });
});
