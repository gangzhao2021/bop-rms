import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import {
  createMerchantRoleAdministration,
  MerchantRoleAdministrationError,
} from "../../../apps/api/src/merchant-role-administration.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { starterRole, withLegacyEquivalents } from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

// Only the browser-session lookup is a test double: the cookie names which synthetic staff member
// is signed in at which Store. Organization, Membership, roles, permissions, MFA and the role pages
// are the real code over real rows, run as a restricted NOBYPASSRLS role holding exactly the
// rendered pilot API grants.
const signedIn = vi.hoisted(() => ({ scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action) =>
    signedIn.scopeFor(tx, cookie, action),
}));

const { Client } = pg;
const id = (n) => "0190a7e1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, storeA, storeB, ana, sam, mia] = [1, 2, 3, 4, 5, 6, 7].map(id);
const operator = id(20),
  approver = id(21);
let references = 0xc000;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");

/**
 * WP-2423 store-type starter roles (Owner 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
 * 对预设进行增删改", DEC-STORE-TYPE-STARTER-ROLES): a tea shop owner starts the Store's roles from the
 * tea shop set. Counter and Drink maker are created as the Store's own roles and sent for approval;
 * Kitchen and Inventory Manager, which nobody holds, are put away, while Front of House stays
 * because Sam holds it. A retry changes nothing, the same reference for another kind of shop is a
 * conflict, the sole owner approves the roles alone and they grant exactly the starter permissions,
 * the owner still edits and removes them, and a later dessert set adds only what is missing and
 * never brings back what the owner removed. Store B is untouched; staff without role access are
 * refused.
 */
