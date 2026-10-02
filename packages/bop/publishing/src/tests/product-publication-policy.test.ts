import { describe, it, expect, vi } from "vitest";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = () => ({
  profile: "PublishingProductPublicationPolicyV1",
  tenantReference: id(1),
  brandReference: id(2),
  familyReference: id(4),
  policyReference: id(6),
  policyVersion: 1,
  scopeOrder: [...productPolicyScopeLevels],
  approvalPolicy: "Required",
  warningOverrideAllowed: false,
  requiredLocales: ["en-CA", "fr-CA"],
  mediaRequirement: "Required",
  effectiveFrom: "2026-09-11T10:00:00.000Z",
  effectiveUntil: null,
});
describe("Product publication policy body", () => {
  it("detaches canonical content and hashes actual requirements", () => {
    const v = input(),
      p = parsePublishingProductPublicationPolicy(v);
    v.scopeOrder.reverse();
    expect(p.scopeOrder[0]).toBe("Store");
    expect(
      publishingProductPublicationPolicyDigest({ ...input(), requiredLocales: ["fr-CA", "en-CA"] }),
    ).toBe(publishingProductPublicationPolicyDigest(input()));
    expect(
      publishingProductPublicationPolicyDigest({ ...input(), mediaRequirement: "Optional" }),
    ).not.toBe(publishingProductPublicationPolicyDigest(input()));
  });
  it.each(["policyReference", "tenantReference", "familyReference", "brandReference"])(
    "rejects invalid %s",
    (key) =>
      expect(() => parsePublishingProductPublicationPolicy({ ...input(), [key]: "bad" })).toThrow(),
  );
  it.each([0, 1.5, -1])("rejects version %s", (policyVersion) =>
    expect(() => parsePublishingProductPublicationPolicy({ ...input(), policyVersion })).toThrow(),
  );
  it("refuses missing/duplicate precedence and Brand above Store", () => {
    for (const scopeOrder of [
      [],
      [...productPolicyScopeLevels.slice(0, 5), "Store"],
      ["Brand", "StoreGroup", "Region", "Store", "Channel", "OrderType"],
    ])
      expect(() => parsePublishingProductPublicationPolicy({ ...input(), scopeOrder })).toThrow();
  });
  it("refuses locale duplication, invalid enums, empty interval and unknown hard-check disable", () => {
    for (const change of [
      { requiredLocales: ["en-CA", "en-CA"] },
      { requiredLocales: ["en-ca"] },
      { approvalPolicy: "AutoApprove" },
      { warningOverrideAllowed: "true" },
      { effectiveUntil: input().effectiveFrom },
      { hardErrorsMayBeOverridden: true },
    ])
      expect(() => parsePublishingProductPublicationPolicy({ ...input(), ...change })).toThrow();
  });
  it("refuses body and array getters without invoking them", () => {
    const get = vi.fn(() => "Required"),
      v = input();
    Object.defineProperty(v, "approvalPolicy", { get, enumerable: true });
    expect(() => parsePublishingProductPublicationPolicy(v)).toThrow();
    const w = input();
    Object.defineProperty(w.requiredLocales, "0", { get, enumerable: true });
    expect(() => parsePublishingProductPublicationPolicy(w)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
