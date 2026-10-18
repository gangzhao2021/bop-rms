import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { renewInternalTestDatabase } from "../../../tooling/environment/pilot-internal-test-renew-database.mjs";
import { createInternalPricingPolicy } from "../../../tooling/environment/pilot-pricing-policy.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const DAY = 86_400_000;
const fixture = (prefix, n) => `${prefix}-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const tenant = fixture("0190ed16", 0x5a),
  brand = fixture("00000000", 2),
  store = fixture("00000000", 3);
const demo = (n) => fixture("0190fa30", n);
const gate = (n) => fixture("0190ed19", n);
const realLooking = "01a0c5df-b8f6-75fa-ace1-94ba2c15c76d";

/**
 * WP-2423: the Owner-approved InternalTest renewal of the synthetic DEMO roster, launch gate and
 * tax evidence. The domain functions run as the renewal tool's own NOBYPASSRLS role and the read
 * checks as a role with exactly the pilot API grants, so row security applies as in the pilot.
 */
it("renews only the synthetic DEMO facts, refuses real rows, audits and is idempotent", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "renew" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "renew_api_" + context.runId;
    try {
      const now = Date.now();
      const iso = (ms) => new Date(Math.floor(ms)).toISOString();
      const createdAt = iso(now - 5 * DAY),
        old = iso(now + 2 * DAY),
        until = iso(now + 25 * DAY);
      const profile = {
        environment: "InternalTest",
        database: context.databaseName,
        warning:
          "DEMO ONLY - simulated payment; synthetic configuration, not real business approval",
        createdAt,
        binding: {
          tenantReference: tenant,
          publicStoreReference: fixture("00000000", 1),
          brandReference: brand,
          storeReference: store,
          lookupEvidenceReference: fixture("00000000", 4),
          validFrom: createdAt,
          validUntil: old,
        },
      };
      const menu = {
        environment: "InternalTest",
        database: context.databaseName,
        skuReference: fixture("0190fa20", 0x0d),
        taxClassificationReference: fixture("0190fa20", 0x100),
      };
      const q = (sql, values = []) => admin.query(sql, values);
      // DEMO roster: two synthetic staff, a Store and a Brand DEMO role, plus a real role without end.
      for (const [membership, actor, assignment] of [
        [demo(1), demo(0x100), demo(3)],
        [demo(0x201), demo(0x200), demo(0x203)],
      ]) {
        await q(
          "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [
            membership,
            actor,
            brand,
            demo(0x900 + Number.parseInt(membership.slice(-3), 16)),
            createdAt,
            old,
          ],
        );
        await q(
          "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [assignment, membership, actor, brand, store, createdAt, old],
        );
      }
      await q("INSERT INTO bop_permission.policy_state VALUES ($1,$2,7,$3)", [
        brand,
        demo(0x700),
        createdAt,
      ]);
      const actions = ["renewal.alpha.read", "renewal.beta.write"];
      for (const [index, action] of actions.entries())
        await q(
          "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
          [demo(0x800 + index), action, createdAt],
        );
      const roles = [
        [demo(4), store, "synthetic_acceptance_renewal", old],
        [demo(0x40), null, "internal_pilot_cancellation_publisher", old],
        [demo(0x41), store, "store_owner", null],
      ];
      for (const [role, roleStore, code, end] of roles)
        await q("INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)", [
          role,
          brand,
          roleStore,
          code,
          createdAt,
          end,
        ]);
      const assignments = [
        [demo(5), demo(4), demo(1), demo(3), demo(0x100), store, old],
        [demo(0x50), demo(0x40), demo(1), null, demo(0x100), null, old],
        [demo(0x205), demo(4), demo(0x201), demo(0x203), demo(0x200), store, old],
        [demo(0x51), demo(0x41), demo(1), demo(3), demo(0x100), store, null],
      ];
      for (const row of assignments)
        await q(
          "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
          [row[0], row[1], row[2], row[3], row[4], brand, row[5], createdAt, row[6]],
        );
      const grants = [
        [demo(0x14), demo(4), demo(0x800), store, old],
        [demo(0x15), demo(4), demo(0x801), store, old],
        [demo(0x16), demo(0x40), demo(0x800), null, old],
        [demo(0x17), demo(0x41), demo(0x801), store, null],
      ];
      for (const row of grants)
        await q(
          "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [row[0], row[1], row[2], brand, row[3], createdAt, row[4]],
        );
      // Synthetic launch gate, as the InternalTest installation seeds it.
      await q(
        "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-STORE-LIVE-GATE',$2,$3,$4,1,'Production','Approved',$5,$6,$5,$7,$8,$8,'ConfigurationMetadata')",
        [gate(0x50), tenant, brand, store, gate(0x0b), gate(0x0a), gate(0x0e), createdAt],
      );
      await q(
        "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,1,'SYNTHETIC_TEST','SYNTHETIC_STORE_READY',$5,true,'Accepted',$6,1,$7,NULL,'ConfigurationMetadata')",
        [gate(0x52), brand, store, gate(0x50), gate(0x0b), gate(0x53), old],
      );
      // Synthetic DEMO tax configuration exactly as the internal pricing policy defines it.
      const policy = await createInternalPricingPolicy({
        loadProfile: async () => profile,
        loadMenu: async () => menu,
        expectedDatabaseName: context.databaseName,
      });
      await seedTaxConfiguration(admin, policy.taxConfiguration, demo(0x100));
      // v15 was seeded without the Brand tax reference projection; reproduce that gap.
      await q("SET row_security=off");
      await q("DELETE FROM rms_pricing.tax_reference_scope");
      await q("DELETE FROM rms_pricing.tax_reference_generation");
      await q("RESET row_security");
      await q(`CREATE ROLE ${api} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      await grantPilotApiAcl(admin, api);

      const evidence = {
        renewalReference: "01a14000-0000-7000-8000-000000000001",
        approvedBy: "Test Owner",
        approval: "TEST ONLY: 批准，续到 11 月 14 日（推荐）",
        reason: "Continue internal testing (acceptance)",
        operatorAccount: "acceptance",
      };
      const renew = (extra = {}) =>
        renewInternalTestDatabase(admin, {
          database: context.databaseName,
          readRole: api,
          profile,
          menu,
          from: old,
          to: until,
          now: Date.now(),
          evidence,
          dryRun: false,
          ...extra,
        });
      const state = async () => ({
        until: (
          await q(
            `SELECT 'm' t,membership_id::text id,effective_until,version::int v FROM bop_membership.membership
             UNION ALL SELECT 's',assignment_id::text,effective_until,version::int FROM bop_membership.store_assignment
             UNION ALL SELECT 'r',role_id::text,effective_until,version::int FROM bop_permission.role
             UNION ALL SELECT 'a',assignment_id::text,effective_until,version::int FROM bop_permission.role_assignment
             UNION ALL SELECT 'g',grant_id::text,effective_until,version::int FROM bop_permission.permission_grant ORDER BY 1,2`,
          )
        ).rows.map((row) => [row.t, row.id, row.effective_until?.toISOString() ?? null, row.v]),
        policy: (await q("SELECT version::int v FROM bop_permission.policy_state")).rows[0].v,
        gates: (await q("SELECT count(*)::int n FROM bop_publishing.live_gate_version")).rows[0].n,
        tax: (await q("SELECT count(*)::int n FROM rms_pricing.tax_configuration_version")).rows[0]
          .n,
        audits: (
          await q(
            "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='INTERNAL_TEST_VALIDITY_EXTENDED'",
          )
        ).rows[0].n,
      });
      const initial = await state();

      // Dry run: the whole change and its checks, then nothing kept.
      const planned = await renew({ dryRun: true });
      assert.equal(planned.status, "Planned");
      assert.equal(planned.membership.length, 4);
      assert.equal(planned.permission.length, 8);
      assert.equal(planned.liveGates.length, 1);
      assert.equal(planned.tax.status, "Renewed");
      assert.equal(planned.tax.referenceScopeRestored, true);
      assert.deepEqual(planned.checks.before.roster, {});
      assert.equal(planned.checks.before.launchGate, "Refused");
      assert.equal(planned.checks.before.tax, "Refused");
      assert.deepEqual(planned.checks.after.roster, {
        [demo(0x100)]: 2,
        [demo(0x200)]: 2,
      });
      assert.equal(planned.checks.after.launchGate, "Accepted");
      assert.equal(planned.checks.after.tax, "Accepted");
      // Earlier instants (just before, one business day before, start of the gate history) read
      // exactly as before the renewal: the launch gate and tax then in force, the same staff.
      const accepted = (checks) =>
        checks.every(
          (check) =>
            check.launchGate === "Accepted" &&
            check.tax === "Accepted" &&
            Object.keys(check.roster).length === 2,
        );
      assert.equal(planned.checks.history.before.length, 3);
      assert.equal(accepted(planned.checks.history.before), true);
      assert.deepEqual(planned.checks.history.after, planned.checks.history.before);
      assert.deepEqual(await state(), initial);

      // Refusals: a real-looking member or a real role with the same expiry stops everything.
      await q("INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)", [
        demo(0x301),
        realLooking,
        brand,
        demo(0x302),
        createdAt,
        old,
      ]);
      await assert.rejects(renew(), { reason: "internal-test-membership-not-synthetic" });
      assert.deepEqual((await state()).audits, 0);
      await q("UPDATE bop_membership.membership SET effective_until=NULL WHERE membership_id=$1", [
        demo(0x301),
      ]);
      await q("UPDATE bop_permission.role SET effective_until=$2 WHERE role_id=$1", [
        demo(0x41),
        old,
      ]);
      await assert.rejects(renew(), { reason: "internal-test-permission-not-synthetic" });
      await q("UPDATE bop_permission.role SET effective_until=NULL WHERE role_id=$1", [demo(0x41)]);
      await assert.rejects(renew({ to: iso(Date.now() + 31 * DAY) }), {
        reason: "internal-test-membership-input-invalid",
      });
      const unchanged = await state();
      assert.equal(unchanged.audits, 0);
      assert.equal(unchanged.gates, 1);
      assert.equal(unchanged.tax, 1);

      // The renewal.
      const renewed = await renew();
      assert.equal(renewed.status, "Renewed");
      assert.deepEqual(renewed.taxConfigurationVersion, {
        versionNumber: 2,
        createdAt: renewed.tax.createdAt,
      });
      const after = await state();
      assert.equal(after.until.filter((row) => row[2] === until).length, 12);
      for (const [type, id, end, version] of after.until) {
        const before = unchanged.until.find((row) => row[0] === type && row[1] === id);
        if (before[2] === old) assert.deepEqual([end, version], [until, before[3] + 1]);
        else assert.deepEqual([end, version], [before[2], before[3]]);
      }
      assert.equal(after.policy, initial.policy + 1);
      assert.equal(after.gates, 2);
      assert.equal(after.tax, 2);
      // One audit per changed roster row, the gate requirement and the tax version.
      assert.equal(after.audits, 12 + 1 + 1);
      const audit = (
        await q(
          "SELECT store_id,before_summary_json b,after_summary_json a,correlation_id::text c FROM platform_audit.audit_record WHERE action_code='INTERNAL_TEST_VALIDITY_EXTENDED' AND target_type='Membership' LIMIT 1",
        )
      ).rows[0];
      assert.equal(audit.store_id, null);
      assert.equal(audit.b.effectiveUntil, old);
      assert.equal(audit.a.effectiveUntil, until);
      assert.equal(audit.a.approval, evidence.approval);
      assert.equal(audit.a.approvedBy, evidence.approvedBy);
      assert.equal(audit.c, evidence.renewalReference);
      const head = (
        await q(
          "SELECT v.version_number::int n,v.registration_evidence_valid_until r,v.professional_evidence_valid_until p,v.effective_from f FROM rms_pricing.tax_configuration t JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=t.current_version_id",
        )
      ).rows[0];
      assert.deepEqual(
        [head.n, head.r.toISOString(), head.p.toISOString(), head.f.toISOString()],
        [2, until, until, policy.taxConfiguration.effectivePeriod.effectiveFrom.instant],
      );
      const rules = (
        await q(
          "SELECT tax_configuration_version_id::text v,order_type,tax_rate::text rate FROM rms_pricing.tax_configuration_rule ORDER BY 1,2",
        )
      ).rows.map((row) => [row.v.slice(-6), row.order_type, row.rate]);
      assert.deepEqual(
        rules.map(([, type, rate]) => [type, rate]),
        [
          ["DineIn", "0.130000000000"],
          ["Pickup", "0.130000000000"],
          ["DineIn", "0.130000000000"],
          ["Pickup", "0.130000000000"],
        ],
      );
      const requirement = (
        await q(
          "SELECT valid_until,evidence_reference::text e,evidence_version::int ev FROM bop_publishing.live_gate_requirement WHERE gate_version=2",
        )
      ).rows[0];
      assert.deepEqual(
        [requirement.valid_until.toISOString(), requirement.e, requirement.ev],
        [until, gate(0x53), 1],
      );
      const renewalRole = (
        await q("SELECT rolbypassrls,rolcanlogin,rolsuper FROM pg_roles WHERE rolname=$1", [
          renewed.role,
        ])
      ).rows[0];
      assert.deepEqual(renewalRole, { rolbypassrls: false, rolcanlogin: false, rolsuper: false });

      // Idempotent: the same run again, and a run after the profile already names the new end.
      const again = await renew();
      assert.equal(again.status, "AlreadyRenewed");
      // After the commit, reads at instants before the renewal still resolve (version 1 in force).
      assert.equal(accepted(renewed.checks.history.after), true);
      assert.equal(accepted(again.checks.history.before), true);
      assert.deepEqual(again.taxConfigurationVersion, renewed.taxConfigurationVersion);
      const resumed = await renew({ from: until });
      assert.equal(resumed.status, "AlreadyRenewed");
      assert.equal(resumed.checks.after.tax, "Accepted");
      assert.deepEqual(await state(), after);
    } finally {
      await admin.end();
      vi.unstubAllEnvs();
    }
  });
});
