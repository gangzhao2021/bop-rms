import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  buildRolePermissionSelections,
  createPostgresRoleAdministrationPorts,
  executeRoleAdministration,
  listRoleAdministration,
  loadRoleAdministration,
  planRoleAdministrationChange,
} from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

const { Client } = pg;
const id = (n) => "01909a09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-07T10:00:00.000Z";

/** WP-2423: Store role administration from a System template to an active Custom role. */
it("runs duplicate, draft, independent approval, activation and guarded deactivation", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_role_flow" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000;
    const next = () => id(++sequence);
    const tenant = id(1),
      brand = id(2),
      store = id(3),
      owner = id(4),
      manager = id(5);
    try {
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'FLOW','Flow Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, at],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'FLOW_STORE','Flow Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, at],
      );
      for (const [actor, membership, assignment] of [
        [owner, id(10), id(11)],
        [manager, id(12), id(13)],
      ]) {
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
          membershipReference: id(10),
          storeAssignmentReference: id(11),
        },
      });

      const scope = { brandReference: brand, storeReference: store };
      const brandRecord = createBrand({
        brandReference: brand,
        code: "FLOW",
        displayName: "Flow Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const storeRecord = createStore({
        storeReference: store,
        brandReference: brand,
        code: "FLOW_STORE",
        displayName: "Flow Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      let minute = 1;
      const run = async (actor, operation, roleReference, options = {}) => {
        const now = `2026-10-07T11:${String(minute++).padStart(2, "0")}:00.000Z`;
        await admin.query("BEGIN");
        try {
          const current = (await loadRoleAdministration(admin, scope, roleReference, now)).record;
          const operationReference = options.operationReference ?? next();
          const ports = createPostgresRoleAdministrationPorts({
            transaction: admin,
            scope,
            operation,
            operationReference,
            actorReference: actor,
            // The real composition asks the current permission policy; this test exercises the
            // owner persistence and service rules.
            authorization: {
              authorize: async (request) =>
                Object.freeze({
                  effect: "Allow",
                  action: request.action,
                  scopeKind: "Store",
                  reason: "ROLE_PERMISSION",
                  source: "RolePermission",
                }),
            },
            clock: { now: () => now },
            nextReference: next,
          });
          const draft =
            options.actions === undefined
              ? null
              : {
                  ...(options.code ? { code: options.code } : {}),
                  displayName: options.name ?? current.displayName,
                  description: "Shift lead: orders, kitchen and pickup",
                  selections: await buildRolePermissionSelections(admin, options.actions),
                };
          const result = await executeRoleAdministration(
            {
              tenantContext: createTenantContext(
                {
                  actorType: "User",
                  accountKind: "Workforce",
                  actorReference: actor,
                  status: "Active",
                  authenticationMethod: "Oidc",
                  verificationLevel: "SingleFactor",
                  authenticatedAt: now,
                  recentMfaAt: null,
                },
                brandRecord,
                storeRecord,
                now,
              ),
              operation,
              expectedVersion: current.version,
              idempotencyKey: operationReference,
              current,
              next: planRoleAdministrationChange({
                operation,
                current,
                actorReference: actor,
                policyVersion: await ports.policy.currentVersion(brand),
                changedAt: now,
                reasonCode: "ROLE_ADMIN_CHANGE",
                nextReference: next,
                draft,
              }),
              auditId: next(),
              correlationId: operationReference,
              sourceChannel: "MERCHANT_WEB",
            },
            ports,
          );
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const roles = await listRoleAdministration(admin, scope, at);
      const byCode = new Map(roles.map((role) => [role.record.code, role]));
      assert.equal(byCode.get("store_owner").memberCount, 1);
      const managerTemplate = byCode.get("store_manager").record;

      const draft = await run(owner, "Duplicate", managerTemplate.roleReference, {
        code: "shift_lead",
        name: "Shift lead",
        actions: ["merchant.access", "ordering.order.read", "ordering.order.accept"],
      });
      assert.equal(draft.lifecycle, "Draft");
      const lead = draft.roleReference;
      const grants = async () =>
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_permission.permission_grant WHERE role_id=$1 AND lifecycle='Active'",
            [lead],
          )
        ).rows[0].n;
      assert.equal(await grants(), 0);
      await run(owner, "SaveDraft", lead, {
        actions: [
          "merchant.access",
          "ordering.order.read",
          "ordering.order.accept",
          "kitchen.work_item.read",
        ],
      });
      await run(owner, "Submit", lead);
      // The submitter can never approve their own change.
      await assert.rejects(run(owner, "Approve", lead), { code: "ROLE_ADMIN_INPUT_INVALID" });
      await run(manager, "Approve", lead);
      const policyBefore = Number(
        (
          await admin.query("SELECT version FROM bop_permission.policy_state WHERE brand_id=$1", [
            brand,
          ])
        ).rows[0].version,
      );
      const activation = id(500);
      const active = await run(owner, "Activate", lead, { operationReference: activation });
      assert.equal(active.lifecycle, "Active");
      // ordering.order.read covers the legacy ordering.operate, which is added automatically.
      assert.equal(await grants(), 6);
      const policyAfter = Number(
        (
          await admin.query("SELECT version FROM bop_permission.policy_state WHERE brand_id=$1", [
            brand,
          ])
        ).rows[0].version,
      );
      assert.equal(policyAfter, policyBefore + 1);

      // A role still held by staff is not deactivated; an unassigned one is, and can be reactivated.
      await assert.rejects(
        run(owner, "Deactivate", byCode.get("store_owner").record.roleReference),
        { code: "ROLE_ADMIN_ROLE_IN_USE" },
      );
      await run(owner, "Deactivate", lead);
      assert.equal(
        (await admin.query("SELECT lifecycle FROM bop_permission.role WHERE role_id=$1", [lead]))
          .rows[0].lifecycle,
        "Suspended",
      );
      await run(owner, "Activate", lead);
      const final = await loadRoleAdministration(admin, scope, lead, at);
      assert.deepEqual(
        { lifecycle: final.record.lifecycle, version: final.record.version },
        { lifecycle: "Active", version: 7 },
      );
      assert.deepEqual(
        final.decisions.map((item) => item.decision),
        ["Submitted", "Approved", "Activated", "Deactivated", "Activated"],
      );
      // System template roles cannot be edited.
      await assert.rejects(
        run(owner, "SaveDraft", managerTemplate.roleReference, { actions: ["merchant.access"] }),
      );
      const audits = (
        await admin.query(
          "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'ROLE_ADMIN_%'",
        )
      ).rows[0].n;
      assert.equal(audits, 7);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
