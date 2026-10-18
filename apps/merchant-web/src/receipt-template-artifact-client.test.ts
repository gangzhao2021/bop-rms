// Controlled HTTP with actual public Device parsers; not native IAM/legal evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateArtifactContent as owningContent,
  parseDigitalReceiptTemplateArtifactVersion as owningVersion,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-artifact.js";
import {
  createReceiptTemplateArtifactClient,
  parseReceiptTemplateArtifactContent,
  parseReceiptTemplateArtifactSnapshot,
  parseReceiptTemplateArtifactsCurrent,
  validateReceiptTemplateArtifactReceipt,
  receiptTemplateArtifactRequiredFields,
  type ReceiptTemplateArtifactKind,
  type PreparedReceiptTemplateArtifact,
} from "./receipt-template-artifact-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
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
const content = (k: ReceiptTemplateArtifactKind) =>
  k === "Layout"
    ? {
        profile: "AccessibleDigitalReceiptLayoutV1",
        dataContractVersion: 1,
        renderEngineVersion: 1,
        outputProfile: "AccessibleDigitalReceipt",
        requiredFields: [...receiptTemplateArtifactRequiredFields],
      }
    : {
        profile: "DigitalReceiptRequiredFieldRuleV1",
        dataContractVersion: 1,
        requiredFields: [...receiptTemplateArtifactRequiredFields],
        professionalReviewStatus: "NotEvaluated",
        legalConclusion: "NotEvaluated",
      };
