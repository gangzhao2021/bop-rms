import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 role presets (Owner request 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
// 对预设进行增删改"): a one-owner store edits the Front of House preset, sees the warning under a
// money power it ticks, sends the change, approves it alone and turns it on, then restores the
// preset; removes and brings back a role nobody holds; creates a role from blank by name (no code
// field). A Store Manager finds a role change on Approvals and in its badge. The routes model the
// BFF contract; every screen is checked at 1440/1024/390, with axe and for internal text.
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const shots = "/tmp/role-presets-shots";
const id = (n: number) => "0190b2f9-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const foh = id(11),
  inventory = id(12),
  created = id(13);
const now = () => new Date().toISOString().replace(/\.\d+Z$/u, ".000Z");
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});
const catalog = [
  ["merchant.access", "Signing in to the back office", "Use the merchant back office", null, null],
  ["ordering.order.read", "Orders and bills", "View orders", null, null],
  [
    "ordering.order.comp",
    "Orders and bills",
    "Comp or discount dishes before the table pays",
    "Can take money off a bill (comp or discount). Each one is recorded under their name.",
    2,
  ],
  [
    "payment.refund.approve",
    "Payments and refunds",
    "Approve a refund above the requester's limit",
    "Can approve refunds. Money leaves your business.",
    0,
  ],
].map(([action, group, description, warning, riskRank]) => ({
  action,
  group,
  description,
  highRisk: warning !== null,
  warning,
  riskRank,
}));

async function session(page: Page, approvals = false) {
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
            nav("IAM-ROLE-LIST", "Roles", "/app/organization/roles", "identity.role.read"),
            ...(approvals
              ? [nav("APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate")]
              : []),
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
  await page.route("**/merchant/organization/staff/role-requests", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: now(), requests: [] },
    }),
  );
}

