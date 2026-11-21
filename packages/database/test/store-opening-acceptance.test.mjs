import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  MerchantStoreOpeningError,
  recordStoreOpening,
} from "../../../apps/api/src/merchant-store-opening.ts";
import {
  assignMemberToStore,
  listBrandMembersNotAtStore,
  listStoreMembers,
} from "../../bop/membership/src/index.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: the Brand's Owner opens another Store
 * (TEST "DEMO Store 2 – not production"). As the restricted pilot API role with the rendered grants:
 * 1. the Store is recorded (Active organisation, the Brand's, its own time zone), the opener gets
 *    their place there on their existing Membership, the opening and an audit record name them and
 *    the Store they opened it from; the caller's Store scope is restored;
 * 2. a retry of the same request answers AlreadyOpened and writes nothing; the same reference with
 *    another request is a Conflict; another request with a code the Brand already uses is CodeTaken;
 * 3. the opening record is append-only;
 * 4. the Brand now has two Stores, so the single-Store menu exception stops (as designed).
 */
it("the Brand's Owner opens a second Store once, recorded and audited", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_open" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const brandReference = id(2),
      storeOne = id(3),
      owner = id(4),
      operation = "01909a2e-1000-7000-8000-000000000010";
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_sto");
      const from = new Date(Date.parse(await dbNow(admin)) - 3 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [storeOne, brandReference, from],
      );
      const ownerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        // The real Brand Owner template (catalog v21); who may open is checked in
        // brand-template-authority-acceptance.
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference: storeOne,
        actorReference: owner,
        name: "Sam",
        roles: [ownerRole],
        from,
        enrolledAt: from,
      });
      const membership = id(400);
      // A cook who works only at the first Store (segment 8: added to the second one later).
      const cookRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(320),
        // A real Brand template that is not the Brand Owner's.
        code: "recipe_developer",
        actions: brandRoleTemplateActions("recipe-developer"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference: storeOne,
        actorReference: id(6),
        name: "Kai",
        roles: [cookRole],
        from,
        enrolledAt: from,
      });
      const run = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query("SET LOCAL statement_timeout = '15s'");
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, storeOne],
          );
          const value = await work({
            query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
          });
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const command = {
        operationReference: operation,
        code: "demo_02",
        displayName: "  DEMO Store 2 – not   production ",
        timeZone: "America/Vancouver",
        locale: "en-CA",
      };
      const open = (overrides = {}, at = new Date(Date.parse(from) + 3600_000).toISOString()) =>
        run(async (tx) => {
          const result = await recordStoreOpening(tx, {
            command: { ...command, ...overrides },
            brandReference,
            openedFromStoreReference: storeOne,
            actorReference: owner,
            membershipReference: membership,
            openedAt: at,
          });
          // The caller's own Store scope is back for the rest of the transaction.
          const [scope] = (
            await tx.query(
              "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
            )
          ).rows;
          assert.deepEqual(scope, { brand: brandReference, store: storeOne });
          return result;
        });
      const opened = await open();
      assert.deepEqual(opened, { status: "Opened", storeReference: operation });

      const scoped = async (store, sql, values) => {
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
          [brandReference, store],
        );
        return (await admin.query(sql, values)).rows;
      };
      assert.deepEqual(
        await scoped(
          operation,
          "SELECT code,display_name,time_zone,locale,lifecycle FROM bop_tenant.store WHERE store_id=$1",
          [operation],
        ),
        [
          {
            code: "DEMO_02",
            display_name: "DEMO Store 2 – not production",
            time_zone: "America/Vancouver",
            locale: "en-CA",
            lifecycle: "Active",
          },
        ],
      );
      // The opener's place at the new Store, on their existing Membership (one Membership).
      assert.deepEqual(
        await scoped(
          operation,
          "SELECT membership_id::text m,actor_id::text a,lifecycle FROM bop_membership.store_assignment WHERE store_id=$1",
          [operation],
        ),
        [{ m: membership, a: owner, lifecycle: "Active" }],
      );
      const [opening] = await scoped(
        operation,
        "SELECT opened_from_store_id::text from_store,actor_id::text actor,audit_id::text audit FROM bop_tenant.store_opening WHERE opening_id=$1",
        [operation],
      );
      assert.deepEqual(
        { from: opening.from_store, actor: opening.actor },
        { from: storeOne, actor: owner },
      );
      assert.deepEqual(
        await scoped(
          operation,
          "SELECT actor_reference::text actor,target_id::text target,reason_code FROM platform_audit.audit_record WHERE action_code='STORE_OPENED' AND audit_id=$1",
          [opening.audit],
        ),
        [{ actor: owner, target: operation, reason_code: "OWNER_OPENED_STORE" }],
      );
      // Store One's scope (the pilot role) sees none of the new Store's records.
      assert.deepEqual(
        await run(async (tx) => [
          (await tx.query("SELECT count(*)::int n FROM bop_tenant.store_opening", [])).rows[0].n,
          (
            await tx.query(
              "SELECT count(*)::int n FROM bop_membership.store_assignment WHERE store_id=$1",
              [operation],
            )
          ).rows[0].n,
        ]),
        [0, 0],
      );

      // A retry answers from the record; nothing new is written.
      assert.deepEqual(await open({}, new Date(Date.parse(from) + 3700_000).toISOString()), {
        status: "AlreadyOpened",
        storeReference: operation,
      });
      assert.equal(
        (
          await scoped(
            operation,
            "SELECT count(*)::int n FROM bop_membership.store_assignment WHERE store_id=$1",
            [operation],
          )
        )[0].n,
        1,
      );
      await assert.rejects(open({ displayName: "Another Store" }), (error) => {
        assert.ok(error instanceof MerchantStoreOpeningError);
        assert.equal(error.code, "Conflict");
        return true;
      });
      await assert.rejects(
        open({ operationReference: "01909a2e-1000-7000-8000-000000000020", code: "DEMO_01" }),
        (error) => error instanceof MerchantStoreOpeningError && error.code === "CodeTaken",
      );
      // An unknown time zone or locale never reaches the database.
      await assert.rejects(
        open({ operationReference: "01909a2e-1000-7000-8000-000000000030", timeZone: "UTC" }),
        (error) => error instanceof MerchantStoreOpeningError && error.code === "Invalid",
      );

      // Append-only.
      await admin.query("RESET ROLE");
      for (const sql of [
        "UPDATE bop_tenant.store_opening SET code='X'",
        "DELETE FROM bop_tenant.store_opening",
      ])
        await assert.rejects(scoped(operation, sql, []), /append-only store opening/u);

      // Segment 8: at the new Store, the Brand's other members are listed by name (the opener is
      // already there); adding the cook gives them a place there on their existing Membership.
      const atStoreTwo = (work) =>
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, operation],
          );
          return work(tx);
        });
      assert.deepEqual(
        (
          await atStoreTwo((tx) =>
            listBrandMembersNotAtStore(tx, { brandReference, storeReference: operation }),
          )
        ).map((member) => [member.actorReference, member.displayName]),
        [[id(6), "Kai"]],
      );
      await atStoreTwo((tx) =>
        assignMemberToStore(tx, {
          brandReference,
          storeReference: operation,
          actorReference: id(6),
          membershipReference: id(600),
          storeAssignmentReference: "01909a2e-1000-7000-8000-000000000060",
          at: new Date(Date.parse(from) + 3800_000).toISOString(),
        }),
      );
      assert.deepEqual(
        await atStoreTwo((tx) =>
          listBrandMembersNotAtStore(tx, { brandReference, storeReference: operation }),
        ),
        [],
      );
      assert.deepEqual(
        (
          await atStoreTwo((tx) =>
            listStoreMembers(tx, { brandReference, storeReference: operation }),
          )
        )
          .map((member) => member.actorReference)
          .sort(),
        [owner, id(6)].sort(),
      );
      // Once at a Store; the first Store's own list is unchanged.
      await assert.rejects(
        atStoreTwo((tx) =>
          assignMemberToStore(tx, {
            brandReference,
            storeReference: operation,
            actorReference: id(6),
            membershipReference: id(600),
            storeAssignmentReference: "01909a2e-1000-7000-8000-000000000061",
            at: new Date(Date.parse(from) + 3900_000).toISOString(),
          }),
        ),
        { code: "MEMBER_DIRECTORY_IDEMPOTENCY_CONFLICT" },
      );
      assert.deepEqual(
        await run((tx) =>
          listBrandMembersNotAtStore(tx, { brandReference, storeReference: storeOne }),
        ),
        [],
      );

      // Two Stores: the single-Store menu exception no longer applies to this Brand.
      assert.equal(
        await run(
          async (tx) =>
            (
              await tx.query("SELECT bop_tenant.brand_has_single_store($1,$2) AS one", [
                brandReference,
                storeOne,
              ])
            ).rows[0].one,
        ),
        false,
      );
    } finally {
      await admin.end();
    }
  });
});
