import { describe, expect, it, vi } from "vitest";
import {
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
} from "../contracts/store-configuration-original.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = "sha256:" + "a".repeat(64);
const plain = {
  profile: "StoreConfigurationOrdinaryCommandV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  operationReference: id(5),
  action: "Materialize",
  expectedHead: { configurationReference: null, configurationVersion: 0, contentDigest: null },
  setupSelector: { setupDraftReference: id(6), sourceRevision: 1, sourceSnapshotDigest: digest },
  reasonCode: "INITIAL_CONFIGURATION",
};
describe("ordinary Store configuration original protocol", () => {
  it("detaches and freezes the stable materialize pins without allocating result metadata", () => {
    const original = { ...plain, setupSelector: { ...plain.setupSelector } };
    const parsed = parseStoreConfigurationOrdinaryCommand(original);
    original.setupSelector.sourceRevision = 2;
    expect(parsed.action).toBe("Materialize");
    if (parsed.action !== "Materialize") throw new Error("wrong controlled action");
    expect(parsed.setupSelector.sourceRevision).toBe(1);
    expect(Object.isFrozen(parsed.setupSelector)).toBe(true);
    expect(parsed).not.toHaveProperty("configuration");
  });
  it("resolves payload-free with exact setup/head pins and original digest", () => {
    const resolve = parseStoreConfigurationOrdinaryResolve({
      ...plain,
      profile: "StoreConfigurationOrdinaryResolveV1",
      intentDigest: digest,
    });
    expect(resolve.intentDigest).toBe(digest);
    expect(resolve).not.toHaveProperty("configuration");
  });
  it("retains a true immutable abandonment without a manufactured successful operation", () => {
    const receipt = parseStoreConfigurationOrdinaryReceipt({
      ...plain,
      profile: "StoreConfigurationOrdinaryReceiptV1",
      intentDigest: digest,
      outcome: "Abandoned",
      operation: null,
      auditReference: id(7),
      occurredAt: "2026-10-05T10:00:00.000Z",
      dataClassification: "ConfigurationMetadata",
    });
    expect(receipt.operation).toBeNull();
    expect(receipt.outcome).toBe("Abandoned");
  });
  it.each(["configuration", "permission", "approvalEvidenceReference", "occurredAt"])(
    "rejects caller authority/result injection %s",
    (key) => {
      expect(() => parseStoreConfigurationOrdinaryCommand({ ...plain, [key]: id(8) })).toThrow();
    },
  );
  it("rejects incomplete head pins and an exhausted materialize version", () => {
    expect(() =>
      parseStoreConfigurationOrdinaryCommand({
        ...plain,
        expectedHead: {
          configurationReference: id(8),
          configurationVersion: 0,
          contentDigest: null,
        },
      }),
    ).toThrow();
    expect(() =>
      parseStoreConfigurationOrdinaryCommand({
        ...plain,
        expectedHead: {
          configurationReference: id(8),
          configurationVersion: Number.MAX_SAFE_INTEGER,
          contentDigest: digest,
        },
      }),
    ).toThrow();
  });
  it("requires a real nonempty full head for lifecycle actions", () => {
    const rest = {
      profile: plain.profile,
      tenantReference: plain.tenantReference,
      brandReference: plain.brandReference,
      storeReference: plain.storeReference,
      actorReference: plain.actorReference,
      operationReference: plain.operationReference,
      expectedHead: plain.expectedHead,
    };
    expect(() => parseStoreConfigurationOrdinaryCommand({ ...rest, action: "Submit" })).toThrow();
    expect(
      parseStoreConfigurationOrdinaryCommand({
        ...rest,
        action: "Submit",
        expectedHead: {
          configurationReference: id(8),
          configurationVersion: 1,
          contentDigest: digest,
        },
      }).action,
    ).toBe("Submit");
  });
  it("refuses descriptors without invoking caller getters", () => {
    const getter = vi.fn(() => id(4)),
      value = { ...plain };
    Object.defineProperty(value, "actorReference", { enumerable: true, get: getter });
    expect(() => parseStoreConfigurationOrdinaryCommand(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses abandoned receipts carrying a result", () => {
    expect(() =>
      parseStoreConfigurationOrdinaryReceipt({
        ...plain,
        profile: "StoreConfigurationOrdinaryReceiptV1",
        intentDigest: digest,
        outcome: "Abandoned",
        operation: {},
        auditReference: id(7),
        occurredAt: "2026-10-05T10:00:00.000Z",
        dataClassification: "ConfigurationMetadata",
      }),
    ).toThrow();
  });
  it("refuses cross-profile payloads and Resolve missing its original digest", () => {
    expect(() =>
      parseStoreConfigurationOrdinaryCommand({
        ...plain,
        profile: "StoreConfigurationOrdinaryResolveV1",
      }),
    ).toThrow();
    expect(() =>
      parseStoreConfigurationOrdinaryResolve({
        ...plain,
        profile: "StoreConfigurationOrdinaryResolveV1",
      }),
    ).toThrow();
  });
});
