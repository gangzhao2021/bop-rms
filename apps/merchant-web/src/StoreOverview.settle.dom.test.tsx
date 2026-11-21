// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { OVERVIEW_SETTLE_MS, StoreOverview } from "./StoreOverview.js";
import { deferred, mount, settle, unmountMounted, until } from "./dom-test-kit.fixture.js";

/**
 * Batch 35 (v15 b34 live): Home's "Needs attention" gained one row per read as each answered,
 * over two seconds, pushing "Right now" down each time. Home now shows its list once every read
 * that adds a row has answered (or after OVERVIEW_SETTLE_MS with what is known, the rest named as
 * still checking), so nothing below the list moves after Home first shows.
 */
const store = "01a4d733-0000-7000-8000-000000000035";
afterEach(async () => {
  await unmountMounted();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const paths = {
  orders: "/merchant/orders",
  pickups: "/merchant/pickup/query",
  tables: "/merchant/dining/tables",
  exceptions: "/merchant/order-exceptions",
} as const;
type Source = keyof typeof paths;

async function home(answer: (source: Source | null, url: string) => Promise<Response>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const source = (Object.keys(paths) as Source[]).find((key) => url.includes(paths[key])) ?? null;
    return answer(source, url);
  });
  vi.stubGlobal("fetch", fetcher);
  const { container } = await mount(
    <MemoryRouter>
      <StoreOverview
        csrf={"a".repeat(43)}
        storeReference={store}
        storeLabel="TEST Store"
        timeZone="America/Toronto"
        screens={[
          "HOME-OVERVIEW",
          "OPS-ORDER-QUEUE",
          "FUL-PICKUP-QUEUE",
          "OPS-ORDER-EXCEPTION",
          "DIN-FLOOR-BOARD",
        ]}
        fetcher={fetcher as unknown as typeof fetch}
      />
    </MemoryRouter>,
  );
  return container;
}
/** Home's sections as a person sees them: null while held back (hidden). */
const shown = (container: HTMLElement) => container.querySelector(".overview-body:not([hidden])");
const failed = () => new Response("{}", { status: 503 });
// The store system board is the Owner's and Store Manager's; for these staff it answers 403.
const notPermitted = () => new Response("{}", { status: 403 });

it("batch 35: Home shows nothing of its list until every read has answered, then all of it at once", async () => {
  const waits = Object.fromEntries(
    (Object.keys(paths) as Source[]).map((key) => [key, deferred<Response>()]),
  ) as Record<Source, ReturnType<typeof deferred<Response>>>;
  const container = await home((source) =>
    source === null ? Promise.resolve(notPermitted()) : waits[source].promise,
  );
  for (const source of ["orders", "tables", "pickups"] as const) {
    waits[source].resolve(failed());
    await settle(10);
    // Still held: no list, no sections that the last read would push down.
    expect(shown(container)).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Reading…");
  }
  waits.exceptions.resolve(failed());
  await until(() => shown(container) !== null);
  // Every read's answer is in the first list shown.
  expect(container.querySelector(".overview-attention")?.textContent).toContain(
    "Could not read: Orders · Pickup · Tables · Exceptions",
  );
  expect(container.textContent).not.toContain("Still checking");
});

it("batch 35: a read that does not answer holds Home back no longer than OVERVIEW_SETTLE_MS, and is named as still checking", async () => {
  const hanging = deferred<Response>();
  const started = performance.now();
  const container = await home((source) =>
    source === "exceptions"
      ? hanging.promise
      : Promise.resolve(source === null ? notPermitted() : failed()),
  );
  await settle(10);
  expect(shown(container)).toBeNull();
  await until(() => shown(container) !== null, OVERVIEW_SETTLE_MS + 2_000);
  expect(performance.now() - started).toBeGreaterThanOrEqual(OVERVIEW_SETTLE_MS - 50);
  const list = container.querySelector(".overview-attention")?.textContent ?? "";
  // What is known shows (the failed reads), and what is not answered yet is said, not left out.
  expect(list).toContain("Could not read: Orders · Pickup · Tables");
  expect(list).toContain("Still checking");
  expect(list).toContain("Not answered yet: Exceptions");
  hanging.resolve(failed());
  await until(() => !(container.textContent ?? "").includes("Still checking"));
  expect(container.querySelector(".overview-attention")?.textContent).toContain(
    "Could not read: Orders · Pickup · Tables · Exceptions",
  );
}, 10_000);

it("v15 finding: the store system card follows the server's answer, not the navigation", async () => {
  // The pilot navigation before this fix carried no OPS-ORDER-EXCEPTION entry, so the card never
  // rendered although the alerts route answers 200 for these roles. A 403 hides it instead.
  // Batch 36 (b35 known limit): a failed alerts read is said as failed at once (after one quick
  // second try), so Home no longer waits OVERVIEW_SETTLE_MS and says "still checking" for it.
  const fetcher = vi.fn(async () => failed());
  vi.stubGlobal("fetch", fetcher);
  const started = performance.now();
  const { container } = await mount(
    <MemoryRouter>
      <StoreOverview
        screens={["MER-WORKSPACE-HOME", "OPS-ORDER-QUEUE", "FUL-PICKUP-QUEUE", "STORE-SETUP"]}
        csrf="csrf"
        storeReference="018f0f58-767a-7f3b-a1d0-000000000001"
        storeLabel="Training Store"
        fetcher={fetcher as unknown as typeof fetch}
      />
    </MemoryRouter>,
  );
  await until(() => shown(container) !== null, OVERVIEW_SETTLE_MS + 2_000);
  expect(performance.now() - started).toBeLessThan(OVERVIEW_SETTLE_MS - 1_000);
  expect(shown(container)?.textContent).toContain("Store system: could not be checked");
  expect(shown(container)?.textContent).toContain("The store system could not be checked");
  expect(shown(container)?.textContent).not.toContain("Still checking");
  expect(shown(container)?.querySelector('[aria-label="Store system"]')).not.toBeNull();
}, 10_000);

it("batch 36: one failed store system read is read again at once, so a blip is never listed", async () => {
  let alerts = 0;
  const container = await home((source, url) => {
    if (source !== null) return Promise.resolve(failed());
    if (!url.includes("/merchant/operations-alerts")) return Promise.resolve(notPermitted());
    alerts += 1;
    return Promise.resolve(alerts === 1 ? failed() : notPermitted());
  });
  await until(() => shown(container) !== null, OVERVIEW_SETTLE_MS + 2_000);
  expect(alerts).toBe(2);
  expect(container.textContent).not.toContain("could not be checked");
  expect(container.textContent).not.toContain("Still checking");
}, 10_000);
