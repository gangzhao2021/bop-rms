// Controlled transport fixtures; no native Session, Provider or readiness claim.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  parseStorePaymentConfigurationContent as owningContent,
  parseStorePaymentConfigurationVersion as owningVersion,
  parseStorePaymentConfigurationCurrent as owningCurrent,
} from "../../../packages/rms/payment/src/contracts/store-payment-configuration.js";
import {
  createStorePaymentConfigurationClient,
  parseStorePaymentConfigurationContent,
  parseStorePaymentConfigurationSnapshot,
  parseStorePaymentConfigurationCurrent,
  validateStorePaymentConfigurationReceipt,
  type PreparedStorePaymentConfiguration,
} from "./store-payment-configuration-client.js";
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
const content = {
  customerOnlineCardEnabled: false,
  staffTerminalCardPresentEnabled: true,
  staffTerminalInteracEnabled: true,
};
const prepare = () => ({
  expectedScope: scope,
  operationReference: id(5),
  expectedConfigurationReference: null,
  expectedRevision: 0,
  content,
});
const snapshot = () => ({
  profile: "StorePaymentConfigurationV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationReference: id(6),
  revision: 1,
  authoredByReference: id(4),
  previousConfigurationReference: null,
  content,
  currencyCode: "CAD",
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const current = () => ({
  profile: "StorePaymentConfigurationCurrentV1",
  ...scope,
  snapshot: null,
  observedAt: at,
  validUntil: until,
  providerReadiness: "NotEvaluated",
});
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const receipt = (p: PreparedStorePaymentConfiguration) => ({
  profile: "StorePaymentConfigurationReceiptV1",
  ...scope,
  operationReference: p.cursor.operationReference,
  intentDigest: p.intentDigest,
  expectedConfigurationReference: null,
  expectedRevision: 0,
  outcome: "Committed",
  snapshot: snapshot(),
  auditReference: id(7),
  occurredAt: at,
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("closed browser facts match actual public Payment constructors, including disabled configuration", () => {
  expect(parseStorePaymentConfigurationContent(content)).toEqual(owningContent(content));
  expect(parseStorePaymentConfigurationSnapshot(snapshot())).toEqual(owningVersion(snapshot()));
  expect(parseStorePaymentConfigurationCurrent(current(), id(3))).toEqual(owningCurrent(current()));
  expect(
    parseStorePaymentConfigurationContent({
      customerOnlineCardEnabled: false,
      staffTerminalCardPresentEnabled: false,
      staffTerminalInteracEnabled: false,
    }),
  ).toMatchObject({ customerOnlineCardEnabled: false });
});
it("GET obtains actual current reader scope and no Provider-ready inference", async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response(current())),
    c = createStorePaymentConfigurationClient(f);
  expect(await c.load({ storeReference: id(3) })).toMatchObject({
    ...scope,
    snapshot: null,
    providerReadiness: "NotEvaluated",
  });
  expect(f.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/payment-configuration?storeReference=${id(3)}`,
  );
  await expect(
    createStorePaymentConfigurationClient(
      vi.fn<typeof fetch>().mockResolvedValue(response({ ...current(), actorReference: id(9) })),
    ).load({ storeReference: id(3), expectedScope: scope }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("Save sends only actual five-field intent with dedicated detached scope4 and no Provider fields", async () => {
  const f = vi.fn<typeof fetch>(),
    c = createStorePaymentConfigurationClient(f),
    raw = prepare(),
    p = await c.prepare(raw);
  raw.content = { ...content, customerOnlineCardEnabled: true };
  f.mockResolvedValue(response(receipt(p)));
  expect(await c.execute(p, { csrf })).toMatchObject({ outcome: "Committed" });
  const init = f.mock.calls[0]?.[1];
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/store-setup/payment-configuration");
  expect(JSON.parse(String(init?.body))).toEqual({
    command: "SaveConfiguration",
    operationReference: id(5),
    expectedConfigurationReference: null,
    expectedRevision: 0,
    content,
  });
  const headers = new Headers(init?.headers),
    encoded = headers.get("X-BOP-Store-Setup-Scope");
  if (!encoded) throw new Error("scope header missing");
  expect(atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/"))).toBe(canonical(scope));
  expect(headers.get("X-BOP-CSRF")).toBe(csrf);
  expect(Object.isFrozen(p.command.content)).toBe(true);
});
it("reply loss preserves exact prepared original bytes for explicit retry without new operation", async () => {
  const f = vi.fn<typeof fetch>(),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  f.mockRejectedValueOnce(new Error("synthetic loss")).mockResolvedValueOnce(response(receipt(p)));
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await c.execute(p, { csrf });
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  expect(f).toHaveBeenCalledTimes(2);
});
it("Resolve is payload-free and requires actual original receipt digest and parent pins", async () => {
  const f = vi.fn<typeof fetch>(),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  f.mockResolvedValue(response(receipt(p)));
  await c.resolve(p.cursor, { csrf });
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
    command: "ResolveOriginal",
    operationReference: id(5),
    expectedConfigurationReference: null,
    expectedRevision: 0,
    intentDigest: p.intentDigest,
  });
  await expect(
    validateStorePaymentConfigurationReceipt(
      {
        ...receipt(p),
        snapshot: { ...snapshot(), content: { ...content, customerOnlineCardEnabled: true } },
      },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateStorePaymentConfigurationReceipt({ ...receipt(p), expectedRevision: 1 }, p.cursor),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(
    await validateStorePaymentConfigurationReceipt(
      { ...receipt(p), outcome: "Abandoned", snapshot: null },
      p.cursor,
    ),
  ).toMatchObject({ outcome: "Abandoned", snapshot: null });
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
])("finite POST status %s remains explicit", async (status, code) => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response({}, Number(status))),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code });
  expect(f).toHaveBeenCalledTimes(1);
});
it("invalid original credentials, content getters and injected Provider data fail before dispatch", async () => {
  let called = false;
  const v = { ...content };
  Object.defineProperty(v, "staffTerminalInteracEnabled", {
    enumerable: true,
    get() {
      called = true;
      return true;
    },
  });
  expect(() => parseStorePaymentConfigurationContent(v)).toThrow();
  expect(called).toBe(false);
  expect(() =>
    parseStorePaymentConfigurationContent({ ...content, providerReady: true }),
  ).toThrow();
  const f = vi.fn<typeof fetch>(),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf: "bad" })).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
});
it("malformed, foreign, stale, fabricated ready and overlong source leases cannot qualify current", async () => {
  for (const view of [
    { ...current(), providerReadiness: "Ready" },
    { ...current(), validUntil: "2026-10-05T10:00:05.001Z" },
    { ...current(), snapshot: { ...snapshot(), currencyCode: "USD" } },
    { ...current(), snapshot: { ...snapshot(), storeReference: id(9) } },
  ])
    expect(() => parseStorePaymentConfigurationCurrent(view, id(3))).toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createStorePaymentConfigurationClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(current())),
    ).load({ storeReference: id(3) }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("malformed success or a sent Abort cannot silently report Committed", async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response({})),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const controller = new AbortController();
  const g = vi.fn<typeof fetch>(async () => {
    controller.abort();
    return response(receipt(p));
  });
  await expect(
    createStorePaymentConfigurationClient(g).execute(p, { csrf, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("late response from old Store is discarded after an actual scope request switch", async () => {
  let answer: ((value: Response) => void) | undefined;
  const f = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    )
    .mockResolvedValueOnce(response({ ...current(), storeReference: id(9) }));
  const c = createStorePaymentConfigurationClient(f),
    old = c.load({ storeReference: id(3) });
  await c.load({ storeReference: id(9) });
  if (!answer) throw new Error("request missing");
  answer(response(current()));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("stream response bound rejects oversized success without accepting a receipt", async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(65537), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    ),
    c = createStorePaymentConfigurationClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
