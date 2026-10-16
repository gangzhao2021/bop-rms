import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 (Owner-approved design "A"): device-bound six-digit staff PINs. A manager sets up the
 * shared tablet and manages tablets and PINs; staff set their own PIN; on the tablet staff switch
 * to themselves with the keypad; wrong PINs lock; a PIN sign-in needs the authenticator code or a
 * full sign-in for sensitive changes. The routes model the Identity HTTP contract.
 */
const csrf = "a".repeat(43);
const headers = { "cache-control": "no-store" };
const zone = "America/Toronto";
const shots = "/tmp/staff-pin-shots";
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Queen St",
  storeReference: "0190b2e0-0000-7000-8000-000000000099",
  timeZone: zone,
};
const testEntry = { path: "/internal-test/staff", testOnly: true };
const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
const clock = (instant: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(
    new Date(instant),
  );
const navigation = [
  { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
  {
    screenId: "OPS-ORDER-QUEUE",
    label: "Orders",
    href: "/operations/orders",
    permission: "ordering.operate",
  },
  {
    screenId: "IAM-SESSION-LIST",
    label: "Shared tablets & PINs",
    href: "/app/organization/sessions",
    permission: "identity.store_device.manage",
  },
];

async function signedIn(
  page: Page,
  signedInNow: { value: boolean } = { value: true },
  links: readonly (typeof navigation)[number][] = navigation,
) {
  await page.route("**/merchant/session", (route) =>
    signedInNow.value
      ? route.fulfill({
          headers,
          json: {
            authenticated: true,
            csrf,
            workspace: {
              screenId: "HOME-OVERVIEW",
              selectedScope: scope,
              authorizedStores: [scope],
              businessDate: "2026-10-14",
              storeStatus: "Open",
              freshness: "Current",
              dashboardAvailability: "UnavailableUntilWP1905",
              navigation: links,
            },
          },
        })
      : route.fulfill({ status: 401, headers, json: { error: "session_required" } }),
  );
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: testEntry }),
  );
  await page.route("**/internal-test/staff", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Staff sign-in</title><h1>Staff sign-in</h1>",
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

const json = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

test("@production a manager sets up this tablet, removes an old one and resets a PIN", async ({
  page,
}) => {
  await signedIn(page);
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      },
    }),
  );
  const lockedUntil = minutesFromNow(12);
  const server = {
    thisDevice: null as null | { device: string; label: string },
    devices: [
      {
        device: "dev-old",
        label: "Back office tablet",
        registeredAt: "2026-09-02T14:00:00.000Z",
        registeredBy: "Mia Manager",
        lastUsedAt: "2026-10-13T21:10:00.000Z" as string | null,
      },
    ],
    staffPins: [
      {
        staff: "staff-ana",
        name: "Ana Lopez",
        state: "Set",
        changedAt: "2026-10-01T15:00:00.000Z",
        lockedUntil: null as string | null,
      },
      { staff: "staff-ben", name: "Ben Ito", state: "NotSet", changedAt: null, lockedUntil: null },
      {
        staff: "staff-cy",
        name: "Cy Park",
        state: "Set",
        changedAt: "2026-10-02T15:00:00.000Z",
        lockedUntil,
      },
    ],
  };
  const commands: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/merchant/store-devices", (route) =>
    route.fulfill({ headers, json: server }),
  );
  await page.route("**/merchant/store-devices/register", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const body = json(route);
    commands.push({ path: "register", body });
    const device = {
      device: "dev-new",
      label: String(body.label),
      registeredAt: new Date().toISOString(),
      registeredBy: "Mia Manager",
      lastUsedAt: null,
    };
    server.thisDevice = { device: device.device, label: device.label };
    server.devices = [...server.devices, device];
    return route.fulfill({ status: 201, headers, json: { device } });
  });
  await page.route("**/merchant/store-devices/revoke", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const body = json(route);
    commands.push({ path: "revoke", body });
    server.devices = server.devices.filter((device) => device.device !== body.device);
    return route.fulfill({ headers, json: { revoked: true, signedOut: 1 } });
  });
  await page.route("**/merchant/staff-pins/reset", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const body = json(route);
    commands.push({ path: "reset", body });
    const pin = { state: "Reset", changedAt: new Date().toISOString(), lockedUntil: null };
    server.staffPins = server.staffPins.map((row) =>
      row.staff === body.staff ? { ...row, ...pin } : row,
    );
    return route.fulfill({ headers, json: { pin } });
  });

  await page.goto("/app/organization/sessions");
  await expect(
    page.getByRole("heading", { level: 1, name: "Shared tablets & PINs" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Shared tablets & PINs" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "This tablet" })).toBeVisible();
  await expect(page.getByText("Staff can then switch to themselves here")).toBeVisible();
  await expect(page.getByRole("row", { name: /Back office tablet/u })).toContainText("Mia Manager");
  await expect(page.getByRole("row", { name: /Cy Park/u })).toContainText(
    `Locked until ${clock(lockedUntil)}`,
  );
  await expect(page.getByRole("row", { name: /Ben Ito/u })).toContainText("No PIN");
  await expect(
    page.getByRole("row", { name: /Ben Ito/u }).getByRole("button", { name: /Reset/u }),
  ).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("dev-old");
  await expect(page.locator("main")).not.toContainText("staff-ana");
  await checkScreen(page, "tablets-page");

  // Set up this tablet.
  await page.getByLabel("Tablet name").fill("  Front counter ");
  await page.getByRole("button", { name: "Set up this tablet for staff PINs" }).click();
  await expect(page.getByText("This tablet is set up as “Front counter”.").first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Front counter \(this tablet\)/u })).toBeVisible();
  expect(commands[0]).toEqual({ path: "register", body: { label: "Front counter" } });

  // Remove the old tablet, after confirming what happens.
  await page.getByRole("button", { name: "Remove Back office tablet" }).click();
  const remove = page.getByRole("dialog", { name: "Remove Back office tablet?" });
  await expect(remove).toContainText(
    "Anyone signed in on it with a PIN is signed out, and it will need to be set up again.",
  );
  await page.screenshot({ path: `${shots}/tablets-remove-confirm-1440.png` });
  await remove.getByRole("button", { name: "Remove tablet" }).click();
  await expect(
    page.getByText("Back office tablet is removed. 1 person was signed out."),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Back office tablet/u })).toHaveCount(0);
  expect(commands[1]).toEqual({ path: "revoke", body: { device: "dev-old" } });

  // Reset a PIN.
  await page.getByRole("button", { name: "Reset Ana Lopez's PIN" }).click();
  const reset = page.getByRole("dialog", { name: "Reset Ana Lopez's PIN?" });
  await expect(reset).toContainText(
    "They sign in with their account and set a new one. This also unlocks a locked PIN and signs them out of PIN sign-ins.",
  );
  await reset.getByRole("button", { name: "Reset PIN" }).click();
  await expect(
    page.getByText("Ana Lopez's PIN is reset. They sign in with their account and set a new one."),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Ana Lopez/u })).toContainText(
    "Reset — waiting for a new PIN",
  );
  expect(commands[2]).toEqual({ path: "reset", body: { staff: "staff-ana" } });
  await checkScreen(page, "tablets-page-after", [1440, 390]);
});