type Role = Record<string, unknown> & { roleReference: string; version: number };
/** A stateful Store with the BOP presets, as the role pages read and change it. */
function store(options: { readonly presetUpdated?: boolean } = {}) {
  const fohActions = ["merchant.access", "ordering.order.read"];
  const roles: Role[] = [
    {
      roleReference: foh,
      name: "Front of House",
      description: "Orders, tables and payments",
      scope: "Store",
      version: 3,
      kind: "Preset",
      locked: false,
      state: "InUse",
      memberCount: 3,
      waitingAssignments: 0,
      permissions: fohActions,
      retiredByBop: 0,
      presetUpdate: null,
      change: null,
      lastOutcome: null,
      operations: ["Revise", "Duplicate"],
      history: [{ decision: "Activated", by: "BOP", at: now() }],
    },
    {
      roleReference: inventory,
      name: "Inventory Manager",
      description: "Stock",
      scope: "Store",
      version: 2,
      kind: "Preset",
      locked: false,
      state: "InUse",
      memberCount: 0,
      waitingAssignments: 0,
      permissions: ["merchant.access"],
      retiredByBop: 0,
      presetUpdate: null,
      change: null,
      lastOutcome: null,
      operations: ["Revise", "Deactivate", "Duplicate"],
      history: [],
    },
  ];
  if (options.presetUpdated)
    // BOP's Inventory Manager preset now also lets staff view orders; this Store's own version
    // (made before) does not.
    Object.assign(roles[1] as Role, {
      name: "Stock",
      kind: "YourVersion",
      operations: ["Revise", "RestoreDefault", "Deactivate", "Duplicate"],
      presetUpdate: { added: ["ordering.order.read"], removed: [] },
    });
  const commands: Record<string, unknown>[] = [];
  const declines: Record<string, unknown>[] = [];
  const find = (reference: unknown) => roles.find((role) => role.roleReference === reference);
  const held = () => (roles[0]?.permissions as string[]) ?? fohActions;
  const change = (status: string, permissions: string[], extra: Record<string, unknown> = {}) => ({
    status,
    name: "Front of House",
    description: "Orders, tables and payments",
    permissions,
    added: permissions.filter((a) => !held().includes(a)),
    removed: held().filter((a) => !permissions.includes(a)),
    restore: false,
    rebased: false,
    droppedByBop: 0,
    by: "You",
    at: now(),
    approvedAlone: false,
    approval:
      status === "InReview"
        ? {
            mine: true,
            soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
            needsHolderOf: [],
          }
        : null,
    ...extra,
  });
  const apply = (input: Record<string, unknown>) => {
    commands.push(input);
    const role = find(input.roleReference);
    const draft = input.draft as { actions: string[]; displayName: string } | null;
    if (input.operation === "Create") {
      roles.push({
        ...roles[1],
        roleReference: created,
        name: draft?.displayName ?? "",
        kind: "Custom",
        state: "NotOn",
        version: 1,
        permissions: [],
        change: { ...change("Draft", draft?.actions ?? []), name: draft?.displayName },
        operations: ["SaveDraft", "Submit", "Withdraw"],
      } as Role);
      return created;
    }
    if (role === undefined) throw new Error("unknown role");
    role.version += 1;
    const pending = (role.change as { permissions: string[] } | null)?.permissions ?? [];
    switch (input.operation) {
      case "Revise":
        role.change = change("Draft", draft?.actions ?? []);
        role.operations = ["SaveDraft", "Submit", "Withdraw"];
        break;
      case "RestoreDefault":
        role.change = change("Draft", fohActions, { restore: true });
        role.operations = ["Submit", "Withdraw"];
        break;
      case "Submit":
        role.change = change("InReview", pending);
        role.operations = ["ApproveAlone", "Withdraw"];
        break;
      case "ApproveAlone":
        role.change = change("Approved", pending, { approvedAlone: true });
        role.operations = ["Activate", "Withdraw"];
        break;
      case "Activate":
        if (role.state === "Removed") role.state = "InUse";
        else {
          role.permissions = pending;
          role.kind = pending.length === fohActions.length ? "Preset" : "YourVersion";
        }
        role.change = null;
        role.operations =
          role.roleReference === foh
            ? role.kind === "YourVersion"
              ? ["Revise", "RestoreDefault", "Duplicate"]
              : ["Revise", "Duplicate"]
            : ["Revise", "Deactivate", "Duplicate"];
        break;
      case "Deactivate":
        role.state = "Removed";
        role.operations = ["Activate", "Duplicate"];
        break;
    }
    return role.roleReference;
  };
  const view = (screenId: string, list: Role[]) => ({
    screenId,
    sourceAsOf: now(),
    freshness: "Fresh",
    completeness: "Complete",
    roles: list,
    mayManage: true,
    catalog,
  });
  return {
    commands,
    declines,
    async install(page: Page) {
      await page.route("**/merchant/organization/roles/offer-decline", (route: Route) => {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        declines.push(input);
        const role = find(input.roleReference) as Role;
        role.presetUpdate = null;
        role.version += 1;
        return route.fulfill({
          headers,
          json: { roleReference: role.roleReference, status: "Recorded" },
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
        const reference = apply(input);
        return route.fulfill({
          headers,
          json: { roleReference: reference, version: 1, status: "Draft" },
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
  expect(text).not.toMatch(/version \d/u);
}

test("@production a sole owner edits Front of House, approves it alone, turns it on and restores it", async ({
  page,
}) => {
  await session(page);
  const state = store();
  await state.install(page);
  await page.goto("/app/organization/roles");
  await expect(page.getByRole("heading", { name: "Roles in use" })).toBeVisible();
  await expect(page.getByText("BOP preset").first()).toBeVisible();
  await checkScreen(page, "list");
  await page
    .locator("li.role-row")
    .filter({ hasText: "Front of House" })
    .getByRole("link", { name: "Open" })
    .click();
  await page.getByRole("button", { name: "Edit this preset" }).click();
  const comp = page.getByLabel("Comp or discount dishes before the table pays");
  await comp.check();
  await expect(
    page.getByRole("note").filter({ hasText: "Can take money off a bill (comp or discount)." }),
  ).toBeVisible();
  await expect(
    page.getByText("This role can: Comp or discount dishes before the table pays"),
  ).toBeVisible();
  await expect(page.getByText(/apply to the 3 staff who hold it once approved/u)).toBeVisible();
  await checkScreen(page, "edit-preset");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByRole("heading", { name: "Change not sent yet" })).toBeVisible();
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByRole("heading", { name: "Change waiting for approval" })).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve on my own and turn on" });
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("I checked this role change and approve on my own").check();
  await checkScreen(page, "approve-alone");
  await approve.click();
  await expect(page.getByText("Your version of a BOP preset").first()).toBeVisible();
  expect(state.commands.map((item) => item.operation)).toEqual([
    "Revise",
    "Submit",
    "ApproveAlone",
    "Activate",
  ]);
  expect(state.commands[2]).toMatchObject({ confirmed: true });
  await page.getByRole("button", { name: "Restore default" }).click();
  await expect(page.getByText(/goes back to the BOP preset: removes 1, adds 0/u)).toBeVisible();
  await checkScreen(page, "restore");
});

test("@production a role nobody holds is removed and brought back; a new role is made by name only", async ({
  page,
}) => {
  await session(page);
  const state = store();
  await state.install(page);
  await page.goto("/app/organization/roles/" + inventory);
  await page.getByRole("button", { name: "Remove role" }).click();
  await expect(page.getByText("Removed roles keep their history.")).toBeVisible();
  await page.getByRole("link", { name: "Back to roles" }).click();
  await expect(page.getByRole("heading", { name: "Removed roles" })).toBeVisible();
  await page
    .locator("li.role-row")
    .filter({ hasText: "Inventory Manager" })
    .getByRole("link", { name: "Open" })
    .click();
  await page.getByRole("button", { name: "Bring back" }).click();
  await expect(page.getByText("0 staff hold this role")).toBeVisible();
  await page.getByRole("link", { name: "Back to roles" }).click();
  await page.getByRole("button", { name: "New role" }).click();
  await expect(page.getByLabel(/code/iu)).toHaveCount(0);
  await page.getByLabel("Role name").fill("Shift lead");
  await checkScreen(page, "new-role");
  await page.getByRole("button", { name: "Create and choose what it can do" }).click();
  await page.waitForURL("**/app/organization/roles/" + created);
  const create = state.commands.find((item) => item.operation === "Create");
  expect(create).toMatchObject({ roleReference: null, expectedVersion: null });
  expect(Object.keys(create?.draft as object).sort()).toEqual([
    "actions",
    "description",
    "displayName",
  ]);
});

test("@production a Store Manager finds a role change on Approvals and in its badge, in English and Chinese", async ({
  page,
}) => {
  await session(page, true);
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "forbidden" } }),
  );
  await page.route("**/merchant/organization/roles/waiting", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "APPROVAL-INBOX",
        sourceAsOf: now(),
        changes: [
          {
            roleReference: foh,
            name: "Front of House",
            added: 2,
            removed: 1,
            by: "Ana",
            at: now(),
            action: "Approve",
          },
        ],
      },
    }),
  );
  await page.goto("/app/approvals");
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation.getByRole("link", { name: "Approvals 1 waiting" })).toBeVisible();
  const section = page.locator("section.role-approvals").filter({
    has: page.getByRole("heading", { name: "Role changes waiting for you" }),
  });
  await expect(
    section.getByText(/Front of House · adds 2, removes 1 · sent by Ana/u),
  ).toBeVisible();
  await expect(page.getByText("Nothing to approve")).toHaveCount(0);
  await checkScreen(page, "manager-approvals");
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "等待你批准的角色改动" })).toBeVisible();
  await checkScreen(page, "manager-approvals-zh");
});

