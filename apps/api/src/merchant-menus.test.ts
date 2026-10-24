import { describe, expect, it } from "vitest";
import type { ReviewedMenuContent } from "@rms/catalog";
import { MerchantMenuError, menuCustomerView, parseMenuCommandBody } from "./merchant-menus.js";

const id = (n: number) => "01909a1e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "b".repeat(64);
const save = (change: Record<string, unknown> = {}) => ({
  action: "SaveDraft",
  operationReference: id(1),
  menuReference: id(2),
  expectedAggregateVersion: 3,
  name: "  All   Day ",
  sections: [
    {
      sectionReference: null,
      code: "coffee",
      name: "Coffee",
      items: [{ skuReference: id(4), featured: true }],
    },
  ],
  ...change,
});
const invalid = (value: unknown) => {
  try {
    parseMenuCommandBody(value);
  } catch (error) {
    return error instanceof MerchantMenuError && error.code === "Invalid";
  }
  return false;
};
describe("WP-2423 menu command body", () => {
  it("normalizes a draft and accepts each lifecycle action", () => {
    expect(parseMenuCommandBody(save())).toMatchObject({
      name: "All Day",
      sections: [{ code: "COFFEE", sectionReference: null }],
    });
    for (const body of [
      {
        action: "Revise",
        operationReference: id(1),
        menuReference: id(2),
        expectedAggregateVersion: 4,
      },
      {
        action: "DiscardDraft",
        operationReference: id(1),
        menuReference: id(2),
        expectedAggregateVersion: 5,
      },
      { action: "Submit", operationReference: id(1), menuReference: id(2) },
      {
        action: "Approve",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 2,
        snapshotDigest: digest,
      },
      {
        action: "Publish",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 3,
        snapshotDigest: digest,
      },
      {
        action: "Rebuild",
        operationReference: id(1),
        menuReference: id(2),
        publishOperationReference: id(5),
      },
    ])
      expect(parseMenuCommandBody(body).action).toBe(body.action);
  });
  it.each([
    ["no sections", save({ sections: [] })],
    ["an extra field", { ...save(), storeReference: id(9) }],
    ["a non-v7 reference", save({ menuReference: "00000000-0000-4000-8000-000000000000" })],
    ["a zero version", save({ expectedAggregateVersion: 0 })],
    ["an empty name", save({ name: "   " })],
    [
      "a SKU twice in a section",
      save({
        sections: [
          {
            sectionReference: null,
            code: "COFFEE",
            name: "Coffee",
            items: [
              { skuReference: id(4), featured: false },
              { skuReference: id(4), featured: true },
            ],
          },
        ],
      }),
    ],
    [
      "duplicate section names",
      save({
        sections: ["A", "B"].map((c) => ({
          sectionReference: null,
          code: c,
          name: "Tea",
          items: [],
        })),
      }),
    ],
    [
      "a malformed digest",
      {
        action: "Publish",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 3,
        snapshotDigest: "sha256:xyz",
      },
    ],
    [
      "a discard without its expected version",
      { action: "DiscardDraft", operationReference: id(1), menuReference: id(2) },
    ],
    ["an unknown action", { action: "Archive", operationReference: id(1), menuReference: id(2) }],
  ])("rejects %s", (_, body) => expect(invalid(body)).toBe(true));
});

