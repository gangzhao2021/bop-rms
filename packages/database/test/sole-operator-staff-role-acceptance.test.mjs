import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it, vi } from "vitest";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import {
  createMerchantStaffAdministration,
  MerchantStaffAdministrationError,
} from "../../../apps/api/src/merchant-staff-administration.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
} from "../../bop/membership/src/index.ts";
import { createPostgresCurrentPermissionPolicySource } from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrandRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";
import {
  openSyntheticBrandRoles,
  openSyntheticStoreRoles,
} from "../test-support/store-role-provisioning.mjs";

// Only the browser-session lookup is a test double: the cookie names which synthetic staff member
// is signed in at the selected Store (and, for Brand actions, the Brand). Organization, Membership,
// roles, permissions, MFA and the staff page are the real code over real rows, run as a restricted
// NOBYPASSRLS role holding exactly the rendered pilot API grants.
const signedIn = vi.hoisted(() => ({ scopeFor: null, brandScopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action) =>
    signedIn.scopeFor(tx, cookie, action),
}));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope: () => async (tx, cookie) => signedIn.brandScopeFor(tx, cookie),
}));

const { Client } = pg;
const id = (n) => "0190a7d1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store, owner, sam, mia, lee, otherBrand] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const mark = "bop_permission.role_assignment_sole_operator_approval";
let references = 0xb000;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");

/**
 * WP-2423 M07 DEC-SOLE-OPERATOR-APPROVAL (staff roles): a store with one owner gives its first
 * cashier a role. The owner asks for it and, while sole operator is in effect for staff role
 * approval (setting On, the owner the only holder at the Store and the Brand), approves it alone
 * after a second-factor check at most 15 minutes old. The approval is marked SoleOperator in the
 * database and Audit; a retry writes nothing more. Once someone else holds staff role approval
 * (a Store Manager, or a Brand-level approver who is not at this Store) the two-person rule is
 * back and that person sees the request on the Approvals page. The database refuses a requester's
 * own approval without its mark, a mark without its approval, a mark while sole operator is off,
 * a stale second factor, a mark for oneself, and any change to a mark.
 */
