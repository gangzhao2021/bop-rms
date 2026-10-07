// Controlled HTTP facts, not native current IAM or Device publication evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createReceiptTemplatePublishedClient,
  parseReceiptTemplatePublishedCurrent,
} from "./receipt-template-published-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
function packet() {
  return {
    profile: "DigitalReceiptTemplatePublishedCurrentV1",
    ...scope,
    templateReference: id(8),
    locale: "en",
    currentVersion: {
      templateReference: id(8),
      versionReference: id(9),
      versionNumber: 1,
      versionCode: "RECEIPT_1",
      brandReference: id(2),
      storeReference: id(3),
      locale: "en",
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      layoutDefinitionReference: id(10),
      complianceRuleReference: id(11),
      requiredFields: receiptTemplateArtifactRequiredFields,
      publicationReference: id(12),
      publishedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
    },
    observedAt: at,
    validUntil: "2026-10-05T10:00:05.000Z",
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  };
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const input = () => ({ expectedScope: scope, templateReference: id(8), locale: "en" });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("GET uses real scope4 header and exact identifiers, no CSRF/body, and returns frozen actual version", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(packet())),
    result = await createReceiptTemplatePublishedClient(f).load(input());
  expect(result.currentVersion.versionReference).toBe(id(9));
  expect(Object.isFrozen(result)).toBe(true);
  const [url, options] = f.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    `/merchant/store-setup/receipt-template-published?storeReference=${id(3)}&templateReference=${id(8)}&locale=en`,
  );
  expect(options).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const h = new Headers(options?.headers);
  expect(h.get("X-BOP-Store-Setup-Scope")).toBeTruthy();
  expect(h.has("X-BOP-CSRF")).toBe(false);
  expect(options?.body).toBeUndefined();
});
it.each(["locale", "scope", "future", "expired", "qualification", "extra", "fields"])(
  "strict public read refuses %s",
  (kind) => {
    const p = packet();
    const changed =
      kind === "locale"
        ? { ...p, locale: "fr" }
        : kind === "scope"
          ? { ...p, actorReference: id(99) }
          : kind === "future"
            ? {
                ...p,
                currentVersion: { ...p.currentVersion, effectiveFrom: "2026-10-06T10:00:00.000Z" },
              }
            : kind === "expired"
              ? { ...p, currentVersion: { ...p.currentVersion, effectiveUntil: at } }
              : kind === "qualification"
                ? { ...p, legalConclusion: "Approved" }
                : kind === "extra"
                  ? { ...p, ready: true }
                  : { ...p, currentVersion: { ...p.currentVersion, requiredFields: [] } };
    expect(() => parseReceiptTemplatePublishedCurrent(changed, scope, id(8), "en")).toThrow();
  },
);
it("unknown current, Denied and conflict are bounded without echo", async () => {
  for (const [status, code] of [
    [403, "Denied"],
    [409, "Conflict"],
    [503, "Unavailable"],
  ]) {
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("private message", { status: Number(status) }));
    await expect(createReceiptTemplatePublishedClient(f).load(input())).rejects.toMatchObject({
      code,
    });
  }
});
it("missing no-store, oversized or stale observation never becomes a selectable version", async () => {
  for (const r of [
    new Response(JSON.stringify(packet()), { headers: { "content-type": "application/json" } }),
    response("x".repeat(33000)),
    response({ ...packet(), validUntil: at }),
  ])
    await expect(
      createReceiptTemplatePublishedClient(vi.fn<typeof fetch>().mockResolvedValue(r)).load(
        input(),
      ),
    ).rejects.toThrow();
});
it("Abort before or during transport is refused and old subject response cannot replace newer request", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const f = vi.fn<typeof fetch>();
  await expect(
    createReceiptTemplatePublishedClient(f).load({ ...input(), signal: aborted.signal }),
  ).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
  let release: ((r: Response) => void) | undefined;
  const client = createReceiptTemplatePublishedClient(
    vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(async () => response(packet())),
  );
  const old = client.load(input());
  await client.load(input());
  if (!release) throw new Error("fixture transport missing");
  release(response(packet()));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("caller mutation and getters cannot substitute selected scope or execute accessor", async () => {
  let calls = 0;
  const getter = {
    ...input(),
    get locale() {
      calls++;
      return "en";
    },
  };
  await expect(createReceiptTemplatePublishedClient().load(getter)).rejects.toThrow();
  expect(calls).toBe(0);
  let release: ((r: Response) => void) | undefined;
  const mutable = { ...input(), expectedScope: { ...scope } },
    client = createReceiptTemplatePublishedClient(
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
  const pending = client.load(mutable);
  mutable.expectedScope.actorReference = id(99);
  if (!release) throw new Error("fixture transport missing");
  release(response(packet()));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});

it("aborted in-flight response and foreign active version never survive final observation", async () => {
  const controller = new AbortController();
  let release: ((r: Response) => void) | undefined;
  const c = createReceiptTemplatePublishedClient(
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    ),
    pending = c.load({ ...input(), signal: controller.signal });
  controller.abort();
  if (!release) throw new Error("fixture transport missing");
  release(response(packet()));
  await expect(pending).rejects.toMatchObject({ code: "Unavailable" });
  const p = packet();
  expect(() =>
    parseReceiptTemplatePublishedCurrent(
      { ...p, currentVersion: { ...p.currentVersion, storeReference: id(99) } },
      scope,
      id(8),
      "en",
    ),
  ).toThrow();
});
