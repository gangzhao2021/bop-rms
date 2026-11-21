import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { zhHans } from "./i18n/zh-Hans.js";
import {
  StarterRoleSetOffer,
  afterApprovalFailure,
  waitingStarterRoles,
} from "./StarterRoleSets.js";
import {
  roleListFixture,
  starterMakerReference,
  starterSetsFixture,
  starterStartedRolesFixture,
  starterStartedSetsFixture,
  starterTeaReference,
} from "./role-administration-pages.fixtures.js";
import {
  createRoleAdministrationPageClient,
  parseRoleAdministrationPageView,
  parseStarterRoleSetsView,
  unavailableRoleAdministrationPageClient,
  type StarterStoreType,
} from "./role-administration-pages.js";

/** WP-2423 store-type starter roles (DEC-STORE-TYPE-STARTER-ROLES). */
const render = (
  options: {
    sets?: unknown;
    roles?: unknown;
    storeType?: StarterStoreType;
    place?: "Roles" | "StoreSetup";
  } = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StarterRoleSetOffer
        client={unavailableRoleAdministrationPageClient}
        csrf="synthetic-csrf"
        place={options.place ?? "StoreSetup"}
        initial={{
          sets: parseStarterRoleSetsView(options.sets ?? starterSetsFixture),
          roles: parseRoleAdministrationPageView(options.roles ?? roleListFixture, "IAM-ROLE-LIST"),
          ...(options.storeType === undefined ? {} : { storeType: options.storeType }),
        }}
      />
    </MemoryRouter>,
  );
const noInternals = (html: string) => {
  const text = html.replace(/<[^>]+>/gu, " ");
  expect(text).not.toMatch(/\b[a-z]+(\.[a-z_]+){1,}\b/u);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  expect(text).not.toMatch(/starter_|TeaShop|NameTaken|ToAdd/u);
};
afterEach(() => setLanguageForTest("en"));

it("asks what kind of shop this is, before any role is added", () => {
  const html = render();
  expect(html).toContain("Who does what");
  expect(html).toContain("What kind of shop is this?");
  for (const kind of [
    "Bubble tea or tea shop",
    "Dessert shop",
    "Hotpot restaurant",
    "Full-service Chinese restaurant",
    "Counter service: guests order and pay first, no waiters",
  ])
    expect(html).toContain(kind);
  expect(html).not.toContain("Use these roles");
  noInternals(html);
});

it("shows a tea shop what it adds, keeps and may remove, and what stays because staff hold it", () => {
  const html = render({ storeType: "TeaShop" });
  expect(html).toContain("Adds these roles:");
  expect(html).toContain("<strong>Counter</strong>");
  expect(html).toContain("<strong>Drink maker</strong>");
  expect(html).toContain("Keeps: Store Manager.");
  expect(html).toContain("Also remove the roles this kind of shop doesn&#x27;t use: Kitchen.");
  expect(html).toContain("Front of House stays: 3 staff hold it.");
  expect(html).toContain("Use these roles");
  noInternals(html);
});

it("never adds a second role under a name the owner already uses", () => {
  const html = render({ storeType: "Hotpot" });
  expect(html).toContain("<strong>Floor</strong>");
  expect(html).toContain("<strong>Cashier</strong>");
  expect(html).not.toContain("<strong>Runner</strong>");
  expect(html).toContain("You already have a role called Runner, so it isn&#x27;t added.");
});

it("says a starter role that was not approved isn't in use, and sends it for approval again", () => {
  const sets = {
    ...starterSetsFixture,
    sets: starterSetsFixture.sets.map((set) =>
      set.storeType !== "CounterOnly"
        ? set
        : {
            ...set,
            roles: set.roles.map((role) => ({
              ...role,
              state: "NotApproved",
              roleReference: starterTeaReference,
            })),
          },
    ),
  };
  const html = render({ sets, storeType: "CounterOnly" });
  expect(html).not.toContain("is already here");
  expect(html).toContain(
    "Counter wasn&#x27;t approved, or was withdrawn, so nobody can be given it yet. These roles send it for approval again.",
  );
  expect(html).toContain("Adds these roles:");
  expect(html).toMatch(/<button[^>]*data-variant="primary"(?![^>]*disabled)[^>]*>Use these roles/u);
  noInternals(html);
});