it("staff roles: a sole owner approves alone, and the two-person rule returns", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_staff" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 0x1000;
    const next = () => id(++sequence);
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_sosr");
      const base = Date.parse(await dbNow(admin));
      const from = new Date(base - 3 * 3600_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'SOLO','Solo Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SOLO_STORE','Solo Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, from],
      );
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
      const storeFact = createStore({
        storeReference: store,
        brandReference: brand,
        code: "SOLO_STORE",
        displayName: "Solo Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      // Owner, Sam (a new cashier, no role yet) and Mia work here; Lee is a Brand member elsewhere.
      const people = { [owner]: "Ana", [sam]: "Sam", [mia]: "Mia", [lee]: "Lee" };
      const members = new Map();
      let n = 0x100;
      for (const actor of [owner, sam, mia, lee]) {
        const membership = id(n++),
          assignment = actor === lee ? null : id(n++);
        members.set(actor, { membership, assignment });
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, id(n++), from],
        );
        if (assignment !== null)
          await admin.query(
            "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
            [assignment, membership, actor, brand, store, from],
          );
        await admin.query(
          "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
          [membership, brand, actor, people[actor], id(n++), from],
        );
        await admin.query(
          "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
          [actor, id(n++), new Date(base - 2 * 3600_000).toISOString()],
        );
      }
      await openSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store,
        operator: id(20),
        approver: id(21),
        at: from,
        next,
        owner: {
          actorReference: owner,
          membershipReference: members.get(owner).membership,
          storeAssignmentReference: members.get(owner).assignment,
        },
      });
      await openSyntheticBrandRoles(admin, {
        tenant,
        brand,
        operator: id(20),
        approver: id(21),
        at: from,
        next,
        owner: { actorReference: owner, membershipReference: members.get(owner).membership },
      });
      const roleIds = new Map(
        (
          await admin.query(
            "SELECT role_code,role_id::text id FROM bop_permission.role WHERE brand_id=$1",
            [brand],
          )
        ).rows.map((row) => [row.role_code, row.id]),
      );

      // ── The staff page composed as the pilot composes it, run as the restricted API role.
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
      const cookies = { owner, sam, mia, lee };
      signedIn.scopeFor = async (tx, cookie, action) => {
        const actorReference = cookies[cookie];
        const resolvedAt = new Date().toISOString();
        const actor = await currentActor(tx, actorReference, from);
        const decide = async (requested) => {
          try {
            const at = new Date().toISOString();
            return (
              await createMerchantWorkforcePermissionSource({
                resolveContext: async () => ({
                  tenantReference: tenant,
                  context: createTenantContext(actor, brandFact, storeFact, at),
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
          context: createTenantContext(actor, brandFact, storeFact, resolvedAt),
          store: storeFact,
          actorReference,
          sessionReference: id(0x800 + Object.keys(cookies).indexOf(cookie)),
          allowed: async () => (await decide(action))?.effect === "Allow",
          authorizeAction: decide,
          kdsOperatorProfileAllows: (requested) =>
            kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
        };
      };
      signedIn.brandScopeFor = async (tx, cookie) => {
        const actorReference = cookies[cookie];
        return {
          authorizeAction: async (action) => {
            try {
              const at = new Date().toISOString();
              const actor = await currentActor(tx, actorReference, from);
              const memberships = createPostgresCurrentMembershipSource(
                tx,
                createTenantContext(actor, brandFact, storeFact, at),
              );
              const membership = resolveActiveMembership(
                await memberships.findMemberships(actorReference, brand),
                actorReference,
                brand,
                at,
              );
              const decision = await createPostgresCurrentPermissionPolicySource(tx).authorize({
                tenantContext: createTenantContext(actor, brandFact, null, at),
                membership,
                storeAssignment: null,
                action,
              });
              return decision.scopeKind === "Brand" ? decision : null;
            } catch {
              return null;
            }
          },
        };
      };
      const staff = createMerchantStaffAdministration({
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
              expected: { tenantReference: tenant, brandReference: brand, storeReference: store },
              persistence: { currentActor },
              sessionActorReference: String(scope.actorReference),
              sessionContext: async () => scope.context,
              current: async (t) => t === tx && (await scope.allowed()),
              permissions: ["identity.role.approve"],
            }),
        },
      });
      const as = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });
      const person = async (who, actor) =>
        (await staff.query({ ...as(who), actorReference: actor })).staff[0];
      const command = (who, body) => staff.command({ ...as(who), body });
      const request = async (who, actor, roleCode) => {
        const change = fresh();
        assert.equal(
          (
            await command(who, {
              operation: "RequestRole",
              actorReference: actor,
              roleReference: roleIds.get(roleCode),
              operationReference: change,
            })
          ).status,
          "Requested",
        );
        return change;
      };
      const alone = (who, change) =>
        command(who, { operation: "ApproveAlone", changeReference: change });
      const refused = (code, reason) => (error) => {
        assert.ok(error instanceof MerchantStaffAdministrationError, String(error));
        assert.equal(error.code, code);
        assert.equal(error.reason, reason);
        return true;
      };
      const marks = async () =>
        (await admin.query(`SELECT count(*)::int n FROM ${mark}`)).rows[0].n;
      const raw = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await work();
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const insertMark = (change, actor, approvedAt, mfaAt, audit = fresh()) =>
        admin.query(
          `INSERT INTO ${mark}(change_id,brand_id,store_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id,data_classification) VALUES($1,$2,$3,'SoleOperator',$4,$5,$6,$7,'ConfigurationMetadata')`,
          [change, brand, store, actor, mfaAt, approvedAt, audit],
        );
      const insertDecision = (change, actor, at, audit = fresh()) =>
        admin.query(
          "INSERT INTO bop_permission.role_assignment_change_decision(change_id,brand_id,store_id,decision,decided_by,decided_at,policy_version,audit_id,data_classification) VALUES($1,$2,$3,'Approved',$4,$5,NULL,$6,'ConfigurationMetadata')",
          [change, brand, store, actor, at, audit],
        );

      // ── (a) Sole operator not set: the owner sees why and cannot approve their own request.
      const toCashier = await request("owner", sam, "front_of_house");
      let pending = (await person("owner", sam)).pending[0];
      assert.equal(pending.mayDecide, false);
      assert.equal(pending.mayWithdraw, true);
      assert.deepEqual(pending.soleOperator, {
        status: "NotSet",
        otherApprovers: [],
        verifiedUntil: null,
      });
      await assert.rejects(alone("owner", toCashier), refused("SoleOperatorNotInEffect", "Off"));
      await assert.rejects(
        command("owner", { operation: "Approve", changeReference: toCashier }),
        refused("PermissionDenied", undefined),
      );
      // (d) The database refuses the requester's own approval without its mark ...
      const now = () => new Date().toISOString();
      await assert.rejects(
        raw(() => insertDecision(toCashier, owner, now())),
        /needs an independent decision/u,
      );
      // ... and a mark while sole operator is not on.
      await assert.rejects(
        raw(() => insertMark(toCashier, owner, now(), now())),
        /needs sole operator on/u,
      );

      // ── Sole operator On (owner-seeded; the setting command has its own acceptance test).
      await seedSoleOperatorSetting(admin, {
        id,
        n: 0x2000,
        tenantReference: tenant,
        brandReference: brand,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      pending = (await person("owner", sam)).pending[0];
      assert.equal(pending.soleOperator.status, "Effective");
      assert.equal(pending.soleOperator.verifiedUntil, null);
      // The confirmation names the role's high-risk permissions in staff words, never codes.
      assert.ok(Array.isArray(pending.highRiskPermissions));
      assert.ok(pending.highRiskPermissions.every((text) => !/^[a-z_]+\.[a-z_.-]+$/u.test(text)));
      // No second factor yet, then one 16 minutes old: verify first.
      await assert.rejects(alone("owner", toCashier), refused("NeedsReverification", undefined));
      await seedStepUp(admin, {
        id,
        n: 0x2100,
        brandReference: brand,
        storeReference: store,
        actorReference: owner,
        ageMs: 16 * 60_000,
      });
      await assert.rejects(alone("owner", toCashier), refused("NeedsReverification", undefined));
      // (c) The database refuses a mark whose second factor is older than 15 minutes.
      await assert.rejects(
        raw(async () => {
          const at = now();
          await insertMark(
            toCashier,
            owner,
            at,
            new Date(Date.parse(at) - 16 * 60_000).toISOString(),
          );
        }),
        /recent_mfa/u,
      );
      // (f) ... and a mark for the subject (nobody approves a role for themselves).
      await assert.rejects(
        raw(() => insertMark(toCashier, sam, now(), now())),
        /must mark its requester/u,
      );
      // (e) A mark without its approval rolls the whole transaction back at commit.
      await assert.rejects(
        raw(() => insertMark(toCashier, owner, now(), now())),
        /needs its approval/u,
      );
      assert.equal(await marks(), 0);

      // ── The owner verifies (5 minutes ago): their own pending request shows on Approvals.
      const verifiedAt = await seedStepUp(admin, {
        id,
        n: 0x2200,
        brandReference: brand,
        storeReference: store,
        actorReference: owner,
        ageMs: 5 * 60_000,
      });
      const ownWaiting = await staff.roleRequests(as("owner"));
      assert.deepEqual(
        ownWaiting.requests.map((item) => [item.person, item.requestedBy, item.action]),
        [["Sam", "You", "ApproveAlone"]],
      );
      const policyBefore = Number(
        (
          await admin.query("SELECT version FROM bop_permission.policy_state WHERE brand_id=$1", [
            brand,
          ])
        ).rows[0].version,
      );
      // (b) Approved alone: the role applies, one mark, decision by the owner, Audit says so.
      const applied = await alone("owner", toCashier);
      assert.equal(applied.status, "Applied");
      assert.equal(applied.policyVersion, policyBefore + 1);
      const recorded = (
        await admin.query(
          `SELECT m.actor_id::text actor,m.actor_mfa_at,m.approved_at,d.decided_by::text decided_by,d.decided_at,m.audit_id=d.audit_id same_audit
           FROM ${mark} m JOIN bop_permission.role_assignment_change_decision d ON d.change_id=m.change_id WHERE m.change_id=$1`,
          [toCashier],
        )
      ).rows;
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].actor, owner);
      assert.equal(recorded[0].decided_by, owner);
      assert.equal(recorded[0].same_audit, true);
      assert.equal(recorded[0].actor_mfa_at.toISOString(), verifiedAt);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      const audit = (
        await admin.query(
          "SELECT after_summary_json->>'approvalMode' mode,after_summary_json->>'actorMfaAt' mfa FROM platform_audit.audit_record WHERE action_code='ROLE_ASSIGNMENT_APPROVED' AND target_id=$1",
          [toCashier],
        )
      ).rows;
      assert.deepEqual(audit, [{ mode: "SoleOperator", mfa: verifiedAt }]);
      // A retried approval answers from its decision and writes no second mark.
      assert.equal((await alone("owner", toCashier)).status, "AlreadyApplied");
      assert.equal(await marks(), 1);
      const cashier = await person("owner", sam);
      assert.deepEqual(
        cashier.assignments.map((item) => [item.roleName, item.approvedAlone]),
        [["Front of House", true]],
      );
      assert.equal(cashier.pending.length, 0);

      // (g) The mark cannot be changed or removed.
      for (const sql of [
        `UPDATE ${mark} SET actor_mfa_at=approved_at`,
        `DELETE FROM ${mark}`,
        `TRUNCATE ${mark}`,
      ])
        await assert.rejects(admin.query(sql), /append-only/u);
      // (l) Another Brand's scope reads no marks.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [otherBrand, store],
      );
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${mark}`)).rows[0].n, 0);
      await admin.query("ROLLBACK");

      // ── (j) A Brand role takes the same path (no Store on the mark).
      const toDeveloper = await request("owner", sam, "recipe_developer");
      assert.equal((await person("owner", sam)).pending[0].soleOperator.status, "Effective");
      assert.equal((await alone("owner", toDeveloper)).status, "Applied");
      assert.equal(
        (await admin.query(`SELECT store_id FROM ${mark} WHERE change_id=$1`, [toDeveloper]))
          .rows[0].store_id,
        null,
      );

      // ── (h) Turning sole operator off waits for an approval in progress (the setting is held).
      const toKitchen = await request("owner", sam, "kitchen");
      assert.equal((await alone("owner", toKitchen)).status, "Applied");
      // An approval in progress (mark and decision written, not yet committed) holds the setting.
      const toInventory = await request("owner", sam, "inventory_manager");
      const blocker = new Client(context.clientConfig);
      await blocker.connect();
      const holder = new Client(context.clientConfig);
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE " + role);
      await holder.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const heldAt = (await holder.query("SELECT date_trunc('milliseconds',clock_timestamp()) t"))
        .rows[0].t;
      await holder.query(
        `INSERT INTO ${mark}(change_id,brand_id,store_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id,data_classification) VALUES($1,$2,$3,'SoleOperator',$4,$5,$5,$6,'ConfigurationMetadata')`,
        [toInventory, brand, store, owner, heldAt, fresh()],
      );
      await holder.query(
        "INSERT INTO bop_permission.role_assignment_change_decision(change_id,brand_id,store_id,decision,decided_by,decided_at,policy_version,audit_id,data_classification) SELECT change_id,brand_id,store_id,'Approved',actor_id,approved_at,NULL,audit_id,'ConfigurationMetadata' FROM " +
          mark +
          " WHERE change_id=$1",
        [toInventory],
      );
      await blocker.query("BEGIN");
      const turnOff = blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('BrandSoleOperatorSetting:'||$1::text,0))",
        [brand],
      );
      for (let i = 0; i < 100; i++) {
        const waiting = await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        if (waiting.rows[0].n > 0) break;
        await delay(50);
      }
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          )
        ).rows[0].n,
        1,
        "turning sole operator off waits for the approval",
      );
      await holder.query("COMMIT");
      await turnOff;
      await blocker.query("ROLLBACK");
      await holder.end();
      await blocker.end();
      assert.equal(await marks(), 4);

      // ── Race: a grant of staff role approval to someone else commits first (under the policy
      // fence) and is seen, so approving alone is refused and names them.
      const toAgain = await request("owner", sam, "store_manager");
      await seedStepUp(admin, {
        id,
        n: 0x2300,
        brandReference: brand,
        storeReference: store,
        actorReference: owner,
        ageMs: 60_000,
      });
      const approverRole = await seedBrandRole(admin, {
        id,
        brandReference: brand,
        roleId: id(0x3000),
        code: "brand_role_approver",
        actions: ["merchant.access", "identity.role.approve"],
        from,
      });
      const granter = new Client(context.clientConfig);
      await granter.connect();
      await granter.query("BEGIN");
      await granter.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PermissionPolicyFence:" + brand,
      ]);
      await granter.query(
        "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,NULL,1,$6,$6)",
        [id(0x3001), approverRole, members.get(lee).membership, lee, brand, from],
      );
      const racing = alone("owner", toAgain).then(
        () => assert.fail("approved alone while Lee could approve"),
        (error) => error,
      );
      for (let i = 0; i < 100; i++) {
        const waiting = await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        if (waiting.rows[0].n > 0) break;
        await delay(50);
      }
      await granter.query("COMMIT");
      await granter.end();
      refused("SoleOperatorNotInEffect", "OtherApprovers")(await racing);
      // The Store page names the Brand-level approver who is not at this Store (union).
      assert.deepEqual((await person("owner", sam)).pending[0].soleOperator.otherApprovers, [
        { displayName: "Lee" },
      ]);
      // End Lee's Brand approval again (owner-seeded), so the Store alone decides below.
      await admin.query(
        "UPDATE bop_permission.role_assignment SET lifecycle='Ended',effective_until=clock_timestamp(),version=2 WHERE assignment_id=$1",
        [id(0x3001)],
      );
      await command("owner", { operation: "Withdraw", changeReference: toAgain });

      // ── (i) The owner approves Mia as Store Manager alone; from then on Mia must approve.
      const toManager = await request("owner", mia, "store_manager");
      assert.equal((await alone("owner", toManager)).status, "Applied");
      const toServer = await request("owner", sam, "store_manager");
      const ownerView = (await person("owner", sam)).pending[0];
      assert.equal(ownerView.soleOperator.status, "OtherApprovers");
      assert.deepEqual(ownerView.soleOperator.otherApprovers, [{ displayName: "Mia" }]);
      await assert.rejects(
        alone("owner", toServer),
        refused("SoleOperatorNotInEffect", "OtherApprovers"),
      );
      // Mia (a Store Manager without refund approval) sees it on the Approvals page.
      const miaWaiting = await staff.roleRequests(as("mia"));
      assert.deepEqual(
        miaWaiting.requests.map((item) => [item.person, item.requestedBy, item.action]),
        [["Sam", "Ana", "Decide"]],
      );
      assert.equal((await staff.roleRequests(as("owner"))).requests.length, 0);
      assert.equal(
        (await command("mia", { operation: "Approve", changeReference: toServer })).status,
        "Applied",
      );
      assert.equal(await marks(), 5);
    } finally {
      await admin.end();
    }
  });
});
