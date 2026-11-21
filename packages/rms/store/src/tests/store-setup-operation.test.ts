import { describe, expect, it } from "vitest";
import {
  createUnconfiguredStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContentV2,
  parseStoreSetupDraft,
} from "../contracts/store-setup-draft.js";
import {
  parseStoreSetupSaveCommand,
  parseStoreSetupResolveCommand,
  parseStoreSetupOperationReceipt,
  parseStoreSetupCurrent,
} from "../contracts/store-setup-operation.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const command = () => ({
  profile: "StoreSetupSaveV1",
  ...scope,
  operationReference: id(5),
  expectedSetupReference: null,
  expectedRevision: 0,
  purposeCode: "STORE_SETUP_DRAFT",
  content: createUnconfiguredStoreSetupDraftContent(),
});
const snapshot = () =>
  parseStoreSetupDraft({
    profile: "StoreSetupDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(6),
    revision: 1,
    authoredByReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: createUnconfiguredStoreSetupDraftContent(),
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  });
const receipt = () => ({
  profile: "StoreSetupOperationReceiptV1",
  ...scope,
  operationReference: id(5),
  expectedSetupReference: null,
  expectedRevision: 0,
  purposeCode: "STORE_SETUP_DRAFT",
  intentDigest: `sha256:${"a".repeat(64)}`,
  outcome: "Committed",
  snapshot: snapshot(),
  auditReference: id(7),
  occurredAt: at,
});
describe("Store setup original operation contracts", () => {
  it("retains an explicitly incomplete Save without claiming reference validity", () => {
    const parsed = parseStoreSetupSaveCommand(command());
    expect(parsed.content.timeZone).toEqual({ state: "Unconfigured" });
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    { expectedSetupReference: id(6) },
    { expectedRevision: 1 },
    { expectedRevision: 2147483648 },
    { purposeCode: "PUBLISH" },
    { approvalReference: id(9) },
  ])("rejects inconsistent roots and extra lifecycle fields %j", (change) =>
    expect(() => parseStoreSetupSaveCommand({ ...command(), ...change })).toThrow(),
  );
  it("refuses accessors without evaluating them", () => {
    let called = false;
    const value = command();
    Object.defineProperty(value, "content", {
      enumerable: true,
      get() {
        called = true;
        return {};
      },
    });
    expect(() => parseStoreSetupSaveCommand(value)).toThrow();
    expect(called).toBe(false);
  });
  it("Resolve holds original intent only, never partial content", () => {
    const { content, ...identity } = command();
    void content;
    expect(
      parseStoreSetupResolveCommand({
        ...identity,
        profile: "StoreSetupResolveV1",
        intentDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).not.toHaveProperty("content");
    expect(() =>
      parseStoreSetupResolveCommand({
        ...identity,
        profile: "StoreSetupResolveV1",
        intentDigest: "b".repeat(64),
      }),
    ).toThrow();
  });
  it("binds original receipt to exact revision writer and original timestamp", () => {
    expect(parseStoreSetupOperationReceipt(receipt()).snapshot?.revision).toBe(1);
    for (const change of [
      { actorReference: id(8) },
      { expectedRevision: 1, expectedSetupReference: id(6) },
      { occurredAt: "2026-10-05T10:00:00.001Z" },
    ])
      expect(() => parseStoreSetupOperationReceipt({ ...receipt(), ...change })).toThrow();
  });
  it("Abandoned carries no generated revision or snapshot", () => {
    expect(
      parseStoreSetupOperationReceipt({ ...receipt(), outcome: "Abandoned", snapshot: null })
        .outcome,
    ).toBe("Abandoned");
    expect(() => parseStoreSetupOperationReceipt({ ...receipt(), outcome: "Abandoned" })).toThrow();
  });
  it("current reader may differ from immutable author and never certifies references", () => {
    const current = {
      profile: "StoreSetupCurrentV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      readerActorReference: id(8),
      snapshot: snapshot(),
      observedAt: at,
      validUntil: "2026-10-05T10:00:05.000Z",
      businessReferenceValidation: "NotEvaluated",
    };
    expect(parseStoreSetupCurrent(current).snapshot?.authoredByReference).toBe(id(4));
    expect(() =>
      parseStoreSetupCurrent({ ...current, businessReferenceValidation: "Pass" }),
    ).toThrow();
    expect(() =>
      parseStoreSetupCurrent({ ...current, validUntil: "2026-10-05T10:00:05.001Z" }),
    ).toThrow();
  });
});

it("strictly joins Save V2 content to V2 and retains V1 recovery/current receipt profiles", () => {
  const v2 = parseStoreSetupSaveCommand({
    ...command(),
    profile: "StoreSetupSaveV2",
    content: createUnconfiguredStoreSetupDraftContentV2(),
  });
  expect(v2.profile).toBe("StoreSetupSaveV2");
  expect(() => parseStoreSetupSaveCommand({ ...v2, profile: "StoreSetupSaveV1" })).toThrow();
  expect(() => parseStoreSetupSaveCommand({ ...command(), profile: "StoreSetupSaveV2" })).toThrow();
  const saved = parseStoreSetupDraft({
    ...snapshot(),
    profile: "StoreSetupDraftV2",
    content: v2.content,
  });
  expect(parseStoreSetupOperationReceipt({ ...receipt(), snapshot: saved }).snapshot?.profile).toBe(
    "StoreSetupDraftV2",
  );
  const { content, ...identity } = v2;
  void content;
  expect(
    parseStoreSetupResolveCommand({
      ...identity,
      profile: "StoreSetupResolveV1",
      intentDigest: "sha256:" + "a".repeat(64),
    }).profile,
  ).toBe("StoreSetupResolveV1");
});
