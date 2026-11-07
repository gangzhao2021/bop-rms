import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { receipt } from "./receipt-fixture";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the receipt offers joining, and joining earns this order's
 * points; the member page shows the balance, history and what can be redeemed; leaving deletes. A
 * failure of any of it leaves the receipt as it was. Synthetic answers; 555-01xx is a fictitious
 * range. The real route is covered under the restricted role by `dining-pay-later-round`.
 */
const orderReference = "018f8815-0000-7000-8000-000000000001";
const json = { "content-type": "application/json", "cache-control": "no-store" };
const rule = {
  earnPointsPerDollar: 3,
  redeemPointsPerDollar: 100,
  minimumRedemptionPoints: 300,
  redemptionIncrementPoints: 100,
  rewards: [
    {
      productReference: "018f8815-0000-7000-8000-000000000009",
      displayName: "Milk tea",
      pointsCost: 800,
    },
  ],
};
const member = (overrides = {}) => ({
  schemaVersion: 1,
  offeredHere: true,
  availablePoints: 640,
  pointsOwed: 0,
  phoneLast4: "0141",
  marketingConsent: false,
  expiresAt: "2028-05-02T12:00:00.000Z",
  expiresSoon: false,
  history: [
    {
      type: "Redeem",
      points: 300,
      reasonCode: "BILL_REDEMPTION",
      occurredAt: "2026-11-01T18:00:00.000Z",
    },
    {
      type: "Earn",
      points: 940,
      reasonCode: "PAID_DISHES",
      occurredAt: "2026-10-01T18:00:00.000Z",
    },
  ],
  rule,
  ...overrides,
});

interface Answers {
  state: () => { status?: number; body: Record<string, unknown> };
  [action: string]: (() => { status?: number; body: Record<string, unknown> }) | undefined;
}
async function serve(page: Page, answers: Partial<Answers>) {
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      headers: json,
      body: JSON.stringify({
        schemaVersion: 1,
        csrfToken: "c".repeat(43),
        menuContext: {
          publicStoreReference: "018f8815-0000-7000-8000-000000000006",
          channel: "Pickup",
          locale: "en-CA",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Receipt Store",
        },
      }),
    }),
  );
  await page.route("**/api/v1/orders/*/receipt**", (route) =>
    route.fulfill({ headers: json, body: JSON.stringify(receipt(true)) }),
  );
  await page.route("**/bff/customer/member", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    asked.push(body);
    const answer = answers[String(body.action)]?.() ?? {
      status: 503,
      body: { schemaVersion: 1, error: { code: "member_unavailable" } },
    };
    await route.fulfill({
      status: answer.status ?? 200,
      headers: json,
      body: JSON.stringify(answer.body),
    });
  });
  return asked;
}
const offer = {
  body: {
    schemaVersion: 1,
    offered: true,
    signedIn: false,
    messagesAvailable: true,
    rule,
    claim: { until: "2026-11-03T18:00:00.000Z", parts: [{ partNumber: null, points: 45 }] },
  },
};
const widths = [1440, 1024, 390];

