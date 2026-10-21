import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: store staff sign in with their own account (work email,
 * password and authenticator app every time), managers invite staff by email, and a "confirm it is
 * you" step signs in again in a small window. The routes model the BFF contract; the managed
 * sign-in page itself is a stand-in.
 */
const csrf = "a".repeat(43);
const headers = { "cache-control": "no-store" };
const zone = "America/Toronto";
const shots = "/tmp/staff-cognito-shots";
const id = (n: number) => "0190b2e0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Queen St",
  storeReference: id(99),
  timeZone: zone,
};
const signInEntry = { path: "/operations/sign-in", testOnly: false };
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});
const navigation = [
  nav("HOME-OVERVIEW", "Overview", "/app", "merchant.access"),
  nav("IAM-USER-LIST", "Staff", "/app/organization/users", "organization.staff.read"),
  nav("APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"),
];
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");

type Target = Page | BrowserContext;

async function session(target: Target, signedIn: { value: boolean }) {
  await target.route("**/merchant/session", (route) =>
    signedIn.value
      ? route.fulfill({
          headers,
          json: {
            authenticated: true,
            csrf,
            workspace: {
              screenId: "HOME-OVERVIEW",
              selectedScope: scope,
              authorizedStores: [scope],
              businessDate: "2026-10-20",
              storeStatus: "Open",
              freshness: "Current",
              dashboardAvailability: "UnavailableUntilWP1905",
              navigation,
            },
          },
        })
      : route.fulfill({ status: 401, headers, json: { error: "session_required" } }),
  );
  await target.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: signInEntry }),
  );
  await target.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      },
    }),
  );
}

async function checkScreen(page: Page, name: string, widths = [1440, 1024, 390]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${name} fits ${width}px`,
    ).toBe(true);
    await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target}`),
  ).toEqual([]);
  await expectNoInternalText(page);
}

/** A page panel by its heading. */
const card = (page: Page, heading: string) =>
  page
    .locator("section.bop-state-card")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
    .first();

const json = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

