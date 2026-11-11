import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { serveStoreSetupPanels } from "./store-setup-panels";

// WP-2423 store-type starter roles (Owner 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
// 对预设进行增删改", DEC-STORE-TYPE-STARTER-ROLES): a one-owner tea shop picks its kind of shop on
// Roles, reads what the set adds, keeps and removes (Front of House stays, Sam holds it), starts
// from it, approves the two new roles alone and turns them on; Store setup offers the same and then
// links to Roles; an outage reads as one, never as no access. The routes model the BFF contract;
// every screen is checked at 1440/1024/390, with axe and for internal text, in English and Chinese.
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const shots = "/tmp/starter-role-sets-shots";
const id = (n: number) => "0190b2f9-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const storeReference = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference,
  timeZone: "America/Toronto",
};
const [foh, kitchen, manager, counter, maker] = [11, 12, 13, 14, 15].map(id) as [
  string,
  string,
  string,
  string,
  string,
];
const now = () => new Date().toISOString().replace(/\.\d+Z$/u, ".000Z");
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});
const catalog = [
  ["merchant.access", "Signing in to the back office", "Use the merchant back office"],
  ["ordering.order.read", "Orders and bills", "View orders"],
].map(([action, group, description]) => ({
  action,
  group,
  description,
  highRisk: false,
  warning: null,
  riskRank: null,
}));

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
          businessDate: "2026-11-11",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            nav("HOME-OVERVIEW", "Overview", "/app", "merchant.access"),
            nav(
              "STORE-SETUP",
              "Store setup",
              `/app/organization/stores/${storeReference}/setup`,
              "organization.manage",
            ),
            nav("IAM-ROLE-LIST", "Roles", "/app/organization/roles", "identity.role.read"),
          ],
        },
      },
    }),
  );
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date(at).toISOString(), validUntil },
    });
  });
}

type Role = Record<string, unknown> & { roleReference: string; version: number };
const preset = (roleReference: string, name: string, memberCount: number): Role => ({
  roleReference,
  name,
  description: name,
  scope: "Store",
  version: 2,
  kind: "Preset",
  locked: false,
  state: "InUse",
  memberCount,
  waitingAssignments: 0,
  permissions: ["merchant.access"],
  retiredByBop: 0,
  presetUpdate: null,
  change: null,
  lastOutcome: null,
  operations: memberCount === 0 ? ["Revise", "Deactivate", "Duplicate"] : ["Revise", "Duplicate"],
  history: [],
});
const definitions = {
  counter: [
    counter,
    "Counter",
    "Takes orders and payment at the counter, hands over pickups, seats pay-first tables and marks items sold out",
  ],
  drink_maker: [
    maker,
    "Drink maker",
    "Makes drinks from the order screen, remakes a wrong one, marks items sold out and hands orders over",
  ],
} as const;