test("@production staff set their own PIN: mismatch, too easy, then saved", async ({ page }) => {
  await signedIn(page);
  let pin = { state: "NotSet", changedAt: null as string | null, lockedUntil: null };
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/staff-pin", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        headers,
        json: { pin, signIn: "Account", verifiedUntil: null },
      });
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const body = json(route);
    sent.push(body);
    if (body.pin === "112233")
      return route.fulfill({
        status: 422,
        headers,
        json: { error: "pin_invalid", reason: "TooSimple" },
      });
    pin = { state: "Set", changedAt: new Date().toISOString(), lockedUntil: null };
    return route.fulfill({ headers, json: { pin } });
  });
  await page.goto("/app");
  const footer = page.locator(".workspace-sidebar__footer");
  await expect(footer.getByRole("button", { name: "Set your PIN" })).toBeVisible();
  await footer.getByRole("button", { name: "My PIN" }).click();
  const dialog = page.getByRole("dialog", { name: "My PIN" });
  await expect(dialog).toContainText("Set a PIN to switch quickly on this store's shared tablets.");
  await expect(dialog).toContainText("6 digits. Avoid easy PINs like 000000 or 123456.");
  await checkScreen(page, "my-pin-dialog", [1440]);

  await dialog.getByLabel("New PIN").fill("482913");
  await dialog.getByLabel("Enter it again").fill("482914");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The two PINs don't match.");
  await dialog.getByLabel("New PIN").fill("123456");
  await dialog.getByLabel("Enter it again").fill("123456");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That PIN is too easy to guess. Choose a different one.",
  );
  expect(sent).toEqual([]);
  // The server is authoritative on easy PINs too.
  await dialog.getByLabel("New PIN").fill("112233");
  await dialog.getByLabel("Enter it again").fill("112233");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That PIN is too easy to guess. Choose a different one.",
  );
  await expect(dialog.getByLabel("New PIN")).toHaveValue("");
  // Letters are never accepted.
  await dialog.getByLabel("New PIN").fill("48a291");
  await expect(dialog.getByLabel("New PIN")).toHaveValue("48291");
  await dialog.getByLabel("New PIN").fill("482913");
  await dialog.getByLabel("Enter it again").fill("482913");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Your PIN is saved. Use it on this store's shared tablets.",
  );
  expect(sent).toEqual([
    { pin: "112233", confirmation: "112233" },
    { pin: "482913", confirmation: "482913" },
  ]);
  await expect(dialog.getByRole("status")).toContainText("PIN set on ");
  await expect(dialog.getByLabel("New PIN")).toHaveValue("");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(footer.getByRole("button", { name: "Set your PIN" })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");

  // On a phone the controls sit in the Menu.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".workspace-sidebar__compact > summary").click();
  const compact = page.locator(".workspace-sidebar__compact");
  await compact.getByRole("button", { name: "My PIN" }).click();
  await expect(page.getByRole("dialog", { name: "My PIN" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `${shots}/my-pin-dialog-390.png` });
});