test("@production staff sign in with their own account from the sign-in page", async ({ page }) => {
  const signedIn = { value: false };
  await session(page, signedIn);
  const logins: string[] = [];
  await page.route("**/merchant/login**", (route) => {
    logins.push(new URL(route.request().url()).search);
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Managed sign-in</title><h1>Managed sign-in</h1>",
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  const entry = page.getByRole("link", { name: "Sign in" });
  await expect(entry).toHaveAttribute("href", "/operations/sign-in");
  await entry.click();
  await page.waitForURL("**/operations/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Staff sign-in" })).toBeVisible();
  // Not a workspace page: no navigation, no "Sign in required" cover.
  await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByText("Sign in required")).toHaveCount(0);
  await expect(
    page.getByText("Use your work email, your password and the code from your authenticator app."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
    "href",
    "/merchant/login?returnTo=/app",
  );
  await expect(page.getByRole("link", { name: "Start kitchen display" })).toHaveAttribute(
    "href",
    "/merchant/login?returnTo=/operations/kitchen/start",
  );
  await expect(page.getByRole("link", { name: "Switch staff with a PIN" })).toHaveAttribute(
    "href",
    "/operations/switch-staff",
  );
  await expect(
    page.getByText(
      "Forgot your password or lost your phone? Ask the store owner or manager; they can contact BOP support to reset your sign-in.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await checkScreen(page, "sign-in");

  // The managed sign-in page, then back in the workspace with a Session.
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Managed sign-in" })).toBeVisible();
  expect(logins).toEqual(["?returnTo=/app"]);
  signedIn.value = true;
  await page.goto("/app");
  await expect(page.getByRole("navigation", { name: "Workspace" }).first()).toBeAttached();
  await expect(page.getByText("Sign in required")).toHaveCount(0);

  // The kitchen display sign-in comes back to the kitchen board.
  await page.goto("/operations/kitchen/start");
  await page.waitForURL((url) => url.pathname === "/operations/kitchen");

  // A refused sign-in comes back with plain guidance above the links.
  signedIn.value = false;
  await page.goto("/operations/sign-in?signIn=failed");
  await expect(page.getByRole("alert")).toHaveText(
    "We couldn't sign you in. If you were invited, sign in with the email address the invitation was sent to; an invitation expires 7 days after it was sent. If it keeps happening, ask your manager.",
  );
  await checkScreen(page, "sign-in-failed", [1440, 390]);

  // The sign-in service's own check (authenticator app required) did not pass: staff are told
  // that signing in is unavailable for now and who can keep working.
  await page.goto("/operations/sign-in?signIn=unavailable");
  await expect(page.getByRole("alert")).toHaveText(
    "Signing in isn't available right now. Staff who are already signed in can keep working, and a shared store tablet still switches staff with a PIN. Try again in a few minutes; if it keeps happening, tell your manager so they can contact BOP support.",
  );
  await checkScreen(page, "sign-in-unavailable", [1440, 390]);
});

test("@production signing out returns to the staff sign-in page", async ({ page }) => {
  const signedIn = { value: true };
  await session(page, signedIn);
  let logouts = 0;
  await page.route("**/merchant/logout", (route) => {
    logouts++;
    signedIn.value = false;
    return route.fulfill({ status: 204, headers });
  });
  await page.goto("/app");
  const footer = page.locator(".workspace-sidebar__footer");
  await footer.getByRole("button", { name: "Switch staff" }).click();
  await page.waitForURL("**/operations/sign-in");
  expect(logouts).toBe(1);
  await expect(page.getByRole("heading", { level: 1, name: "Staff sign-in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
});

function staffMember(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    actorReference: id(n),
    displayName: name,
    label: name,
    self: false,
    membershipStatus: "Active",
    storeAssignmentStatus: "Active",
    profileVersion: 1,
    assignments: [],
    pending: [],
    mayRequest: true,
    mayRename: true,
    mayRemove: true,
    ...extra,
  };
}
const role = { roleReference: id(50), code: "STORE_STAFF", name: "Counter staff", scope: "Store" };
const viewer = {
  mayManage: true,
  mayApprove: true,
  brandMayManage: false,
  brandMayApprove: false,
  mayInvite: true,
};

test("@production a manager invites a staff member by email; a name is required", async ({
  page,
}) => {
  await session(page, { value: true });
  const staff: Record<string, unknown>[] = [
    staffMember(1, "Mia Manager", { self: true, mayRemove: false, mayRequest: false }),
  ];
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/organization/staff/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "IAM-USER-LIST",
        sourceAsOf: new Date().toISOString().replace(/\.\d+Z$/u, ".000Z"),
        viewer,
        roles: [role],
        staff,
      },
    }),
  );
  await page.route("**/merchant/organization/staff/command", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const body = json(route);
    commands.push(body);
    if (body.email === "mia@example.com")
      return route.fulfill({ status: 409, headers, json: { error: "AlreadyInvited" } });
    staff.push(
      staffMember(2, String(body.displayName), {
        membershipStatus: "PendingActivation",
        pending: [
          {
            changeReference: id(60),
            roleName: "Counter staff",
            scope: "Store",
            requestedBy: "Mia Manager",
            requestedAt: new Date().toISOString().replace(/\.\d+Z$/u, ".000Z"),
            mayDecide: false,
            mayWithdraw: true,
          },
        ],
        invitation: {
          status: "Pending",
          delivery: "Sent",
          emailHint: "a•••@example.com",
          sentAt: new Date().toISOString().replace(/\.\d+Z$/u, ".000Z"),
          expiresAt: inDays(7),
          sendCount: 1,
          version: 1,
          mayResend: true,
          mayRevoke: true,
        },
      }),
    );
    return route.fulfill({
      headers,
      json: { status: "Invited", actorReference: id(2), delivery: "Sent" },
    });
  });

  await page.goto("/app/organization/users");
  const panel = card(page, "Invite a staff member");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Required — orders, refunds and records show who did what."),
  ).toBeVisible();
  await expect(panel.getByText("The role starts after another manager approves it.")).toBeVisible();
  const send = panel.getByRole("button", { name: "Send invitation" });
  await panel.getByLabel("Work email").fill("ana@example.com");
  await panel.getByLabel("Role").selectOption({ label: "Counter staff — this Store" });
  await expect(send).toBeDisabled();
  await panel.getByLabel("Name", { exact: true }).fill("   ");
  await expect(send).toBeDisabled();
  await checkScreen(page, "invite-panel");

  // An email with an open invitation already.
  await panel.getByLabel("Name", { exact: true }).fill("Ana Lopez");
  await panel.getByLabel("Work email").fill("mia@example.com");
  await send.click();
  await expect(page.getByText("This email already has an open invitation.")).toBeVisible();

  await panel.getByLabel("Work email").fill(" ana@example.com ");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    panel.getByText(
      "Invitation sent. They'll get an email with a temporary password; it expires in 7 days.",
    ),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  const sent = commands[1] ?? {};
  expect(Object.keys(sent).sort()).toEqual(
    ["displayName", "email", "operation", "operationReference", "roleReference"].sort(),
  );
  expect(sent).toMatchObject({
    operation: "Invite",
    displayName: "Ana Lopez",
    email: "ana@example.com",
    roleReference: id(50),
  });
  expect(String(sent.operationReference)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(sent.operationReference).not.toBe(commands[0]?.operationReference);
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("");
  const ana = card(page, "Ana Lopez");
  await expect(ana).toContainText("Invited · email sent");
  await expect(ana).toContainText("expires");
  await expect(page.locator("main")).not.toContainText("PendingActivation");
  await checkScreen(page, "invite-sent", [1440, 390]);
});