it("offers a sole owner to approve the sent roles alone, and Store setup says the step is not done", () => {
  const html = render({ sets: starterStartedSetsFixture, roles: starterStartedRolesFixture });
  expect(html).toContain("Waiting for approval: Counter, Drink maker.");
  expect(html).toContain("Approve them on my own and turn them on");
  // v15 2026-11-11: several roles are "them", never "it".
  expect(html).toContain("so you may approve them yourself. Check them first:");
  expect(html).not.toContain("approve it yourself");
  expect(html).toContain("Staff can be given them once they are approved and turned on.");
  // v15 2026-11-11: never "set up" while the roles still wait for approval.
  expect(html).not.toContain("Your roles are set up for your kind of shop.");
  expect(html).toContain("Not done yet: nobody can be given these roles until they are on.");
  // The waiting roles are named once, in the approval above.
  expect(html).not.toContain("Waiting for another person who approves roles");
  expect(html).toContain('href="/app/organization/roles"');
  expect(html).not.toContain("What kind of shop is this?");
  // On Roles the offer stays, folded, for another kind of shop.
  const roles = render({
    sets: starterStartedSetsFixture,
    roles: starterStartedRolesFixture,
    place: "Roles",
  });
  expect(roles).toContain("Start from the roles of another kind of shop");
  noInternals(roles);
});

it("speaks of one waiting starter role in the singular", () => {
  const roles = {
    ...starterStartedRolesFixture,
    roles: starterStartedRolesFixture.roles.filter(
      (role) => role.roleReference !== starterMakerReference,
    ),
  };
  const html = render({ sets: starterStartedSetsFixture, roles });
  expect(html).toContain("Waiting for approval: Counter.");
  expect(html).toContain("so you may approve it yourself. Check it first:");
  expect(html).toContain("New role: Counter.");
  expect(html).toContain("Approve it on my own and turn it on");
  expect(html).toContain("Staff can be given it once it is approved and turned on.");
  expect(html).not.toContain("them");
});

it("Store setup says withdrawn starter roles are not on and offers to send them again", () => {
  const withdrawn = (role: (typeof starterStartedRolesFixture.roles)[number]) =>
    role.roleReference === starterTeaReference || role.roleReference === starterMakerReference
      ? { ...role, change: null, lastOutcome: "Withdrawn", operations: [] }
      : role;
  const roles = {
    ...starterStartedRolesFixture,
    roles: starterStartedRolesFixture.roles.map(withdrawn),
  };
  const html = render({ sets: starterStartedSetsFixture, roles });
  expect(html).not.toContain("Your roles are set up for your kind of shop.");
  expect(html).toContain("Not done yet: nobody can be given these roles until they are on.");
  expect(html).toContain(
    "Counter, Drink maker weren&#x27;t approved, or were withdrawn. Choose your kind of shop again to send them for approval again.",
  );
  expect(html).toContain("What kind of shop is this?");
  noInternals(html);
  setLanguageForTest("zh-Hans");
  const zh = render({ sets: starterStartedSetsFixture, roles });
  expect(zh).toContain("还没完成：这些角色启用之前，不能分给任何员工。");
  expect(zh).toContain("没有获批，或已撤回。重新选择店型，即可再次送审。");
});

it("Store setup says the roles are set up once the starter roles are on", () => {
  const on = (role: (typeof starterStartedRolesFixture.roles)[number]) =>
    role.roleReference === starterTeaReference || role.roleReference === starterMakerReference
      ? { ...role, state: "InUse", change: null, operations: [] }
      : role;
  const roles = { ...starterStartedRolesFixture, roles: starterStartedRolesFixture.roles.map(on) };
  const html = render({ sets: starterStartedSetsFixture, roles });
  expect(html).toContain("Your roles are set up for your kind of shop.");
  expect(html).not.toContain("Not done yet");
});

it("finds the starter roles waiting on the signed-in person", () => {
  const waiting = waitingStarterRoles(
    parseStarterRoleSetsView(starterStartedSetsFixture),
    parseRoleAdministrationPageView(starterStartedRolesFixture, "IAM-ROLE-LIST"),
  );
  expect(waiting.mine.map((role) => role.roleReference)).toEqual([
    starterTeaReference,
    starterMakerReference,
  ]);
  expect(waiting.approveAlone).toBe(true);
  expect(waiting.turnOn).toEqual([]);
});

it("reads in Chinese, the shop's roles included", () => {
  setLanguageForTest("zh-Hans");
  const html = render({ storeType: "TeaShop" });
  expect(html).toContain("这是什么类型的店？");
  expect(html).toContain("奶茶店或茶饮店");
  expect(html).toContain("<strong>柜台</strong>");
  expect(html).toContain("<strong>饮品师</strong>");
  expect(html).toContain("用这些角色");
  expect(html.replace(/<[^>]+>/gu, " ")).not.toMatch(/[A-Za-z]{3,}/u);
});

