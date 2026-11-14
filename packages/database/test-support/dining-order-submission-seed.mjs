import assert from "node:assert/strict";
export async function seedSubmissionCart(client, f) {
  const c = f.cart,
    l = c.lifecycle;
  assert(l);
  await client.query(
    `INSERT INTO rms_ordering.cart
      (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,
       aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,
       idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at,terminal_at,terminal_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      c.cartReference,
      c.brandReference,
      c.storeReference,
      c.orderType,
      c.sourceChannel,
      c.diningSessionReference,
      c.createdByActorReference,
      c.aggregateVersion,
      c.createdAt,
      c.updatedAt,
      l.status,
      l.policyVersionReference,
      l.policyDigest,
      l.idleTimeoutSeconds,
      l.absoluteTimeoutSeconds,
      l.idleExpiresAt,
      l.absoluteExpiresAt,
      l.terminalAt,
      l.terminalReason,
    ],
  );
  for (const item of c.items)
    await client.query(
      `INSERT INTO rms_ordering.cart_line
      (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,customer_note,
       catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12)`,
      [
        item.cartItemReference,
        c.cartReference,
        c.brandReference,
        c.storeReference,
        item.sellableReference,
        item.quantity,
        JSON.stringify(item.optionSelections),
        item.customerNote,
        JSON.stringify(item.catalogSelectionEvidence),
        item.addedByActorReference,
        item.addedByParticipantReference,
        item.addedAt,
      ],
    );
}