test("@production staff switch on a shared tablet: wrong PIN, lockout, busy tablet, then signed in", async ({
  page,
}) => {
  const session = { value: false };
  await signedIn(page, session);
  const lockedUntil = minutesFromNow(15);
  const attempts: Record<string, unknown>[] = [];
  let anaWrong = 0;
  await page.route("**/merchant/staff-switch", (route) =>
    route.fulfill({
      headers,
      json: {
        storeLabel: "Queen St",
        timeZone: zone,
        staff: [
          { choice: "ch-ana", name: "Ana Lopez" },
          { choice: "ch-ben", name: "Ben Ito" },
          { choice: "ch-cy", name: "Cy Park" },
        ],
        fullSignIn: testEntry,
      },
    }),
  );
  await page.route("**/merchant/staff-switch/unlock", (route) => {
    const body = json(route);
    attempts.push(body);
    expect(route.request().headers()["x-bop-csrf"]).toBeUndefined();
    if (body.choice === "ch-cy")
      return route.fulfill({
        status: 429,
        headers,
        json: { error: "device_busy", retryAfterSeconds: 90 },
      });
    if (body.choice === "ch-ben" && body.pin === "482913") {
      session.value = true;
      return route.fulfill({ headers, json: { status: "SignedIn", next: "/operations/orders" } });
    }
    if (body.choice === "ch-ana" && ++anaWrong >= 5)
      return route.fulfill({ status: 423, headers, json: { error: "pin_locked", lockedUntil } });
    return route.fulfill({ status: 401, headers, json: { error: "pin_rejected" } });
  });

  await page.goto("/operations/switch-staff");
  await expect(
    page.getByRole("heading", { level: 1, name: "Switch staff · Queen St" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
  await expect(
    page.getByText("Not on the list? Sign in with your account and choose “My PIN” to set one."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with your account" })).toHaveAttribute(
    "href",
    "/internal-test/staff",
  );
  await expect(page.locator("main")).not.toContainText("ch-ana");
  await checkScreen(page, "switch-picker");

  // Ana: wrong PIN with the on-screen keypad.
  await page.getByRole("button", { name: "Ana Lopez" }).click();
  await expect(page.getByRole("heading", { name: "Enter Ana Lopez's PIN" })).toBeVisible();
  for (const digit of ["1", "1", "1"])
    await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByText("3 of 6 digits entered")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("2 of 6 digits entered")).toBeVisible();
  await checkScreen(page, "switch-keypad");
  for (const digit of ["1", "1", "1", "1"])
    await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That PIN didn't match. Try again. After 5 wrong tries the PIN locks for 15 minutes.",
  );
  await expect(page.getByText("0 of 6 digits entered")).toBeVisible();
  expect(attempts.at(-1)).toEqual({ choice: "ch-ana", pin: "111111" });
  expect(await page.locator("body").innerText()).not.toContain("111111");

  // Physical keyboard: four more wrong PINs lock Ana's PIN.
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect(page.getByText("0 of 6 digits entered")).toBeVisible();
    await page.keyboard.type("222222");
    await expect.poll(() => attempts.length).toBe(attempt + 2);
  }
  await expect(page.getByRole("alert")).toHaveText(
    `Too many wrong PINs. Ana Lopez's PIN is locked until ${clock(lockedUntil)}. Ask a manager to reset it, or sign in with your account.`,
  );
  await expect(page.getByRole("button", { name: "5", exact: true })).toBeDisabled();
  await checkScreen(page, "switch-locked", [1440, 390]);

  // Cy: the tablet itself is busy.
  await page.getByRole("button", { name: "Not Ana Lopez? Choose someone else" }).click();
  await page.getByRole("button", { name: "Cy Park" }).click();
  await page.keyboard.type("135790");
  await expect(page.getByRole("alert")).toHaveText(
    "Too many tries on this tablet. Wait 2 minutes, or sign in with your account.",
  );

  // Ben: the right PIN signs him in and opens Orders.
  await page.getByRole("button", { name: "Not Cy Park? Choose someone else" }).click();
  await page.getByRole("button", { name: "Ben Ito" }).click();
  await page.keyboard.type("482913");
  await page.waitForURL("**/operations/orders");
  expect(attempts.at(-1)).toEqual({ choice: "ch-ben", pin: "482913" });
  expect(page.url()).not.toContain("482913");
});

test("@production a person who left the list since it was shown: the tablet reads it again", async ({
  page,
}) => {
  await signedIn(page, { value: false });
  // The lock screen names people by opaque tablet tokens, never by account references.
  const ana = "A".repeat(43),
    dee = "D".repeat(43);
  let reads = 0;
  await page.route("**/merchant/staff-switch", (route) => {
    reads++;
    return route.fulfill({
      headers,
      json: {
        storeLabel: "Queen St",
        timeZone: zone,
        staff:
          reads === 1
            ? [
                { choice: ana, name: "Ana Lopez" },
                { choice: dee, name: "Dee Moss" },
              ]
            : [{ choice: ana, name: "Ana Lopez" }],
        fullSignIn: testEntry,
      },
    });
  });
  const attempts: Record<string, unknown>[] = [];
  await page.route("**/merchant/staff-switch/unlock", (route) => {
    attempts.push(json(route));
    return route.fulfill({ status: 409, headers, json: { error: "staff_not_listed" } });
  });
  await page.goto("/operations/switch-staff");
  await page.getByRole("button", { name: "Dee Moss" }).click();
  await page.keyboard.type("482913");
  await expect(page.getByRole("heading", { name: "Who's working?" })).toBeVisible();
  await expect(page.getByText("The staff list has changed. Choose your name again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dee Moss" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ana Lopez" })).toBeVisible();
  expect(attempts).toEqual([{ choice: dee, pin: "482913" }]);
  await expect(page.locator("main")).not.toContainText(dee);
  // Choosing again clears the notice.
  await page.getByRole("button", { name: "Ana Lopez" }).click();
  await expect(page.getByText("The staff list has changed.")).toHaveCount(0);
});

test("@production a tablet that is not set up, or offline, says what to do", async ({ page }) => {
  await signedIn(page, { value: false });
  let mode: "offline" | "unregistered" | "empty" = "offline";
  await page.route("**/merchant/staff-switch", (route) =>
    mode === "offline"
      ? route.abort("internetdisconnected")
      : mode === "unregistered"
        ? route.fulfill({
            status: 404,
            headers,
            json: { error: "device_not_registered", fullSignIn: testEntry },
          })
        : route.fulfill({
            headers,
            json: { storeLabel: "Queen St", timeZone: zone, staff: [], fullSignIn: testEntry },
          }),
  );
  await page.goto("/operations/switch-staff");
  await expect(page.getByRole("heading", { name: "No connection" })).toBeVisible();
  await expect(page.getByText(/PINs need the connection/u)).toBeVisible();
  await checkScreen(page, "switch-offline", [1440, 390]);
  mode = "unregistered";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "This tablet isn't set up for staff PINs" }),
  ).toBeVisible();
  await expect(
    page.getByText("A manager can set it up under “Shared tablets & PINs” after signing in."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with your account" })).toBeVisible();
  await checkScreen(page, "switch-unregistered", [1440, 390]);
  mode = "empty";
  await page.reload();
  await expect(page.getByText("No one has set a PIN for this store yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with your account" })).toBeVisible();
});

test("@production a PIN sign-in needs the authenticator code for PIN and tablet changes", async ({
  page,
}) => {
  await signedIn(page);
  let verifiedUntil: string | null = null;
  const stepUps: Record<string, unknown>[] = [];
  await page.route("**/merchant/staff-pin", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        headers,
        json: {
          pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
          signIn: "Pin",
          verifiedUntil,
        },
      });
    if (verifiedUntil === null)
      return route.fulfill({ status: 403, headers, json: { error: "full_sign_in_required" } });
    return route.fulfill({
      headers,
      json: { pin: { state: "Set", changedAt: new Date().toISOString(), lockedUntil: null } },
    });
  });
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: verifiedUntil } });
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    stepUps.push(json(route));
    verifiedUntil = minutesFromNow(15);
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date().toISOString(), validUntil: verifiedUntil },
    });
  });
  await page.route("**/merchant/store-devices", (route) =>
    route.fulfill({
      headers,
      json: { thisDevice: null, devices: [], staffPins: null },
    }),
  );
  await page.route("**/merchant/store-devices/register", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "full_sign_in_required" } }),
  );

  await page.goto("/app");
  const footer = page.locator(".workspace-sidebar__footer");
  const notice = footer.getByRole("region", { name: "PIN sign-in" });
  await expect(notice).toContainText(
    "Signed in with PIN. Refunds, price changes and staff changes need your authenticator code or a full sign-in.",
  );
  await checkScreen(page, "pin-session-notice", [1440]);

  // Changing the PIN is refused until the person verifies.
  await footer.getByRole("button", { name: "My PIN" }).click();
  const dialog = page.getByRole("dialog", { name: "My PIN" });
  await dialog.getByLabel("New PIN").fill("482913");
  await dialog.getByLabel("Enter it again").fill("482913");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert").first()).toContainText(
    "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to change your PIN.",
  );
  await dialog.getByRole("button", { name: "Verify it's you" }).click();
  const code = page.getByRole("dialog", { name: "Confirm it is you" }).last();
  await code.getByLabel("Six-digit code").fill("123456");
  await code.getByRole("button", { name: "Verify" }).click();
  expect(stepUps).toEqual([{ purpose: "PinSessionElevation", code: "123456" }]);
  // Wait until the verification is shown before typing again (the page re-renders on it).
  await expect(notice.getByText(/Verified until/u)).toBeVisible();
  await dialog.getByLabel("New PIN").fill("482913");
  await dialog.getByLabel("Enter it again").fill("482913");
  await expect(dialog.getByLabel("New PIN")).toHaveValue("482913");
  await expect(dialog.getByLabel("Enter it again")).toHaveValue("482913");
  await dialog.getByRole("button", { name: "Save PIN" }).click();
  await expect(dialog.getByRole("alert").last()).toHaveText(
    "Your PIN is saved. Use it on this store's shared tablets.",
  );
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(notice).toContainText("Verified until");

  // A tablet change refused for a PIN sign-in explains the way forward on the page.
  await page.getByRole("link", { name: "Shared tablets & PINs" }).first().click();
  await page.getByLabel("Tablet name").fill("Front counter");
  await page.getByRole("button", { name: "Set up this tablet for staff PINs" }).click();
  await expect(page.getByRole("region", { name: "Confirm it's you" })).toContainText(
    "Confirm it's you with your authenticator app, or sign in with your account",
  );
  await expect(page.getByRole("heading", { name: "Staff PINs" })).toHaveCount(0);
  // The guidance is shown once, in the verification section only.
  await expect(page.getByText(/You signed in with a PIN\. Confirm it's you/u)).toHaveCount(1);
  // WP-2423 item 7: one label for the step ("Verify it's you", as in the sidebar) and the
  // authenticator hint is not repeated under the guidance that already says it.
  await expect(
    page
      .getByRole("region", { name: "Confirm it's you" })
      .getByRole("button", { name: "Verify it's you" }),
  ).toBeVisible();
  await expect(
    page.getByText("Confirm it is you with the code from your authenticator app."),
  ).toHaveCount(0);
  await expect(page.getByText("Not done")).toHaveCount(0);
  await checkScreen(page, "tablets-full-sign-in", [1440, 390]);
});

