import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parsePlatformBrandTemplateScope,
  parsePlatformBrandTemplateContent,
  parsePlatformBrandTemplateSave,
  parsePlatformBrandTemplateResolve,
  createPlatformBrandTemplateRevision,
  assertPlatformBrandTemplateRevisionDigests,
  parsePlatformBrandTemplateReceipt,
  parsePlatformBrandTemplateCurrent,
  parsePlatformBrandTemplateExact,
  parsePlatformBrandTemplateHistory,
  parsePlatformBrandTemplateListRequest,
  parsePlatformBrandTemplateList,
  platformBrandTemplateIntentDigest,
  platformBrandTemplateSemanticContent,
} from "../contracts/platform-brand-template.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(Object.getOwnPropertyDescriptor(v, k)?.value)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const codec = {
  canonicalize: canonical,
  hashIntent: (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex"),
};
const scope = {
  kind: "Platform" as const,
  actorReference: id(1),
  purposeCode: "PLATFORM_BRAND_TEMPLATE" as const,
};
const content = {
  code: "BRAND_STANDARD",
  name: "Brand standard",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
};
const command = () =>
  parsePlatformBrandTemplateSave({
    profile: "PlatformBrandTemplateSaveV1",
    ...scope,
    operationReference: id(2),
    templateReference: null,
    expectedHead: null,
    content,
  });