test("@production BOP updated a preset this store made its own: the owner keeps theirs, or adds it through approval, in English and Chinese", async ({
  page,
}) => {
  await session(page);
  const state = store({ presetUpdated: true });
  await state.install(page);
  await page.goto("/app/organization/roles");
  const row = page.locator("li.role-row").filter({ hasText: "Stock" });
  await expect(row.getByText("BOP updated the preset this role is based on")).toBeVisible();
  await expect(
    row.getByText("The BOP preset now also includes: View orders. Add it to your version?"),
  ).toBeVisible();
  await checkScreen(page, "preset-update-list");
  await row.getByRole("button", { name: "Keep mine without it" }).click();
  await expect(row.getByText("BOP updated the preset this role is based on")).toHaveCount(0);
  expect(state.declines).toEqual([
    expect.objectContaining({
      roleReference: inventory,
      kind: "Add",
      actions: ["ordering.order.read"],
    }),
  ]);
  expect(state.commands).toEqual([]);

  // Another store's owner adds it instead: a draft with it ticked, sent through approval.
  const other = store({ presetUpdated: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await session(page);
  await other.install(page);
  await page.goto("/app/organization/roles/" + inventory);
  await expect(page.getByText("BOP updated the preset this role is based on")).toBeVisible();
  await checkScreen(page, "preset-update-editor");
  await page.getByRole("button", { name: "Add to my version" }).click();
  await expect(page.getByRole("heading", { name: "Change not sent yet" })).toBeVisible();
  expect(other.commands).toEqual([
    expect.objectContaining({
      operation: "Revise",
      roleReference: inventory,
      draft: {
        displayName: "Stock",
        description: "Stock",
        actions: ["merchant.access", "ordering.order.read"],
      },
    }),
  ]);
  await expect(page.getByRole("button", { name: "Send for approval" })).toBeVisible();

  const chinese = store({ presetUpdated: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await session(page);
  await chinese.install(page);
  await page.addInitScript(() => localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.goto("/app/organization/roles/" + inventory);
  await expect(page.getByText("BOP 更新了这个角色所基于的预设")).toBeVisible();
  await expect(page.getByRole("button", { name: "加到本店版本" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保持本店版本，不加" })).toBeVisible();
  await checkScreen(page, "preset-update-zh");
});
