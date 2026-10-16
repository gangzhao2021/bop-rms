import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { describe, expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { TaxClassificationsPage, TaxClassificationsView } from "./TaxClassificationsPage.js";
import {
  TaxClassificationPageError,
  createTaxClassificationClient,
  nameFieldLabel,
  parseTaxClassificationView,
  taxClassificationMessages,
  type TaxClassificationView,
} from "./tax-classification-page.js";

const id = (n: number) => `0199e8a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const view = (mayManage = true, classifications = sample): TaxClassificationView =>
  parseTaxClassificationView({
    screenId: "CAT-TAX-CLASSIFICATION-LIST",
    sourceAsOf: "2026-10-15T12:00:00.000Z",
    permissions: { mayManage },
    registryVersion: 3,
    defaultLocale: "en-CA",
    locales: ["en-CA", "fr-CA"],
    classifications,
  });
const sample = [
  {
    classificationReference: id(1),
    names: { "en-CA": "Prepared food", "fr-CA": "Aliments préparés" },
    lifecycle: "Active",
    isDefault: true,
  },
  {
    classificationReference: id(2),
    names: { "en-CA": "Fees" },
    lifecycle: "Active",
    isDefault: false,
  },
  {
    classificationReference: id(3),
    names: { "en-CA": "Old bottles" },
    lifecycle: "Retired",
    isDefault: false,
  },
];
const render = (
  value: TaxClassificationView,
  error: Parameters<typeof TaxClassificationsView>[0]["error"] = null,
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StoreTimeZoneContext.Provider value="America/Toronto">
        <TaxClassificationsView
          view={value}
          busy={false}
          notice=""
          error={error}
          csrf="c"
          onChange={() => undefined}
          onReload={() => undefined}
        />
      </StoreTimeZoneContext.Provider>
    </MemoryRouter>,
  );
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WP-2423 tax classifications page", () => {
  it("parses only the closed server view", () => {
    expect(view().classifications).toHaveLength(3);
    for (const broken of [
      { ...view(), screenId: "TAX-STORE-REVIEW" },
      { ...view(), extra: 1 },
      { ...view(), locales: ["fr-CA", "en-CA"] },
      { ...view(), classifications: [{ ...sample[0], names: { "fr-CA": "Frais" } }] },
      { ...view(), classifications: [{ ...sample[0], lifecycle: "Paused" }] },
    ])
      expect(() => parseTaxClassificationView(broken)).toThrow(TaxClassificationPageError);
  });

  it("shows the Owner the list, default, retired names and add form in plain words", () => {
    const html = render(view());
    const text = staticText(html);
    expect(text).toContain("Prepared food");
    expect(text).toContain("Aliments préparés");
    expect(text).toContain("Default for products without their own");
    expect(text).toContain("No rates are set here");
    expect(html).toContain("Add classification");
    expect(html).toContain('aria-label="Retire Fees"');
    expect(html).toContain('aria-label="Make Fees the default"');
    expect(html).toContain('aria-label="Stop using Prepared food as the default"');
    expect(text).toContain("Old bottles");
    expect(html).not.toContain('aria-label="Retire Old bottles"');
    expect(findInternalText([text])).toEqual([]);
  });

  it("shows readers the list without change controls", () => {
    const html = render(view(false));
    expect(staticText(html)).toContain(
      "Only the Brand Owner can add or change tax classifications.",
    );
    expect(html).not.toContain("Add classification");
    expect(html).not.toContain('aria-label="Retire');
    expect(html).not.toContain("Rename");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });

  it("explains an empty list and every refusal without codes", () => {
    const empty = staticText(render(view(true, [])));
    expect(empty).toContain("No tax classifications yet");
    expect(empty).toContain("Store setup fees can then be turned on");
    for (const code of [
      "Conflict",
      "NameTaken",
      "Retired",
      "NotFound",
      "Invalid",
      "Unavailable",
      "Offline",
    ] as const) {
      const text = staticText(render(view(), code));
      expect(text).toContain(taxClassificationMessages[code]);
      expect(findInternalText([text]), code).toEqual([]);
    }
    expect(staticText(render(view(), "Conflict"))).toContain("Reload the list");
    expect(staticText(render(view(), "FullSignInRequired"))).toContain("authenticator app");
    expect(nameFieldLabel("en-CA", "en-CA")).toBe("English name");
    expect(nameFieldLabel("fr-CA", "en-CA")).toBe("French name (optional)");
  });

  it("renders the loading state before the list arrives", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaxClassificationsPage
          client={{ load: () => new Promise(() => undefined), command: vi.fn() }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading tax classifications");
  });

  it("posts to the closed routes and maps answers to page errors", async () => {
    const fetcher = vi.fn(async (...call: [string, RequestInit]) => (void call, json(200, view())));
    const client = createTaxClassificationClient("token", fetcher as unknown as typeof fetch);
    expect((await client.load()).registryVersion).toBe(3);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/commerce/tax-classifications/query");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "x-bop-csrf": "token" },
      body: "{}",
    });
    fetcher.mockResolvedValueOnce(json(200, { status: "Replayed", view: view() }));
    const body = {
      action: "Retire" as const,
      operationReference: id(9),
      expectedRegistryVersion: 3,
      classificationReference: id(2),
    };
    expect((await client.command(body)).status).toBe("Replayed");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toEqual(body);
    const failure = async (response: Response) => {
      fetcher.mockResolvedValueOnce(response);
      return client
        .command(body)
        .catch((error: unknown) => (error as TaxClassificationPageError).code);
    };
    expect(await failure(json(409, { error: "Conflict" }))).toBe("Conflict");
    expect(await failure(json(409, { error: "NameTaken" }))).toBe("NameTaken");
    expect(await failure(json(403, { error: "full_sign_in_required" }))).toBe("FullSignInRequired");
    expect(await failure(json(403, { error: "request_denied" }))).toBe("PermissionDenied");
    expect(await failure(json(500, { error: "boom" }))).toBe("Unavailable");
    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    expect(
      await client.load().catch((error: unknown) => (error as TaxClassificationPageError).code),
    ).toBe("Offline");
  });
});