const prepare = (artifactKind: ReceiptTemplateArtifactKind = "Layout") => ({
  expectedScope: scope,
  artifactKind,
  operationReference: id(5),
  expectedArtifactReference: null,
  expectedRevision: 0,
  content: content(artifactKind),
});
const snapshot = (artifactKind: ReceiptTemplateArtifactKind = "Layout") => ({
  profile: "DigitalReceiptTemplateArtifactV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  artifactKind,
  artifactReference: id(6),
  revision: 1,
  authoredByReference: id(4),
  previousArtifactReference: null,
  content: content(artifactKind),
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const current = () => ({
  profile: "DigitalReceiptTemplateArtifactsCurrentV1",
  ...scope,
  layout: null,
  compliance: null,
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const receipt = (p: PreparedReceiptTemplateArtifact) => ({
  profile: "DigitalReceiptTemplateArtifactReceiptV1",
  ...scope,
  artifactKind: p.cursor.artifactKind,
  operationReference: p.cursor.operationReference,
  intentDigest: p.intentDigest,
  expectedArtifactReference: null,
  expectedRevision: 0,
  outcome: "Committed",
  snapshot: snapshot(p.cursor.artifactKind),
  auditReference: id(7),
  occurredAt: at,
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it.each(["Layout", "Compliance"] as const)(
  "%s browser content/version matches owning constructors without legal claims",
  (k) => {
    expect(parseReceiptTemplateArtifactContent(k, content(k))).toEqual(
      owningContent(content(k), k),
    );
    expect(parseReceiptTemplateArtifactSnapshot(snapshot(k))).toEqual(owningVersion(snapshot(k)));
  },
);
it("current GET has real scope4 and allows historical author distinct from reader", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...current(), layout: snapshot(), actorReference: id(9) })),
    c = createReceiptTemplateArtifactClient(f);
  expect((await c.load({ storeReference: id(3) })).actorReference).toBe(id(9));
  expect(f.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/receipt-artifacts?storeReference=${id(3)}`,
  );
  expect(parseReceiptTemplateArtifactsCurrent(current(), id(3)).sourceQualification).toBe(
    "NotEvaluated",
  );
});
it.each(["Layout", "Compliance"] as const)(
  "%s Save has exact five body keys, dedicated scope header and detached original",
  async (k) => {
    const f = vi.fn<typeof fetch>(),
      c = createReceiptTemplateArtifactClient(f),
      p = await c.prepare(prepare(k));
    f.mockResolvedValue(response(receipt(p)));
    await c.execute(p, { csrf });
    expect(f.mock.calls[0]?.[0]).toBe(`/merchant/store-setup/receipt-artifacts/${k.toLowerCase()}`);
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
      command: "SaveArtifact",
      operationReference: id(5),
      expectedArtifactReference: null,
      expectedRevision: 0,
      content: content(k),
    });
    const h = new Headers(f.mock.calls[0]?.[1]?.headers),
      encoded = h.get("X-BOP-Store-Setup-Scope");
    if (!encoded) throw new Error("scope missing");
    expect(atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/"))).toBe(canonical(scope));
    expect(Object.isFrozen(p.command.content.requiredFields)).toBe(true);
  },
);
it("lost result exact retry keeps same operation and bytes, Resolve excludes artifact content", async () => {
  const f = vi.fn<typeof fetch>(),
    c = createReceiptTemplateArtifactClient(f),
    p = await c.prepare(prepare());
  f.mockRejectedValueOnce(new Error("synthetic loss")).mockImplementation(async () =>
    response(receipt(p)),
  );
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await c.execute(p, { csrf });
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  await c.resolve(p.cursor, { csrf });
  expect(JSON.parse(String(f.mock.calls[2]?.[1]?.body))).toEqual({
    command: "ResolveOriginal",
    operationReference: id(5),
    expectedArtifactReference: null,
    expectedRevision: 0,
    intentDigest: p.intentDigest,
  });
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
])("status %s never silently retries or discards original", async (status, code) => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response({}, Number(status))),
    c = createReceiptTemplateArtifactClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code });
  expect(f).toHaveBeenCalledTimes(1);
});
it("rejects HTML, altered field order, legal/professional conclusions and getters", () => {
  expect(() =>
    parseReceiptTemplateArtifactContent("Layout", { ...content("Layout"), html: "<p>Receipt</p>" }),
  ).toThrow();
  expect(() =>
    parseReceiptTemplateArtifactContent("Layout", {
      ...content("Layout"),
      requiredFields: [...receiptTemplateArtifactRequiredFields].reverse(),
    }),
  ).toThrow();
  expect(() =>
    parseReceiptTemplateArtifactContent("Compliance", {
      ...content("Compliance"),
      legalConclusion: "Approved",
    }),
  ).toThrow();
  let called = false;
  const value = { ...content("Layout") };
  Object.defineProperty(value, "requiredFields", {
    enumerable: true,
    get() {
      called = true;
      return receiptTemplateArtifactRequiredFields;
    },
  });
  expect(() => parseReceiptTemplateArtifactContent("Layout", value)).toThrow();
  expect(called).toBe(false);
});
it("receipt must bind original kind, author, parent and recomputed content digest", async () => {
  const c = createReceiptTemplateArtifactClient(),
    p = await c.prepare(prepare()),
    r = receipt(p);
  await expect(
    validateReceiptTemplateArtifactReceipt({ ...r, artifactKind: "Compliance" }, p.cursor),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateReceiptTemplateArtifactReceipt(
      { ...r, snapshot: { ...snapshot(), authoredByReference: id(9) } },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateReceiptTemplateArtifactReceipt(
      { ...r, intentDigest: "sha256:" + "f".repeat(64) },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(
    await validateReceiptTemplateArtifactReceipt(
      { ...r, outcome: "Abandoned", snapshot: null },
      p.cursor,
    ),
  ).toMatchObject({ outcome: "Abandoned" });
});
it("malformed or foreign current and expired leases fail closed", async () => {
  for (const v of [
    { ...current(), sourceQualification: "Pass" },
    { ...current(), layout: snapshot("Compliance") },
    { ...current(), layout: { ...snapshot(), storeReference: id(9) } },
    { ...current(), validUntil: "2026-10-05T10:00:05.001Z" },
  ])
    expect(() => parseReceiptTemplateArtifactsCurrent(v, id(3))).toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createReceiptTemplateArtifactClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(current())),
    ).load({ storeReference: id(3) }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("scope transition drops old response and sent abort stays unknown", async () => {
  let answer: ((v: Response) => void) | undefined;
  const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            answer = r;
          }),
      )
      .mockResolvedValueOnce(response({ ...current(), storeReference: id(9) })),
    c = createReceiptTemplateArtifactClient(f),
    old = c.load({ storeReference: id(3) });
  await c.load({ storeReference: id(9) });
  if (!answer) throw new Error("missing request");
  answer(response(current()));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
  const p = await c.prepare(prepare()),
    a = new AbortController(),
    g = vi.fn<typeof fetch>(async () => {
      a.abort();
      return response(receipt(p));
    });
  await expect(
    createReceiptTemplateArtifactClient(g).execute(p, { csrf, signal: a.signal }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("noncanonical credentials and oversized streamed replies cannot dispatch or report terminal", async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(65537), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    ),
    c = createReceiptTemplateArtifactClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf: "bad" })).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
