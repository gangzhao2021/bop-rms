import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { StarterRoleSetOffer, waitingStarterRoles } from "./StarterRoleSets.js";
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
    "Counter service only, no table service",
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

it("offers a sole owner to approve the sent roles alone, and Store setup then links to Roles", () => {
  const html = render({ sets: starterStartedSetsFixture, roles: starterStartedRolesFixture });
  expect(html).toContain("Waiting for approval: Counter, Drink maker.");
  expect(html).toContain("Approve them on my own and turn them on");
  expect(html).toContain("Your roles are set up for your kind of shop.");
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
