import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenStoreSection, StoresPage } from "./StoresPage.js";
import { mayOpenStore, openStore, StoreOpeningClientError } from "./store-opening-client.js";

const stores = [
  { storeReference: "01909a2e-1000-7000-8000-000000000001", storeLabel: "DEMO Store" },
  { storeReference: "01909a2e-1000-7000-8000-000000000002", storeLabel: "DEMO Store 2" },
];
const render = () =>
  renderToStaticMarkup(
    <StoresPage
      stores={stores}
      currentStoreReference={stores[0]?.storeReference ?? ""}
      csrf="csrf"
      switching={false}
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
    const html = render();
    expect(html).toContain("DEMO Store 2");
    expect(html).toContain("You are here");
    expect(html.match(/Switch to this store/gu)?.length).toBe(1);
    // No form until the server says this person may open a Store.
    expect(html).not.toContain("Open a store");
  });
  it("says so when a switch is refused, never a silent no-op (v15 2026-10-31)", () => {
    const refused = renderToStaticMarkup(
      <StoresPage
        stores={stores}
        currentStoreReference={stores[0]?.storeReference ?? ""}
        csrf="csrf"
        switching={false}
        switchFailed
        onSwitchStore={() => undefined}
      />,
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("ask the brand owner to check your access there");
    expect(render()).not.toContain('role="alert"');
  });
  it("shows the Owner the opening form with time zones staff recognise, never codes", () => {
    const html = renderToStaticMarkup(<OpenStoreSection csrf="csrf" />);
    expect(html).toContain("Open a store");
    expect(html).toContain("Pacific time (Vancouver)");
    expect(html).not.toContain(">America/Vancouver<");
  });
  it("asks the server who may open a Store; anything but a yes is no", async () => {
    const yes = answer(200, { mayOpen: true });
    await expect(mayOpenStore("csrf", yes)).resolves.toBe(true);
    const [url, init] = yes.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/merchant/organization/stores/may-open");
    expect(init.headers).toMatchObject({ "x-bop-csrf": "csrf" });
    await expect(mayOpenStore("csrf", answer(200, { mayOpen: false }))).resolves.toBe(false);
    await expect(mayOpenStore("csrf", answer(403, { error: "request_denied" }))).resolves.toBe(
      false,
    );
    await expect(mayOpenStore("csrf", answer(200, { mayOpen: "yes" }))).resolves.toBe(false);
    await expect(
      mayOpenStore(
        "csrf",
        vi.fn(async () => Promise.reject(new Error("offline"))),
      ),
    ).resolves.toBe(false);
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