for (const width of widths)
  test.describe(`@production member points at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 }, serviceWorkers: "block" });

    test("a guest joins from the receipt, with the offers box unticked, and this order earns", async ({
      page,
    }) => {
      const asked = await serve(page, {
        State: () => offer,
        SendCode: () => ({ body: { schemaVersion: 1, sent: true } }),
        Verify: () => ({ body: { schemaVersion: 1, joined: true, earnedPoints: 45 } }),
      });
      await page.goto("/orders/" + orderReference + "/receipt");
      const panel = page.getByRole("region", { name: "Join and earn 45 points on this order" });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("only on orders you place by scanning the QR code");
      await expect(panel).toContainText("only to text you a sign-in code");
      await expect(panel.getByRole("checkbox")).not.toBeChecked();
      await page.screenshot({
        path: `test-results/member-join-${String(width)}.png`,
        fullPage: true,
      });
      await panel.getByLabel("Mobile number").fill("613 555 0141");
      await panel.getByRole("button", { name: "Text me a code" }).click();
      await panel.getByLabel("Code from the text").fill("123456");
      await panel.getByRole("button", { name: "Join and add my points" }).click();
      await expect(page.getByRole("region", { name: "You’re a member" })).toContainText(
        "45 points added for this order.",
      );
      const verify = asked.find((body) => body.action === "Verify");
      expect(verify).toMatchObject({ marketingConsent: false, claim: true, orderReference });
      expect(page.url()).not.toContain("613");
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test("the member page: balance, history, what can be redeemed, and leaving", async ({
      page,
    }) => {
      await serve(page, {
        Home: () => ({ body: member() }),
        Leave: () => ({ body: { schemaVersion: 1, left: true } }),
      });
      await page.goto("/member");
      await expect(page.getByRole("heading", { name: "640 points" })).toBeVisible();
      await expect(page.getByText("Number ending in 0141")).toBeVisible();
      await expect(page.getByText("Milk tea · 800 points")).toBeVisible();
      await expect(page.getByText("Used on a bill")).toBeVisible();
      await expect(page.getByText("−300")).toBeVisible();
      await expect(page.getByText("+940")).toBeVisible();
      await expect(page.getByText(/expire on/u)).toBeVisible();
      await page.screenshot({
        path: `test-results/member-page-${String(width)}.png`,
        fullPage: true,
      });
      await expectNoInternalText(page);
      await page.getByRole("button", { name: "Leave and delete my details" }).click();
      const confirm = page.getByRole("group", { name: "Confirm leaving" });
      await expect(confirm).toContainText("your 640 points are gone");
      await confirm.getByRole("button", { name: "Leave and delete", exact: true }).click();
      await expect(page.getByText("You’ve left. Your phone number is deleted.")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  });

test.describe("@production a signed-in member after paying", () => {
  test.use({ serviceWorkers: "block" });
  const claimOf = (parts: unknown[]) => ({
    body: {
      schemaVersion: 1,
      offered: true,
      signedIn: true,
      messagesAvailable: true,
      rule,
      claim: { until: "2026-11-03T18:00:00.000Z", parts },
    },
  });
  test("this phone certainly paid: added without pressing anything, once", async ({ page }) => {
    let added = false;
    const asked = await serve(page, {
      State: () =>
        added
          ? { body: { schemaVersion: 1, offered: true, signedIn: true, rule, claim: null } }
          : claimOf([{ partNumber: null, points: 45, certain: true }]),
      Claim: () => {
        added = true;
        return { body: { schemaVersion: 1, earnedPoints: 45 } };
      },
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    await expect(page.getByText("45 points added for this order.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add my points" })).toHaveCount(0);
    expect(asked.filter((body) => body.action === "Claim")).toHaveLength(1);
  });
  test("it might be someone else's part: the button stays, and pressing it adds them", async ({
    page,
  }) => {
    const asked = await serve(page, {
      State: () => claimOf([{ partNumber: null, points: 45, certain: false }]),
      Claim: () => ({ body: { schemaVersion: 1, earnedPoints: 45 } }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    const button = page.getByRole("button", { name: "Add my points" });
    await expect(button).toBeVisible();
    expect(asked.filter((body) => body.action === "Claim")).toHaveLength(0);
    await button.click();
    await expect(page.getByText("45 points added for this order.")).toBeVisible();
  });
  test("adding them fails: the receipt stands and the button is there to try again", async ({
    page,
  }) => {
    await serve(page, {
      State: () => claimOf([{ partNumber: null, points: 45, certain: true }]),
      Claim: () => ({
        status: 503,
        body: { schemaVersion: 1, error: { code: "member_unavailable" } },
      }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    await expect(page.getByRole("heading", { name: "Receipt", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add my points" })).toBeVisible();
  });
});

test.describe("@production member points when something is down", () => {
  test.use({ serviceWorkers: "block" });
  test("no text account: the page says so and the order's points wait until a stated time", async ({
    page,
  }) => {
    await serve(page, {
      State: () => offer,
      SendCode: () => ({
        status: 503,
        body: { schemaVersion: 1, error: { code: "member_code_unavailable" } },
      }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    const panel = page.getByRole("region", { name: "Join and earn 45 points on this order" });
    await panel.getByLabel("Mobile number").fill("6135550141");
    await panel.getByRole("button", { name: "Text me a code" }).click();
    await expect(panel.getByRole("alert")).toContainText("We can’t send a code right now.");
    await expect(panel.getByRole("alert")).toContainText("still yours");
    await panel.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByText(/You can still add this order’s points/u)).toBeVisible();
  });
  test("too many codes says how long to wait", async ({ page }) => {
    await serve(page, {
      State: () => offer,
      SendCode: () => ({
        status: 429,
        body: { schemaVersion: 1, error: { code: "member_rate_limited", retryAfterSeconds: 600 } },
      }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    const panel = page.getByRole("region", { name: "Join and earn 45 points on this order" });
    await panel.getByLabel("Mobile number").fill("6135550141");
    await panel.getByRole("button", { name: "Text me a code" }).click();
    await expect(panel.getByRole("alert")).toContainText("Try again in 10 min.");
  });
  test("points off, or a failed read: the receipt is just the receipt", async ({ page }) => {
    await serve(page, {
      State: () => ({ body: { schemaVersion: 1, offered: false, signedIn: false } }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    await expect(page.getByRole("heading", { name: "Receipt", exact: true })).toBeVisible();
    await expect(page.getByLabel("Mobile number")).toHaveCount(0);
    await page.unroute("**/bff/customer/member");
    await page.route("**/bff/customer/member", (route) => route.abort());
    await page.reload();
    await expect(page.getByRole("heading", { name: "Receipt", exact: true })).toBeVisible();
    await expect(page.getByLabel("Mobile number")).toHaveCount(0);
  });
  test("in Chinese", async ({ page }) => {
    await serve(page, {
      State: () => offer,
      Home: () => ({ body: member({ expiresSoon: true }) }),
    });
    await page.goto("/orders/" + orderReference + "/receipt");
    await expect(
      page.getByRole("region", { name: "Join and earn 45 points on this order" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "切换到中文" }).click();
    const panel = page.getByRole("region", { name: "加入会员，这单可以积 45 分" });
    await expect(panel).toContainText("只有扫码点的单才能积分和使用积分");
    await expect(panel).toContainText("手机号只用来发登录验证码");
    await page.goto("/member");
    await expect(page.getByRole("heading", { name: "640 分" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("过期");
    await expectNoInternalText(page);
  });
});