test("@production a manager resends and cancels an invitation", async ({ page }) => {
  await session(page, { value: true });
  const invited = staffMember(2, "Ana Lopez", {
    membershipStatus: "PendingActivation",
    pending: [
      {
        changeReference: id(60),
        roleName: "Counter staff",
        scope: "Store",
        requestedBy: "Mia Manager",
        requestedAt: "2026-10-13T14:00:00.000Z",
        mayDecide: false,
        mayWithdraw: false,
      },
    ],
    invitation: {
      status: "Expired",
      delivery: "Sent",
      emailHint: "a•••@example.com",
      sentAt: "2026-10-13T14:00:00.000Z",
      expiresAt: "2026-10-20T14:00:00.000Z",
      sendCount: 1,
      version: 4,
      mayResend: true,
      mayRevoke: true,
    },
  });
  let present = true;
  await page.route("**/merchant/organization/staff/query", (route) => {
    const detail = json(route).actorReference !== null;
    return route.fulfill({
      headers,
      json: {
        screenId: detail ? "IAM-USER-DETAIL" : "IAM-USER-LIST",
        sourceAsOf: "2026-10-20T15:00:00.000Z",
        viewer,
        roles: [role],
        staff: detail ? [invited] : present ? [invited] : [],
      },
    });
  });
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/organization/staff/command", (route) => {
    const body = json(route);
    commands.push(body);
    if (body.operation === "RevokeInvitation") {
      present = false;
      return route.fulfill({ headers, json: { status: "Applied", accountRemoved: true } });
    }
    if (body.email === undefined)
      return route.fulfill({
        headers,
        json: { status: "Resent", delivery: "Unknown", emailNeeded: true },
      });
    if (body.email !== "ana@example.com")
      return route.fulfill({ status: 409, headers, json: { error: "EmailMismatch" } });
    return route.fulfill({
      headers,
      json: { status: "Resent", delivery: "Sent", emailNeeded: false },
    });
  });

  await page.goto(`/app/organization/users/${id(2)}`);
  const panel = card(page, "Invitation");
  await expect(panel).toContainText("Invitation expired · sent to a•••@example.com");
  await expect(page.getByText("Membership Invited (not signed in yet)")).toBeVisible();
  await expect(
    page.getByText(
      "Starts after Ana Lopez accepts the invitation and another manager approves it.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Waiting for another administrator.")).toHaveCount(0);
  await checkScreen(page, "invitation-detail");

  await panel.getByRole("button", { name: "Resend invitation" }).click();
  const again = panel.getByLabel("Enter their work email again to send a new invitation");
  await expect(again).toBeVisible();
  await again.fill("ana.lopez@example.com");
  await panel.getByRole("button", { name: "Resend invitation" }).click();
  await expect(
    page.getByText(
      "That's not the email this invitation was sent to. Cancel this invitation and invite again with the new address.",
    ),
  ).toBeVisible();
  await again.fill("ana@example.com");
  await panel.getByRole("button", { name: "Resend invitation" }).click();
  await expect(
    panel.getByText(
      "Invitation sent again. They'll get a new temporary password; it expires in 7 days.",
    ),
  ).toBeVisible();
  expect(commands.map((command) => [command.operation, command.email])).toEqual([
    ["ResendInvitation", undefined],
    ["ResendInvitation", "ana.lopez@example.com"],
    ["ResendInvitation", "ana@example.com"],
  ]);
  expect(commands.every((command) => command.expectedVersion === 4)).toBe(true);
  expect(commands.every((command) => command.actorReference === id(2))).toBe(true);
  await checkScreen(page, "invitation-resent", [1440, 390]);

  await panel.getByRole("button", { name: "Cancel invitation" }).click();
  await panel.getByRole("button", { name: "Confirm: cancel the invitation for Ana Lopez" }).click();
  await page.waitForURL((url) => url.pathname === "/app/organization/users");
  expect(commands.at(-1)).toMatchObject({
    operation: "RevokeInvitation",
    actorReference: id(2),
    expectedVersion: 4,
  });
  await expect(page.getByText("No member is assigned to this Store.")).toBeVisible();
});

