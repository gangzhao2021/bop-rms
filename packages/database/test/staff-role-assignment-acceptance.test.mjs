import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  confirmStoreMemberScope,
  listStoreMembers,
  setStoreMemberDisplayName,
} from "../../bop/membership/src/index.ts";
import {
  decideRoleAssignment,
  listRoleAdministration,
  listStoreRoleAssignments,
  requestRoleAssignment,
  revokeRoleAssignment,
} from "../../bop/permission/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

const { Client } = pg;
const id = (n) => "01909a0b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-07T10:00:00.000Z";

/** WP-2423: Store staff names and role assignment with independent approval. */
it("assigns Store roles only after independent approval and keeps an Owner", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_roles" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000;
    const next = () => id(++sequence);
    const [tenant, brand, store, owner, manager, cashier] = [1, 2, 3, 4, 5, 6].map(id);
    const members = new Map();
    try {
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'STAFF','Staff Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, at],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'STAFF_STORE','Staff Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, at],
      );
      for (const actor of [owner, manager, cashier]) {
        const membership = next(),
          assignment = next();
        members.set(actor, { membership, assignment });
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, next(), at],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
          [assignment, membership, actor, brand, store, at],
        );
      }
      await openSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store,
        operator: id(20),
        approver: id(21),
        at,
        next,
        owner: {
          actorReference: owner,
          membershipReference: members.get(owner).membership,
          storeAssignmentReference: members.get(owner).assignment,
        },
      });
      const scope = { brandReference: brand, storeReference: store };
      let minute = 1;
      const tx = async (work) => {
        const now = `2026-10-07T11:${String(minute++).padStart(2, "0")}:00.000Z`;
        await admin.query("BEGIN");
        try {
          const value = await work(now);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const roles = new Map(
        (await listRoleAdministration(admin, scope, at)).map((role) => [
          role.record.code,
          role.record.roleReference,
        ]),
      );
      const policy = async () =>
        Number(
          (
            await admin.query("SELECT version FROM bop_permission.policy_state WHERE brand_id=$1", [
              brand,
            ])
          ).rows[0].version,
        );

      // Names: versioned, idempotent per operation, stale versions refused; never in audit.
      const rename = (actor, name, expected, operation = next()) =>
        tx((now) =>
          setStoreMemberDisplayName(
            admin,
            {
              ...scope,
              actorReference: actor,
              expectedProfileVersion: expected,
              displayName: name,
              operationReference: operation,
              changedBy: owner,
              changedAt: now,
              auditReference: next(),
            },
            appendAuditRecordInTransaction,
          ),
        );
      const renameOperation = id(300);
      assert.equal((await rename(manager, "Mia Chen", 0, renameOperation)).profileVersion, 1);
      assert.equal(
        (await rename(manager, "Mia Chen", 0, renameOperation)).status,
        "AlreadyApplied",
      );
      await assert.rejects(rename(manager, "Mia C.", 0), {
        code: "MEMBER_DIRECTORY_VERSION_CONFLICT",
      });
      await assert.rejects(rename(manager, " padded", 1), {
        code: "MEMBER_DIRECTORY_INPUT_INVALID",
      });
      await rename(cashier, "Sam Lee", 0);
      const listed = await listStoreMembers(admin, scope);
      assert.deepEqual(
        listed.map((member) => member.displayName),
        ["Mia Chen", "Sam Lee", null],
      );
      // RLS on audit records needs the Store scope.
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      const audit = await admin.query(
        "SELECT count(*)::int n,count(*) FILTER (WHERE (before_summary_json::text||after_summary_json::text) ~ '(Mia|Sam)')::int leaked FROM platform_audit.audit_record WHERE action_code='MEMBER_PROFILE_NAME_CHANGED'",
      );
      assert.deepEqual(audit.rows[0], { n: 2, leaked: 0 });

      const request = (actor, role, requestedBy, change = next()) =>
        tx((now) =>
          requestRoleAssignment(admin, {
            ...scope,
            changeReference: change,
            assignmentReference: next(),
            roleReference: roles.get(role),
            actorReference: actor,
            membershipReference: members.get(actor).membership,
            storeAssignmentReference: members.get(actor).assignment,
            requestedBy,
            at: now,
            auditReference: next(),
          }),
        );
      const decide = (change, decision, decidedBy) =>
        tx((now) =>
          decideRoleAssignment(
            admin,
            {
              ...scope,
              changeReference: change,
              decision,
              decidedBy,
              at: now,
              auditReference: next(),
              snapshotReference: next(),
            },
            (member) => confirmStoreMemberScope(admin, { ...scope, ...member, at: now }),
          ),
        );
      await assert.rejects(request(owner, "store_manager", owner), {
        code: "ROLE_ASSIGNMENT_SELF",
      });
      const toManager = id(400);
      assert.equal((await request(manager, "store_manager", owner, toManager)).status, "Requested");
      await assert.rejects(request(manager, "store_manager", owner), {
        code: "ROLE_ASSIGNMENT_CONFLICT",
      });
      // Neither the requester nor the subject may decide it.
      await assert.rejects(decide(toManager, "Approved", owner), { code: "ROLE_ASSIGNMENT_SELF" });
      await assert.rejects(decide(toManager, "Approved", manager), {
        code: "ROLE_ASSIGNMENT_SELF",
      });
      // The database refuses a self-decision written around the owner code as well.
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_permission.role_assignment_change_decision VALUES($1,$2,$3,'Approved',$4,$5,NULL,$6,'ConfigurationMetadata')",
          [toManager, brand, store, owner, at, next()],
        ),
        /independent decision/u,
      );
      const before = await policy();
      const approved = await decide(toManager, "Approved", cashier);
      assert.equal(approved.status, "Applied");
      assert.equal(await policy(), before + 1);
      assert.equal((await decide(toManager, "Approved", cashier)).status, "AlreadyApplied");

      const toCashier = id(401);
      await request(cashier, "front_of_house", manager, toCashier);
      await decide(toCashier, "Approved", owner);
      const withdrawn = id(402);
      await request(cashier, "kitchen", owner, withdrawn);
      await assert.rejects(decide(withdrawn, "Withdrawn", manager), {
        code: "ROLE_ASSIGNMENT_SELF",
      });
      await decide(withdrawn, "Withdrawn", owner);
      const current = await listStoreRoleAssignments(admin, scope, "2026-10-07T12:00:00.000Z");
      assert.deepEqual(
        current.assignments.map((item) => [item.roleCode, item.actorReference]).sort(),
        [
          ["front_of_house", cashier],
          ["store_manager", manager],
          ["store_owner", owner],
        ].sort(),
      );
      assert.equal(current.pending.length, 0);

      const revoke = (assignment, revokedBy) =>
        tx((now) =>
          revokeRoleAssignment(admin, {
            ...scope,
            changeReference: next(),
            assignmentReference: assignment,
            revokedBy,
            at: now,
            auditReference: next(),
            snapshotReference: next(),
          }),
        );
      const of = (code) =>
        current.assignments.find((item) => item.roleCode === code).assignmentReference;
      await assert.rejects(revoke(of("store_owner"), owner), { code: "ROLE_ASSIGNMENT_SELF" });
      await assert.rejects(revoke(of("store_owner"), manager), {
        code: "ROLE_ASSIGNMENT_LAST_OWNER",
      });
      await revoke(of("front_of_house"), owner);
      assert.deepEqual(
        (await listStoreRoleAssignments(admin, scope, "2026-10-07T13:00:00.000Z")).assignments
          .map((item) => item.roleCode)
          .sort(),
        ["store_manager", "store_owner"],
      );
      const audits = (
        await admin.query(
          "SELECT action_code,count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'ROLE_ASSIGNMENT_%' GROUP BY 1 ORDER BY 1",
        )
      ).rows.map((row) => `${row.action_code}:${row.n}`);
      assert.deepEqual(audits, [
        "ROLE_ASSIGNMENT_APPROVED:2",
        "ROLE_ASSIGNMENT_REQUESTED:3",
        "ROLE_ASSIGNMENT_REVOKED:1",
        "ROLE_ASSIGNMENT_WITHDRAWN:1",
      ]);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
