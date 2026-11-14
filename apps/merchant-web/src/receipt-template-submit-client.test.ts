// Controlled HTTP and identities; not native IAM, approval, or publication evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createReceiptTemplateSubmitClient,
  parseReceiptTemplateReviewCurrent,
  parseReceiptTemplateSubmitCursor,
  validateReceiptTemplateSubmitReceipt,
  type PreparedReceiptTemplateSubmit,
} from "./receipt-template-submit-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43),
  digest = `sha256:${"a".repeat(64)}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const input = () => ({
  expectedScope: scope,
  operationReference: id(7),
  templateReference: id(8),
  expectedVersionReference: id(9),
  expectedRevision: 2,
});
const submission = () => ({
  profile: "DigitalReceiptTemplateSubmissionV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  templateReference: id(8),
  familyReference: id(10),
  versionReference: id(9),
  draftRevision: 2,
  contentDigest: digest,
  authoredByReference: id(5),
  submittedByReference: id(4),
  operationReference: id(7),
  reviewLifecycleReference: id(11),
  reviewVersion: 2,
  validationEvidenceReference: id(12),
  checkedAt: at,
  validationValidUntil: "2026-10-08T10:00:00.000Z",
  submittedAt: at,
  auditReference: id(13),
  dataClassification: "Internal",
});
const current = (recorded = false) => ({
  profile: "DigitalReceiptTemplateReviewCurrentV1",
  ...scope,
  templateReference: id(8),
  currentDraft: { versionReference: id(9), revision: 2, contentDigest: digest },
  submission: recorded ? submission() : null,
  lifecycle: recorded
    ? {
        lifecycleReference: id(11),
        version: 2,
        state: "InReview",
        latestMutationOperationReference: id(7),
        changedAt: at,
        validationEvidenceReference: id(12),
        approvalEvidenceReference: null,
      }
    : null,
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const receipt = (p: PreparedReceiptTemplateSubmit, abandoned = false) => ({
  profile: "DigitalReceiptTemplateSubmitReceiptV1",
  ...scope,
  operationReference: p.cursor.operationReference,
  templateReference: id(8),
  expectedVersionReference: id(9),
  expectedRevision: 2,
  intentDigest: p.intentDigest,
  outcome: abandoned ? "Abandoned" : "Committed",
  submission: abandoned ? null : submission(),
  auditReference: id(13),
  occurredAt: at,
});
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("prepares detached identity-only intent and no caller review IDs, deadline or content", async () => {
  const raw = { ...input(), expectedScope: { ...scope } },
    p = await createReceiptTemplateSubmitClient().prepare(raw);
  expect(p.intentDigest).toBe(await publicationValueDigest(p.command));
  expect(Object.isFrozen(p.cursor.scope)).toBe(true);
  raw.expectedScope.actorReference = id(90);
  expect(p.command.actorReference).toBe(id(4));
  expect(Object.keys(p.cursor)).toEqual([
    "profile",
    "scope",
    "operationReference",
    "templateReference",
    "expectedVersionReference",
    "expectedRevision",
    "intentDigest",
  ]);
  for (const extra of [
    { content: {} },
    { actorReference: id(90) },
    { validationValidUntil: until },
    { reviewLifecycleReference: id(11) },
  ])
    await expect(
      createReceiptTemplateSubmitClient().prepare({ ...input(), ...extra }),
    ).rejects.toMatchObject({ code: "Invalid" });
});
it("rejects getters, prototype injection, null template and invalid revision before dispatch", async () => {
  const getter = { ...input() };
  Object.defineProperty(getter, "expectedRevision", {
    enumerable: true,
    get: () => {
      throw new Error("getter executed");
    },
  });
  for (const v of [
    getter,
    Object.assign(Object.create({ foreign: true }), input()),
    { ...input(), templateReference: null },
    { ...input(), expectedRevision: 0 },
    { ...input(), expectedRevision: 2147483648 },
  ])
    await expect(createReceiptTemplateSubmitClient().prepare(v)).rejects.toMatchObject({
      code: "Invalid",
    });
});
it("loads actual absence and actual immutable submission with a different author/current reader", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(current())),
    c = createReceiptTemplateSubmitClient(f);
  expect(
    (await c.load({ storeReference: id(3), templateReference: id(8), expectedScope: scope }))
      .lifecycle,
  ).toBeNull();
  expect(f.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/receipt-template-review?storeReference=${id(3)}&templateReference=${id(8)}`,
  );
  expect(new Headers(f.mock.calls[0]?.[1]?.headers).get("x-bop-store-setup-scope")).toBe(
    btoa(canonical(scope)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  );
  const packet = { ...current(true), actorReference: id(99) };
  expect(
    parseReceiptTemplateReviewCurrent(packet, id(3), id(8)).submission?.submittedByReference,
  ).toBe(id(4));
});
it("rejects contradictory current root, invented lifecycle, malformed history and shifted scope", () => {
  const saved = current(true),
    s = submission();
  for (const packet of [
    { ...current(), lifecycle: saved.lifecycle },
    {
      ...saved,
      currentDraft: { ...saved.currentDraft, contentDigest: `sha256:${"b".repeat(64)}` },
    },
    { ...saved, submission: { ...s, validationValidUntil: at } },
    { ...saved, lifecycle: { ...saved.lifecycle, latestMutationOperationReference: id(90) } },
    { ...saved, sourceQualification: "Pass" },
  ])
    expect(() => parseReceiptTemplateReviewCurrent(packet, id(3), id(8), scope)).toThrow();
  expect(() =>
    parseReceiptTemplateReviewCurrent({ ...saved, actorReference: id(90) }, id(3), id(8), scope),
  ).toThrow();
});
it("accepts a successor Draft without claiming that successor was submitted", () => {
  const packet = {
    ...current(true),
    currentDraft: {
      versionReference: id(90),
      revision: 3,
      contentDigest: `sha256:${"b".repeat(64)}`,
    },
  };
  const parsed = parseReceiptTemplateReviewCurrent(packet, id(3), id(8));
  expect(parsed.submission?.versionReference).toBe(id(9));
  expect(parsed.currentDraft.versionReference).toBe(id(90));
});
it("sends exact five/six bodies and scope4 header, retrying original bytes without allocating IDs", async () => {
  const p = await createReceiptTemplateSubmitClient().prepare(input()),
    f = vi.fn<typeof fetch>().mockImplementation(async () => response(receipt(p))),
    c = createReceiptTemplateSubmitClient(f);
  await c.execute(p, { csrf });
  await c.execute(p, { csrf });
  await c.resolve(p.cursor, { csrf });
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  const body = JSON.parse(String(f.mock.calls[0]?.[1]?.body));
  expect(Object.keys(body).sort()).toEqual(
    [
      "command",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
    ].sort(),
  );
  expect(JSON.parse(String(f.mock.calls[2]?.[1]?.body))).toEqual({
    ...body,
    command: "ResolveOriginal",
    intentDigest: p.intentDigest,
  });
  const h = new Headers(f.mock.calls[0]?.[1]?.headers);
  expect(h.get("X-BOP-Store-Setup-Scope")).toBe(
    btoa(canonical(scope)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  );
  expect(f.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
});
it("validates historical committed and permanent abandoned originals without rechecking business expiry", async () => {
  const p = await createReceiptTemplateSubmitClient().prepare(input());
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-05T10:00:00.000Z"));
  expect(
    (await validateReceiptTemplateSubmitReceipt(receipt(p), p.cursor)).submission
      ?.authoredByReference,
  ).toBe(id(5));
  expect((await validateReceiptTemplateSubmitReceipt(receipt(p, true), p.cursor)).outcome).toBe(
    "Abandoned",
  );
  for (const r of [
    { ...receipt(p), intentDigest: digest },
    { ...receipt(p), submission: { ...submission(), submittedByReference: id(90) } },
    { ...receipt(p), submission: { ...submission(), versionReference: id(90) } },
  ])
    await expect(validateReceiptTemplateSubmitReceipt(r, p.cursor)).rejects.toThrow();
});
it("refuses forged cursor digest before a Resolve network call", async () => {
  const p = await createReceiptTemplateSubmitClient().prepare(input()),
    f = vi.fn<typeof fetch>();
  await expect(
    createReceiptTemplateSubmitClient(f).resolve({ ...p.cursor, intentDigest: digest }, { csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
  expect(() => parseReceiptTemplateSubmitCursor({ ...p.cursor, content: {} })).toThrow();
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
] as const)("maps %s without raw echo or automatic replacement", async (status, code) => {
  const p = await createReceiptTemplateSubmitClient().prepare(input()),
    f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ error: "request_denied" }, status));
  await expect(createReceiptTemplateSubmitClient(f).execute(p, { csrf })).rejects.toMatchObject({
    code,
  });
  expect(f).toHaveBeenCalledTimes(1);
});
it("malformed or oversized mutation replies remain unknown, reads stale and no-store failures refuse", async () => {
  const p = await createReceiptTemplateSubmitClient().prepare(input());
  for (const reply of [
    () => response({ ...receipt(p), unsafe: "x" }),
    () => response({ padding: "x".repeat(32769) }),
    () =>
      new Response(JSON.stringify(receipt(p)), { headers: { "content-type": "application/json" } }),
  ])
    await expect(
      createReceiptTemplateSubmitClient(vi.fn(async () => reply())).execute(p, { csrf }),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createReceiptTemplateSubmitClient(vi.fn(async () => response(current()))).load({
      storeReference: id(3),
      templateReference: id(8),
    }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("a late older request cannot replace another Actor's current observation", async () => {
  let release: ((v: Response) => void) | undefined;
  const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      )
      .mockImplementationOnce(async () => response({ ...current(), actorReference: id(90) })),
    c = createReceiptTemplateSubmitClient(f);
  const old = c.load({ storeReference: id(3), templateReference: id(8), expectedScope: scope });
  const refused = expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
  await c.load({
    storeReference: id(3),
    templateReference: id(8),
    expectedScope: { ...scope, actorReference: id(90) },
  });
  release?.(response(current()));
  await refused;
});
it.each(["execute", "resolve"] as const)(
  "%s checks AbortSignal after asynchronous intent hashing and never dispatches",
  async (method) => {
    const p = await createReceiptTemplateSubmitClient().prepare(input()),
      f = vi.fn<typeof fetch>(),
      controller = new AbortController();
    let resume: (() => void) | undefined, entered: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
        resume = r;
      }),
      start = new Promise<void>((r) => {
        entered = r;
      }),
      actual = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      entered?.();
      await gate;
      return actual(...args);
    });
    const c = createReceiptTemplateSubmitClient(f),
      promise =
        method === "execute"
          ? c.execute(p, { csrf, signal: controller.signal })
          : c.resolve(p.cursor, { csrf, signal: controller.signal });
    const refused = expect(promise).rejects.toMatchObject({ code: "Unavailable" });
    await start;
    controller.abort();
    resume?.();
    await refused;
    expect(f).not.toHaveBeenCalled();
  },
);