it("shows nothing to staff who cannot change roles", () => {
  expect(render({ sets: { ...starterSetsFixture, mayApply: false } })).toBe("");
});

it("parses only a closed reply and posts the apply to its own route", async () => {
  expect(() => parseStarterRoleSetsView({ ...starterSetsFixture, extra: true })).toThrow();
  expect(() =>
    parseStarterRoleSetsView({
      ...starterSetsFixture,
      sets: [{ ...starterSetsFixture.sets[0], storeType: "Bakery" }],
    }),
  ).toThrow();
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  const client = createRoleAdministrationPageClient("synthetic-csrf", fetcher);
  const request = {
    storeType: "TeaShop" as const,
    operationReference: "018f2195-0000-7000-8000-000000000099",
    putAway: true,
  };
  await client.applyStarterSet(request);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/organization/roles/starter-sets/apply",
    expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
  );
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }),
  );
  await expect(client.applyStarterSet(request)).rejects.toMatchObject({ code: "Conflict" });
});

it("reads the roles again after an approval run fails other than offline, so the next press is fresh", () => {
  const rest = [
    {
      operation: "Activate" as const,
      roleReference: starterTeaReference,
      expectedVersion: 3,
      operationReference: "018f2195-0000-7000-8000-000000000098",
      reasonCode: "ROLE_ACTIVATED",
      draft: null,
    },
  ];
  for (const code of ["Conflict", "NameTaken", "NeedsReverification", "Unavailable"] as const)
    expect(afterApprovalFailure(code, rest, 0)).toEqual({ pending: null, reread: true });
  // A lost answer keeps the same steps for Try again; what did go through is read again.
  expect(afterApprovalFailure("Offline", rest, 0)).toEqual({ pending: rest, reread: false });
  expect(afterApprovalFailure("Offline", rest, 1)).toEqual({ pending: rest, reread: true });
});

it("names the button it points to, and a counter shop's kind matches its Counter role", () => {
  // The Chinese line points at the button by its own Chinese label.
  expect(
    zhHans["Offline. Nothing was confirmed; Try again sends the same request again."],
  ).toContain("“" + zhHans["Try again"] + "”");
  // Counter seats pay-first tables, so the counter shop's kind never says it has no tables.
  setLanguageForTest("zh-Hans");
  const html = render({ storeType: "CounterOnly" });
  expect(html).toContain("柜台点单、先付款，没有服务员");
  expect(html).not.toContain("没有桌边服务");
  expect(html).toContain("安排先付款的桌位");
});

it("leaves the roles this kind of shop doesn't use in place unless the owner ticks the box", () => {
  // v15 2026-11-11 b10: the box was ticked already, so Use these roles removed presets in use.
  const html = render({ storeType: "TeaShop" });
  const box = /<label class="starter-roles__put-away"><input type="checkbox"([^>]*)\/?>/u.exec(
    html,
  );
  expect(box).not.toBeNull();
  expect(box?.[1] ?? "").not.toContain("checked");
});

it("Store setup says no role for the kind of shop is in use once every starter role was removed", () => {
  const removed = (role: (typeof starterStartedRolesFixture.roles)[number]) =>
    role.roleReference === starterTeaReference || role.roleReference === starterMakerReference
      ? { ...role, state: "Removed", change: null, operations: [] }
      : role;
  const roles = {
    ...starterStartedRolesFixture,
    roles: starterStartedRolesFixture.roles.map(removed),
  };
  const html = render({ sets: starterStartedSetsFixture, roles });
  expect(html).not.toContain("Your roles are set up for your kind of shop.");
  expect(html).toContain(
    "Counter, Drink maker were removed, so no role for your kind of shop is in use. Bring them back on Roles, or start from the roles of another kind of shop.",
  );
  expect(html).toContain("What kind of shop is this?");
  noInternals(html);
  // One of them still in use: the owner removed the other on purpose, and the step is done.
  const one = {
    ...roles,
    roles: roles.roles.map((role) =>
      role.roleReference === starterTeaReference ? { ...role, state: "InUse" } : role,
    ),
  };
  expect(render({ sets: starterStartedSetsFixture, roles: one })).toContain(
    "Your roles are set up for your kind of shop.",
  );
  setLanguageForTest("zh-Hans");
  expect(render({ sets: starterStartedSetsFixture, roles })).toContain(
    "都已移除，所以现在没有在用的店型角色。",
  );
});
