import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 65 (v15 b64 live, guest-split-own-payment): on G64 B two phones each added Beef noodles
// (TEST) and sent neither; staff pressed Start checkout. A Cart left open named "Beef noodles
// (TEST) × 2" under "Not sent to the kitchen", but a Cart opened or reloaded after that showed
// only "Your table is paying the bill / Ask staff if you want to add more." (its read was refused
// 409), as if the dishes had gone to the kitchen. And after a language switch the dish name on
// the open Cart stayed in the old language. The cart read here is the real one on a local server
// (apps/api/test-support/guest-cart-at-checkout-http.ts): Dining's participation query decides
// the table is checking out, Ordering composes the Cart read-only, the API's handler answers. The
// visit, the bill, the staff call and the storefront reads are synthetic.
type Phase = "Active" | "Closing";
interface CartHttp {
  readonly url: string;
  close(): Promise<void>;
}
let phase: Phase = "Closing";
let api: CartHttp;
test.beforeAll(async () => {
  // A variable path: the API's source is loaded at run time, outside this app's typecheck.
  const helper = "../../api/test-support/guest-cart-at-checkout-http.ts";
  const { startGuestCartAtCheckoutHttp } = (await import(helper)) as {
    startGuestCartAtCheckoutHttp(origin: string, phase: () => Phase): Promise<CartHttp>;
  };
  api = await startGuestCartAtCheckoutHttp("https://127.0.0.1", () => phase);
});
test.afterAll(async () => api?.close());
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const id = (n: number) => "0198b065-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const height = 844;
const tableLabel = "G64 B (TEST)";
const accent = "rgb(31, 99, 224)";

async function stubVisit(page: Page, staffCalls: string[]) {
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "d".repeat(43),
        menuContext: {
          publicStoreReference: id(16),
          channel: "DineIn",
          locale: "en-CA",
          brandDisplayName: "Test Merchant 2 - not production",
          storeDisplayName: "Test Merchant 2 Main - not production",
        },
        visit: { publicTableReference: id(33), joined: true },
      }),
    ),
  );
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
  // The cart read: the real handler on the local server, with the language the page asks in.
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({
      url: api.url + asked.pathname + asked.search,
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        cookie: "__Host-bop-guest=" + "s".repeat(43),
      },
    });
    await route.fulfill({ response });
  });
  // Every change and price check is refused while the table checks out (as v15 answered).
  await page.route("**/api/v1/carts**", (route) =>
    route.fulfill(
      json(409, {
        schemaVersion: 1,
        error: { code: "cart_table_checking_out", messageKey: "customer.cart.table_checking_out" },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        payment: {
          tableLabel,
          checkingOut: true,
          rounds: [
            {
              roundNumber: 1,
              items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "1250" }],
              totalMinor: "1413",
            },
          ],
          owed: { subtotalMinor: "1250", taxMinor: "163", totalMinor: "1413" },
          consistent: true,
          tips: { enabled: false, tierPercents: [10, 15, 18] },
          state: "NotPaid",
          attempt: null,
          split: null,
          receipt: null,
        },
      }),
    ),
  );
  // This table's staff call: offered, and asked once the guest taps it.
  await page.route("**/api/v1/dine-in/staff-call", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      staffCalls.push(String((request.postDataJSON() as { reason?: unknown }).reason));
      return route.fulfill(
        json(201, {
          schemaVersion: 1,
          status: "Called",
          staffCall: {
            open: {
              callReference: id(70),
              reason: "OrderProblem",
              calledAt: new Date().toISOString(),
            },
            recentlyClosed: null,
            nextCallAt: null,
          },
        }),
      );
    }
    return route.fulfill(
      json(200, {
        schemaVersion: 1,
        staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
      }),
    );
  });
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: false } })),
  );
}

async function toLanguage(page: Page, zh: boolean) {
  await page
    .getByRole("button", { name: /^(切换到中文|Switch to English)$/u })
    .first()
    .waitFor();
  const button = page.getByRole("button", { name: zh ? "切换到中文" : "Switch to English" });
  if ((await button.count()) > 0) {
    await button.click();
    await page.getByRole("button", { name: zh ? "Switch to English" : "切换到中文" }).waitFor();
  }
}

const words = (zh: boolean) => ({
  heading: zh ? "这桌正在结账" : "Your table is paying the bill",
  unsent: zh ? "没有送到厨房" : "Not sent to the kitchen",
  line: zh ? "牛肉面 × 2" : "Beef noodles (TEST) × 2",
  ask: zh ? "请店员加上这些菜" : "Ask staff to add these",
  addMore: zh ? /如需加点/u : /Ask staff if you want to add more/u,
});

/** The unsent list reads as one dish × 2, inside the gutter, and the page never scrolls sideways. */
async function expectUnsentNamed(page: Page, zh: boolean, width: number) {
  const main = page.getByRole("main");
  const text = words(zh);
  await expect(main.getByRole("heading", { name: text.heading })).toBeVisible();
  const heading = main.getByRole("heading", { name: text.unsent });
  await expect(heading).toBeVisible();
  const lines = main.locator(".cart-unsent li");
  await expect(lines).toHaveCount(1);
  await expect(lines).toHaveText(text.line);
  await expect(main).not.toContainText(text.addMore);
  expect(
    await heading.evaluate((element) => {
      const css = getComputedStyle(element);
      return [css.fontSize, css.fontWeight];
    }),
  ).toEqual(["20px", "600"]);
  for (const box of [heading, lines.first(), main.getByRole("button", { name: text.ask })]) {
    const rect = await box.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect?.x ?? 0).toBeGreaterThanOrEqual(15);
    expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN b65 the Cart at checkout (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height }, hasTouch: width < 768, isMobile: width < 768 });
      const shot = (name: string) =>
        `test-results/b65-cart-${name}-${zh ? "zh" : "en"}-${width}.png`;

      test("opened and reloaded after Start checkout, it names the unsent dish; staff can be called", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        phase = "Closing";
        const staffCalls: string[] = [];
        await stubVisit(page, staffCalls);
        await page.goto("/cart");
        if (zh) await toLanguage(page, true);
        await expectUnsentNamed(page, zh, width);
        await page.screenshot({ path: shot("opened"), fullPage: true });
        await page.reload();
        await expectUnsentNamed(page, zh, width);
        // Still read-only: no place-order, quantity or remove control, only the one call to staff.
        const main = page.getByRole("main");
        await expect(main.getByRole("button")).toHaveCount(1);
        const ask = main.getByRole("button", { name: words(zh).ask });
        expect(await ask.evaluate((element) => getComputedStyle(element).color)).toBe(accent);
        expect((await ask.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        await ask.click();
        await expect(main.locator(".cart-unsent [role=status]")).toHaveText(
          zh ? "已请店员到您的桌边" : "Staff have been asked to come to your table",
        );
        expect(staffCalls).toEqual(["OrderProblem"]);
        await expectNoInternalText(page);
        await page.screenshot({ path: shot("reloaded-asked"), fullPage: true });
      });

      test("after a language switch the unsent dish is named in the new language", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        phase = "Closing";
        await stubVisit(page, []);
        await page.goto("/cart");
        if (zh) await toLanguage(page, true);
        await expectUnsentNamed(page, zh, width);
        await toLanguage(page, !zh);
        await expectUnsentNamed(page, !zh, width);
        await expect(page.getByRole("main")).not.toContainText(zh ? "牛肉面" : "Beef noodles");
        await page.screenshot({ path: shot("switched"), fullPage: true });
      });
    });
