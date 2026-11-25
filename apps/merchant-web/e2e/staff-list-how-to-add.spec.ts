import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// Batch 63 F55 (v15 design review RA-02): an Owner opening Staff to add a waiter saw only
// "You · Owner, Brand Owner · View and manage" — no way to add anyone and no word on why.
// Inviting waits on staff sign-in for the Store (an External Evidence gate), so the page now
// says plainly who adds staff meanwhile, with no link to a page that cannot do it. "View and
// manage" was a black underlined 18 px link; "Source as of" is the shared "Updated" stamp.
// Synthetic, TEST-only data.
const headers = { "cache-control": "no-store" };
const id = (n: number) => "0190b2f1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const owner = {
  actorReference: id(5),
  displayName: "TEST Owner",
  label: "TEST Owner",
  self: true,
  membershipStatus: "Active",
  storeAssignmentStatus: "Active",
  profileVersion: 1,
  invitation: null,
  assignments: [
    {
      assignmentReference: id(12),
      roleReference: id(11),
      roleName: "Owner",
      scope: "Store",
      since: "2026-11-01T12:00:00.000Z",
      mayRevoke: false,
      approvedAlone: false,
    },
  ],
  pending: [],
  mayRequest: true,
  mayRemove: false,
  mayRename: true,
};

async function staffPage(page: Page, mayInvite: boolean, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-25",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "IAM-USER-LIST",
              label: "Staff",
              href: "/app/organization/users",
              permission: "organization.staff.read",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "IAM-USER-LIST",
        sourceAsOf: "2026-11-25T06:52:00.000Z",
        otherStoresStaff: [],
        viewer: {
          mayManage: true,
          mayApprove: true,
          brandMayManage: true,
          brandMayApprove: true,
          mayInvite,
        },
        roles: [{ roleReference: id(11), code: "owner", name: "Owner", scope: "Store" }],
        staff: [owner],
      },
    }),
  );
  await page.goto("/app/organization/users");
}

for (const language of ["en", "zh-Hans"] as const) {
  test(`@production Staff says who adds staff while inviting is not on, and its link is a real target (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await staffPage(page, false, language);
    const line = page.getByText(
      zh
        ? "门店开通员工登录后，就能在这里添加新员工。在那之前，请联系 BOP 技术支持帮你添加。"
        : "Adding new staff opens when staff sign-in is switched on for your store. Until then, ask BOP support to add them.",
    );
    await expect(line).toBeVisible();
    // No link to a page that cannot add anyone.
    await expect(line.locator("a")).toHaveCount(0);
    await expect(page.getByText(zh ? "01:52 已更新" : "Updated 01:52")).toBeVisible();
    await expect(page.getByText(zh ? "数据截至" : "Source as of")).toHaveCount(0);
    const manage = page.getByRole("link", { name: zh ? "查看与管理" : "View and manage" });
    await expect(manage).toBeVisible();
    await expectNoInternalText(page);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const look = await page.evaluate(
        ([manageName]) => {
          const link = [...document.querySelectorAll("a")].find(
            (element) => element.textContent === manageName,
          ) as HTMLElement;
          const probe = document.createElement("span");
          probe.style.color = "var(--bop-color-accent)";
          document.body.append(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          const style = getComputedStyle(link);
          const note = document.querySelector(".staff-list__how-to-add") as HTMLElement;
          const noteStyle = getComputedStyle(note);
          return {
            linkHeight: link.getBoundingClientRect().height,
            linkColor: style.color,
            accent,
            underline: style.textDecorationLine,
            noteSize: noteStyle.fontSize,
            noteWeight: noteStyle.fontWeight,
            noteMuted: noteStyle.color !== getComputedStyle(document.body).color,
          };
        },
        [zh ? "查看与管理" : "View and manage"],
      );
      expect(look.linkHeight, JSON.stringify(look)).toBeGreaterThanOrEqual(44);
      expect(look.linkColor, JSON.stringify(look)).toBe(look.accent);
      expect(look.underline, JSON.stringify(look)).toBe("none");
      expect(look.noteSize).toBe("14px");
      expect(look.noteWeight).toBe("400");
      expect(look.noteMuted).toBe(true);
      await page.screenshot({
        path: `test-results/staff-how-to-add-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });
}

test("@production Staff drops the line once inviting is on", async ({ page }) => {
  await staffPage(page, true, "en");
  await expect(page.getByRole("link", { name: "View and manage" })).toBeVisible();
  await expect(page.getByText("ask BOP support to add them", { exact: false })).toHaveCount(0);
});
