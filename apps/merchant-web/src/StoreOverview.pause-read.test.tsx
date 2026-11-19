// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { PauseOrderingShownContext } from "./PauseOrderingControl.js";
import { StoreOverview } from "./StoreOverview.js";
import { mount, settle, unmountMounted } from "./dom-test-kit.fixture.js";

const store = "01a4d733-0000-7000-8000-000000000003";
afterEach(async () => {
  await unmountMounted();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function homeReads(shown: boolean | undefined) {
  const urls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 403 });
  });
  vi.stubGlobal("fetch", fetcher);
  await mount(
    <MemoryRouter>
      <PauseOrderingShownContext.Provider value={shown}>
        <StoreOverview
          csrf={"a".repeat(43)}
          storeReference={store}
          storeLabel="TEST Store"
          timeZone="America/Toronto"
          screens={["HOME-OVERVIEW", "STORE-SETUP", "OPS-ORDER-QUEUE"]}
          fetcher={fetcher as unknown as typeof fetch}
        />
      </PauseOrderingShownContext.Provider>
    </MemoryRouter>,
  );
  await settle(10);
  return urls.filter((url) => url.includes("/merchant/service-control"));
}

it("WP-2423 batch 33: Home sends no service-control read for staff the workspace says are not shown Pause ordering", async () => {
  expect(await homeReads(false)).toEqual([]);
});

it("WP-2423 batch 33: Home still reads it for an owner who is shown Pause ordering (the store-phone step needs the services)", async () => {
  expect((await homeReads(true)).length).toBeGreaterThan(0);
});
