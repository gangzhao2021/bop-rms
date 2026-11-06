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
import {
  listStoreRoleAssignments,
  storeRoleTemplateActions,
  withLegacyEquivalents,
} from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";
import {
  openSyntheticStoreRoles,
  upgradeSyntheticStoreRoles,
} from "../test-support/store-role-provisioning.mjs";

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
 * WP-2423 role presets (Owner request 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
 * 对预设进行增删改"): a one-owner store edits the Front of House preset (the staff who hold it keep
 * the old name and permissions until the change is approved and turned on), approves it alone as
 * sole operator, removes and brings back roles nobody holds, creates a role from blank by name,
 * keeps its version through a BOP preset upgrade (a change waiting on a preset is withdrawn and
 * sent back as a draft), restores the preset, and gets the two-person rule back once a Store
 * Manager joins — who is told about the change, cannot approve flagged powers they lack, and never
 * sees another Store's changes.
 */
it("role presets: edit, approve alone, remove, create, upgrade, restore and the two-person rule", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_role_presets" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      let sequence = 0x1000;
      const next = () => id(++sequence);
      const role = await createPilotApiRole(admin, context, "wp2423_rp");
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
      const samRoleName = async () =>
        (
          await asApi(storeA, (client) =>
            listStoreRoleAssignments(
              client,
              { brandReference: brand, storeReference: storeA },
              new Date().toISOString(),
            ),
          )
        ).assignments.find((item) => item.actorReference === sam).roleName;
      const fohActions = [...storeRoleTemplateActions("front-of-house")].filter(
        (code) => !code.endsWith(".operate"),
      );
      const catalogFoh = (await detail("ana", foh)).permissions;

      // ── (a) Ana edits Front of House: renames it and adds comps. Sam keeps the old name and
      // permissions while the change waits.
      await assert.rejects(
        send("ana", "Revise", foh, {
          draft: { displayName: "kitchen", description: "x", actions: catalogFoh },
        }),
        refused("NameTaken"),
      );
      await send("ana", "Revise", foh, {
        draft: {
          displayName: "Servers",
          description: "Orders, tables and payments",
          actions: [...catalogFoh, "ordering.order.comp"].sort(),
        },
      });
      let item = await detail("ana", foh);
      assert.equal(item.name, "Front of House");
      assert.equal(item.kind, "Preset");
      assert.equal(item.change.status, "Draft");
      assert.equal(item.change.name, "Servers");
      assert.deepEqual(item.change.added, ["ordering.order.comp"]);
      assert.equal(await samRoleName(), "Front of House");
      assert.ok(!(await grantsOf(storeA, foh)).includes("ordering.order.comp"));
      await send("ana", "Submit", foh);
      assert.equal(await samRoleName(), "Front of House");

      // ── Sole operator: off, then On with a stale second factor, then a fresh one.
      await assert.rejects(send("ana", "ApproveAlone", foh), refused("SoleOperatorNotInEffect"));
      assert.deepEqual((await roles.waiting(as("ana"))).changes, []);
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
        n: 0x2100,
        brandReference: brand,
        storeReference: storeA,
        actorReference: ana,
        ageMs: 16 * 60_000,
      });
      assert.deepEqual(
        (await roles.waiting(as("ana"))).changes.map((change) => [change.name, change.action]),
        [["Front of House", "ApproveAlone"]],
      );
      // (e) Store B never shows Store A's change.
      assert.deepEqual((await roles.waiting(as("anaB"))).changes, []);
      await assert.rejects(send("ana", "ApproveAlone", foh), refused("NeedsReverification"));
      await seedStepUp(admin, {
        id,
        n: 0x2200,
        brandReference: brand,
        storeReference: storeA,
        actorReference: ana,
        ageMs: 60_000,
      });
      // An ordinary approval by the submitter is never accepted.
      await assert.rejects(send("ana", "Approve", foh), refused("Invalid"));
      await send("ana", "ApproveAlone", foh);
      const marks = await admin.query(
        "SELECT actor_id::text actor,approval_mode FROM bop_permission.role_administration_sole_operator_approval",
      );
      assert.deepEqual(marks.rows, [{ actor: ana, approval_mode: "SoleOperator" }]);
      assert.equal(await samRoleName(), "Front of House");
      await send("ana", "Activate", foh);
      item = await detail("ana", foh);
      assert.deepEqual(
        [item.name, item.kind, item.state, item.change],
        ["Servers", "YourVersion", "InUse", null],
      );
      assert.equal(await samRoleName(), "Servers");
      assert.ok((await grantsOf(storeA, foh)).includes("ordering.order.comp"));
      // Store B's Front of House is unchanged.
      const fohB = await roleId(storeB, "front_of_house");
      assert.deepEqual(await grantsOf(storeB, fohB), [
        ...storeRoleTemplateActions("front-of-house"),
      ]);
      // History is append-only, the mark too.
      for (const sql of [
        "UPDATE bop_permission.role_administration_version SET display_name='x' WHERE role_id=$1",
        "UPDATE bop_permission.role_administration_sole_operator_approval SET actor_id=actor_id WHERE brand_id=$1::uuid OR $1 IS NOT NULL",
      ])
        await assert.rejects(
          asApi(storeA, (client) => client.query(sql, [foh])),
          /append-only|permission denied/u,
        );

      // ── (d) A role someone holds, or a waiting staff role request would give, is not removed.
      await assert.rejects(send("ana", "Deactivate", foh), refused("InUse"));
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, storeA],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment_change(change_id,brand_id,store_id,kind,role_id,assignment_id,actor_id,membership_id,store_assignment_id,requested_by,requested_at,reason_code,audit_id,data_classification) VALUES($1,$2,$3,'Assign',$4,$5,$6,$7,$8,$9,date_trunc('milliseconds',now()),'ROLE_REQUESTED',$10,'ConfigurationMetadata')",
        [
          next(),
          brand,
          storeA,
          kitchen,
          next(),
          mia,
          members.get(mia).membership,
          members.get(mia).assignments[storeA],
          ana,
          next(),
        ],
      );
      assert.equal((await detail("ana", kitchen)).operations.includes("Deactivate"), false);
      await assert.rejects(send("ana", "Deactivate", kitchen), refused("InUse"));
      // Nobody holds Inventory Manager: removed, listed as removed, and brought back.
      await send("ana", "Deactivate", inventory);
      assert.equal((await detail("ana", inventory)).state, "Removed");
      await send("ana", "Activate", inventory);
      assert.equal((await detail("ana", inventory)).state, "InUse");

      // ── New role from blank: the server names its code; a retry gives the same role.
      const createRef = fresh();
      const blank = {
        displayName: "Prep cook",
        description: "Prepares dishes",
        actions: ["kitchen.work_item.read", "merchant.access"],
      };
      const created = await send("ana", "Create", null, {
        operationReference: createRef,
        draft: blank,
      });
      const again = await send("ana", "Create", null, {
        operationReference: createRef,
        draft: blank,
      });
      assert.equal(again.roleReference, created.roleReference);
      await assert.rejects(
        send("ana", "Create", null, { draft: { ...blank, displayName: "Prep Cook " } }),
        refused("NameTaken"),
      );
      // Two people creating the same name at the same moment: exactly one role takes it.
      const together = await Promise.allSettled(
        [0, 1, 2].map(() =>
          send("ana", "Create", null, { draft: { ...blank, displayName: "Night lead" } }),
        ),
      );
      assert.equal(together.filter((result) => result.status === "fulfilled").length, 1);
      for (const result of together.filter((item) => item.status === "rejected"))
        assert.ok(refused("NameTaken")(result.reason));
      assert.equal(
        (
          await admin.query(
            "SELECT count(DISTINCT role_id)::int n FROM bop_permission.role_administration_version WHERE store_id=$1 AND display_name='Night lead'",
            [storeA],
          )
        ).rows[0].n,
        1,
      );
      // Two drafts renamed to the same name at the same moment: exactly one keeps it.
      const bars = [];
      for (const displayName of ["Bar one", "Bar two"])
        bars.push(
          (await send("ana", "Create", null, { draft: { ...blank, displayName } })).roleReference,
        );
      const renamed = await Promise.allSettled(
        bars.map((bar) =>
          send("ana", "SaveDraft", bar, { draft: { ...blank, displayName: "Bar lead" } }),
        ),
      );
      assert.equal(renamed.filter((result) => result.status === "fulfilled").length, 1);
      for (const result of renamed.filter((item) => item.status === "rejected"))
        assert.ok(refused("NameTaken")(result.reason));
      const prep = created.roleReference;
      assert.match(
        (await admin.query("SELECT role_code FROM bop_permission.role WHERE role_id=$1", [prep]))
          .rows[0].role_code,
        /^custom_[0-9a-f]{12}$/u,
      );
      // (f) Approved alone, then removed, brought back, and still read by every page and upgrade.
      await send("ana", "Submit", prep);
      await send("ana", "ApproveAlone", prep);
      await send("ana", "Activate", prep);
      await send("ana", "Deactivate", prep);
      await send("ana", "Activate", prep);
      assert.equal((await detail("ana", prep)).state, "InUse");
      assert.ok((await roles.list(as("ana"))).roles.some((row) => row.name === "Prep cook"));

      // ── A change waiting on Kitchen when BOP upgrades the presets.
      const kitchenActions = (await detail("ana", kitchen)).permissions;
      await send("ana", "Revise", kitchen, {
        draft: {
          displayName: "Kitchen",
          description: "Kitchen work",
          actions: [...kitchenActions, "ordering.order.read"].sort(),
        },
      });
      await send("ana", "Submit", kitchen);
      const upgraded = await upgradeSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store: storeA,
        operator,
        approver,
        at: new Date().toISOString(),
        next,
      });
      assert.deepEqual([upgraded.customizedRoleCount, upgraded.rebasedRoleCount], [1, 1]);
      // Ana's version of Front of House kept its grants; Prep cook is not a preset.
      assert.ok((await grantsOf(storeA, foh)).includes("ordering.order.comp"));
      item = await detail("ana", kitchen);
      assert.deepEqual(
        [item.kind, item.change.status, item.change.rebased],
        ["Preset", "Draft", true],
      );
      assert.deepEqual(item.change.added, ["ordering.order.read"]);
      const kitchenHistory = await asApi(
        storeA,
        async (client) =>
          (
            await client.query(
              `SELECT v.lifecycle,v.role_type,v.authored_by_reference::text author,v.reason_code,d.actor_reference::text decided_by
             FROM bop_permission.role_administration_version v LEFT JOIN bop_permission.role_administration_decision d
               ON d.brand_id=v.brand_id AND d.administration_reference=v.administration_reference AND d.administration_version=v.version AND d.decision='Withdrawn'
             WHERE v.role_id=$1 ORDER BY v.version DESC LIMIT 3`,
              [kitchen],
            )
          ).rows,
      );
      // The platform withdrew it (the operator decided, Ana keeps authorship), then the preset,
      // then Ana's content back as a draft for her to check and send again.
      assert.deepEqual(kitchenHistory, [
        {
          lifecycle: "Draft",
          role_type: "Custom",
          author: ana,
          reason_code: "ROLE_DRAFT_REBASED",
          decided_by: null,
        },
        {
          lifecycle: "Active",
          role_type: "System",
          author: operator,
          reason_code: "STORE_ROLE_TEMPLATE_UPGRADE",
          decided_by: null,
        },
        {
          lifecycle: "Withdrawn",
          role_type: "Custom",
          author: ana,
          reason_code: "ROLE_CHANGE_WITHDRAWN_FOR_PRESET_UPDATE",
          decided_by: operator,
        },
      ]);
      // No tool writes the preset over a Store's own version.
      await admin.query("BEGIN");
      try {
        const head = (
          await admin.query(
            "SELECT * FROM bop_permission.role_administration_version WHERE role_id=$1 ORDER BY version DESC LIMIT 1",
            [foh],
          )
        ).rows[0];
        await assert.rejects(
          admin.query(
            `INSERT INTO bop_permission.role_administration_version(administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,
               role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification)
             VALUES($1,$2,$3,$4,$5,$6,'Front of House','x','System','Active',$7,$8,$8,$9,$10,'STORE_ROLE_TEMPLATE_UPGRADE',now(),'ConfigurationMetadata')`,
            [
              head.administration_reference,
              foh,
              Number(head.version) + 1,
              brand,
              storeA,
              head.role_code,
              head.source_policy_version,
              operator,
              approver,
              next(),
            ],
          ),
          (error) => error.code === "23514",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      // A version approved by its own submitter without a mark is refused at commit.
      await admin.query("BEGIN");
      const prepHead = (
        await admin.query(
          "SELECT * FROM bop_permission.role_administration_version WHERE role_id=$1 ORDER BY version DESC LIMIT 1",
          [prep],
        )
      ).rows[0];
      await admin.query(
        `INSERT INTO bop_permission.role_administration_version(administration_reference,role_id,version,brand_id,store_id,role_code,display_name,description,
           role_type,lifecycle,source_policy_version,authored_by_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,reason_code,changed_at,data_classification)
         VALUES($1,$2,$3,$4,$5,$6,'Prep cook','x','Custom','Approved',1,$7,$7,$7,$8,'ROLE_ADMIN_CHANGE',now(),'ConfigurationMetadata')`,
        [
          prepHead.administration_reference,
          prep,
          Number(prepHead.version) + 1,
          brand,
          storeA,
          prepHead.role_code,
          mia,
          next(),
        ],
      );
      await assert.rejects(admin.query("COMMIT"), /needs a sole operator approval/u);

      // ── Restore Front of House: back to the preset, so BOP upgrades apply to it again.
      await send("ana", "RestoreDefault", foh);
      item = await detail("ana", foh);
      assert.equal(item.change.restore, true);
      assert.deepEqual(item.change.removed, ["ordering.order.comp"]);
      assert.equal(item.operations.includes("SaveDraft"), false);
      await send("ana", "Submit", foh);
      await send("ana", "ApproveAlone", foh);
      await send("ana", "Activate", foh);
      item = await detail("ana", foh);
      assert.deepEqual([item.kind, item.name], ["Preset", "Front of House"]);
      assert.deepEqual(await grantsOf(storeA, foh), [
        ...storeRoleTemplateActions("front-of-house"),
      ]);
      assert.deepEqual(
        withLegacyEquivalents(fohActions).filter((code) => !code.endsWith(".operate")),
        fohActions,
      );

      // ── Mia joins as Store Manager: the two-person rule is back.
      await assign(mia, "store_manager");
      await send("ana", "SaveDraft", kitchen, {
        draft: {
          displayName: "Kitchen",
          description: "Kitchen work",
          actions: [...kitchenActions, "ordering.order.read", "payment.refund.approve"].sort(),
        },
      });
      await send("ana", "Submit", kitchen);
      await assert.rejects(
        send("ana", "ApproveAlone", kitchen),
        refused("SoleOperatorNotInEffect"),
      );
      item = await detail("ana", kitchen);
      assert.deepEqual(item.change.approval.soleOperator.otherApprovers, [{ displayName: "Mia" }]);
      // Mia is told, and sees only Store A's changes; Ana's change waiting at Store B is not hers.
      await send("anaB", "Revise", fohB, {
        draft: { displayName: "Floor", description: "x", actions: catalogFoh },
      });
      await send("anaB", "Submit", fohB);
      const miaWaiting = (await roles.waiting(as("mia"))).changes;
      assert.deepEqual(
        miaWaiting.map((change) => [change.name, change.by, change.action]),
        [["Kitchen", "Ana", "Approve"]],
      );
      assert.equal(
        (await roles.list(as("mia"))).roles.filter((row) => row.change?.status === "InReview")
          .length,
        miaWaiting.length,
      );
      // (b) Mia lacks refund approval, so she cannot give it to everyone who holds Kitchen.
      assert.deepEqual((await detail("mia", kitchen)).change.approval.needsHolderOf, [
        "payment.refund.approve",
      ]);
      await assert.rejects(send("mia", "Approve", kitchen), refused("ApproverLacksAccess"));
      // Ana takes it back; nothing was deleted.
      await send("ana", "Withdraw", kitchen);
      item = await detail("ana", kitchen);
      assert.deepEqual([item.change, item.lastOutcome, item.kind], [null, "Withdrawn", "Preset"]);
      assert.ok(
        item.history.every((entry) => !/version|[0-9a-f]{8}-/u.test(JSON.stringify(entry))),
      );
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
