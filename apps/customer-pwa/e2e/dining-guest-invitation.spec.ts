import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const id = (n: number) => `018f2423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noStore = { "cache-control": "no-store" };
// Codes are shown on screen; do not retain traces or failure screenshots.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

/**
 * WP-2423 DEC-DINING-GUEST-INVITATION. Synthetic HTTP (route fixtures standing in for the API)
 * exercises the production UI end to end across two phones: the table's host makes a one-time
 * code, the second guest scans the table and joins with it, the code cannot be used again, and
 * both guests order on the table's shared cart. Server rules (host only, single use, 15 minutes,
 * replacement, closure, move, budget) are proven by the database acceptance test.
 */
test.describe("@production guests invite each other at the table", () => {
  test("the host invites the second guest, who joins once and orders on the shared cart", async ({
    browser,
  }, info) => {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const issuedCode = "482913";
    const nextCode = "591027";
    const table = {
      used: false,
      issued: 0,
      joined: 0,
      keys: [] as string[],
      usedKey: null as string | null,
      replacedKey: null as string | null,
      asked: 0,
    };
    const errors: string[] = [];

    async function phone(name: string) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.on("pageerror", () => errors.push(name + " page error"));
      page.on("console", (message) => {
        // The browser logs every non-2xx response (the expected 409 refusal, unmocked 404s).
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
          errors.push(name + " console error");
      });
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          headers: noStore,
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Dining Store",
            publicStoreReference: id(6),
            publicTableReference: id(7),
            channel: "DineIn",
            operatingState: "Open",
            availableServiceModes: ["DineIn"],
            locale: "en-CA",
            contextExpiresAt: expiresAt,
            csrfToken: (name === "host" ? "h" : name === "guest" ? "g" : "x").repeat(43),
          },
        }),
      );
      return { context, page };
    }

    async function cart(page: Page, own: "host" | "guest") {
      const item = (who: "host" | "guest") => ({
        cartItemReference: id(who === "host" ? 20 : 21),
        sellableReference: id(who === "host" ? 22 : 23),
        displayName: who === "host" ? "Synthetic ramen" : "Synthetic gyoza",
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
        warnings: who === own ? [] : ["OTHER_PARTICIPANT_ITEM"],
      });
      await page.route("**/bff/customer/cart", (route) =>
        route.fulfill({
          status: 200,
          headers: noStore,
          json: {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "DineIn",
              serviceMode: "DineIn",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic Dining Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [item("host"), item("guest")],
              quote: null,
              warnings: [],
            },
          },
        }),
      );
    }

    async function tableView(page: Page, canInvite: boolean) {
      await page.route("**/api/v1/dine-in/session", (route) =>
        route.fulfill({
          status: 200,
          headers: noStore,
          json: {
            schemaVersion: 1,
            session: {
              tableLabel: "T4",
              orderNumber: null,
              checkedAt: new Date().toISOString(),
              rounds: [],
              summary: null,
            },
          },
        }),
      );
      await page.route("**/api/v1/dine-in/invitation", async (route) => {
        const request = route.request();
        if (request.method() === "GET") {
          // The host's phone asks about the code it shows by the request that made it, never
          // by the code itself.
          const asked = request.headers()["x-dining-invitation-reference"];
          if (asked === undefined) {
            await route.fulfill({
              status: 200,
              headers: noStore,
              json: { schemaVersion: 1, invitation: { canInvite } },
            });
            return;
          }
          expect(asked).toBe(table.keys.at(-1));
          expect(request.url()).not.toMatch(/\?|482913|591027/u);
          table.asked++;
          await route.fulfill({
            status: 200,
            headers: noStore,
            json: {
              schemaVersion: 1,
              invitation: {
                canInvite,
                codeState:
                  asked === table.replacedKey
                    ? "Replaced"
                    : asked === table.usedKey
                      ? "Used"
                      : "Live",
              },
            },
          });
          return;
        }
        expect(canInvite).toBe(true);
        const key = request.headers()["idempotency-key"] ?? "";
        expect(key).toMatch(/^[0-9a-f-]{36}$/u);
        expect(request.postData()).toBe("{}");
        table.keys.push(key);
        table.issued++;
        await route.fulfill({
          status: 201,
          headers: noStore,
          json: {
            schemaVersion: 1,
            invitation: {
              status: "Issued",
              code: table.issued === 1 ? issuedCode : nextCode,
              expiresAt,
            },
          },
        });
      });
    }

    async function joinRoutes(context: BrowserContext) {
      await context.route("**/bff/customer/dining/join", async (route) => {
        const request = route.request();
        const body = JSON.parse(request.postData() ?? "{}") as { joinCredential?: string };
        if (body.joinCredential === issuedCode && !table.used) {
          table.used = true;
          table.usedKey = table.keys[0] ?? null;
          table.joined++;
          await route.fulfill({
            status: 200,
            headers: noStore,
            json: {
              status: "Joined",
              operationReference: request.headers()["idempotency-key"],
              admissionReference: id(30),
            },
          });
          return;
        }
        await route.fulfill({
          status: 409,
          headers: noStore,
          json: {
            error: {
              code:
                body.joinCredential === issuedCode
                  ? "dining_join_code_used"
                  : "dining_join_code_not_accepted",
              messageKey:
                body.joinCredential === issuedCode
                  ? "customer.dining.join_code_used"
                  : "customer.dining.join_code_not_accepted",
            },
          },
        });
      });
      await context.route("**/bff/customer/dining-binding/prepare", (route) =>
        route.fulfill({
          status: 200,
          headers: noStore,
          json: {
            status: "Prepared",
            operationReference: route.request().headers()["idempotency-key"],
            candidateCsrfToken: "n".repeat(43),
            recoveryProof: "r".repeat(43),
            expiresAt,
          },
        }),
      );
      await context.route("**/bff/customer/dining-binding/activate", (route) =>
        route.fulfill({
          status: 200,
          headers: noStore,
          json: {
            status: "Activated",
            operationReference: route.request().headers()["idempotency-key"],
            csrfToken: "n".repeat(43),
          },
        }),
      );
    }

    const goTo = (page: Page, path: string) =>
      page.evaluate((target) => {
        history.pushState(null, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, path);

    // ── The host (already at the table) makes a code on their phone.
    const host = await phone("host");
    await tableView(host.page, true);
    await cart(host.page, "host");
    await host.page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      host.page.getByRole("heading", { name: "Synthetic Dining Store", exact: true }),
    ).toBeVisible();
    await goTo(host.page, "/dine-in/session");
    const invite = host.page.getByRole("region", { name: "Invite someone at your table" });
    await expect(invite).toBeVisible();
    await expect(invite.getByText("They scan the QR code on the table")).toBeVisible();
    const make = invite.getByRole("button", { name: "Make a code" });
    expect((await make.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await make.click();
    await expect(invite.getByText("482 913", { exact: true })).toBeVisible();
    await expect(
      invite.getByText(
        "Show this code to the person joining you. It works once and for 15 minutes",
        { exact: false },
      ),
    ).toBeVisible();
    expect(table.issued).toBe(1);
    expect(host.page.url()).not.toContain(issuedCode);
    expect(await host.page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([
      0, 0,
    ]);
    expect(
      await host.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await host.page.screenshot({
      path: info.outputPath("host-invitation-390.png"),
      fullPage: true,
    });

    // ── The second guest scans the table and joins with the host's code.
    const guest = await phone("guest");
    await joinRoutes(guest.context);
    await tableView(guest.page, false);
    await cart(guest.page, "guest");
    await guest.page.goto("/#qr=aaa.bbb.ccc");
    const field = guest.page.getByLabel("Join code or invitation", { exact: true });
    await expect(
      guest.page.getByText("Ask staff, or the person who joined your table first", {
        exact: false,
      }),
    ).toBeVisible();
    await field.fill(issuedCode);
    await guest.page.getByRole("button", { name: "Join table", exact: true }).click();
    await expect(
      guest.page.getByRole("heading", { name: "You’ve joined this table" }),
    ).toBeVisible();
    expect(table.joined).toBe(1);

    // ── The code works once: a third phone using it is told it was already used.
    const third = await phone("third");
    await joinRoutes(third.context);
    await third.page.goto("/#qr=aaa.bbb.ccc");
    await third.page.getByLabel("Join code or invitation", { exact: true }).fill(issuedCode);
    await third.page.getByRole("button", { name: "Join table", exact: true }).click();
    await expect(third.page.getByRole("alert")).toContainText(
      "This code was already used. Ask staff, or the person who invited you, for a new one.",
    );
    expect(table.joined).toBe(1);

    // ── v15 42e95248: the host's phone learns, without a reload, that the code was used, and
    // offers another; when staff (or another phone) replace that one, it says so.
    await expect(invite.getByText("Someone joined with this code.", { exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect(invite.getByText("482 913", { exact: true })).toHaveCount(0);
    await invite.getByRole("button", { name: "Make another code" }).click();
    await expect(invite.getByText("591 027", { exact: true })).toBeVisible();
    table.replacedKey = table.keys[1] ?? null;
    await expect(
      invite.getByText("This code was replaced. Make a new one.", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(invite.getByText("591 027", { exact: true })).toHaveCount(0);
    await expect(invite.getByRole("button", { name: "Make a new code" })).toBeVisible();
    expect(table.asked).toBeGreaterThanOrEqual(2);

    // ── Only the host sees the invite control.
    await goTo(guest.page, "/dine-in/session");
    await expect(guest.page.getByRole("heading", { name: "Your table · T4" })).toBeVisible();
    await expect(
      guest.page.getByRole("region", { name: "Invite someone at your table" }),
    ).toHaveCount(0);

    // ── Both order on the table's shared cart: each changes only their own dish.
    for (const [who, page, own, other] of [
      ["host", host.page, "Synthetic ramen", "Synthetic gyoza"],
      ["guest", guest.page, "Synthetic gyoza", "Synthetic ramen"],
    ] as const) {
      await goTo(page, "/cart");
      await expect(page.getByRole("heading", { name: "Your cart", exact: true })).toBeVisible();
      const mine = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: own }) });
      const theirs = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: other }) });
      await expect(mine.getByRole("button", { name: `Increase ${own} quantity` })).toBeEnabled();
      await expect(
        theirs.getByText("Added by another guest. Only they can change this item.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`${who}-shared-cart-390.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    await Promise.all([host.context.close(), guest.context.close(), third.context.close()]);
  });
});
