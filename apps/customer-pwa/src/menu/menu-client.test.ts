import { describe, expect, it, vi } from "vitest";
import { createCustomerMenuClient, normalizeMenuSearch } from "./menu-client.js";
import type { MenuJourneyContext } from "./types.js";

const references = Object.freeze({
  store: "018f7500-0000-7000-8000-000000000001",
  menu: "018f7500-0000-7000-8000-000000000002",
  version: "018f7500-0000-7000-8000-000000000003",
  release: "018f7500-0000-7000-8000-000000000004",
  checkpoint: "018f7500-0000-7000-8000-000000000005",
  section: "018f7500-0000-7000-8000-000000000006",
  sellable: "018f7500-0000-7000-8000-000000000007",
  product: "018f7500-0000-7000-8000-000000000008",
  registry: "018f7500-0000-7000-8000-000000000009",
  allergen: "018f7500-0000-7000-8000-00000000000a",
  binding: "018f7500-0000-7000-8000-00000000000b",
  optionSet: "018f7500-0000-7000-8000-00000000000c",
  option: "018f7500-0000-7000-8000-00000000000d",
});
const at = "2026-08-11T20:00:00.000Z";
const context: MenuJourneyContext = Object.freeze({
  publicStoreReference: references.store,
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
});

function found() {
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: references.checkpoint,
      sourceAggregateVersion: 4,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5_000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: references.store,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: references.menu,
      menuVersionReference: references.version,
      releaseReference: references.release,
      locale: "en-CA",
      name: "All Day",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: references.section,
          name: "Drinks",
          sellables: [
            {
              sellableReference: references.sellable,
              productVersionReference: references.product,
              name: "Latte",
              description: null as string | null,
              photo: null as unknown,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  name: "Milk",
                  bindingReference: references.binding,
                  optionSetVersionReference: references.optionSet,
                  minimumSelections: 0,
                  maximumSelections: 1,
                  enabledOptionReferences: [references.option],
                  defaultOptionReferences: [],
                  options: [
                    {
                      optionReference: references.option,
                      name: "Oat beverage",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                      incrementalPrice: {
                        status: "Unavailable",
                        amount: null,
                        currency: null,
                        reason: "PRICING_NOT_INTEGRATED",
                      },
                    },
                  ],
                },
              ],
              allergenDisclosure: {
                registryVersionReference: references.registry,
                items: [
                  {
                    allergenReference: references.allergen,
                    code: "MILK",
                    name: "Milk",
                    classification: "Contains",
                  },
                ],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: {
                status: "Unavailable",
                amount: null,
                currency: null,
                reason: "PRICING_NOT_INTEGRATED",
              },
              taxDisplayContext: {
                status: "Unavailable",
                taxInclusive: null,
                reason: "FINAL_QUOTE_REQUIRED",
              },
            },
          ],
        },
      ],
    },
  };
}

