import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 M07 DEC-SOLE-OPERATOR-APPROVAL (staff roles): a store run by one owner gives its new
// cashier a role. The owner asks for it and, with sole operator in effect, approves it on their
// own after confirming it is them; when sole operator is off, or someone else can approve staff
// roles, the page says why and who. A Store Manager who can approve roles (but not refunds) finds
// the waiting role on the Approvals page and in its badge. The routes model the BFF contract.
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const shots = "/tmp/sole-operator-staff-role-shots";
const id = (n: number) => "0190b2f1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const sam = id(5),
  change = id(9),
  roleReference = id(11);
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});
const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");

async function session(page: Page) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-06",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            nav("HOME-OVERVIEW", "Overview", "/app", "merchant.access"),
            nav("IAM-USER-LIST", "Staff", "/app/organization/users", "organization.staff.read"),
            nav("APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"),
          ],
        },
      },
    }),
  );
  const stepUps: string[] = [];
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    stepUps.push(route.request().postData() ?? "");
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date(at).toISOString(), validUntil },
    });
  });
  return stepUps;
}

type Gate = {
  status: "Effective" | "NotSet" | "OtherApprovers";
  otherApprovers: { displayName: string | null }[];
  verifiedUntil: string | null;
} | null;
const cashier = (state: { gate: Gate; approved: boolean }) => ({
  actorReference: sam,
  displayName: "Sam",
  label: "Sam",
  self: false,
  membershipStatus: "Active",
  storeAssignmentStatus: "Active",
  profileVersion: 1,
  invitation: null,
  assignments: state.approved
    ? [
        {
          assignmentReference: id(12),
          roleReference,
          roleName: "Front of House",
          scope: "Store",
          since: minutesFromNow(0),
          mayRevoke: true,
          approvedAlone: true,
        },
      ]
    : [],
  pending: state.approved
    ? []
    : [
        {
          changeReference: change,
          roleName: "Front of House",
          scope: "Store",
          requestedBy: "You",
          requestedAt: minutesFromNow(-2),
          mayDecide: false,
          mayWithdraw: true,
          highRiskPermissions: ["Approve or reject a Store role change"],
          soleOperator: state.gate,
        },
      ],
  mayRequest: true,
  mayRemove: true,
  mayRename: true,
});
const detail = (member: object) => ({
  screenId: "IAM-USER-DETAIL",
  sourceAsOf: minutesFromNow(0),
  otherStoresStaff: [],
  viewer: {
    mayManage: true,
    mayApprove: true,
    brandMayManage: true,
    brandMayApprove: true,
    mayInvite: true,
  },
  roles: [{ roleReference, code: "front_of_house", name: "Front of House", scope: "Store" }],
  staff: [member],
});
const body = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;
const noRoleRequests = (page: Page) =>
  page.route("**/merchant/organization/staff/role-requests", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: minutesFromNow(0), requests: [] },
    }),
  );

async function checkScreen(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
        message: `${name} fits ${width}px`,
      })
      .toBe(true);
    await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations.map((item) => `${item.id}: ${item.nodes[0]?.target}`)).toEqual([]);
  await expectNoInternalText(page);
}