/** A tea shop with Front of House (Sam holds it), Kitchen and Store Manager, as the BFF answers. */
function teaShop(options: { readonly setsDown?: boolean } = {}) {
  const roles: Role[] = [
    preset(foh, "Front of House", 1),
    preset(kitchen, "Kitchen", 0),
    preset(manager, "Store Manager", 0),
  ];
  const applies: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const find = (reference: unknown) => roles.find((role) => role.roleReference === reference);
  const starterView = (key: keyof typeof definitions) => {
    const [reference, name, description] = definitions[key];
    const have = find(reference);
    return {
      key,
      name,
      description,
      permissions: ["merchant.access", "ordering.order.read"],
      state:
        have === undefined
          ? "ToAdd"
          : have.state === "Removed"
            ? "Removed"
            : have.state === "NotOn" && have.change === null
              ? "NotApproved"
              : "Added",
      roleReference: have === undefined ? null : reference,
    };
  };
  const active = (reference: string) => find(reference)?.state === "InUse";
  const sets = () => ({
    screenId: "IAM-ROLE-LIST",
    sourceAsOf: now(),
    mayApply: true,
    mayPutAway: true,
    started: find(counter) !== undefined,
    sets: ["TeaShop", "DessertShop", "Hotpot", "FullService", "CounterOnly"].map((storeType) => ({
      storeType,
      roles:
        storeType === "TeaShop"
          ? [starterView("counter"), starterView("drink_maker")]
          : [starterView("counter")],
      keep: [{ roleReference: manager, name: "Store Manager" }],
      putAway: [
        { roleReference: foh, name: "Front of House", held: true, memberCount: 1 },
        ...(active(kitchen)
          ? [{ roleReference: kitchen, name: "Kitchen", held: false, memberCount: 0 }]
          : []),
      ],
    })),
  });
  const view = (screenId: string, list: Role[]) => ({
    screenId,
    sourceAsOf: now(),
    freshness: "Fresh",
    completeness: "Complete",
    roles: list,
    mayManage: true,
    catalog,
  });
  const change = (status: string, name: string) => ({
    status,
    name,
    description: name,
    permissions: ["merchant.access", "ordering.order.read"],
    added: ["merchant.access", "ordering.order.read"],
    removed: [],
    restore: false,
    rebased: false,
    droppedByBop: 0,
    by: "You",
    at: now(),
    approvedAlone: status === "Approved",
    approval:
      status === "InReview"
        ? {
            mine: true,
            soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
            needsHolderOf: [],
          }
        : null,
  });
  return {
    applies,
    commands,
    /** The owner withdrew a sent starter role (elsewhere): not on, nothing waiting. */
    withdraw(reference: string) {
      Object.assign(find(reference) as Role, {
        change: null,
        lastOutcome: "Withdrawn",
        operations: [],
        version: (find(reference) as Role).version + 1,
      });
    },
    /** Someone else changes a role meanwhile: its version moves on without this page knowing. */
    changeMeanwhile(reference: string) {
      (find(reference) as Role).version += 1;
    },
    async install(page: Page) {
      await page.route("**/merchant/organization/roles/starter-sets", (route: Route) =>
        options.setsDown === true
          ? route.fulfill({ status: 503, headers, json: { error: "Unavailable" } })
          : route.fulfill({ headers, json: sets() }),
      );
      await page.route("**/merchant/organization/roles/starter-sets/apply", (route: Route) => {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        applies.push(input);
        for (const key of ["counter", "drink_maker"] as const) {
          const [reference, name, description] = definitions[key];
          if (find(reference) === undefined)
            roles.push({
              ...preset(reference, name, 0),
              description,
              kind: "Custom",
              state: "NotOn",
              version: 2,
              permissions: [],
              change: change("InReview", name),
              operations: ["Withdraw", "ApproveAlone"],
            });
        }
        if (input.putAway === true)
          Object.assign(find(kitchen) as Role, {
            state: "Removed",
            operations: ["Activate", "Duplicate"],
          });
        return route.fulfill({
          headers,
          json: { storeType: input.storeType, added: 2, putAway: input.putAway === true ? 1 : 0 },
        });
      });
      await page.route("**/merchant/organization/roles/query", (route: Route) => {
        const reference = (route.request().postDataJSON() as { roleReference: string | null })
          .roleReference;
        return route.fulfill({
          headers,
          json:
            reference === null
              ? view("IAM-ROLE-LIST", roles)
              : view("IAM-ROLE-EDITOR", [find(reference) as Role]),
        });
      });
      await page.route("**/merchant/organization/roles/command", (route: Route) => {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        commands.push(input);
        const role = find(input.roleReference) as Role;
        if (input.expectedVersion !== role.version)
          return route.fulfill({ status: 409, headers, json: { error: "Conflict" } });
        role.version += 1;
        if (input.operation === "ApproveAlone") {
          role.change = change("Approved", String(role.name));
          role.operations = ["Activate", "Withdraw"];
        } else if (input.operation === "Activate") {
          role.change = null;
          role.state = "InUse";
          role.permissions = ["merchant.access", "ordering.order.read"];
          role.operations = ["Revise", "Deactivate", "Duplicate"];
        }
        return route.fulfill({
          headers,
          json: { roleReference: role.roleReference, version: role.version, status: "Active" },
        });
      });
    },
  };
}

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
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\b[a-z]+(\.[a-z_]+){1,}\b/u);
  expect(text).not.toMatch(/starter_|TeaShop|NameTaken|ToAdd/u);
}

