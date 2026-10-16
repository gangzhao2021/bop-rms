import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";

/**
 * WP-2423 Q19 step 2: owner-seeded (admin client) Organization, Membership and Permission rows for
 * the Brand-gate sole-operator acceptance tests, and the restricted pilot API role. Only these
 * fixtures are written as owner; every command under test runs as the restricted role.
 */
export async function createPilotApiRole(admin, context, prefix, name = null) {
  const role = name ?? prefix + "_" + context.runId,
    worker = role + "_w";
  for (const name of [role, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const root = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
  return role;
}

export async function dbNow(admin) {
  return (
    await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
  ).rows[0].at.toISOString();
}

/** Brand (Organization) row and the Brand's permission policy state. */
export async function seedBrand(admin, { brandReference, policyReference, from }) {
  await admin.query(
    "INSERT INTO bop_tenant.brand (brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,'SYNTHETIC_Q19B','Synthetic Q19 Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
    [brandReference, from],
  );
  await admin.query(
    "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
    [brandReference, policyReference, from],
  );
}

let permissionNumber = 0;
/** A Brand-level role (no Store) granting the actions; returns its id. */
export async function seedBrandRole(admin, { id, brandReference, roleId, code, actions, from }) {
  await admin.query(
    "INSERT INTO bop_permission.role VALUES ($1,$2,NULL,$3,'Active',$4,NULL,1,$4,$4)",
    [roleId, brandReference, code, from],
  );
  for (const action of actions) {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = id(0xe000 + permissionNumber++);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,NULL,'Active',$5,NULL,1,$5,$5)",
      [id(0xe000 + permissionNumber++), roleId, permission, brandReference, from],
    );
  }
  return roleId;
}

/**
 * An Active Brand member with a Store assignment, a display name, MFA enrollment two hours old
 * (so only a step-up is recent) and the given Brand-level roles.
 */
export async function seedBrandMember(
  admin,
  { id, base, brandReference, storeReference, actorReference, name, roles, from, enrolledAt },
) {
  const membership = id(base),
    assignment = id(base + 1);
  await admin.query(
    "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
    [membership, actorReference, brandReference, id(base + 2), from],
  );
  await admin.query(
    "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
    [assignment, membership, actorReference, brandReference, storeReference, from],
  );
  await admin.query(
    "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
    [membership, brandReference, actorReference, name, id(base + 3), from],
  );
  await admin.query(
    "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1) ON CONFLICT DO NOTHING",
    [actorReference, id(base + 4), enrolledAt],
  );
  for (const [j, roleId] of roles.entries())
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,NULL,1,$6,$6)",
      [id(base + 5 + j), roleId, membership, actorReference, brandReference, from],
    );
}

/** Owner-seeded setting change (the command itself is covered by the Q19 step 1 acceptance). */
export async function seedSoleOperatorSetting(
  admin,
  { id, n, tenantReference, brandReference, actorReference, state, version },
) {
  const at = await dbNow(admin);
  await admin.query(
    "INSERT INTO bop_tenant.brand_sole_operator_setting (tenant_id,brand_id,setting_id,version,state,reason_code,actor_id,actor_mfa_at,recorded_at,operation_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)",
    [
      tenantReference,
      brandReference,
      id(n),
      version,
      state,
      state === "On" ? "OWNER_RUNS_STORE_ALONE" : "OWNER_CHOICE",
      actorReference,
      at,
      id(n + 1),
      id(n + 2),
    ],
  );
}

/**
 * WP-2423 v15 defect (2026-10-16): owner-seeded setting history (test-controlled) continuing the
 * Brand's versions, alternating, until at least `atLeast` versions exist and the latest is
 * `latest`. From version 10 on, a text sort ("9" > "10") read version 9 as the latest. Returns
 * the latest version number. `n` reserves three references per version.
 */
export async function seedSoleOperatorHistory(
  admin,
  { id, n, tenantReference, brandReference, actorReference, atLeast, latest },
) {
  const head = (
    await admin.query(
      "SELECT s.version::int AS version,s.state FROM bop_tenant.brand_sole_operator_setting s WHERE s.brand_id=$1 ORDER BY s.version DESC LIMIT 1",
      [brandReference],
    )
  ).rows[0];
  let version = head?.version ?? 0,
    state = head?.state ?? "Off";
  while (version < atLeast || state !== latest) {
    version += 1;
    state = state === "On" ? "Off" : "On";
    await seedSoleOperatorSetting(admin, {
      id,
      n: n + version * 3,
      tenantReference,
      brandReference,
      actorReference,
      state,
      version,
    });
  }
  return version;
}

let timeStep = 100;
/** A verified second-factor step-up at the Store, `ageMs` old (owner-seeded evidence). */
export async function seedStepUp(
  admin,
  { id, n, brandReference, storeReference, actorReference, ageMs = 0 },
) {
  const at = new Date(Date.parse(await dbNow(admin)) - ageMs).toISOString();
  await admin.query(
    "INSERT INTO bop_identity.workforce_mfa_step_up (step_up_id,brand_id,store_id,actor_id,session_id,method,purpose_code,outcome,rejection_reason,time_step,attempted_at,audit_id) VALUES ($1,$2,$3,$4,$5,'InternalTestTotp','ORGANIZATION_SOLE_OPERATOR_APPROVAL','Verified',NULL,$6,$7,$8)",
    [id(n), brandReference, storeReference, actorReference, id(n + 1), timeStep++, at, id(n + 2)],
  );
  return at;
}

/**
 * The pilot API grants (pilot ACL matrix plus the WP-2423 Q19 additions) a sole-operator gate read
 * needs, for acceptance tests that grant the API role by hand: the Organization setting, Brand
 * holders (Permission, Membership) with names, and the actor's second factor (Identity).
 */
export const soleOperatorReadGrants = [
  "GRANT USAGE ON SCHEMA bop_tenant,bop_permission,bop_membership,bop_identity TO ROLE_",
  "GRANT SELECT ON bop_tenant.brand_sole_operator_setting TO ROLE_",
  "GRANT SELECT ON bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_definition,bop_permission.permission_override TO ROLE_",
  "GRANT SELECT ON bop_membership.membership,bop_membership.store_assignment,bop_membership.member_profile_version TO ROLE_",
  "GRANT SELECT ON bop_identity.workforce_mfa_status,bop_identity.workforce_mfa_step_up TO ROLE_",
  // As in the pilot matrix: the MFA read takes FOR SHARE (column UPDATE privilege only).
  "GRANT UPDATE(actor_id) ON bop_identity.workforce_mfa_status TO ROLE_",
];
