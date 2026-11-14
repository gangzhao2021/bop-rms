import { describe, expect, it, vi } from "vitest";
import {
  createStoreCapabilityClient,
  parseStoreCapabilityObservation,
} from "./store-capability-client.js";
const id = (n: number) => `019a0024-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  scope = { brandReference: id(1), storeReference: id(2) },
  key = "catalog.cat_product_edit";
const fixture = () => ({
  ...scope,
  capabilityKey: key,
  controlKey: "catalog.product.edit",
  backendExecution: "Deny",
  frontendVisibility: "Hide",
  reason: "Disabled",
  source: "StoreOverride",
  controlReference: id(3),
  controlVersion: 2,
  observedAt: at,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
const input = { scope, capabilityKey: key, csrf: "c".repeat(43) };
describe("WP-2421 current Store capability transport", () => {
  it("checks scope and a single coherent backend/frontend decision", () => {
    expect(parseStoreCapabilityObservation(fixture(), scope, key, Date.parse(at)).reason).toBe(
      "Disabled",
    );
    expect(() =>
      parseStoreCapabilityObservation(
        { ...fixture(), frontendVisibility: "Show" },
        scope,
        key,
        Date.parse(at),
      ),
    ).toThrow();
    expect(() =>
      parseStoreCapabilityObservation(
        { ...fixture(), backendExecution: "Allow" },
        scope,
        key,
        Date.parse(at),
      ),
    ).toThrow();
  });
  it("can anchor the initial observation to the selected Store, then pin the actual Brand", () => {
    const first = parseStoreCapabilityObservation(
      fixture(),
      { storeReference: scope.storeReference },
      key,
      Date.parse(at),
    );
    expect(first.brandReference).toBe(scope.brandReference);
    expect(() =>
      parseStoreCapabilityObservation(
        { ...fixture(), brandReference: id(4) },
        { storeReference: first.storeReference, brandReference: first.brandReference },
        key,
        Date.parse(at),
      ),
    ).toThrow("Store capability could not be loaded");
  });
  it.each(["2026-09-29T11:59:54.000Z", "2026-09-29T12:00:01.000Z"])(
    "refuses an expired or future observation %s",
    (observedAt) => {
      expect(() =>
        parseStoreCapabilityObservation({ ...fixture(), observedAt }, scope, key, Date.parse(at)),
      ).toThrow();
    },
  );
  it.each([
    { storeReference: id(4) },
    { controlKey: "catalog.product.other" },
    { actorReference: id(5) },
    { controlVersion: null },
  ])("refuses changed scope, mapping or injected/malformed fields", (extra) => {
    expect(() =>
      parseStoreCapabilityObservation({ ...fixture(), ...extra }, scope, key, Date.parse(at)),
    ).toThrow();
  });
  it("uses private same-origin bounded POST without identity in the URL/body", async () => {
    const fetcher = vi.fn(async () => response(fixture()));
    const result = await createStoreCapabilityClient(fetcher, () => Date.parse(at)).load(
      input,
      new AbortController().signal,
    );
    expect(result.backendExecution).toBe("Deny");
    expect(fetcher).toHaveBeenCalledWith(
      "/merchant/store-capability",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        body: JSON.stringify({ capabilityKey: key }),
        headers: expect.objectContaining({ "x-bop-csrf": input.csrf }),
      }),
    );
  });
  it("does not trust cached, oversized or denied responses", async () => {
    const cached = response(fixture());
    cached.headers.set("cache-control", "private");
    const large = response({ padding: "x".repeat(9000) });
    for (const r of [cached, large, response({ error: "request_denied" }, 403)]) {
      await expect(
        createStoreCapabilityClient(
          async () => r,
          () => Date.parse(at),
        ).load(input, new AbortController().signal),
      ).rejects.toThrow();
    }
  });
  it("cancels even when an injected transport ignores the signal", async () => {
    const controller = new AbortController();
    const read = createStoreCapabilityClient(() => new Promise<Response>(() => undefined)).load(
      input,
      controller.signal,
    );
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not execute accessors on an untrusted decision", () => {
    const getter = vi.fn(() => "Allow");
    const value = Object.defineProperty(fixture(), "backendExecution", {
      enumerable: true,
      get: getter,
    });
    expect(() => parseStoreCapabilityObservation(value, scope, key, Date.parse(at))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

it.each(["list", "create", "detail", "edit"])(
  "anchors actual Option %s capability without a Product mapping",
  async (action) => {
    const capabilityKey = "catalog.cat_optionset_" + action,
      value = { ...fixture(), capabilityKey, controlKey: "catalog.optionset." + action };
    const fetcher = vi.fn<typeof fetch>(async () => response(value));
    const result = await createStoreCapabilityClient(fetcher, () => Date.parse(at)).load(
      { scope: { storeReference: scope.storeReference }, capabilityKey, csrf: input.csrf },
      new AbortController().signal,
    );
    expect(result.brandReference).toBe(scope.brandReference);
    expect(result.reason).toBe("Disabled");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ capabilityKey });
    expect(() =>
      parseStoreCapabilityObservation(
        { ...value, controlKey: "catalog.product.edit" },
        scope,
        capabilityKey,
        Date.parse(at),
      ),
    ).toThrow();
  },
);

it.each([
  ["pricing.price_book_list", "pricing.pricebook.list"],
  ["pricing.price_book_editor", "pricing.pricebook.editor"],
])(
  "reads actual Pricing capability %s without a Catalog control",
  async (capabilityKey, controlKey) => {
    const value = { ...fixture(), capabilityKey, controlKey };
    const fetcher = vi.fn<typeof fetch>(async () => response(value));
    const result = await createStoreCapabilityClient(fetcher, () => Date.parse(at)).load(
      { scope: { storeReference: scope.storeReference }, capabilityKey, csrf: input.csrf },
      new AbortController().signal,
    );
    expect(result.brandReference).toBe(scope.brandReference);
    expect(result.backendExecution).toBe("Deny");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ capabilityKey });
    for (const wrong of ["catalog.product.edit", controlKey.replace("pricebook", "price_book")])
      expect(() =>
        parseStoreCapabilityObservation(
          { ...value, controlKey: wrong },
          scope,
          capabilityKey,
          Date.parse(at),
        ),
      ).toThrow();
    expect(() =>
      parseStoreCapabilityObservation(
        { ...value, storeReference: id(9) },
        scope,
        capabilityKey,
        Date.parse(at),
      ),
    ).toThrow();
  },
);
