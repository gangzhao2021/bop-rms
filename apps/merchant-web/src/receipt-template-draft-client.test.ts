// Controlled HTTP/identity; these tests do not prove native IAM or template publication.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createReceiptTemplateDraftClient,
  parseReceiptTemplateDraftFields,
  parseReceiptTemplateDraftContent,
  parseReceiptTemplateDraftSnapshot,
  parseReceiptTemplateDraftCurrent,
  validateReceiptTemplateDraftReceipt,
  type PreparedReceiptTemplateDraft,
} from "./receipt-template-draft-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const fields = () => ({
  locale: "en-CA",
  layoutDefinitionReference: id(5),
  complianceRuleReference: id(6),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
const input = () => ({
  expectedScope: scope,
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  operationReference: id(7),
  fields: fields(),
});
const content = () => ({
  profile: "DigitalReceiptTemplateContentV2",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  templateReference: id(8),
  versionReference: id(9),
  versionNumber: 1,
  versionCode: "RECEIPT_1",
  ...fields(),
  dataContractVersion: 1,
  renderEngineVersion: 1,
  outputProfile: "AccessibleDigitalReceipt",
  requiredFields: [...receiptTemplateArtifactRequiredFields],
  dataClassification: "Internal",
});
async function snapshot() {
  const c = content();
  return {
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(10),
    revision: 1,
    authoredByReference: id(4),
    previousVersionReference: null,
    content: c,
    contentDigest: await publicationValueDigest(c),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
const current = (templateReference: string | null = null, snapshot: unknown = null) => ({
  profile: "DigitalReceiptTemplateDraftCurrentV1",
  ...scope,
  templateReference,
  snapshot,
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
async function receipt(p: PreparedReceiptTemplateDraft, abandoned = false) {
  return {
    profile: "DigitalReceiptTemplateDraftReceiptV1",
    ...scope,
    operationReference: p.cursor.operationReference,
    templateReference: p.cursor.templateReference,
    expectedVersionReference: p.cursor.expectedVersionReference,
    expectedRevision: p.cursor.expectedRevision,
    intentDigest: p.intentDigest,
    outcome: abandoned ? "Abandoned" : "Committed",
    snapshot: abandoned ? null : await snapshot(),
    auditReference: id(11),
    occurredAt: at,
  };
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("prepares exact five editable fields with no caller server IDs or credential cache", async () => {
  const p = await createReceiptTemplateDraftClient().prepare(input());
  expect(p.intentDigest).toBe(await publicationValueDigest(p.command));
  expect(p.cursor.templateReference).toBeNull();
  expect(Object.isFrozen(p.command.fields.activation)).toBe(true);
  expect(JSON.stringify(p.cursor)).not.toMatch(
    /locale|layoutDefinitionReference|csrf|content|fields/u,
  );
  await expect(
    createReceiptTemplateDraftClient().prepare({
      ...input(),
      fields: { ...fields(), versionNumber: 1 },
    }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("validates complete V2 fixed field ordering, locale and scheduled effective period", () => {
  expect(parseReceiptTemplateDraftContent(content()).requiredFields).toEqual(
    receiptTemplateArtifactRequiredFields,
  );
  expect(
    parseReceiptTemplateDraftFields({
      ...fields(),
      activation: { mode: "Scheduled", effectiveFrom: "2026-10-06T00:00:00.000Z" },
      effectiveUntil: "2026-10-07T00:00:00.000Z",
    }).activation.mode,
  ).toBe("Scheduled");
  expect(() =>
    parseReceiptTemplateDraftContent({
      ...content(),
      requiredFields: [...receiptTemplateArtifactRequiredFields].reverse(),
    }),
  ).toThrow();
  expect(() =>
    parseReceiptTemplateDraftFields({
      ...fields(),
      activation: { mode: "Scheduled", effectiveFrom: until },
      effectiveUntil: at,
    }),
  ).toThrow();
});
it("loads truthful null subject and explicit existing template without treating artifact as template", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(current()));
  const client = createReceiptTemplateDraftClient(fetcher);
  expect(
    (await client.load({ storeReference: id(3), templateReference: null })).snapshot,
  ).toBeNull();
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/receipt-template-draft?storeReference=${id(3)}`,
  );
  const s = await snapshot();
  fetcher.mockImplementation(async () => response(current(id(8), s)));
  expect(
    (await client.load({ storeReference: id(3), templateReference: id(8), expectedScope: scope }))
      .snapshot?.content.versionReference,
  ).toBe(id(9));
  expect(fetcher.mock.calls[1]?.[0]).toContain(`templateReference=${id(8)}`);
});
it("uses closed six-key same-origin Save, immutable exact retry and hash-only Resolve", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    client = createReceiptTemplateDraftClient(fetcher),
    p = await client.prepare(input()),
    r = await receipt(p);
  fetcher.mockImplementation(async () => response(r));
  expect(await client.execute(p, { csrf })).toEqual(r);
  await client.execute(p, { csrf });
  await client.resolve(p.cursor, { csrf });
  const first = fetcher.mock.calls[0]?.[1];
  expect(first?.credentials).toBe("same-origin");
  expect(first?.cache).toBe("no-store");
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(first?.body);
  const body = JSON.parse(String(first?.body));
  expect(Object.keys(body).sort()).toEqual(
    [
      "command",
      "expectedRevision",
      "expectedVersionReference",
      "fields",
      "operationReference",
      "templateReference",
    ].sort(),
  );
  const resolved = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
  expect(resolved.command).toBe("ResolveOriginal");
  expect(resolved.intentDigest).toBe(p.intentDigest);
  expect(resolved.fields).toBeUndefined();
  expect(new Headers(first?.headers).get("X-BOP-Store-Setup-Scope")).toBe(
    btoa(canonical(scope)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  );
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [503, "OutcomeUnknown"],
] as const)("retains exact original after HTTP %s", async (status, code) => {
  const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ error: "bounded" }, status)),
    client = createReceiptTemplateDraftClient(fetcher),
    p = await client.prepare(input());
  await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code });
  expect(p.cursor.operationReference).toBe(id(7));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects corrupted content/hash, mismatched result template and incomplete immutable receipt", async () => {
  const client = createReceiptTemplateDraftClient(),
    p = await client.prepare(input()),
    r = await receipt(p);
  await expect(
    validateReceiptTemplateDraftReceipt(
      { ...r, snapshot: { ...(await snapshot()), contentDigest: `sha256:${"0".repeat(64)}` } },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateReceiptTemplateDraftReceipt({ ...r, templateReference: id(99) }, p.cursor),
  ).rejects.toThrow();
  const s = await snapshot();
  expect(() =>
    parseReceiptTemplateDraftSnapshot({ ...s, previousVersionReference: id(99) }),
  ).toThrow();
});
it("permits historical author distinct current reader but refuses source scope/subject/stale lease", async () => {
  const s = await snapshot(),
    v = current(id(8), s);
  expect(
    parseReceiptTemplateDraftCurrent({ ...v, actorReference: id(12) }, id(3), id(8)).snapshot
      ?.authoredByReference,
  ).toBe(id(4));
  expect(() => parseReceiptTemplateDraftCurrent(v, id(3), id(90))).toThrow();
  expect(() =>
    parseReceiptTemplateDraftCurrent({ ...v, storeReference: id(99) }, id(3), id(8)),
  ).toThrow();
  const c = createReceiptTemplateDraftClient(
    vi.fn<typeof fetch>().mockImplementation(async () => response({ ...v, validUntil: at })),
  );
  await expect(c.load({ storeReference: id(3), templateReference: id(8) })).rejects.toThrow();
});
it("late scope/subject response never repopulates a newer subject", async () => {
  let release: (v: Response) => void = () => undefined;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementationOnce(async () => response(current(id(20))));
  const c = createReceiptTemplateDraftClient(fetcher),
    old = c.load({ storeReference: id(3), templateReference: null });
  await c.load({ storeReference: id(3), templateReference: id(20) });
  release(response(current()));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("abort or malformed confirmed write remains OutcomeUnknown, never automatic replacement", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response({ profile: "invalid" })),
    c = createReceiptTemplateDraftClient(f),
    p = await c.prepare(input());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  await expect(c.execute(p, { csrf, signal: controller.signal })).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(f).toHaveBeenCalledTimes(1);
});
it("rejects getters, sparse canonical fields, and non-zero missing parent before transport", async () => {
  const getter = Object.defineProperty({ ...fields() }, "locale", {
    get: () => "en-CA",
    enumerable: true,
  });
  expect(() => parseReceiptTemplateDraftFields(getter)).toThrow();
  const sparse = Array(13);
  expect(() =>
    parseReceiptTemplateDraftContent({ ...content(), requiredFields: sparse }),
  ).toThrow();
  await expect(
    createReceiptTemplateDraftClient().prepare({ ...input(), expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("loads real roster projection with immutable original snapshots and truthful non-publication status", async () => {
  const s = await snapshot(),
    packet = {
      profile: "DigitalReceiptTemplateDraftRosterV1",
      ...scope,
      afterTemplate: null,
      entries: [s],
      nextAfter: null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    },
    f = vi.fn<typeof fetch>().mockImplementation(async () => response(packet));
  const result = await createReceiptTemplateDraftClient(f).loadRoster({
    storeReference: id(3),
    afterTemplate: null,
    expectedScope: scope,
  });
  expect(result.entries[0]?.familyReference).toBe(id(10));
  expect(result.sourceQualification).toBe("NotEvaluated");
  expect(f.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/receipt-template-drafts?storeReference=${id(3)}`,
  );
});
it("roster rejects cursor ordering, ambiguous duplicate templates, forged page pointers and content digests", async () => {
  const s = await snapshot(),
    base = {
      profile: "DigitalReceiptTemplateDraftRosterV1",
      ...scope,
      afterTemplate: null,
      entries: [s],
      nextAfter: null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    };
  for (const packet of [
    { ...base, entries: [s, s] },
    { ...base, nextAfter: id(8) },
    { ...base, entries: [{ ...s, contentDigest: `sha256:${"0".repeat(64)}` }] },
  ]) {
    const c = createReceiptTemplateDraftClient(
      vi.fn<typeof fetch>().mockImplementation(async () => response(packet)),
    );
    await expect(
      c.loadRoster({ storeReference: id(3), afterTemplate: null }),
    ).rejects.toMatchObject({ code: "Invalid" });
  }
  const f = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ ...base, afterTemplate: id(8), entries: [] }));
  await createReceiptTemplateDraftClient(f).loadRoster({
    storeReference: id(3),
    afterTemplate: id(8),
  });
  expect(f.mock.calls[0]?.[0]).toContain(`afterTemplate=${id(8)}`);
});

it.each(["Current", "Roster"] as const)(
  "%s refuses cancellation during asynchronous content digest validation",
  async (kind) => {
    const saved = await snapshot();
    const body =
      kind === "Current"
        ? current(id(8), saved)
        : {
            profile: "DigitalReceiptTemplateDraftRosterV1",
            ...scope,
            afterTemplate: null,
            entries: [saved],
            nextAfter: null,
            observedAt: at,
            validUntil: until,
            sourceQualification: "NotEvaluated",
          };
    let resume: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      markEntered?.();
      await gate;
      return originalDigest(...args);
    });
    const controller = new AbortController();
    const client = createReceiptTemplateDraftClient(vi.fn(async () => response(body)));
    const reading =
      kind === "Current"
        ? client.load({
            storeReference: id(3),
            templateReference: id(8),
            expectedScope: scope,
            signal: controller.signal,
          })
        : client.loadRoster({
            storeReference: id(3),
            afterTemplate: null,
            expectedScope: scope,
            signal: controller.signal,
          });
    const refused = expect(reading).rejects.toMatchObject({ code: "ScopeChanged" });
    await entered;
    controller.abort();
    resume?.();
    await refused;
  },
);