function response(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

describe("Customer Menu client", () => {
  it("loads the exact QR-established scope with no-store controls", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `/api/v1/public/stores/${references.store}/menu?channel=CUSTOMER_PWA&orderType=DINE_IN&locale=en-CA&q=iced+latte`,
      );
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      return response(200, found());
    });
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    await expect(client.load({ searchTerm: "  iced   latte " })).resolves.toEqual({
      kind: "Found",
      menu: {
        name: "All Day",
        locale: "en-CA",
        effectiveFrom: at,
        effectiveUntil: null,
        sections: [
          {
            sectionReference: references.section,
            name: "Drinks",
            sellables: [
              {
                sellableReference: references.sellable,
                productVersionReference: references.product,
                name: "Latte",
                description: null,
                photo: null,
                presentationRole: "Standard",
                pinned: false,
                availability: "Available",
                price: null,
                allergens: [{ name: "Milk", classification: "Contains" }],
                optionRules: [
                  {
                    name: "Milk",
                    minimumSelections: 0,
                    maximumSelections: 1,
                    options: [
                      {
                        optionReference: references.option,
                        name: "Oat beverage",
                        maximumQuantity: 1,
                        conflictOptionReferences: [],
                        selectedByDefault: false,
                        price: null,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("passes a selected section through the authorized menu query", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        `/api/v1/public/stores/${references.store}/menu?channel=CUSTOMER_PWA&orderType=DINE_IN&locale=en-CA&section=${references.section}`,
      );
      return response(200, found());
    });
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    await expect(client.load({ sectionReference: references.section })).resolves.toMatchObject({
      kind: "Found",
      menu: { sections: [{ sectionReference: references.section }] },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not request or expose a cached menu while offline", async () => {
    const fetch = vi.fn();
    const client = createCustomerMenuClient(context, { fetch, online: () => false });
    await expect(client.load()).resolves.toEqual({ kind: "Offline" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous identical reads without retaining a response cache", async () => {
    const fetch = vi.fn(async () => response(200, found()));
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    const [first, second] = await Promise.all([client.load(), client.load()]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.load();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, "menu_not_found", "customer.menu.not_found", "NotFound"],
    [503, "menu_projection_stale", "customer.menu.projection_stale", "Stale"],
    [503, "menu_service_unavailable", "customer.menu.service_unavailable", "Unavailable"],
  ] as const)("maps the bounded %s response", async (status, code, messageKey, kind) => {
    const client = createCustomerMenuClient(context, {
      fetch: async () => response(status, { schemaVersion: 1, error: { code, messageKey } }),
      online: () => true,
    });
    await expect(client.load()).resolves.toEqual({ kind });
  });

  it("maps an explicit HTTP 403 to permission denied without parsing its body", async () => {
    const json = vi.fn(async () => {
      throw new Error("proxy response must not be exposed");
    });
    const client = createCustomerMenuClient(context, {
      fetch: async () => ({ status: 403, json }) as unknown as Response,
      online: () => true,
    });
    await expect(client.load()).resolves.toEqual({ kind: "PermissionDenied" });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    { ...found(), unexpected: "private" },
    { ...found(), projection: { ...found().projection, partial: false } },
    { ...found(), scope: { ...found().scope, publicStoreReference: references.menu } },
    {
      ...found(),
      menu: {
        ...found().menu,
        sections: [
          {
            ...found().menu.sections[0],
            sellables: [
              {
                ...found().menu.sections[0]?.sellables[0],
                allergenDisclosure: {
                  ...found().menu.sections[0]?.sellables[0]?.allergenDisclosure,
                  allergenFreeClaim: true,
                },
              },
            ],
          },
        ],
      },
    },
  ])("fails a malformed or authority-expanding DTO closed", async (body) => {
    const client = createCustomerMenuClient(context, {
      fetch: async () => response(200, body),
      online: () => true,
    });
    await expect(client.load()).resolves.toEqual({ kind: "Unavailable" });
  });

  it("bounds search text before network use", async () => {
    expect(normalizeMenuSearch("  café   latte ")).toBe("café latte");
    expect(normalizeMenuSearch("<script>")).toBeNull();
    expect(normalizeMenuSearch("x".repeat(101))).toBeNull();
    const fetch = vi.fn();
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    await expect(client.load({ searchTerm: "<script>" })).resolves.toEqual({
      kind: "Unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const jpegPath = (seed: string) => `/media/images/${seed.repeat(64)}.jpg`;
const webpPath = (seed: string) => `/media/images/${seed.repeat(64)}.webp`;

function photoWire() {
  return {
    altText: "Latte in a white cup on a wooden table",
    width: 1280,
    height: 960,
    renditions: [
      { url: jpegPath("a"), contentType: "image/jpeg", width: 320, height: 240 },
      { url: webpPath("b"), contentType: "image/webp", width: 320, height: 240 },
      { url: jpegPath("c"), contentType: "image/jpeg", width: 640, height: 480 },
      { url: webpPath("d"), contentType: "image/webp", width: 640, height: 480 },
      { url: jpegPath("e"), contentType: "image/jpeg", width: 1280, height: 960 },
      { url: webpPath("f"), contentType: "image/webp", width: 1280, height: 960 },
    ],
  };
}

function withPresentation(description: unknown, photo: unknown) {
  const value = found();
  const item = value.menu.sections[0]?.sellables[0];
  if (!item) throw new Error("fixture");
  Object.assign(item, { description, photo });
  return value;
}

async function loadBody(body: unknown) {
  const client = createCustomerMenuClient(context, {
    fetch: async () => response(200, body),
    online: () => true,
  });
  return client.load();
}

describe("Customer Menu description and photo", () => {
  it("accepts a published description and photo exactly as sent", async () => {
    const description =
      "Double espresso with steamed milk — smooth, 12 oz. Ask for oat (no charge)!";
    const result = await loadBody(withPresentation(description, photoWire()));
    if (result.kind !== "Found") throw new Error(`expected Found, got ${result.kind}`);
    const item = result.menu.sections[0]?.sellables[0];
    expect(item?.description).toBe(description);
    expect(item?.photo).toEqual(photoWire());
    expect(Object.isFrozen(item?.photo)).toBe(true);
  });

  it("accepts a 240-character description and a 160-character alt text", async () => {
    const photo = { ...photoWire(), altText: "a".repeat(160) };
    const result = await loadBody(withPresentation("d".repeat(240), photo));
    expect(result.kind).toBe("Found");
  });

  it("accepts a menu item without description or photo", async () => {
    const result = await loadBody(withPresentation(null, null));
    if (result.kind !== "Found") throw new Error("expected Found");
    expect(result.menu.sections[0]?.sellables[0]).toMatchObject({ description: null, photo: null });
  });

  it("requires both keys on every sellable", async () => {
    const value = found();
    const item = value.menu.sections[0]?.sellables[0] as Record<string, unknown> | undefined;
    if (!item) throw new Error("fixture");
    delete item.photo;
    expect((await loadBody(value)).kind).toBe("Unavailable");
    const second = found();
    const other = second.menu.sections[0]?.sellables[0] as Record<string, unknown> | undefined;
    if (!other) throw new Error("fixture");
    delete other.description;
    expect((await loadBody(second)).kind).toBe("Unavailable");
  });

  it.each([
    ["empty", ""],
    ["too long", "d".repeat(241)],
    ["leading space", " Latte"],
    ["markup", "<b>Latte</b>"],
    ["template braces", "Latte {price}"],
    ["control character", "Latte\u0007"],
    ["line break", "Latte\nwith milk"],
    ["format character", "Latte\u200b"],
    ["not a string", 42],
  ])("rejects a %s description", async (_label, description) => {
    expect((await loadBody(withPresentation(description, null))).kind).toBe("Unavailable");
  });

  const renditions = photoWire().renditions;
  it.each([
    ["extra key", { ...photoWire(), imageReference: "018f7500-0000-7000-8000-000000000010" }],
    ["missing alt text", { ...photoWire(), altText: "" }],
    ["long alt text", { ...photoWire(), altText: "a".repeat(161) }],
    ["markup in alt text", { ...photoWire(), altText: "<img onerror=x>" }],
    ["zero width", { ...photoWire(), width: 0 }],
    ["fractional height", { ...photoWire(), height: 1.5 }],
    ["no renditions", { ...photoWire(), renditions: [] }],
    ["seven renditions", { ...photoWire(), renditions: [...renditions, renditions[0]] }],
    [
      "external url",
      { ...photoWire(), renditions: [{ ...renditions[0], url: "https://example.com/a.jpg" }] },
    ],
    [
      "protocol-relative url",
      { ...photoWire(), renditions: [{ ...renditions[0], url: `//evil${jpegPath("a")}` }] },
    ],
    [
      "traversal url",
      { ...photoWire(), renditions: [{ ...renditions[0], url: "/media/images/../secret.jpg" }] },
    ],
    [
      "uppercase hash",
      {
        ...photoWire(),
        renditions: [{ ...renditions[0], url: `/media/images/${"A".repeat(64)}.jpg` }],
      },
    ],
    [
      "query string",
      { ...photoWire(), renditions: [{ ...renditions[0], url: `${jpegPath("a")}?x=1` }] },
    ],
    ["png type", { ...photoWire(), renditions: [{ ...renditions[0], contentType: "image/png" }] }],
    [
      "mismatched extension",
      { ...photoWire(), renditions: [{ ...renditions[0], contentType: "image/webp" }] },
    ],
    ["rendition extra key", { ...photoWire(), renditions: [{ ...renditions[0], byteSize: 10 }] }],
    ["rendition zero width", { ...photoWire(), renditions: [{ ...renditions[0], width: 0 }] }],
    ["array", [photoWire()]],
    ["string", "/media/images/a.jpg"],
  ])("rejects a photo with %s", async (_label, photo) => {
    expect((await loadBody(withPresentation(null, photo))).kind).toBe("Unavailable");
  });
});

it("retains explicit quantities and rejects a dangling activation reference", async () => {
  const value = found();
  const rule = value.menu.sections[0]?.sellables[0]?.optionRules[0];
  const option = rule?.options[0];
  if (!rule || !option) throw new Error("fixture");
  Object.assign(rule, {
    semanticsVersion: 2,
    activationOptionReferences: [],
    minimumSelections: 2,
    maximumSelections: 3,
    defaultOptionReferences: [option.optionReference],
  });
  Object.assign(option, { maximumQuantity: 3, selectedByDefault: true, defaultQuantity: 2 });
  const client = createCustomerMenuClient(context, {
    fetch: async () => response(200, value),
    online: () => true,
  });
  const result = await client.load();
  expect(result.kind).toBe("Found");
  if (result.kind !== "Found") throw new Error("fixture");
  expect(result.menu.sections[0]?.sellables[0]?.optionRules[0]?.options[0]?.defaultQuantity).toBe(
    2,
  );
  Object.assign(rule, { activationOptionReferences: [references.allergen] });
  expect((await client.load()).kind).not.toBe("Found");
});
