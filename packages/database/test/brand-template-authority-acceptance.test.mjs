import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { brandOwnerAuthority } from "../../../apps/api/src/merchant-sole-operator.ts";
import { storeOpeningPermission } from "../../../apps/api/src/merchant-store-opening.ts";
import { storePricePermission } from "../../../apps/api/src/merchant-store-prices.ts";
import { storeReportsReadPermission } from "../../../apps/api/src/persistent-merchant-store-reports.ts";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "../../bop/membership/src/index.ts";
import {
  brandRoleTemplateActions,
  createPostgresCurrentPermissionPolicySource,
  storeRoleTemplateActions,
} from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3a-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, v15 2026-10-31 (coordinator): the Brand Owner
 * could not open a Store, because segment 3a asked for a code no real role template holds and its
 * acceptance granted that code by hand. Here every role comes from the real templates
 * (`brandRoleTemplateActions`, `storeRoleTemplateActions`, catalog v21) and each permission check
 * segments 3–9 added is decided by the real Permission policy, under the restricted pilot API role,
 * for a Brand Owner (Brand role, assigned at both Stores), a Store Owner and a Store Manager (Store
 * roles at Store One) and an Area Manager (Store roles at both Stores).
 */
it("segments 3–9: each new check passes exactly the real templates meant to pass it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_tpl_auth" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const brandReference = id(2),
      storeOne = id(3),
      storeTwo = id(6);
    const actors = {
      brandOwner: id(10),
      storeOwner: id(11),
      storeManager: id(12),
      areaManager: id(13),
    };
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_tpl");
      const from = new Date(Date.parse(await dbNow(admin)) - 3 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      for (const [store, code] of [
        [storeOne, "STORE_ONE"],
        [storeTwo, "STORE_TWO"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD','Active',1,$5,$5)",
          [store, brandReference, code, "Synthetic " + code, from],
        );
      const brandOwnerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(100),
        code: "brand_owner",
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      let next = 0x2000;
      /** A Store role of the real template at one Store, as Store role provisioning makes it. */
      const storeRole = async (template, code, store) => {
        const roleId = id(next++);
        await admin.query(
          "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [roleId, brandReference, store, code, from],
        );
        for (const action of storeRoleTemplateActions(template)) {
          let permission = (
            await admin.query(
              "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
              [action],
            )
          ).rows[0]?.permission_id;
          if (!permission) {
            permission = id(next++);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
              [permission, action, from],
            );
          }
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
            [id(next++), roleId, permission, brandReference, store, from],
          );
        }
        return roleId;
      };
      const roles = {
        owner: await storeRole("owner", "store_owner", storeOne),
        manager: await storeRole("store-manager", "store_manager", storeOne),
        areaOne: await storeRole("area-manager", "area_manager", storeOne),
        areaTwo: await storeRole("area-manager", "area_manager", storeTwo),
      };
      // Members: each works at Store One; the Brand Owner and Area Manager also at Store Two.
      const bases = {
        brandOwner: 400,
        storeOwner: 420,
        storeManager: 440,
        areaManager: 460,
      };
      for (const [name, actor] of Object.entries(actors))
        await seedBrandMember(admin, {
          id,
          base: bases[name],
          brandReference,
          storeReference: storeOne,
          actorReference: actor,
          name,
          roles: name === "brandOwner" ? [brandOwnerRole] : [],
          from,
          enrolledAt: from,
        });
      const membership = (name) => id(bases[name]);
      const storeAssignment = (name, store) =>
        store === storeOne ? id(bases[name] + 1) : id(bases[name] + 15);
      for (const name of ["brandOwner", "areaManager"])
        await admin.query(
          "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
          [
            storeAssignment(name, storeTwo),
            membership(name),
            actors[name],
            brandReference,
            storeTwo,
            from,
          ],
        );
      const assign = (name, roleId, store) =>
        admin.query(
          "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,NULL,1,$8,$8)",
          [
            id(next++),
            roleId,
            membership(name),
            storeAssignment(name, store),
            actors[name],
            brandReference,
            store,
            from,
          ],
        );
      await assign("storeOwner", roles.owner, storeOne);
      await assign("storeManager", roles.manager, storeOne);
      await assign("areaManager", roles.areaOne, storeOne);
      await assign("areaManager", roles.areaTwo, storeTwo);

      // The real Permission policy's decision, as the merchant scopes ask it (Brand: no Store).
      const at = new Date().toISOString();
      const brand = createBrand({
        brandReference,
        code: "SYNTHETIC_Q19B",
        displayName: "Synthetic Q19 Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      const storeOf = (storeReference) =>
        createStore({
          storeReference,
          brandReference,
          code: storeReference === storeOne ? "STORE_ONE" : "STORE_TWO",
          displayName: "Synthetic Store",
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: from,
          updatedAt: from,
        });
      const allowed = async (name, scope, actions) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, scope === "Brand" ? "" : scope],
          );
          const actor = {
            actorType: "User",
            actorReference: actors[name],
            accountKind: "Workforce",
            status: "Active",
            authenticationMethod: "Oidc",
            verificationLevel: "SingleFactor",
            authenticatedAt: at,
            recentMfaAt: null,
          };
          const store = scope === "Brand" ? null : storeOf(scope);
          const tenantContext = createTenantContext(actor, brand, store, at);
          const memberships = createPostgresCurrentMembershipSource(
            admin,
            createTenantContext(actor, brand, storeOf(storeOne), at),
          );
          const member = resolveActiveMembership(
            await memberships.findMemberships(actors[name], brand.brandReference),
            actors[name],
            brand.brandReference,
            at,
          );
          let assignment = null;
          if (store !== null) {
            const here = createPostgresCurrentMembershipSource(admin, tenantContext);
            assignment = resolveActiveStoreAssignment(
              member,
              await here.findStoreAssignments(member.membershipReference, store.storeReference),
              store.storeReference,
              at,
            );
          }
          const result = await createPostgresCurrentPermissionPolicySource(
            admin,
          ).authorizeActionsWithRoles({
            tenantContext,
            membership: member,
            storeAssignment: assignment,
            actions: Object.freeze(actions),
          });
          return result.decisions.every((decision) => decision.effect === "Allow");
        } catch {
          return false;
        } finally {
          await admin.query("ROLLBACK");
        }
      };
      const passing = async (scope, actions) => {
        const found = [];
        for (const name of Object.keys(actors))
          if (await allowed(name, scope, actions)) found.push(name);
        return found;
      };

      // Each check, the code it asks for, and who passes it with the real templates.
      const table = {
        "3a open a Store (Brand)": await passing("Brand", [storeOpeningPermission]),
        "9a list Brand menu changes directly (Brand)": await passing("Brand", [
          brandOwnerAuthority,
        ]),
        "9b change this Store's price (Store One)": await passing(storeOne, [
          "merchant.access",
          storePricePermission,
        ]),
        "9b show or hide an item here (Store One)": await passing(storeOne, [
          "merchant.access",
          "catalog.sku.availability.manage",
        ]),
        "8 add someone from another Store (Store One)": await passing(storeOne, [
          "merchant.access",
          "organization.staff.manage",
        ]),
        "7 another Store's tonight (Store Two)": await passing(storeTwo, [
          "merchant.access",
          storeReportsReadPermission,
        ]),
      };
      assert.deepEqual(table, {
        // Opening a Store is Brand Owner authority, the same definition as 2000_134.
        "3a open a Store (Brand)": ["brandOwner"],
        "9a list Brand menu changes directly (Brand)": ["brandOwner"],
        "9b change this Store's price (Store One)": [
          "brandOwner",
          "storeOwner",
          "storeManager",
          "areaManager",
        ],
        "9b show or hide an item here (Store One)": [
          "brandOwner",
          "storeOwner",
          "storeManager",
          "areaManager",
        ],
        "8 add someone from another Store (Store One)": ["brandOwner", "storeOwner"],
        "7 another Store's tonight (Store Two)": ["areaManager"],
      });
      assert.equal(storeOpeningPermission, brandOwnerAuthority);
    } finally {
      await admin.end();
    }
  });
}, 240_000);