test("@production a sole owner approves their new cashier's role on their own after confirming", async ({
  page,
}) => {
  const stepUps = await session(page);
  await noRoleRequests(page);
  const state = {
    gate: { status: "Effective", otherApprovers: [], verifiedUntil: null } as Gate,
    approved: false,
  };
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({ headers, json: detail(cashier(state)) }),
  );
  const commands: Record<string, unknown>[] = [];
  let refuse: { error: string; reason?: string } | null = { error: "NeedsReverification" };
  await page.route("**/merchant/organization/staff/command", (route) => {
    commands.push(body(route));
    if (refuse !== null) return route.fulfill({ status: 409, headers, json: refuse });
    state.approved = true;
    return route.fulfill({ headers, json: { status: "Applied", policyVersion: 7 } });
  });
  await page.goto("/app/organization/users/" + sam);
  const panel = page.locator(".staff-sole-operator");
  await expect(
    panel.getByText(
      "You asked for this role and you are the only person who holds staff role approval (sole operator), so you may approve it yourself. Check it first:",
    ),
  ).toBeVisible();
  await expect(panel.getByText("Sam · Front of House · This Store")).toBeVisible();
  await expect(
    panel.getByText("This role can: Approve or reject a Store role change"),
  ).toBeVisible();
  await expect(panel.getByText("It will be recorded as approved by you alone.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Withdraw request" })).toBeVisible();
  const approve = panel.getByRole("button", { name: "Approve on my own" });
  // Nothing happens by default: verify and tick first.
  await expect(approve).toBeDisabled();
  await panel.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(stepUps[0] ?? "{}").purpose).toBe("SoleOperatorApproval");
  await expect(approve).toBeDisabled();
  await panel.getByLabel("I checked this role and approve on my own").check();
  await checkScreen(page, "owner-effective");
  // The server finds the verification too old: the owner is told to verify again.
  await approve.click();
  await expect(
    page.getByText("Confirm it is you with your authenticator code, then try again."),
  ).toBeVisible();
  refuse = null;
  await approve.click();
  expect(commands.at(-1)).toEqual({ operation: "ApproveAlone", changeReference: change });
  const roles = page
    .locator("section.bop-state-card")
    .filter({ has: page.getByRole("heading", { name: "Roles", exact: true }) });
  await expect(roles.getByText("Front of House")).toBeVisible();
  await expect(roles.getByText(/approved alone \(sole operator\)/u)).toBeVisible();
  await expect(page.getByText("No pending change.")).toBeVisible();
  await checkScreen(page, "owner-approved");
});

test("@production when sole operator is off or someone else can approve, the page says why and who", async ({
  page,
}) => {
  await session(page);
  await noRoleRequests(page);
  const state = {
    gate: { status: "NotSet", otherApprovers: [], verifiedUntil: null } as Gate,
    approved: false,
  };
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({ headers, json: detail(cashier(state)) }),
  );
  await page.route("**/merchant/organization/staff/command", (route) =>
    route.fulfill({ headers, json: { status: "Applied", policyVersion: null } }),
  );
  await page.goto("/app/organization/users/" + sam);
  await expect(
    page.getByText(
      "You asked for this role, so someone else who holds staff role approval must approve it. Sole operator is off. If you run this business on your own, the brand owner can turn on Sole operator in Store setup.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve on my own" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();
  await expect(page.getByText("Assign role (takes effect once approved)")).toBeVisible();
  await checkScreen(page, "owner-off");

  state.gate = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Mia" }],
    verifiedUntil: null,
  };
  await page.reload();
  await expect(
    page.getByText(
      "Sole operator is on, but Mia also holds staff role approval, so they must approve this.",
    ),
  ).toBeVisible();
  // A Brand-level approver without a recorded name is never shown by a code.
  state.gate = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: null }],
    verifiedUntil: null,
  };
  await page.reload();
  await expect(
    page.getByText(
      "Sole operator is on, but another staff member also holds staff role approval, so they must approve this.",
    ),
  ).toBeVisible();
  await checkScreen(page, "owner-other-approvers");

  // The same page in Chinese.
  state.gate = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.reload();
  await expect(
    page.getByText(
      "你申请了这个角色，而你是唯一持有员工角色批准权限的人（独立经营者），因此可以自行批准。请先核对：",
    ),
  ).toBeVisible();
  await expect(page.getByText("此角色可以：批准或拒绝门店角色更改")).toBeVisible();
  await expect(page.getByRole("button", { name: "自行批准", exact: true })).toBeVisible();
  await expect(page.getByText("分配角色（批准后生效）")).toBeVisible();
  await checkScreen(page, "owner-effective-zh");
});

