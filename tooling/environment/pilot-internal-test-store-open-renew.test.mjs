import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { planServedStoreRenewal } from "./pilot-internal-test-store-open.mjs";

/**
 * v15 2026-11-06: `renew` of a served Store also moves its staff file's entries at the common
 * expiry (DEMO staff at a DEMO-Brand Store, the TEST Owner at a TEST merchant's Store), with the
 * same proofs as the installation's staff file, and is refused for anything else.
 */
const OLD = "2026-11-26T02:26:31.598Z",
  UNTIL = "2026-12-06T02:26:31.598Z",
  LATER = "2027-01-30T23:59:17.721Z";
const database = "isolated_test";
const demoScope = {
  tenantReference: "0190ed16-0000-7000-8000-00000000005a",
  brandReference: "00000000-0000-7000-8000-000000000002",
  storeReference: "00000000-0000-7000-8000-000000000003",
};
const tea = {
  tenantReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0010",
  brandReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0011",
  storeReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0012",
};
const demo2 = { ...demoScope, storeReference: "01a190a6-6c74-7588-8071-6e3da993bdba" };
const staff = {
  selector: "staff",
  actorReference: "0190fa30-0000-7000-8000-000000000100",
  validUntil: OLD,
};
const kitchen = {
  selector: "kitchen",
  actorReference: "0190fa30-0000-7000-8000-000000000200",
  validUntil: OLD,
};
const owner = {
  selector: "owner-tea",
  actorReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0001",
  validUntil: OLD,
};
const support = {
  selector: "support-1",
  actorReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0020",
  validUntil: LATER,
};
const internal = (extra) => ({ environment: "InternalTest", database, ...extra });
const profile = (binding) =>
  internal({ binding: { ...binding, validFrom: "2026-10-20T02:26:31.598Z", validUntil: OLD } });
const roster = (scope, actors) => internal({ schemaVersion: 2, scope, actors });
let root;
async function put(directory, files) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [file, value] of Object.entries(files))
    await writeFile(join(directory, file), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
const store = (name, binding, actors, extra = {}) =>
  put(join(root, "stores", name), {
    "installation.json": internal({ schemaVersion: 1 }),
    "internal-test-profile.json": profile(binding),
    "internal-test-merchant.json": roster(binding, actors),
    ...extra,
  });
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bop-store-renew-")));
  await put(root, {
    "installation.json": internal({ schemaVersion: 1 }),
    "internal-test-profile.json": profile(demoScope),
    "internal-test-merchant.json": roster(demoScope, [staff, kitchen, support, owner]),
    "stores.json": { schemaVersion: 1, stores: ["stores/demo-2", "stores/tea"] },
  });
  await store("demo-2", demo2, [staff, { ...kitchen, validUntil: LATER }]);
  await store("tea", tea, [owner]);
});
afterEach(() => rm(root, { recursive: true, force: true }));
const plan = (name) =>
  planServedStoreRenewal({ storeDirectory: join(root, "stores", name), from: OLD, until: UNTIL });

test("a DEMO-Brand Store renews its DEMO staff at the common expiry and keeps a later end", async () => {
  const result = await plan("demo-2");
  expect(result).toMatchObject({ store: "stores/demo-2", testMerchant: false });
  expect(result.rosterChanges).toEqual([
    { path: "actors[0].validUntil", selector: "staff", from: OLD, to: UNTIL },
  ]);
  expect(result.retainedRosterEntries).toEqual([
    { selector: "kitchen", kind: "Demo", validUntil: LATER },
  ]);
  expect(result.roster.actors.map((actor) => actor.validUntil)).toEqual([UNTIL, LATER]);
});

test("a TEST merchant's Store renews its Owner and is marked for the database proof", async () => {
  const result = await plan("tea");
  expect(result).toMatchObject({ store: "stores/tea", testMerchant: true });
  expect(result.roster.actors).toEqual([{ ...owner, validUntil: UNTIL }]);
  // A rerun after the staff file moved changes nothing more.
  await store("tea", tea, [{ ...owner, validUntil: UNTIL }]);
  expect((await plan("tea")).roster).toBe(null);
});

test.each([
  [
    "a Store not served",
    async () => put(root, { "stores.json": { schemaVersion: 1, stores: ["stores/demo-2"] } }),
    "tea",
    "store-not-served",
  ],
  [
    "a Pilot Store",
    async () =>
      store("tea", tea, [owner], {
        "internal-test-profile.json": { ...profile(tea), environment: "Pilot" },
      }),
    "tea",
    "not-internal-test",
  ],
  [
    "someone not on the installation's staff file",
    async () =>
      store("demo-2", demo2, [
        staff,
        { ...kitchen, actorReference: "0190fa30-0000-7000-8000-000000000999" },
      ]),
    "demo-2",
    "identity-not-synthetic",
  ],
  [
    "a real-looking person",
    async () =>
      store("tea", tea, [
        owner,
        {
          selector: "manager",
          actorReference: "01a1b000-1111-7aaa-8bbb-ccccdddd0099",
          validUntil: OLD,
        },
      ]),
    "tea",
    "identity-not-synthetic",
  ],
  [
    "another Store's Owner",
    async () => store("tea", tea, [{ ...owner, selector: "owner-hotpot" }]),
    "tea",
    "identity-not-synthetic",
  ],
  [
    "support staff at a Store",
    async () => store("tea", tea, [support]),
    "tea",
    "identity-not-synthetic",
  ],
  [
    "a TEST Owner at a DEMO-Brand Store",
    async () => store("demo-2", demo2, [owner]),
    "demo-2",
    "identity-not-synthetic",
  ],
  [
    "a merchant sharing the installation's Tenant",
    async () => store("tea", { ...tea, tenantReference: demoScope.tenantReference }, [owner]),
    "tea",
    "store-not-own-merchant",
  ],
  [
    "a window changed individually",
    async () =>
      store("tea", tea, [owner], {
        "internal-test-profile.json": {
          ...profile(tea),
          binding: { ...profile(tea).binding, validUntil: LATER },
        },
      }),
    "tea",
    "window-mismatch",
  ],
])("refuses %s", async (_, change, name, reason) => {
  await change();
  await expect(plan(name)).rejects.toMatchObject({ reason });
});
