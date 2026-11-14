import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createPlatformBrandTemplateRevision } from "@bop/tenant";
import {
  parseMerchantBrandTemplateCandidates,
  projectMerchantBrandTemplateCandidates,
} from "./merchant-brand-template-candidates.js";

const id = (n: number) => `01902606-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) };
function packet() {
  const template = createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(10),
      templateVersionReference: id(11),
      revision: 1,
      recordKind: "AuthoredContent",
      content: {
        code: "INITIAL",
        name: "Synthetic initial template",
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA", "fr-CA"],
        overrideAllowedFieldCodes: ["CONTACT"],
        hardRequirementFieldCodes: ["CURRENCY"],
        effectiveFrom: at,
        effectiveUntil: null,
        reasonCode: "INITIAL_CONFIGURATION",
      },
      supersedesVersionReference: null,
      authoredByReference: id(12),
      operationReference: id(13),
      auditReference: id(14),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    { canonicalize: canonicalizeRfc8785, hashIntent: (text) => "sha256:" + sha256Hex(text) },
  );
  return projectMerchantBrandTemplateCandidates(
    {
      profile: "PlatformTemplateBrandReferenceListV1",
      scope,
      observedAt: at,
      validUntil: until,
      items: [
        {
          template,
          releaseReference: id(15),
          releaseSequence: 1,
          publishedAt: at,
          publicationSourceDigest: "sha256:" + "a".repeat(64),
        },
      ],
      hasMore: false,
      nextAfterTemplateReference: null,
    },
    null,
  );
}
it("projects actual content without exposing author, operation, audit or release identities", () => {
  const result = packet();
  expect(result.items[0]).toMatchObject({
    templateReference: id(10),
    templateVersionReference: id(11),
    code: "INITIAL",
    name: "Synthetic initial template",
    hardRequirementFieldCodes: ["CURRENCY"],
  });
  const serialized = JSON.stringify(result);
  for (const n of [12, 13, 14, 15]) expect(serialized).not.toContain(id(n));
  expect(parseMerchantBrandTemplateCandidates(result, scope, at, null)).toEqual(result);
  expect(Object.isFrozen(result.items)).toBe(true);
});
it("allows an empty scanned page with a real advancing cursor and preserves finite observations", () => {
  const result = {
    ...packet(),
    afterTemplateReference: id(5),
    items: [],
    hasMore: true,
    nextAfterTemplateReference: id(8),
  };
  expect(parseMerchantBrandTemplateCandidates(result, scope, at, id(5))).toEqual(result);
  expect(() => parseMerchantBrandTemplateCandidates(result, scope, until, id(5))).toThrow();
});
it.each([
  { actorReference: id(9) },
  { tenantReference: id(9) },
  { scope },
  { profile: "Published" },
  { validUntil: "2026-10-06T12:00:06.000Z" },
  { observedAt: "2026-10-06T12:00:01.000Z" },
  { hasMore: true },
  { nextAfterTemplateReference: id(10) },
  { afterTemplateReference: id(5) },
])("refuses mismatched scope, page, clock or open packet: %j", (change) => {
  expect(() =>
    parseMerchantBrandTemplateCandidates({ ...packet(), ...change }, scope, at, null),
  ).toThrow();
});
it.each([
  { authoredByReference: id(12) },
  { revision: 0 },
  { contentDigest: "unknown" },
  { effectiveUntil: at },
  { effectiveUntil: "2026-10-06T12:00:03.000Z" },
  { effectiveFrom: until },
  { supportedLocales: ["fr-CA"] },
  { overrideAllowedFieldCodes: ["CURRENCY"] },
])("rejects invalid or leaking candidate content: %j", (change) => {
  const result = packet();
  expect(() =>
    parseMerchantBrandTemplateCandidates(
      { ...result, items: [{ ...result.items[0], ...change }] },
      scope,
      at,
      null,
    ),
  ).toThrow();
});
it("rejects duplicate, reversed, oversized or accessor-backed candidate pages", () => {
  const result = packet(),
    item = result.items[0];
  for (const items of [[item, item], Array(21).fill(item), new Array(1)])
    expect(() =>
      parseMerchantBrandTemplateCandidates({ ...result, items }, scope, at, null),
    ).toThrow();
  const items: unknown[] = [];
  Object.defineProperty(items, "0", {
    enumerable: true,
    get() {
      throw new Error("must not invoke");
    },
  });
  expect(() =>
    parseMerchantBrandTemplateCandidates({ ...result, items }, scope, at, null),
  ).toThrow();
});
