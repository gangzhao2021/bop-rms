import { expect, test, type Page } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity.
test.beforeEach(({ context }) => routeStorefrontReads(context));

// WP-2423 Q28 DEC-DINING-STAFF-CALL: synthetic HTTP fixtures stand in for the API; the server
// rules (seated guests only, one open call, budget, scope, append-only) are proven by the
// database acceptance test. No real Store, guest or table data.
const id = (n: number) => `018f2331-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const session = {
  schemaVersion: 1,
  session: {
    tableLabel: "12",
    orderNumber: null,
    checkedAt: "2026-10-25T18:00:00.000Z",
    rounds: [],
    summary: null,
  },
};
const noStore = { "cache-control": "no-store" };
async function enterTable(page: Page) {
  const onSession = () => ({ status: 200, json: session });
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Noodle Bar",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "s".repeat(43),
      },
    }),
  );
  await page.route("**/api/v1/dine-in/session", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-csrf-token"]).toBe("s".repeat(43));
    expect(new URL(route.request().url()).search).toBe("");
    const { status, json } = onSession();
    return route.fulfill({ status, headers: { "cache-control": "no-store" }, json });
  });
  // WP-2423 DEC-DINING-GUEST-INVITATION: this guest is not the table's host (no invite control).
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Noodle Bar", exact: true }),
  ).toBeVisible();
  // Same-document navigation retains the real Entry CSRF context, as after joining the table.
  await page.evaluate(() => {
    history.pushState(null, "", "/menu");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page
    .getByRole("navigation", { name: "Customer journey" })
    .getByRole("link", { name: "Your table" })
    .click();
  await expect(page).toHaveURL(/\/dine-in\/session$/u);
}

test.describe("@production a guest at the table asks staff to come over", () => {
  test.use({ serviceWorkers: "block" });

  test("asks with a reason, sees it is open for the whole table, and withdraws it", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let view: Record<string, unknown> = { open: null, recentlyClosed: null, nextCallAt: null };
    const calls: { key: string | undefined; body: unknown }[] = [];
    const withdrawals: unknown[] = [];
    await page.route("**/api/v1/dine-in/staff-call", (route) => {
      const request = route.request();
      expect(request.headers()["x-csrf-token"]).toBe("s".repeat(43));
      if (request.method() === "GET")
        return route.fulfill({
          status: 200,
          headers: noStore,
          json: { schemaVersion: 1, staffCall: view },
        });
      calls.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
      view = {
        open: { callReference: id(30), reason: "TableNeeds", calledAt: new Date().toISOString() },
        recentlyClosed: null,
        nextCallAt: null,
      };
      return route.fulfill({
        status: 201,
        headers: noStore,
        json: { schemaVersion: 1, status: "Called", staffCall: view },
      });
    });
    await page.route("**/api/v1/dine-in/staff-call/withdraw", (route) => {
      withdrawals.push(route.request().postDataJSON());
      view = {
        open: null,
        recentlyClosed: { kind: "Withdrawn", closedAt: new Date().toISOString() },
        nextCallAt: null,
      };
      return route.fulfill({
        status: 200,
        headers: noStore,
        json: { schemaVersion: 1, status: "Withdrawn" },
      });
    });
    await enterTable(page);
    const panel = page.getByRole("region", { name: "Need a staff member?" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("radio", { name: "A question" })).toBeChecked();
    await panel
      .getByRole("radio", { name: "Something for the table (water, cutlery, napkins)" })
      .check();
    // Nothing to type: no allergy or personal detail goes through this.
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await panel.getByRole("button", { name: "Ask staff to come to the table" }).click();
    const asked = page.getByRole("region", { name: "Staff have been asked to come to your table" });
    await expect(asked).toBeVisible();
    await expect(asked.getByText(/Asked at .+ · Something for the table/u)).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reason: "TableNeeds" });
    expect(calls[0]?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
    }
    await asked.getByRole("button", { name: "No longer needed" }).click();
    await expect(panel.getByText("Your request was withdrawn.")).toBeVisible();
    expect(withdrawals).toEqual([{ callReference: id(30) }]);
    expect(errors).toEqual([]);
  });

  test("says when staff answered, when to ask again, and to wave when staff cannot be told", async ({
    page,
  }) => {
    let mode: "answered" | "limit" | "down" = "answered";
    await page.route("**/api/v1/dine-in/staff-call", (route) => {
      if (route.request().method() !== "GET")
        return route.fulfill({ status: 503, headers: noStore, json: {} });
      if (mode === "down") return route.fulfill({ status: 503, headers: noStore, json: {} });
      return route.fulfill({
        status: 200,
        headers: noStore,
        json: {
          schemaVersion: 1,
          staffCall:
            mode === "answered"
              ? {
                  open: null,
                  recentlyClosed: { kind: "Answered", closedAt: new Date().toISOString() },
                  nextCallAt: null,
                }
              : {
                  open: null,
                  recentlyClosed: null,
                  nextCallAt: new Date(Date.now() + 20 * 60_000).toISOString(),
                },
        },
      });
    });
    await enterTable(page);
    const panel = page.getByRole("region", { name: "Need a staff member?" });
    await expect(panel.getByText(/A staff member saw your request at/u)).toBeVisible();
    await panel.getByRole("button", { name: "Ask staff to come to the table" }).click();
    await expect(
      panel.getByText("We couldn’t reach the staff. Try again, or wave to a staff member."),
    ).toBeVisible();
    mode = "limit";
    await enterTable(page);
    await expect(
      page.getByText(/You can ask again at .+, or wave to a staff member\./u),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask staff to come to the table" })).toHaveCount(
      0,
    );
  });
});