test("@production a price change on a PIN sign-in asks to confirm it's you, not for permission", async ({
  page,
}) => {
  await signedIn(page, { value: true }, [
    ...navigation,
    {
      screenId: "PRICE-BOOK-LIST",
      label: "Prices",
      href: "/app/commerce/pricing",
      permission: "pricing.price_book.read",
    },
  ]);
  let verifiedUntil: string | null = null;
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Pin",
        verifiedUntil,
      },
    }),
  );
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: verifiedUntil } });
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    expect(json(route)).toEqual({ purpose: "PinSessionElevation", code: "123456" });
    verifiedUntil = minutesFromNow(15);
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date().toISOString(), validUntil: verifiedUntil },
    });
  });
  await page.route("**/merchant/commerce/pricing/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PRICE-BOOK-LIST",
        sourceAsOf: "2026-10-14T18:00:00.000Z",
        viewer: "staff-ana",
        permissions: { mayRead: true, mayEdit: true, mayApprove: true },
        currencyCode: "CAD",
        storeAssignment: null,
        assignmentHistory: [],
        sellables: [],
        menuSellables: [],
        books: [],
      },
    }),
  );
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/pricing/command", (route) => {
    commands.push(json(route));
    return verifiedUntil === null
      ? route.fulfill({ status: 403, headers, json: { error: "full_sign_in_required" } })
      : route.fulfill({ headers, json: {} });
  });

  await page.goto("/app/commerce/pricing");
  await page.getByRole("button", { name: "Create draft" }).click();
  const prompt = page.getByRole("region", { name: "Confirm it's you" });
  await expect(prompt).toContainText(
    "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to do this.",
  );
  await expect(
    prompt.getByRole("button", { name: "Sign out and sign in with your account" }),
  ).toBeVisible();
  await expect(page.getByText(/permission/u)).toHaveCount(0);
  await expect(page.getByText("Not created")).toHaveCount(0);
  await checkScreen(page, "prices-full-sign-in", [1440, 390]);

  await prompt.getByRole("button", { name: "Verify it's you" }).click();
  const code = prompt.getByRole("dialog", { name: "Confirm it is you" });
  await code.getByLabel("Six-digit code").fill("123456");
  await code.getByRole("button", { name: "Verify" }).click();
  await expect(prompt).toContainText("Verified. Try again now.");
  // The same request is sent again, so it cannot be done twice.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(prompt).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
});
