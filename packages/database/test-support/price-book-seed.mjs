/** Explicit synthetic acceptance policy, never a real Store price approval. */
export async function seedPriceBook(admin, priceBook, actorReference) {
  const currencyMetadata = priceBook.currencyMetadata;
  await admin.query(
    "INSERT INTO rms_pricing.price_book (price_book_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$5)",
    [
      priceBook.priceBookReference,
      priceBook.brandReference,
      priceBook.stableCode,
      priceBook.aggregateVersion,
      priceBook.createdAt,
      actorReference,
    ],
  );
  await admin.query(
    "INSERT INTO rms_pricing.price_book_version (price_book_version_id,price_book_id,brand_id,version_number,snapshot_digest,lifecycle,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      priceBook.versionReference,
      priceBook.priceBookReference,
      priceBook.brandReference,
      priceBook.versionNumber,
      priceBook.snapshotDigest,
      priceBook.lifecycle,
      currencyMetadata.currencyCode,
      currencyMetadata.metadataVersion,
      currencyMetadata.metadataVersionReference,
      currencyMetadata.metadataDigest,
      priceBook.createdAt,
    ],
  );
  for (const entry of priceBook.entries)
    await admin.query(
      "INSERT INTO rms_pricing.price_entry (price_entry_id,price_book_version_id,price_book_id,brand_id,sellable_id,scope_kind,scope_id,channel_code,order_type,amount_minor,currency_code,effective_from,effective_until,effective_time_zone,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [
        entry.entryReference,
        priceBook.versionReference,
        priceBook.priceBookReference,
        priceBook.brandReference,
        entry.sellableReference,
        entry.scopeKind,
        entry.scopeReference,
        entry.channelCode,
        entry.orderType,
        entry.amount.amountMinor.toString(),
        entry.amount.currencyCode,
        entry.effectivePeriod.effectiveFrom.instant,
        entry.effectivePeriod.effectiveUntil?.instant ?? null,
        entry.effectivePeriod.timeZone,
        entry.reasonCode,
      ],
    );
  await admin.query(
    "UPDATE rms_pricing.price_book SET current_version_id=$1 WHERE price_book_id=$2",
    [priceBook.versionReference, priceBook.priceBookReference],
  );
}