test("@production a tea shop owner starts from the tea shop roles on Roles, approves them alone and turns them on", async ({
  page,
}) => {
  await session(page);
  const state = teaShop();
  await state.install(page);
  await page.goto("/app/organization/roles");
  const offer = page.locator("section.starter-roles");
  await expect(offer.getByRole("heading", { name: "Roles for your kind of shop" })).toBeVisible();
  await expect(offer.getByRole("group", { name: "What kind of shop is this?" })).toBeVisible();
  await checkScreen(page, "roles-offer");
  await offer.getByLabel("Bubble tea or tea shop").check();
  await expect(offer.getByText("Adds these roles:")).toBeVisible();
  await expect(offer.getByText("Counter", { exact: true })).toBeVisible();
  await expect(offer.getByText("Drink maker", { exact: true })).toBeVisible();
  await expect(offer.getByText("Keeps: Store Manager.")).toBeVisible();
  await expect(offer.getByText("Front of House stays: 1 staff hold it.")).toBeVisible();
  const removeKitchen = offer.getByLabel(/doesn't use: Kitchen\./u);
  await expect(removeKitchen).toBeChecked();
  await checkScreen(page, "roles-tea-preview");
  await offer.getByRole("button", { name: "Use these roles" }).click();
  await expect(offer.getByText("Added 2 roles. Each is on once it is approved.")).toBeVisible();
  await expect(offer.getByText("Waiting for approval: Counter, Drink maker.")).toBeVisible();
  expect(state.applies).toEqual([expect.objectContaining({ storeType: "TeaShop", putAway: true })]);
  // The list shows the new roles waiting and Kitchen removed (it can come back).
  await expect(page.getByRole("heading", { name: "Removed roles" })).toBeVisible();
  await expect(
    page.locator("li.role-row").filter({ hasText: "Counter" }).getByText("Not turned on yet"),
  ).toBeVisible();
  const approve = offer.getByRole("button", { name: "Approve them on my own and turn them on" });
  await expect(approve).toBeDisabled();
  await offer.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await offer.getByLabel("I checked these new roles and approve on my own").check();
  // Two roles are "them" (v15 2026-11-11).
  await expect(
    offer.getByText(/so you may approve them yourself\. Check them first:/u),
  ).toBeVisible();
  await checkScreen(page, "roles-tea-approve");
  await approve.click();
  await expect(
    offer.getByText("Your new roles are on. Give them to staff on Staff."),
  ).toBeVisible();
  expect(state.commands.map((item) => [item.operation, item.roleReference])).toEqual([
    ["ApproveAlone", counter],
    ["Activate", counter],
    ["ApproveAlone", maker],
    ["Activate", maker],
  ]);
  expect(state.commands[0]).toMatchObject({ confirmed: true });
  // The owner can start from another kind of shop later; it is folded away now.
  await expect(offer.getByText("Start from the roles of another kind of shop")).toBeVisible();
  await expect(offer.getByRole("group", { name: "What kind of shop is this?" })).toBeHidden();
  await checkScreen(page, "roles-tea-done");
});

test("@production a role changed meanwhile makes the approve step read the roles again, and the next press goes through", async ({
  page,
}) => {
  await session(page);
  const state = teaShop();
  await state.install(page);
  await page.goto("/app/organization/roles");
  const offer = page.locator("section.starter-roles");
  await offer.getByLabel("Bubble tea or tea shop").check();
  await offer.getByRole("button", { name: "Use these roles" }).click();
  await expect(offer.getByText("Waiting for approval: Counter, Drink maker.")).toBeVisible();
  await offer.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  state.changeMeanwhile(counter);
  await offer.getByLabel("I checked these new roles and approve on my own").check();
  const approve = offer.getByRole("button", { name: "Approve them on my own and turn them on" });
  await approve.click();
  await expect(
    offer.getByText("Your roles changed meanwhile. Check the list again, then choose."),
  ).toBeVisible();
  await expect(approve).toBeEnabled();
  if (!(await offer.getByLabel("I checked these new roles and approve on my own").isChecked()))
    await offer.getByLabel("I checked these new roles and approve on my own").check();
  await approve.click();
  await expect(
    offer.getByText("Your new roles are on. Give them to staff on Staff."),
  ).toBeVisible();
  // The second press used the version read again, never the one the offer first held.
  expect(
    state.commands.map((item) => [item.operation, item.roleReference, item.expectedVersion]),
  ).toEqual([
    ["ApproveAlone", counter, 2],
    ["ApproveAlone", counter, 3],
    ["Activate", counter, 4],
    ["ApproveAlone", maker, 2],
    ["Activate", maker, 3],
  ]);
});

test("@production Store setup offers who does what, in Chinese, and links to Roles once started", async ({
  page,
}) => {
  await session(page);
  await serveStoreSetupPanels(page);
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  const state = teaShop();
  await state.install(page);
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.goto(`/app/organization/stores/${storeReference}/setup`);
  const offer = page.locator("section.starter-roles");
  await expect(offer.getByRole("heading", { name: "谁做什么" })).toBeVisible();
  await offer.getByLabel("奶茶店或茶饮店").check();
  await expect(offer.getByText("柜台", { exact: true })).toBeVisible();
  await expect(offer.getByText("饮品师", { exact: true })).toBeVisible();
  await checkScreen(page, "setup-tea-preview-zh");
  await offer.getByRole("button", { name: "用这些角色" }).click();
  await expect(offer.getByText("等待批准：柜台、饮品师。")).toBeVisible();
  // v15 2026-11-11: the step is not done while the roles wait for approval.
  await expect(offer.getByText("还没完成：这些角色启用之前，不能分给任何员工。")).toBeVisible();
  await expect(offer.getByText("角色已按你的店型设置好。")).toHaveCount(0);
  await checkScreen(page, "setup-tea-started-zh");
  // The sole owner approves them alone right here; then the step is done.
  await offer.getByRole("button", { name: "验证后自行批准" }).click();
  const dialog = page.getByRole("dialog", { name: "确认身份" });
  await dialog.getByLabel("六位验证码").fill("123456");
  await dialog.getByRole("button", { name: "验证", exact: true }).click();
  await expect(dialog).toBeHidden();
  await offer.getByLabel("我已核对这些新角色，并自行批准").check();
  await offer.getByRole("button", { name: "我自己批准并启用" }).click();
  await expect(offer.getByText("角色已按你的店型设置好。")).toBeVisible();
  await expect(offer.getByText(/还没完成/u)).toHaveCount(0);
  await expect(offer.getByRole("link", { name: "到“角色”里修改" })).toHaveAttribute(
    "href",
    "/app/organization/roles",
  );
  await checkScreen(page, "setup-tea-done-zh");
});

test("@production Store setup says withdrawn starter roles are not on and sends them for approval again", async ({
  page,
}) => {
  await session(page);
  await serveStoreSetupPanels(page);
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  const state = teaShop();
  await state.install(page);
  await page.goto(`/app/organization/stores/${storeReference}/setup`);
  const offer = page.locator("section.starter-roles");
  await offer.getByLabel("Bubble tea or tea shop").check();
  await offer.getByRole("button", { name: "Use these roles" }).click();
  await expect(offer.getByText("Waiting for approval: Counter, Drink maker.")).toBeVisible();
  state.withdraw(counter);
  state.withdraw(maker);
  await page.reload();
  await expect(
    offer.getByText("Not done yet: nobody can be given these roles until they are on."),
  ).toBeVisible();
  await expect(
    offer.getByText(
      "Counter, Drink maker weren't approved, or were withdrawn. Choose your kind of shop again to send them for approval again.",
    ),
  ).toBeVisible();
  await expect(offer.getByText("Your roles are set up for your kind of shop.")).toHaveCount(0);
  await expect(offer.getByRole("group", { name: "What kind of shop is this?" })).toBeVisible();
  await checkScreen(page, "setup-tea-withdrawn");
});

test("@production an outage of the starter roles reads as an outage with Try again, never as no access", async ({
  page,
}) => {
  await session(page);
  const state = teaShop({ setsDown: true });
  await state.install(page);
  await page.goto("/app/organization/roles");
  const offer = page.locator("section.starter-roles");
  await expect(
    offer.getByText("The roles for your kind of shop didn't load. Nothing was changed."),
  ).toBeVisible();
  await expect(offer.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText(/access/iu)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Roles in use" })).toBeVisible();
  await checkScreen(page, "roles-sets-outage");
});
