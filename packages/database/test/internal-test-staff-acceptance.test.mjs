import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import {
  addInternalTestStaffMember,
  nextDemoStaffReferences,
} from "../../../tooling/environment/pilot-internal-test-staff.mjs";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import {
  confirmStoreMemberScope,
  isActiveStoreMember,
  listStoreMembers,
} from "../../bop/membership/src/index.ts";
import { decideRoleAssignment, requestRoleAssignment } from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole, dbNow } from "../test-support/sole-operator-brand-gate.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

const { Client } = pg;
// Synthetic fixture identities, as the DEMO installation's (`xxxxxxxx-0000-7000-8000-…`).
const id = (n) => "0190b380-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store] = [1, 2, 3].map(id);
const owner = id(0x100),
  manager = id(0x200),
  // An earlier DEMO person who left the Store keeps their block.
  former = id(0x400);
let sequence = 0x9000;
const next = () => id(++sequence);
// Operation and audit references are generated (UUIDv7), as the tool makes them.
let generated = 0xa000;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (generated++).toString(16).padStart(12, "0");

/**
 * WP-2423 batch 38 (v15 b37 finding 4b): every DEMO identity held Orders, so "a staff member
 * without Orders" could not be tried live. The TEST tool adds a DEMO cook — Membership, place at
 * the Store and TEST name, written as the restricted pilot API role holding exactly the rendered
 * pilot grants — and the Owner gives them the Kitchen role through the Staff page's own request and
 * a manager's approval. As the API role the merchant BFF uses, the cook is refused Orders and every
 * other front-of-house page, and allowed the kitchen, sold out today and recording waste.
 */