describe("WP-2423 what customers will see, from the frozen review snapshot", () => {
  const path = (c: string, ext: string) => "/media/images/" + c.repeat(64) + "." + ext;
  const photo = (image: number, c: string, alt: string) => ({
    imageReference: id(image),
    localizedAltText: { "en-CA": alt },
    width: 1280,
    height: 960,
    renditions: [320, 640, 1280].flatMap((width) => [
      { contentType: "image/jpeg", width, height: (width * 3) / 4, path: path(c, "jpg") },
      { contentType: "image/webp", width, height: (width * 3) / 4, path: path(c, "webp") },
    ]),
  });
  const item = (
    sku: number,
    name: string,
    sortOrder: number,
    presentation?: { description?: string; photo?: ReturnType<typeof photo> | null },
    role = "Standard",
  ) => ({
    placementReference: id(100 + sku),
    sellableReference: id(sku),
    productVersionReference: id(200 + sku),
    localizedNames: { "en-CA": name },
    presentationRole: role,
    sortOrder,
    pinned: false,
    configuredAvailability: "Available",
    optionRules: [],
    allergenDisclosure: {},
    ...(presentation === undefined
      ? {}
      : {
          presentation: {
            localizedDescriptions:
              presentation.description === undefined ? {} : { "en-CA": presentation.description },
            photo: presentation.photo ?? null,
          },
        }),
  });
  const content = (items: ReturnType<typeof item>[]) =>
    ({
      brandReference: id(1),
      menuReference: id(2),
      menuVersionReference: id(3),
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "All day" },
      storeReferences: [],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["PICKUP"],
      sections: [
        {
          sectionReference: id(9),
          internalCode: "DRINKS",
          localizedNames: { "en-CA": "Drinks" },
          sortOrder: 0,
          sellables: items,
        },
      ],
    }) as unknown as ReviewedMenuContent;
  const frozenAt = "2026-10-17T14:00:00.000Z";
  it("shows each item's reviewed description and photo thumbnail with its alt text", () => {
    const view = menuCustomerView({
      locale: "en-CA",
      current: {
        content: content([
          item(10, "Latte — Small", 1, {
            description: "Espresso and steamed milk.",
            photo: photo(80, "a", "Latte in a glass"),
          }),
          item(11, "Tea", 0),
          item(12, "Secret", 2, { description: "Staff only" }, "Hidden"),
        ]),
        createdAt: frozenAt,
      },
      published: null,
    });
    expect(view).toEqual({
      frozenAt,
      comparedWithPublishedAt: null,
      removedFromMenu: [],
      items: [
        expect.objectContaining({ name: "Tea", description: null, photo: null, newOnMenu: null }),
        expect.objectContaining({
          sectionName: "Drinks",
          name: "Latte — Small",
          description: "Espresso and steamed milk.",
          photo: { url: path("a", "jpg"), width: 320, height: 240, altText: "Latte in a glass" },
          newOnMenu: null,
          descriptionChange: null,
          photoChange: null,
          before: null,
        }),
      ],
    });
  });
  it("marks new, changed and removed descriptions and photos against the published menu", () => {
    const view = menuCustomerView({
      locale: "en-CA",
      current: {
        content: content([
          item(10, "Latte", 0, { photo: photo(81, "b", "Latte in a cup") }),
          item(11, "Tea", 1, { description: "Loose leaf." }),
          item(13, "Mocha", 2, { description: "New.", photo: photo(83, "c", "Mocha") }),
          item(14, "Cocoa", 3, { photo: photo(84, "d", "Cocoa with cream") }),
          item(15, "Juice", 4, { description: "Same." }),
        ]),
        createdAt: frozenAt,
      },
      published: {
        publishedAt: "2026-10-16T18:05:00.000Z",
        content: content([
          item(10, "Latte", 0, {
            description: "Espresso and steamed milk.",
            photo: photo(80, "a", "Latte in a glass"),
          }),
          item(11, "Tea", 1, { description: "Bagged.", photo: photo(82, "e", "Tea") }),
          item(14, "Cocoa", 2, { photo: photo(84, "d", "Cocoa") }),
          item(15, "Juice", 3, { description: "Same." }),
          item(16, "Scone", 4),
        ]),
      },
    });
    const by = (name: string) => view.items.find((entry) => entry.name === name);
    expect(view.comparedWithPublishedAt).toBe("2026-10-16T18:05:00.000Z");
    expect(by("Latte")).toMatchObject({
      newOnMenu: false,
      descriptionChange: "Removed",
      photoChange: "Replaced",
      before: {
        description: "Espresso and steamed milk.",
        photo: { url: path("a", "jpg"), altText: "Latte in a glass" },
      },
    });
    expect(by("Tea")).toMatchObject({
      descriptionChange: "Changed",
      photoChange: "Removed",
      before: { description: "Bagged.", photo: { altText: "Tea" } },
    });
    expect(by("Mocha")).toMatchObject({
      newOnMenu: true,
      descriptionChange: null,
      photoChange: null,
      before: null,
    });
    expect(by("Cocoa")).toMatchObject({
      descriptionChange: null,
      photoChange: "DescriptionChanged",
      before: { description: null, photo: { altText: "Cocoa" } },
    });
    expect(by("Juice")).toMatchObject({ descriptionChange: null, photoChange: null, before: null });
    expect(view.removedFromMenu).toEqual([{ skuReference: id(16), name: "Scone" }]);
  });
});