test("@production approving a refund confirms it is the owner by signing in again", async ({
  page,
}) => {
  const context = page.context();
  await session(context, { value: true });
  const now = Date.now();
  const entry = {
    orderReference: id(1),
    orderNumber: "A-0042",
    requestReference: id(2),
    paymentIntentReferences: [id(3)],
    paymentMethod: "Online",
    currencyCode: "CAD",
    amountMinor: "12500",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    requestedAt: new Date(now - 60_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: new Date(now + 14 * 60_000).toISOString(),
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: true,
    soleOperatorApproval: false,
  };
  await context.route("**/merchant/organization/sole-operator", (route) =>
    route.fulfill({ headers, json: { brandOwner: false } }),
  );
  await context.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date(now).toISOString(),
        canApprove: true,
        soleOperator: null,
        entries: [entry],
      },
    }),
  );
  let validUntil: string | null = null;
  const codes: string[] = [];
  await context.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() !== "GET") {
      codes.push(route.request().postData() ?? "");
      return route.fulfill({ status: 409, headers, json: { error: "step_up_method" } });
    }
    return route.fulfill({ headers, json: { validUntil, method: "SignIn" } });
  });
  const starts: URL[] = [];
  await context.route("**/merchant/identity/step-up/start**", (route) => {
    const url = new URL(route.request().url());
    starts.push(url);
    validUntil = minutesFromNow(15);
    return route.fulfill({
      status: 303,
      headers: {
        location:
          "/app/identity/step-up-complete?result=verified&returnTo=" +
          encodeURIComponent(url.searchParams.get("returnTo") ?? "/app"),
      },
    });
  });

  await page.goto("/app/approvals");
  const card = page.getByRole("listitem").filter({ hasText: "Order A-0042" });
  await card.getByRole("button", { name: "Verify to approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toContainText(
    "Confirm it is you by signing in again with your password and authenticator app. After you verify, approvals and refunds can go ahead for 15 minutes.",
  );
  await expect(dialog.getByLabel("Six-digit code")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/step-up-sign-in-1440.png` });
  const popupOpened = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Continue to sign in" }).click();
  const popup = await popupOpened;
  // The window tells this page how it went and closes itself.
  await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true);
  expect(starts).toHaveLength(1);
  expect(starts[0]?.pathname).toBe("/merchant/identity/step-up/start");
  expect(starts[0]?.searchParams.get("purpose")).toBe("RefundApproval");
  expect(starts[0]?.searchParams.get("returnTo")).toBe("/app/approvals");
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("Verified until");
  await expect(card.getByRole("button", { name: "Approve and refund $125.00" })).toBeEnabled();
  expect(codes).toEqual([]);
});

test("@production the end of the sign-in window, opened on its own, goes back", async ({
  page,
}) => {
  await session(page, { value: true });
  await page.goto(
    "/app/identity/step-up-complete?result=failed&returnTo=" + encodeURIComponent("/app/approvals"),
  );
  await expect(page.getByRole("alert")).toHaveText("We couldn't confirm it's you.");
  await expect(page.getByRole("link", { name: "Go back" })).toHaveAttribute(
    "href",
    "/app/approvals",
  );
  await checkScreen(page, "step-up-failed", [1440, 390]);
  await page.goto(
    "/app/identity/step-up-complete?result=unavailable&returnTo=" +
      encodeURIComponent("/app/approvals"),
  );
  await expect(page.getByRole("alert")).toHaveText(
    "Signing in again isn't available right now, so nothing was changed. Try again in a few minutes; if it keeps happening, tell your manager.",
  );
  await page.goto(
    "/app/identity/step-up-complete?result=cancelled&returnTo=" +
      encodeURIComponent("//evil.example/x"),
  );
  await page.waitForURL((url) => url.pathname === "/app");
});

test("@production a PIN sign-in confirms it is you by signing in again, without a code field", async ({
  page,
}) => {
  await session(page, { value: true });
  // A PIN sign-in on a shared tablet; this Store confirms by signing in again (Cognito).
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Pin",
        verifiedUntil: null,
      },
    }),
  );
  await page.route("**/merchant/identity/step-up", (route) =>
    route.fulfill({ headers, json: { validUntil: null, method: "SignIn" } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  const footer = page.locator(".workspace-sidebar__footer");
  await footer.getByRole("button", { name: "Verify it's you" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toContainText(
    "Confirm it is you by signing in again with your password and authenticator app. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.",
  );
  await expect(dialog).not.toContainText("six-digit");
  await expect(dialog.getByLabel("Six-digit code")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Continue to sign in" })).toBeVisible();
});
