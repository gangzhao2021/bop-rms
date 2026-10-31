import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoresPage } from "./StoresPage.js";
import { openStore, StoreOpeningClientError } from "./store-opening-client.js";

const stores = [
  { storeReference: "01909a2e-1000-7000-8000-000000000001", storeLabel: "DEMO Store" },
  { storeReference: "01909a2e-1000-7000-8000-000000000002", storeLabel: "DEMO Store 2" },
];
const render = (mayOpen: boolean) =>
  renderToStaticMarkup(
    <StoresPage
      stores={stores}
      currentStoreReference={stores[0]?.storeReference ?? ""}
      csrf="csrf"
      switching={false}
      mayOpen={mayOpen}
      onSwitchStore={() => undefined}
    />,
  );
const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
const input = {
  operationReference: "01909a2e-1000-7000-8000-000000000010",
  code: "DEMO_02",
  displayName: "DEMO Store 2 – not production",
  timeZone: "America/Vancouver",
  locale: "en-CA",
};

describe("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Stores page", () => {
  it("lists the person's Stores, marks the current one and offers switching to the others", () => {
    const html = render(false);
    expect(html).toContain("DEMO Store 2");
    expect(html).toContain("You are here");
    expect(html.match(/Switch to this store/gu)?.length).toBe(1);
    // Only the Store's Owner sees how to open a Store.
    expect(html).not.toContain("Open a store");
  });
  it("shows the Owner the opening form with time zones staff recognise, never codes", () => {
    const html = render(true);
    expect(html).toContain("Open a store");
    expect(html).toContain("Pacific time (Vancouver)");
    expect(html).not.toContain(">America/Vancouver<");
  });
  it("sends the opening once and reads each answer", async () => {
    const opened = answer(201, { status: "Opened", storeReference: input.operationReference });
    await expect(openStore("csrf", input, opened)).resolves.toEqual({
      status: "Opened",
      storeReference: input.operationReference,
    });
    const [url, init] = opened.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/merchant/organization/stores");
    expect(init.headers).toMatchObject({ "x-bop-csrf": "csrf" });
    expect(JSON.parse(String(init.body))).toEqual(input);
    for (const [status, body, code] of [
      [403, { error: "request_denied" }, "PermissionDenied"],
      [409, { error: "store_code_taken" }, "CodeTaken"],
      [409, { error: "store_opening_conflict" }, "Conflict"],
      [400, { error: "store_opening_invalid" }, "Invalid"],
      [503, { error: "store_opening_unavailable" }, "OutcomeUnknown"],
    ] as const)
      await expect(openStore("csrf", input, answer(status, body))).rejects.toMatchObject({
        code,
      });
    await expect(
      openStore(
        "csrf",
        input,
        vi.fn(async () => Promise.reject(new Error("offline"))),
      ),
    ).rejects.toBeInstanceOf(StoreOpeningClientError);
  });
});
