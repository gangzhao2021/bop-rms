import { seedOrdinaryRefundSession } from "./ordinary-refund-session.mjs";

/** Isolated test authority only: actual membership, policy, encrypted session and selected scope. */
export async function seedMerchantAcceptanceSession({
  admin,
  runner,
  role,
  scope,
  actor,
  at,
  kitchenPermission = false,
  pickupPermission = false,
  referencePrefix = "01909968",
  sessionReferencePrefix = "01909967",
}) {
  const id = (n) => referencePrefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const from = new Date(Date.parse(at) - 60000).toISOString();
  const until = new Date(Date.parse(at) + 3600000).toISOString();
  await admin.query(
    "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC_RECEIPT_BRAND','Synthetic Receipt Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
    [scope.brandReference, from],
  );
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_RECEIPT_STORE','Synthetic Receipt Store','America/Toronto','en-CA','CAD','Active',1,$3,$3) ON CONFLICT (store_id) DO NOTHING",
    [scope.storeReference, scope.brandReference, from],
  );
  await admin.query(
    "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
    [scope.brandReference, id(900), from],
  );
  await admin.query(
    "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
    [id(1), actor, scope.brandReference, id(2), from, until],
  );
  await admin.query(
    "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [id(3), id(1), actor, scope.brandReference, scope.storeReference, from, until],
  );
  await admin.query("INSERT INTO bop_permission.role VALUES ($1,$2,$3,$6,'Active',$4,$5,1,$4,$4)", [
    id(4),
    scope.brandReference,
    scope.storeReference,
    from,
    until,
    "synthetic_acceptance_" + referencePrefix,
  ]);
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
    [id(5), id(4), id(1), id(3), actor, scope.brandReference, scope.storeReference, from, until],
  );
  for (const [i, action] of [
    "merchant.access",
    "order.accept",
    "ordering.operate",
    ...(kitchenPermission ? ["kitchen.operate"] : []),
    ...(pickupPermission ? ["fulfillment.pickup.complete", "fulfillment.operate"] : []),
  ].entries()) {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = id(10 + i);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(20 + i), id(4), permission, scope.brandReference, scope.storeReference, from, until],
    );
  }
  if (role !== undefined) {
    // FOR SHARE requires UPDATE privilege; grant only immutable identity for locking.
    await admin.query("GRANT UPDATE(kitchen_ticket_id) ON rms_kitchen.kitchen_ticket TO " + role);

    await admin.query("GRANT USAGE ON SCHEMA rms_kitchen,rms_dining TO " + role);
    await admin.query(
      "GRANT SELECT ON rms_kitchen.kitchen_ticket,rms_kitchen.kitchen_work_item,rms_kitchen.kitchen_order_item_ready_result,rms_dining.dining_item_service_record TO " +
        role,
    );

    await admin.query(
      "GRANT USAGE ON SCHEMA bop_identity,bop_membership,bop_permission,bop_tenant TO " + role,
    );
    await admin.query("GRANT SELECT,UPDATE ON bop_identity.authentication_session TO " + role);
    await admin.query(
      "GRANT SELECT ON bop_identity.browser_session_selection,bop_membership.membership,bop_membership.store_assignment,bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_definition,bop_permission.permission_grant,bop_permission.permission_override TO " +
        role,
    );
    await admin.query("GRANT SELECT,UPDATE ON bop_tenant.brand,bop_tenant.store TO " + role);
    // Internal isolated owner-composition role: public readers retain no mutation authority.
    await admin.query(
      "GRANT UPDATE ON bop_membership.membership,bop_membership.store_assignment,bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_definition,bop_permission.permission_grant,bop_permission.permission_override TO " +
        role,
    );
  }
  const session = await seedOrdinaryRefundSession({
    client: admin,
    runner: () => runner,
    scope,
    requester: actor,
    at,
    referencePrefix: sessionReferencePrefix,
  });
  return {
    ...session,
    revokePickupQueue: () =>
      admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(kitchenPermission ? 25 : 24)],
      ),
    revokePickup: () =>
      admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(kitchenPermission ? 24 : 23)],
      ),
    revokeKitchen: () =>
      admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(23)],
      ),
    revoke: () =>
      admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(21)],
      ),
  };
}
