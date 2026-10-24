import { encodeOrderItemSnapshot } from "../../rms/ordering/src/index.ts";

export async function seedAcceptanceOrderHistory(client, seeded) {
  const n = seeded.orderNumberAllocation,
    r = seeded.order,
    b = r.batches[0];
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO rms_ordering.order_number_allocation
      (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
       business_date_configuration_id,business_date_configuration_version,business_date_content_digest,
       time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        n.orderReference,
        n.brandReference,
        n.storeReference,
        n.businessDate,
        n.sequence.toString(),
        n.orderNumber,
        n.allocatedAt,
        n.businessDateResolution.configurationReference,
        n.businessDateResolution.configurationVersion,
        n.businessDateResolution.contentDigest,
        n.businessDateResolution.timeZone,
        n.businessDateResolution.businessDayStartLocalTime,
        n.businessDateResolution.businessDateBoundaryAt,
        n.businessDateResolution.boundaryDisambiguation,
      ],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_header
      (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,
       created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        r.orderReference,
        r.brandReference,
        r.storeReference,
        n.businessDate,
        n.orderNumber,
        r.orderType,
        r.sourceChannel,
        r.diningSessionReference,
        r.createdByActorReference,
        r.submittedByActorReference,
        r.aggregateVersion,
        r.canonicalPhase,
        r.closureStatus,
        r.paymentStatus,
        r.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_submission_record
      (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        seeded.submissionReference,
        r.brandReference,
        r.storeReference,
        r.orderReference,
        seeded.guestSessionReference,
        seeded.submissionIntentHash,
        b.sourceCartReference,
        b.sourceCartVersion,
        b.quoteReference,
        seeded.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_batch
      (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,
       checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        b.orderBatchReference,
        r.brandReference,
        r.storeReference,
        r.orderReference,
        b.submissionReference,
        b.sourceCartReference,
        b.sourceCartVersion,
        b.checkoutValidationReference,
        b.quoteReference,
        b.submittedByActorReference,
        b.submittedAt,
      ],
    );
    // Insert physically in reverse order; only the immutable ordinal establishes original order.
    for (const [index, item] of [...seeded.items.entries()].reverse()) {
      await client.query(
        `INSERT INTO rms_ordering.order_item
        (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
         catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          item.orderItemReference,
          r.brandReference,
          r.storeReference,
          r.orderReference,
          item.orderBatchReference,
          item.cartItemReference,
          item.quantity,
          item.catalog.snapshotDigest,
          item.pricing.quoteInputDigest,
          encodeOrderItemSnapshot(item),
          item.snapshotCapturedAt,
          index + 1,
        ],
      );
    }
    await client.query(
      "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
      [
        seeded.submissionReference,
        r.brandReference,
        r.storeReference,
        r.orderReference,
        seeded.createdAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
