import { describe, it, expect, vi } from "vitest";
import {
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
  createPostgresPublishingMutationStore,
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
  type CommitPublishingMutationInput,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = () => ({
  profile: "PublishingOptionSetPublicationPolicyV1",
  tenantReference: id(1),
  brandReference: id(2),
  familyReference: id(4),
  policyReference: id(6),
  policyVersion: 1,
  scopeOrder: [...optionSetPolicyScopeLevels],
  approvalPolicy: "Required",
  warningOverrideAllowed: false,
  requiredLocales: ["en-CA", "fr-CA"],
  mediaRequirement: "Required",
  effectiveFrom: "2026-09-11T10:00:00.000Z",
  effectiveUntil: null,
});
describe("Option publication policy body", () => {
  it("detaches canonical content and hashes actual requirements", () => {
    const v = input(),
      p = parsePublishingOptionSetPublicationPolicy(v);
    v.scopeOrder.reverse();
    expect(p.scopeOrder[0]).toBe("Store");
    expect(
      publishingOptionSetPublicationPolicyDigest({
        ...input(),
        requiredLocales: ["fr-CA", "en-CA"],
      }),
    ).toBe(publishingOptionSetPublicationPolicyDigest(input()));
    expect(
      publishingOptionSetPublicationPolicyDigest({ ...input(), mediaRequirement: "Optional" }),
    ).not.toBe(publishingOptionSetPublicationPolicyDigest(input()));
  });
  it.each(["policyReference", "tenantReference", "familyReference", "brandReference"])(
    "rejects invalid %s",
    (key) =>
      expect(() =>
        parsePublishingOptionSetPublicationPolicy({ ...input(), [key]: "bad" }),
      ).toThrow(),
  );
  it.each([0, 1.5, -1])("rejects version %s", (policyVersion) =>
    expect(() =>
      parsePublishingOptionSetPublicationPolicy({ ...input(), policyVersion }),
    ).toThrow(),
  );
  it("refuses missing/duplicate precedence and Brand above Store", () => {
    for (const scopeOrder of [
      [],
      [...optionSetPolicyScopeLevels.slice(0, 5), "Store"],
      ["Brand", "StoreGroup", "Region", "Store", "Channel", "OrderType"],
    ])
      expect(() => parsePublishingOptionSetPublicationPolicy({ ...input(), scopeOrder })).toThrow();
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
      expect(() => parsePublishingOptionSetPublicationPolicy({ ...input(), ...change })).toThrow();
  });
  it("refuses body and array getters without invoking them", () => {
    const get = vi.fn(() => "Required"),
      v = input();
    Object.defineProperty(v, "approvalPolicy", { get, enumerable: true });
    expect(() => parsePublishingOptionSetPublicationPolicy(v)).toThrow();
    const w = input();
    Object.defineProperty(w.requiredLocales, "0", { get, enumerable: true });
    expect(() => parsePublishingOptionSetPublicationPolicy(w)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Option policy owner input boundary", () => {
  it("keeps profiles and digests separate from Product", () => {
    expect(() =>
      parsePublishingOptionSetPublicationPolicy({
        ...input(),
        profile: "PublishingProductPublicationPolicyV1",
      }),
    ).toThrow();
    expect(() => parsePublishingProductPublicationPolicy(input())).toThrow();
    expect(publishingOptionSetPublicationPolicyDigest(input())).not.toBe(
      publishingProductPublicationPolicyDigest({
        ...input(),
        profile: "PublishingProductPublicationPolicyV1",
      }),
    );
  });
  const request = { policyReference: id(6), policyVersion: 1, observedAt: input().effectiveFrom };
  it.each([
    null,
    [],
    {},
    { ...request, ready: true },
    { ...request, policyReference: "bad" },
    { ...request, policyVersion: 0 },
    { ...request, observedAt: "2026-09-11T10:00:00Z" },
    Object.create(request),
  ])("refuses malformed current source before opening SQL (%#)", async (value) => {
    const run = vi.fn();
    const store = createPostgresPublishingMutationStore({ run }, id(1), {
      kind: "Brand",
      brandReference: id(2) as never,
      storeReference: null,
    });
    await expect(
      store.resolveCurrentOptionSetPublicationPolicy(value as typeof request),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses current source accessors without invoking them", async () => {
    const value = { ...request },
      get = vi.fn(() => id(6)),
      run = vi.fn();
    Object.defineProperty(value, "policyReference", { get, enumerable: true });
    const store = createPostgresPublishingMutationStore({ run }, id(1), {
      kind: "Brand",
      brandReference: id(2) as never,
      storeReference: null,
    });
    await expect(store.resolveCurrentOptionSetPublicationPolicy(value)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses Store policy source before opening SQL", async () => {
    const run = vi.fn();
    const store = createPostgresPublishingMutationStore({ run }, id(1), {
      kind: "Store",
      brandReference: id(2) as never,
      storeReference: id(3) as never,
    });
    await expect(store.resolveCurrentOptionSetPublicationPolicy(request)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses repeatable-read observation", async () => {
    const query = vi.fn(async () => ({ rows: [{ isolation: "repeatable read" }] }));
    const store = createPostgresPublishingMutationStore(
      { run: async (work) => work({ query }) },
      id(1),
      { kind: "Brand", brandReference: id(2) as never, storeReference: null },
    );
    await expect(store.resolveCurrentOptionSetPublicationPolicy(request)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(["Brand", "Product", "Digest", "Purpose", "Family", "Version", "Both", "Getter"])(
    "rejects mismatched typed registration before SQL (%s)",
    async (bad) => {
      const run = vi.fn(),
        body = input();
      const next = {
        lifecycleId: id(8),
        familyReference: id(4),
        configurationType: "OPTION_SET_PUBLICATION_POLICY",
        purposeCode: "OPTION_SET_PUBLICATION_POLICY",
        snapshotReference: id(6),
        snapshotDigest: publishingOptionSetPublicationPolicyDigest(body),
        scope: { kind: "Brand", brandReference: id(2), storeReference: null },
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: body.effectiveFrom,
        changedAt: body.effectiveFrom,
      };
      const value: Record<string, unknown> = {
        operation: "CreateDraft",
        next,
        optionSetPolicyContent: body,
      };
      if (bad === "Brand") body.brandReference = id(3);
      if (bad === "Product") body.profile = "PublishingProductPublicationPolicyV1";
      if (bad === "Digest") next.snapshotDigest = "sha256:" + "a".repeat(64);
      if (bad === "Purpose") next.purposeCode = "PRODUCT_PUBLICATION_POLICY";
      if (bad === "Family") body.familyReference = id(5);
      if (bad === "Version") body.policyVersion = 0;
      if (bad === "Both")
        value.productPolicyContent = { ...body, profile: "PublishingProductPublicationPolicyV1" };
      const get = vi.fn(() => body);
      if (bad === "Getter")
        Object.defineProperty(value, "optionSetPolicyContent", { get, enumerable: true });
      const store = createPostgresPublishingMutationStore({ run }, id(1), {
        kind: "Brand",
        brandReference: id(2) as never,
        storeReference: null,
      });
      await expect(
        store.commit(value as unknown as CommitPublishingMutationInput),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );
});