it("starter roles: apply a kind of shop's set, approve alone, edit, remove and apply another", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_starter_roles" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      let sequence = 0x1000;
      const next = () => id(++sequence);
      const role = await createPilotApiRole(admin, context, "wp2423_sr");
      const base = Date.parse(await dbNow(admin));
      const from = new Date(base - 3 * 3600_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'SOLO','Solo Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      const facts = {};
      const brandFact = createBrand({
        brandReference: brand,
        code: "SOLO",
        displayName: "Solo Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      for (const [store, code] of [
        [storeA, "SOLO_A"],
        [storeB, "SOLO_B"],
      ]) {
        await admin.query(
          "INSERT INTO bop_tenant.store VALUES ($1,$2,$3,$3,'America/Toronto','en-CA','CAD','Active',1,$4,$4)",
          [store, brand, code, from],
        );
        facts[store] = createStore({
          storeReference: store,
          brandReference: brand,
          code,
          displayName: code,
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: from,
          updatedAt: from,
        });
      }
      // Ana owns both Stores; Sam and Mia work at Store A (Mia without a role for now).
      const names = { [ana]: "Ana", [sam]: "Sam", [mia]: "Mia" };
      const members = new Map();
      for (const actor of [ana, sam, mia]) {
        const membership = next();
        const assignments = {};
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, next(), from],
        );
        for (const store of actor === ana ? [storeA, storeB] : [storeA]) {
          assignments[store] = next();
          await admin.query(
            "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
            [assignments[store], membership, actor, brand, store, from],
          );
        }
        await admin.query(
          "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
          [membership, brand, actor, names[actor], next(), from],
        );
        await admin.query(
          "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
          [actor, next(), new Date(base - 2 * 3600_000).toISOString()],
        );
        members.set(actor, { membership, assignments });
      }
      for (const store of [storeA, storeB])
        await openSyntheticStoreRoles(admin, {
          tenant,
          brand,
          store,
          operator,
          approver,
          at: from,
          next,
          owner: {
            actorReference: ana,
            membershipReference: members.get(ana).membership,
            storeAssignmentReference: members.get(ana).assignments[store],
          },
        });
      const roleId = async (store, code) =>
        (
          await admin.query(
            "SELECT role_id::text id FROM bop_permission.role WHERE brand_id=$1 AND store_id=$2 AND role_code=$3",
            [brand, store, code],
          )
        ).rows[0].id;
      const assign = async (actor, roleCode) =>
        admin.query(
          "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,NULL,1,$8,$8)",
          [
            next(),
            await roleId(storeA, roleCode),
            members.get(actor).membership,
            members.get(actor).assignments[storeA],
            actor,
            brand,
            storeA,
            from,
          ],
        );
      await assign(sam, "front_of_house");
      const foh = await roleId(storeA, "front_of_house"),
        kitchen = await roleId(storeA, "kitchen"),
        inventory = await roleId(storeA, "inventory_manager");

      // ── The role pages composed as the pilot composes them, run as the restricted API role.
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='20s'");
            await client.query("SET LOCAL statement_timeout='30s'");
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const currentActor = async (_tx, reference, authenticatedAt) =>
        createIdentityActor({
          actorType: "User",
          actorReference: reference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        });
      const cookies = {
        ana: [ana, storeA],
        anaB: [ana, storeB],
        mia: [mia, storeA],
        sam: [sam, storeA],
      };
      signedIn.scopeFor = async (tx, cookie, action) => {
        const [actorReference, store] = cookies[cookie];
        const actor = await currentActor(tx, actorReference, from);
        const decide = async (requested) => {
          try {
            const at = new Date().toISOString();
            return (
              await createMerchantWorkforcePermissionSource({
                resolveContext: async () => ({
                  tenantReference: tenant,
                  context: createTenantContext(actor, brandFact, facts[store], at),
                }),
              })(tx, {
                tenantReference: tenant,
                brandReference: brand,
                storeReference: store,
                actorReference,
                observedAt: at,
                permissionCode: requested,
              })
            ).decision;
          } catch {
            return null;
          }
        };
        return {
          selected: { tenantReference: tenant },
          context: createTenantContext(actor, brandFact, facts[store], new Date().toISOString()),
          store: facts[store],
          actorReference,
          sessionReference: id(0x800 + Object.keys(cookies).indexOf(cookie)),
          allowed: async () => (await decide(action))?.effect === "Allow",
          authorizeAction: decide,
          authorizeActions: async (actions) =>
            new Map(await Promise.all(actions.map(async (item) => [item, await decide(item)]))),
          kdsOperatorProfileAllows: (requested) =>
            kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
        };
      };
      const roles = createMerchantRoleAdministration({
        persistence: { transactions, now: () => new Date().toISOString() },
        authentication: {
          authorize: async (input) => ({
            sessionReference: id(0x800 + Object.keys(cookies).indexOf(input.sessionCookie)),
          }),
        },
        references: { next: fresh },
        soleOperator: {
          resolveContext: (tx, scope) =>
            createInternalRefundWorkforceContext({
              expected: {
                tenantReference: tenant,
                brandReference: brand,
                storeReference: String(scope.store.storeReference),
              },
              persistence: { currentActor },
              sessionActorReference: String(scope.actorReference),
              sessionContext: async () => scope.context,
              current: async (t) => t === tx && (await scope.allowed()),
              permissions: ["identity.role.approve"],
            }),
        },
      });
      const as = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });
      const detail = async (who, roleReference) =>
        (await roles.detail({ ...as(who), roleReference })).roles[0];
      const send = async (who, operation, roleReference, extra = {}) => {
        const current = roleReference === null ? null : await detail(who, roleReference);
        return roles.command({
          ...as(who),
          body: {
            operation,
            roleReference,
            expectedVersion: current === null ? null : current.version,
            operationReference: extra.operationReference ?? fresh(),
            reasonCode: "ROLE_ADMIN_CHANGE",
            draft: extra.draft ?? null,
            ...(operation === "ApproveAlone" ? { confirmed: true } : {}),
          },
        });
      };
      const refused = (code) => (error) => {
        assert.ok(error instanceof MerchantRoleAdministrationError, String(error));
        assert.equal(error.code, code);
        return true;
      };
      const asApi = async (store, work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          return await work(client);
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          await client.end();
        }
      };
      const grantsOf = (store, roleReference) =>
        asApi(store, async (client) =>
          (
            await client.query(
              `SELECT d.action_code FROM bop_permission.permission_grant g JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id
               WHERE g.role_id=$1 AND g.lifecycle='Active' ORDER BY d.action_code COLLATE "C"`,
              [roleReference],
            )
          ).rows.map((row) => row.action_code),
        );
      const roleIdOf = async (store, code) =>
        (
          await admin.query(
            "SELECT role_id::text id FROM bop_permission.role WHERE brand_id=$1 AND store_id=$2 AND role_code=$3",
            [brand, store, code],
          )
        ).rows[0]?.id ?? null;
      const versions = async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*) n FROM bop_permission.role_administration_version WHERE brand_id=$1",
              [brand],
            )
          ).rows[0].n,
        );
      const apply = (who, storeType, operationReference, putAway = true) =>
        roles.applyStarterSet({ ...as(who), body: { storeType, operationReference, putAway } });
      const setOf = async (who, storeType) =>
        (await roles.starterSets(as(who))).sets.find((set) => set.storeType === storeType);

      // ── Staff without role access are refused; Ana reads the tea shop set.
      await assert.rejects(roles.starterSets(as("sam")), refused("PermissionDenied"));
      await assert.rejects(apply("sam", "TeaShop", fresh()), refused("PermissionDenied"));
      const before = await roles.starterSets(as("ana"));
      assert.equal(before.mayApply, true);
      assert.equal(before.started, false);
      let tea = before.sets.find((set) => set.storeType === "TeaShop");
      assert.deepEqual(
        tea.roles.map((role) => [role.name, role.state]),
        [
          ["Counter", "ToAdd"],
          ["Drink maker", "ToAdd"],
        ],
      );
      assert.deepEqual(
        tea.putAway.map((role) => [role.name, role.held]),
        [
          ["Front of House", true],
          ["Kitchen", false],
          ["Inventory Manager", false],
        ],
      );

      // ── Apply: two roles created and sent for approval, two unused presets put away.
      const reference = fresh();
      assert.deepEqual(await apply("ana", "TeaShop", reference), {
        storeType: "TeaShop",
        added: 2,
        putAway: 2,
      });
      const counter = await roleIdOf(storeA, "starter_counter"),
        maker = await roleIdOf(storeA, "starter_drink_maker");
      assert.ok(counter !== null && maker !== null);
      let item = await detail("ana", counter);
      assert.deepEqual(
        [item.name, item.kind, item.state, item.change.status],
        ["Counter", "Custom", "NotOn", "InReview"],
      );
      const counterCodes = [...starterRole("counter").actions].sort();
      assert.deepEqual(item.change.permissions, counterCodes);
      // Nothing is granted before approval.
      assert.deepEqual(await grantsOf(storeA, counter), []);
      assert.equal((await detail("ana", kitchen)).state, "Removed");
      assert.equal((await detail("ana", inventory)).state, "Removed");
      assert.equal((await detail("ana", foh)).state, "InUse");
      tea = await setOf("ana", "TeaShop");
      assert.deepEqual(
        tea.roles.map((role) => role.state),
        ["Added", "Added"],
      );
      assert.equal((await roles.starterSets(as("ana"))).started, true);

      // ── A retry changes nothing; the same reference for another kind of shop is a conflict.
      const count = await versions();
      assert.deepEqual(await apply("ana", "TeaShop", reference), {
        storeType: "TeaShop",
        added: 0,
        putAway: 0,
      });
      assert.equal(await versions(), count);
      await assert.rejects(apply("ana", "Hotpot", reference), refused("Conflict"));
      assert.equal(await versions(), count);
      assert.equal(await roleIdOf(storeA, "starter_floor"), null);

      // ── Store B is untouched.
      assert.equal(await roleIdOf(storeB, "starter_counter"), null);
      assert.equal((await roles.starterSets(as("anaB"))).started, false);

      // ── The sole owner approves both alone and turns them on: exactly the starter permissions.
      await assert.rejects(
        send("ana", "ApproveAlone", counter),
        refused("SoleOperatorNotInEffect"),
      );
      await seedSoleOperatorSetting(admin, {
        id,
        n: 0x2000,
        tenantReference: tenant,
        brandReference: brand,
        actorReference: ana,
        state: "On",
        version: 1,
      });
      await seedStepUp(admin, {
        id,
        n: 0x2200,
        brandReference: brand,
        storeReference: storeA,
        actorReference: ana,
        ageMs: 60_000,
      });
      assert.deepEqual(
        (await roles.waiting(as("ana"))).changes
          .map((change) => [change.name, change.action])
          .sort(),
        [
          ["Counter", "ApproveAlone"],
          ["Drink maker", "ApproveAlone"],
        ],
      );
      for (const role of [counter, maker]) {
        await send("ana", "ApproveAlone", role);
        await send("ana", "Activate", role);
      }
      assert.deepEqual(
        await grantsOf(storeA, counter),
        [...withLegacyEquivalents(counterCodes)].sort(),
      );
      assert.deepEqual(
        await grantsOf(storeA, maker),
        [...withLegacyEquivalents(starterRole("drink_maker").actions)].sort(),
      );
      item = await detail("ana", counter);
      assert.deepEqual([item.kind, item.state, item.change], ["Custom", "InUse", null]);

      // ── The owner still edits it (Counter staff no longer pause ordering) and removes the other.
      await send("ana", "Revise", counter, {
        draft: {
          displayName: "Counter",
          description: item.description,
          actions: counterCodes.filter((code) => code !== "operations.ordering.pause"),
        },
      });
      await send("ana", "Submit", counter);
      await send("ana", "ApproveAlone", counter);
      await send("ana", "Activate", counter);
      assert.ok(!(await grantsOf(storeA, counter)).includes("operations.ordering.pause"));
      await send("ana", "Deactivate", maker);
      assert.equal((await detail("ana", maker)).state, "Removed");

      // ── A dessert set later adds only the dessert maker: Counter stays as the owner edited it,
      // and the drink maker the owner removed is not brought back.
      const dessert = await setOf("ana", "DessertShop");
      assert.deepEqual(
        dessert.roles.map((role) => [role.name, role.state]),
        [
          ["Counter", "Added"],
          ["Dessert maker", "ToAdd"],
        ],
      );
      assert.deepEqual(await apply("ana", "DessertShop", fresh(), false), {
        storeType: "DessertShop",
        added: 1,
        putAway: 0,
      });
      assert.equal((await detail("ana", maker)).state, "Removed");
      assert.ok(!(await grantsOf(storeA, counter)).includes("operations.ordering.pause"));
      assert.equal((await setOf("ana", "TeaShop")).roles[1].state, "Removed");

      // ── A put-away preset comes back with one step.
      await send("ana", "Activate", kitchen);
      assert.equal((await detail("ana", kitchen)).state, "InUse");

      // ── A name the owner already uses is never given to a second role.
      const hotpot = await setOf("ana", "Hotpot");
      assert.deepEqual(
        hotpot.roles.map((role) => role.state),
        ["ToAdd", "ToAdd", "ToAdd"],
      );
      await send("ana", "Create", null, {
        draft: { displayName: "runner", description: "Runs dishes", actions: ["merchant.access"] },
      });
      assert.deepEqual(
        (await setOf("ana", "Hotpot")).roles.map((role) => role.state),
        ["ToAdd", "NameTaken", "ToAdd"],
      );
      assert.deepEqual(await apply("ana", "Hotpot", fresh(), false), {
        storeType: "Hotpot",
        added: 2,
        putAway: 0,
      });
      assert.equal(await roleIdOf(storeA, "starter_runner"), null);

      // ── History is append-only: a recorded starter step cannot be rewritten.
      await assert.rejects(
        asApi(storeA, (client) =>
          client.query(
            "UPDATE bop_permission.role_administration_version SET display_name='x' WHERE role_id=$1",
            [counter],
          ),
        ),
      );
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