function revision(revision = 1) {
  return createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(3),
      templateVersionReference: id(revision + 3),
      revision,
      recordKind: "AuthoredContent",
      content,
      supersedesVersionReference: revision === 1 ? null : id(revision + 2),
      authoredByReference: id(1),
      operationReference: id(2),
      auditReference: id(5),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
}
function receipt() {
  const original = command();
  return parsePlatformBrandTemplateReceipt(
    {
      profile: "PlatformBrandTemplateOperationV1",
      ...scope,
      operationReference: id(2),
      intentDigest: platformBrandTemplateIntentDigest(original, codec),
      originalCommand: original,
      outcome: "Committed",
      snapshot: revision(),
      auditReference: id(5),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
}
it("stores bounded actual policy content with no publication or foreign scope claim", () => {
  expect(parsePlatformBrandTemplateContent(content)).toEqual(content);
  expect(revision()).toMatchObject({ recordKind: "AuthoredContent", content });
  expect(revision()).not.toHaveProperty("lifecycle");
  expect(() => parsePlatformBrandTemplateScope({ ...scope, brandReference: id(9) })).toThrow();
  expect(() => parsePlatformBrandTemplateScope({ ...scope, kind: "Brand" })).toThrow();
});
it("refuses hidden/accessor authority or content fields without invoking getters", () => {
  const getter = vi.fn(() => content);
  expect(() =>
    parsePlatformBrandTemplateSave({
      ...command(),
      get content() {
        return getter();
      },
    }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const hidden = { ...content };
  Object.defineProperty(hidden, "trusted", { value: true, enumerable: false });
  expect(() => parsePlatformBrandTemplateContent(hidden)).toThrow();
  expect(() => parsePlatformBrandTemplateContent({ ...content, published: true })).toThrow();
});
for (const patch of [
  { supportedLocales: [] },
  { supportedLocales: ["en-CA", "en-CA"] },
  { defaultLocale: "de-DE" },
  { overrideAllowedFieldCodes: ["SECURITY.REAUTH"] },
  { name: " <script> " },
  { name: "a".repeat(161) },
  { reasonCode: "" },
  { effectiveUntil: at },
  { effectiveFrom: "2026-02-30T00:00:00.000Z" },
])
  it("rejects invalid policy and bounded label: " + JSON.stringify(patch), () =>
    expect(() => parsePlatformBrandTemplateContent({ ...content, ...patch })).toThrow(),
  );
it("binds both full immutable source and semantic hashes, with sorted policy sets", () => {
  const r = revision();
  expect(assertPlatformBrandTemplateRevisionDigests(r, codec)).toEqual(r);
  expect(() =>
    assertPlatformBrandTemplateRevisionDigests(
      { ...r, content: { ...r.content, name: "Different" } },
      codec,
    ),
  ).toThrow();
  const reversed = {
    ...r,
    content: { ...r.content, supportedLocales: [...r.content.supportedLocales].reverse() },
  };
  expect(canonical(platformBrandTemplateSemanticContent(reversed))).toBe(
    canonical(platformBrandTemplateSemanticContent(r)),
  );
  expect(() => assertPlatformBrandTemplateRevisionDigests(reversed, codec)).toThrow();
});
it("requires CAS pins for existing identity and scalar original intent", () => {
  expect(() =>
    parsePlatformBrandTemplateSave({ ...command(), templateReference: id(3) }),
  ).toThrow();
  const original = parsePlatformBrandTemplateResolve({
    profile: "PlatformBrandTemplateResolveV1",
    ...scope,
    operationReference: id(2),
    intentDigest: platformBrandTemplateIntentDigest(command(), codec),
  });
  expect(original).not.toHaveProperty("content");
  expect(() => parsePlatformBrandTemplateResolve({ ...original, content })).toThrow();
});
it("binds committed receipt to exact original author, content, ID, Audit and time", () => {
  const r = receipt();
  for (const patch of [
    { actorReference: id(9) },
    { intentDigest: "sha256:" + "a".repeat(64) },
    { auditReference: id(9) },
    { originalCommand: { ...r.originalCommand, content: { ...content, name: "Changed" } } },
    { snapshot: { ...r.snapshot, authoredByReference: id(9) } },
  ])
    expect(() => parsePlatformBrandTemplateReceipt({ ...r, ...patch }, codec)).toThrow();
});
it("allows only an explicit null-payload Abandoned original", () => {
  const r = receipt();
  expect(
    parsePlatformBrandTemplateReceipt(
      { ...r, outcome: "Abandoned", snapshot: null, originalCommand: null },
      codec,
    ).outcome,
  ).toBe("Abandoned");
  expect(() =>
    parsePlatformBrandTemplateReceipt({ ...r, outcome: "Abandoned", snapshot: null }, codec),
  ).toThrow();
});
it("keeps current reader distinct from author and publication NotEvaluated", () => {
  const r = revision(),
    base = {
      ...scope,
      actorReference: id(9),
      observedAt: at,
      validUntil: until,
      publication: "NotEvaluated",
    };
  expect(
    parsePlatformBrandTemplateCurrent(
      { profile: "PlatformBrandTemplateCurrentV1", ...base, templateReference: id(3), current: r },
      codec,
    ),
  ).toMatchObject({
    actorReference: id(9),
    current: { authoredByReference: id(1) },
    publication: "NotEvaluated",
  });
  expect(
    parsePlatformBrandTemplateExact(
      {
        profile: "PlatformBrandTemplateExactV1",
        ...base,
        templateVersionReference: r.templateVersionReference,
        snapshot: r,
      },
      codec,
    ).snapshot,
  ).toEqual(r);
  expect(() =>
    parsePlatformBrandTemplateCurrent(
      {
        profile: "PlatformBrandTemplateCurrentV1",
        ...base,
        templateReference: id(3),
        current: r,
        publication: "Published",
      },
      codec,
    ),
  ).toThrow();
});
it("parses descending bounded history with exact owner cursor and original <=5s observation", () => {
  const entries = [revision(3), revision(2)],
    packet = {
      profile: "PlatformBrandTemplateHistoryV1",
      ...scope,
      templateReference: id(3),
      beforeRevision: 4,
      entries,
      nextBeforeRevision: 2,
      observedAt: at,
      validUntil: until,
      publication: "NotEvaluated",
    };
  expect(parsePlatformBrandTemplateHistory(packet, codec).nextBeforeRevision).toBe(2);
  for (const patch of [
    { entries: [...entries].reverse() },
    { nextBeforeRevision: 3 },
    { beforeRevision: 3 },
    { validUntil: "2026-10-06T10:00:06.000Z" },
  ])
    expect(() => parsePlatformBrandTemplateHistory({ ...packet, ...patch }, codec)).toThrow();
});

function summary(template = id(3), code = "BRAND_STANDARD") {
  const r = revision();
  return {
    templateReference: template,
    templateVersionReference: id(100 + Number.parseInt(template.slice(-12), 16)),
    revision: r.revision,
    code,
    name: r.content.name,
    contentDigest: r.contentDigest,
    sourceDigest: r.sourceDigest,
    authoredByReference: r.authoredByReference,
    recordedAt: r.recordedAt,
  };
}
function listPacket() {
  const first = summary(id(3), "FIRST_TEMPLATE"),
    second = summary(id(9), "SECOND_TEMPLATE");
  return {
    profile: "PlatformBrandTemplateListV1",
    ...scope,
    actorReference: id(8),
    after: null,
    limit: 2,
    items: [first, second],
    hasMore: true,
    nextCursor: { code: second.code, templateReference: second.templateReference },
    observedAt: at,
    validUntil: until,
    publication: "NotEvaluated",
  };
}
it("parses bounded real-label discovery and exact last-item cursor without publication claims", () => {
  const packet = listPacket(),
    parsed = parsePlatformBrandTemplateList(packet);
  expect(parsed.items).toEqual(packet.items);
  expect(parsed.actorReference).toBe(id(8));
  expect(parsed.items[0]?.authoredByReference).toBe(id(1));
  expect(parsed.publication).toBe("NotEvaluated");
  expect(Object.isFrozen(parsed.items)).toBe(true);
  expect(
    parsePlatformBrandTemplateList({
      ...packet,
      after: packet.nextCursor,
      items: [],
      hasMore: false,
      nextCursor: null,
    }).items,
  ).toEqual([]);
});
it("rejects malformed discovery request bounds and accessors without invoking them", () => {
  for (const request of [
    { after: null, limit: 0 },
    { after: null, limit: 21 },
    { after: null, limit: 1.5 },
    { after: { code: "bad", templateReference: id(3) }, limit: 1 },
    { after: { code: "BRAND_STANDARD", templateReference: "bad" }, limit: 1 },
    { after: null, limit: 1, qualification: true },
  ])
    expect(() => parsePlatformBrandTemplateListRequest(request)).toThrow();
  const getter = vi.fn(() => 1),
    request = { after: null };
  Object.defineProperty(request, "limit", { enumerable: true, get: getter });
  expect(() => parsePlatformBrandTemplateListRequest(request)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects unordered, duplicate, oversized or forged-cursor discovery packets", () => {
  const packet = listPacket();
  for (const patch of [
    { items: [...packet.items].reverse() },
    { items: [packet.items[0], packet.items[0]] },
    { limit: 1 },
    { nextCursor: { code: "OTHER", templateReference: id(9) } },
    { hasMore: false },
    { after: packet.nextCursor },
    { publication: "Published" },
    { items: [{ ...packet.items[0], name: "<bad>" }, packet.items[1]] },
    { validUntil: "2026-10-06T10:00:06.000Z" },
    { items: [{ ...packet.items[0], recordedAt: until }, packet.items[1]] },
  ])
    expect(() => parsePlatformBrandTemplateList({ ...packet, ...patch })).toThrow();
  const getter = vi.fn(() => packet.items[0]),
    items: unknown[] = [];
  Object.defineProperty(items, "0", { enumerable: true, get: getter });
  expect(() => parsePlatformBrandTemplateList({ ...packet, items })).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