test("@production a Store Manager who approves roles finds the waiting role on Approvals and its badge", async ({
  page,
}) => {
  await session(page);
  // A Store Manager approves staff roles but not refunds.
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "forbidden" } }),
  );
  await page.route("**/merchant/organization/staff/role-requests", (route) => {
    expect(body(route)).toEqual({});
    return route.fulfill({
      headers,
      json: {
        screenId: "APPROVAL-INBOX",
        sourceAsOf: minutesFromNow(0),
        requests: [
          {
            actorReference: sam,
            person: "Sam",
            roleName: "Front of House",
            scope: "Store",
            requestedBy: "Ana",
            requestedAt: minutesFromNow(-2),
            action: "Decide",
          },
        ],
      },
    });
  });
  const member = {
    ...cashier({ gate: null, approved: false }),
    pending: [
      {
        changeReference: change,
        roleName: "Front of House",
        scope: "Store",
        requestedBy: "Ana",
        requestedAt: minutesFromNow(-2),
        mayDecide: true,
        mayWithdraw: false,
        highRiskPermissions: [],
        soleOperator: null,
      },
    ],
  };
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({ headers, json: detail(member) }),
  );
  await page.goto("/app/approvals");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals 1 waiting" })).toBeVisible();
  const section = page.locator("section.role-approvals");
  await expect(section.getByRole("heading", { name: "Staff roles waiting for you" })).toBeVisible();
  await expect(section.getByText(/Sam · Front of House · asked by Ana/u)).toBeVisible();
  // Refunds are not theirs to approve: no refusal panel instead of the roles.
  await expect(page.getByText("Refunds awaiting approval")).toHaveCount(0);
  await checkScreen(page, "manager-approvals");
  await section.getByRole("link", { name: "Open their page" }).click();
  await page.waitForURL("**/app/organization/users/" + sam);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
});

// WP-2423 M07 (v15 2026-11-06): the sole owner's own request waits for them on Approvals (the
// read lists it with "ApproveAlone" once nobody else can approve). If someone else gets staff
// role approval before the owner approves, the command answers 409 OtherApprovers and the page
// names them.
test("@production the sole owner finds their own role request on Approvals, in English and Chinese", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "forbidden" } }),
  );
  await page.route("**/merchant/organization/staff/role-requests", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "APPROVAL-INBOX",
        sourceAsOf: minutesFromNow(0),
        requests: [
          {
            actorReference: sam,
            person: "Sam",
            roleName: "Front of House",
            scope: "Store",
            requestedBy: "You",
            requestedAt: minutesFromNow(-2),
            action: "ApproveAlone",
          },
        ],
      },
    }),
  );
  const state = {
    gate: { status: "Effective", otherApprovers: [], verifiedUntil: null } as Gate,
    approved: false,
  };
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({ headers, json: detail(cashier(state)) }),
  );
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/organization/staff/command", (route) => {
    commands.push(body(route));
    // Mia was made a Store Manager meanwhile: the gate is read again for this request.
    state.gate = {
      status: "OtherApprovers",
      otherApprovers: [{ displayName: "Mia" }],
      verifiedUntil: null,
    };
    return route.fulfill({
      status: 409,
      headers,
      json: { error: "SoleOperatorNotInEffect", reason: "OtherApprovers" },
    });
  });
  await page.goto("/app/approvals");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals 1 waiting" })).toBeVisible();
  const section = page.locator("section.role-approvals");
  await expect(section.getByRole("heading", { name: "Staff roles waiting for you" })).toBeVisible();
  await expect(
    section.getByText(/Sam · Front of House · asked by you, you may approve it on your own/u),
  ).toBeVisible();
  await checkScreen(page, "owner-approvals");
  await section.getByRole("link", { name: "Open their page" }).click();
  await page.waitForURL("**/app/organization/users/" + sam);
  const panel = page.locator(".staff-sole-operator");
  const approve = panel.getByRole("button", { name: "Approve on my own" });
  await expect(approve).toBeDisabled();
  await panel.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await panel.getByLabel("I checked this role and approve on my own").check();
  await approve.click();
  expect(commands).toEqual([{ operation: "ApproveAlone", changeReference: change }]);
  await expect(
    page.getByText("Someone else can now approve staff roles here, so they must approve this."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sole operator is on, but Mia also holds staff role approval, so they must approve this.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve on my own" })).toHaveCount(0);
  await checkScreen(page, "owner-now-other-approver");

  // The Approvals row in Chinese.
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.goto("/app/approvals");
  await expect(
    page.locator("section.role-approvals").getByRole("heading", { name: "等待你批准的员工角色" }),
  ).toBeVisible();
  await expect(page.getByText(/由你申请，你可以自行批准/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "打开其页面" })).toBeVisible();
  await checkScreen(page, "owner-approvals-zh");
});