it("a TEST cook with the Kitchen role is refused Orders and allowed the kitchen", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_test_cook" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_cook");
      const base = Date.parse(await dbNow(admin));
      const from = new Date(base - 3 * 3600_000).toISOString();
      const until = new Date(base + 10 * 86_400_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'DEMO','DEMO Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'DEMO','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, from],
      );
      const brandFact = createBrand({
        brandReference: brand,
        code: "DEMO",
        displayName: "DEMO Brand",
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
        code: "DEMO",
        displayName: "DEMO Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      // The DEMO owner and manager, as the installation seeded them.
      const members = new Map();
      for (const [actor, block] of [
        [owner, 0x100],
        [manager, 0x200],
        [former, 0x400],
      ]) {
        const membership = id(block + 1),
          assignment = id(block + 3);
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [membership, actor, brand, id(block + 2), from, until],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$7,$7)",
          [
            assignment,
            membership,
            actor,
            brand,
            store,
            actor === former ? "Ended" : "Active",
            from,
            actor === former ? new Date(base - 3600_000).toISOString() : until,
          ],
        );
        await admin.query(
          "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'Required',NULL,NULL,NULL,1)",
          [actor],
        );
        members.set(actor, { membership, assignment });
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
      const roleId = async (code) =>
        (
          await admin.query(
            "SELECT role_id::text id FROM bop_permission.role WHERE brand_id=$1 AND store_id=$2 AND role_code=$3",
            [brand, store, code],
          )
        ).rows[0].id;
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,NULL,1,$8,$8)",
        [
          next(),
          await roleId("store_manager"),
          members.get(manager).membership,
          members.get(manager).assignment,
          manager,
          brand,
          store,
          from,
        ],
      );

      // ── The tool's step: the next free DEMO block, past the person who left.
      const roster = {
        actors: [
          { selector: "staff", actorReference: owner },
          { selector: "kitchen", actorReference: manager },
        ],
      };
      const known = (
        await admin.query("SELECT actor_id::text actor FROM bop_membership.membership")
      ).rows.map((row) => row.actor);
      const references = nextDemoStaffReferences(roster, known);
      const cook = id(0x500);
      assert.deepEqual(references, {
        actorReference: cook,
        membershipReference: id(0x501),
        relationshipReference: id(0x502),
        storeAssignmentReference: id(0x503),
      });
      const binding = { brandReference: brand, storeReference: store };
      const add = async () => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          return await addInternalTestStaffMember(client, {
            apiRole: api,
            binding,
            references,
            copyMfaFrom: owner,
            name: "TEST Cook",
            approverActorReference: id(21),
            until,
            at: new Date().toISOString(),
            next: fresh,
          });
        } finally {
          await client.end();
        }
      };
      assert.equal(await add(), "Added");
      // A rerun finds the same person and writes nothing more.
      assert.equal(await add(), "AlreadyPresent");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_membership.membership WHERE actor_id=$1",
            [cook],
          )
        ).rows[0].n,
        1,
      );
      // A real (non-fixture) person is never written by the tool.
      const real = { ...references, actorReference: fresh() };
      const client = new Client(context.clientConfig);
      await client.connect();
      await assert.rejects(
        addInternalTestStaffMember(client, {
          apiRole: api,
          binding,
          references: real,
          copyMfaFrom: owner,
          name: "TEST Real",
          approverActorReference: id(21),
          until,
          at: new Date().toISOString(),
          next: fresh,
        }),
        { reason: "not-synthetic" },
      );
      await client.end();

      // ── Read back as the services' role: a current member with the TEST name, no role yet.
      const transaction = async (work) => {
        const tx = new Client(context.clientConfig);
        await tx.connect();
        try {
          await tx.query("BEGIN");
          await tx.query("SET LOCAL ROLE " + api);
          const result = await work(tx, await dbNow(tx));
          await tx.query("COMMIT");
          return result;
        } catch (error) {
          await tx.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await tx.end();
        }
      };
      await transaction(async (tx, now) => {
        assert.equal(
          await isActiveStoreMember(tx, {
            brandReference: brand,
            storeReference: store,
            actorReference: cook,
            at: now,
          }),
          true,
        );
        const listed = (await listStoreMembers(tx, binding)).find(
          (member) => member.actorReference === cook,
        );
        assert.equal(listed?.displayName, "TEST Cook");
      });
      // RLS on audit records needs the Store scope.
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      const audit = await admin.query(
        "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='INTERNAL_TEST_MEMBER_ADDED' AND target_id=$1 AND source_channel='DEPLOYMENT'",
        [references.membershipReference],
      );
      assert.equal(audit.rows[0].n, 1);

      // ── The Staff page's own commands: the Owner asks for Kitchen, the manager approves it.
      const scope = { brandReference: brand, storeReference: store };
      const change = next();
      const kitchenRole = await roleId("kitchen");
      const requested = await transaction((tx, now) =>
        requestRoleAssignment(tx, {
          ...scope,
          changeReference: change,
          assignmentReference: next(),
          roleReference: kitchenRole,
          actorReference: cook,
          membershipReference: references.membershipReference,
          storeAssignmentReference: references.storeAssignmentReference,
          requestedBy: owner,
          at: now,
          auditReference: next(),
        }),
      );
      assert.equal(requested.status, "Requested");
      await transaction((tx, now) =>
        decideRoleAssignment(
          tx,
          {
            ...scope,
            changeReference: change,
            decision: "Approved",
            decidedBy: manager,
            at: now,
            auditReference: next(),
            snapshotReference: next(),
          },
          (member) => confirmStoreMemberScope(tx, { ...scope, ...member, at: now }),
        ),
      );

      // ── What the merchant BFF decides for the cook, as the restricted API role.
      const decide = (actorReference, permissionCode) =>
        transaction(async (tx, now) => {
          const actor = createIdentityActor({
            actorType: "User",
            actorReference,
            accountKind: "Workforce",
            status: "Active",
            authenticationMethod: "Oidc",
            verificationLevel: "SingleFactor",
            authenticatedAt: now,
            recentMfaAt: null,
          });
          return (
            await createMerchantWorkforcePermissionSource({
              resolveContext: async () => ({
                tenantReference: tenant,
                context: createTenantContext(actor, brandFact, storeFact, now),
              }),
            })(tx, {
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              actorReference,
              observedAt: now,
              permissionCode,
            })
          ).decision.effect;
        });
      // Refused: Orders (the screen and its list), counter orders, Tables, pickup, refunds, reports.
      for (const refused of [
        "ordering.operate",
        "ordering.order.read",
        "ordering.order.create_staff",
        "dining.operate",
        "fulfillment.operate",
        "payment.refund.request",
        "reporting.sales.read",
        "operations.order-exception.manage",
      ])
        assert.equal(await decide(cook, refused), "Deny", refused);
      // Allowed: the kitchen board and its steps, remakes, sold out today, recording waste.
      for (const allowed of [
        "merchant.access",
        "kitchen.operate",
        "kitchen.work_item.rework",
        "catalog.sku.sold_out.mark",
        "inventory.waste.record",
      ])
        assert.equal(await decide(cook, allowed), "Allow", allowed);
      // At the kitchen display the same person still operates the kitchen, and never Orders.
      assert.equal(
        kdsOperatorProfileAllows({ policy: { code: "NamedKdsOperator" } }, "kitchen.operate"),
        true,
      );
      // The manager the test approved with still has Orders: no existing role was weakened.
      assert.equal(await decide(manager, "ordering.operate"), "Allow");
    } finally {
      await admin.end();
    }
  });
});
