import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 shared-table-checkout (a), pay first (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账: 默认付全桌,
// 只付我加的, 选几道菜帮别人付). Synthetic HTTP (routes standing in for the API) on the production
// PWA at 390, 1024 and 1440: phone A starts on "The whole table", pays only what it added, and its
// cart becomes that round; phone B sees plainly that someone pays and its dish waits, then gets the
// dish back once the round is sent; the payer is warned a minute before the choice stops being
// kept and keeps it. The server rules (one round = one cart version, each dish back once, the
// checkout_scope_held fence) are proven by the restricted-role acceptance dining-checkout-scope.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ trace: "off", video: "off" });
const id = (n: number) => "018f2520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);

function pricedMenu() {
  const at = new Date().toISOString();
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: id(40),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: publicStore,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: id(41),
      menuVersionReference: id(42),
      releaseReference: id(43),
      locale: "en-CA",
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(44),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(3),
              productVersionReference: id(45),
              name: "Synthetic noodles",
              description: null,
              photo: null,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(46),
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: { status: "Available", amount: "10.00", currency: "CAD", reason: null },
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

interface Table {
  version: number;
  items: { reference: number; name: string; quantity: number; other: boolean }[];
  tablePay: Record<string, unknown>;
}
const idle = () => ({ defaultChoice: "WholeTable", payer: null, waiting: [], returnable: false });

async function stubTable(
  page: Page,
  table: Table,
  onScope: (body: Record<string, unknown>) => unknown,
) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const scopeCalls: { body: Record<string, unknown>; key: string }[] = [];
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({ status: 200, json: { schemaVersion: 1, messages: [] } }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Table Store",
        publicStoreReference: publicStore,
        publicTableReference: id(5),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
      },
    }),
  );
  await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
    route.fulfill({ status: 200, json: pricedMenu() }),
  );
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: table.version,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: table.items.map((item) => ({
            cartItemReference: id(item.reference),
            sellableReference: id(3),
            displayName: item.name,
            quantity: item.quantity,
            configuration: [],
            customerNote: null,
            lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
            warnings: item.other ? ["OTHER_PARTICIPANT_ITEM"] : [],
          })),
          quote: null,
          warnings: [],
          tablePay: table.tablePay,
        },
      },
    }),
  );
  await page.route("**/api/v1/dine-in/checkout-scope", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    scopeCalls.push({ body, key: route.request().headers()["idempotency-key"] ?? "" });
    return route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, ...(onScope(body) as object) },
    });
  });
  for (const path of ["session**", "table-payment", "staff-call", "invitation"])
    await page.route(`**/api/v1/dine-in/${path}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json:
          path === "session**"
            ? {
                schemaVersion: 1,
                session: {
                  tableLabel: "12",
                  orderNumber: null,
                  checkedAt: new Date().toISOString(),
                  paymentTiming: "PayFirst",
                  rounds: [],
                  summary: null,
                },
              }
            : path === "table-payment"
              ? {
                  schemaVersion: 1,
                  payment: {
                    tableLabel: "12",
                    checkingOut: false,
                    rounds: [],
                    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
                    consistent: true,
                    state: "NotPaid",
                    attempt: null,
                    receipt: null,
                  },
                }
              : path === "staff-call"
                ? {
                    schemaVersion: 1,
                    staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
                  }
                : { schemaVersion: 1, invitation: { canInvite: false } },
      }),
    );
  // The checkout page asks these; its details are not what this spec is about.
  await page.route("**/api/v1/carts/*/quote", (route) => route.abort());
  await page.route("**/bff/customer/checkout-details/**", (route) => route.abort());
  return scopeCalls;
}

async function enterTable(page: Page, path: "/cart" | "/checkout") {
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
  ).toBeVisible();
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const screen of [
  { width: 390, height: 844, touch: true },
  { width: 1024, height: 900, touch: false },
  { width: 1440, height: 900, touch: false },
]) {
  test.describe(`@production Paying a round for chosen dishes (${screen.width})`, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });

    test("phone A starts on the whole table, pays only what it added, and its cart is that round", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", () => errors.push("page error"));
      const table: Table = {
        version: 4,
        items: [
          { reference: 2, name: "Synthetic noodles", quantity: 2, other: false },
          { reference: 6, name: "Synthetic sesame soup", quantity: 1, other: true },
        ],
        tablePay: idle(),
      };
      const calls = await stubTable(page, table, (body) => {
        if (body.action !== "Choose") return { status: "NothingToReturn", cartVersion: 5 };
        table.version = 5;
        table.items = table.items.filter((item) => !item.other);
        table.tablePay = {
          ...idle(),
          payer: {
            thisPhone: true,
            choice: "Mine",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            reserved: true,
          },
          waiting: [
            {
              waitingLineReference: id(60),
              quantity: 1,
              names: { "en-CA": "Synthetic sesame soup" },
              withOptions: false,
              mine: false,
            },
          ],
        };
        return {
          status: "Chosen",
          cartVersion: 5,
          expiresAt: table.tablePay.payer.expiresAt,
          setAsideUnits: 1,
        };
      });
      await enterTable(page, "/cart");
      await expect(page.getByText("Which dishes are you paying for?")).toBeVisible();
      await expect(page.getByLabel("The whole table (3 dishes · $30.00)")).toBeChecked();
      await expect(page.getByLabel("Only what I added (2 · $20.00)")).toBeVisible();
      await noHorizontalScroll(page);
      await expectNoInternalText(page);
      await page.screenshot({
        path: `test-results/table-pay-choice-${screen.width}.png`,
        fullPage: true,
      });
      await page.getByLabel("Only what I added (2 · $20.00)").check();
      await expect(
        page.getByText("Dishes you don't choose stay for the others at your table."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue to pay", exact: true }).click();
      await expect(page).toHaveURL(/\/checkout$/u);
      expect(calls.map((call) => call.body)).toEqual([
        {
          action: "Choose",
          cartReference: id(1),
          expectedCartVersion: 4,
          choice: "Mine",
          lines: [],
        },
      ]);
      // Back on the cart: this phone's round, the others' dish waiting, and the way back.
      await page.evaluate(() => {
        history.pushState(null, "", "/cart");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(
        page.getByRole("heading", { name: "You're paying for the dishes in this cart" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Next round" })).toBeVisible();
      await expect(page.getByText("Synthetic sesame soup")).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Back to cart (your choice is cancelled; nothing was charged)",
        }),
      ).toBeVisible();
      await noHorizontalScroll(page);
      await expectNoInternalText(page);
      await page.screenshot({
        path: `test-results/table-pay-payer-${screen.width}.png`,
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });

    test("phone B sees someone paying, its dish waiting, and gets it back once the round is sent", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", () => errors.push("page error"));
      const table: Table = {
        version: 5,
        items: [{ reference: 2, name: "Synthetic noodles", quantity: 2, other: true }],
        tablePay: {
          ...idle(),
          payer: {
            thisPhone: false,
            choice: "Mine",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            reserved: true,
          },
          waiting: [
            {
              waitingLineReference: id(60),
              quantity: 1,
              names: { "en-CA": "Synthetic sesame soup" },
              withOptions: false,
              mine: true,
            },
          ],
        },
      };
      const calls = await stubTable(page, table, (body) => {
        if (body.action !== "Return") return { status: "NotLive" };
        table.version = 7;
        table.items = [{ reference: 61, name: "Synthetic sesame soup", quantity: 1, other: false }];
        table.tablePay = idle();
        return { status: "Returned", cartVersion: 7, returnedUnits: 1 };
      });
      await enterTable(page, "/cart");
      await expect(
        page.getByText(
          "Someone at your table is paying for their dishes. Yours are kept and come back here when they finish.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Next round" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Someone at your table is paying", exact: true }),
      ).toBeDisabled();
      await noHorizontalScroll(page);
      await expectNoInternalText(page);
      await page.screenshot({
        path: `test-results/table-pay-waiting-${screen.width}.png`,
        fullPage: true,
      });
      expect(calls).toEqual([]);
      // A's round is sent: the cart is empty, and B's dish can come back.
      table.version = 6;
      table.items = [];
      table.tablePay = { ...table.tablePay, payer: null, returnable: true };
      await expect(page.getByRole("heading", { name: "Synthetic sesame soup" })).toBeVisible({
        timeout: 10_000,
      });
      expect(calls.map((call) => call.body)).toEqual([{ action: "Return" }]);
      await expect(page.getByRole("heading", { name: "Next round" })).toHaveCount(0);
      await expectNoInternalText(page);
      expect(errors).toEqual([]);
    });

    test("the payer is warned a minute before the choice stops being kept, and keeps it", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", () => errors.push("page error"));
      const table: Table = {
        version: 5,
        items: [{ reference: 2, name: "Synthetic noodles", quantity: 2, other: false }],
        tablePay: {
          ...idle(),
          payer: {
            thisPhone: true,
            choice: "Mine",
            expiresAt: new Date(Date.now() + 45_000).toISOString(),
            reserved: true,
          },
          waiting: [],
        },
      };
      const calls = await stubTable(page, table, (body) => {
        if (body.action !== "Extend") return { status: "NotLive" };
        const expiresAt = new Date(Date.now() + 300_000).toISOString();
        table.tablePay = {
          ...table.tablePay,
          payer: { thisPhone: true, choice: "Mine", expiresAt, reserved: true },
        };
        return { status: "Extended", expiresAt };
      });
      await enterTable(page, "/checkout");
      await expect(
        page.getByText(/The dishes you chose are kept for \d+ more seconds\./u),
      ).toBeVisible();
      await noHorizontalScroll(page);
      await page.screenshot({
        path: `test-results/table-pay-warning-${screen.width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Keep them", exact: true }).click();
      await expect(page.getByText(/The dishes you chose are kept for/u)).toHaveCount(0);
      expect(calls.map((call) => call.body)).toEqual([{ action: "Extend" }]);
      await expectNoInternalText(page);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("@production Paying a round for chosen dishes in Chinese (390)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  test("the choice reads in Chinese and starts on the Store's own-dishes setting", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("bop.customer.language", "zh-Hans"));
    const table: Table = {
      version: 4,
      items: [
        { reference: 2, name: "Synthetic noodles", quantity: 2, other: false },
        { reference: 6, name: "Synthetic sesame soup", quantity: 1, other: true },
      ],
      tablePay: {
        ...idle(),
        defaultChoice: "OwnDishes",
        waiting: [],
      },
    };
    await stubTable(page, table, () => ({ status: "NotLive" }));
    await enterTable(page, "/cart");
    await expect(page.getByText("这次付哪些菜？")).toBeVisible();
    await expect(page.getByLabel("只付我加的（2 道）")).toBeChecked();
    await expect(page.getByText("没选的菜留给同桌其他人付。含税金额在下一步显示。")).toBeVisible();
    await expect(page.getByRole("button", { name: "去付款", exact: true })).toBeVisible();
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/table-pay-choice-zh-390.png", fullPage: true });
  });
});
