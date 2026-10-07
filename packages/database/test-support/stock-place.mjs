/**
 * WP-2423 / DEC-INV-LOCATIONS: registers a synthetic, active Stock Site and Storage Location so an
 * isolated test may open stock accounts at them. Idempotent per id; never marked default. Not a real
 * Store layout. Run with the isolated database owner connection outside any scoped role transaction.
 */
export async function ensureSyntheticStockPlace(
  admin,
  { tenantId, brandId, storeId, stockSiteId, locationId, at, actorId = locationId },
) {
  const code = (prefix, reference) =>
    prefix + reference.replaceAll("-", "").slice(-12).toUpperCase();
  const site = await admin.query(
    `INSERT INTO rms_inventory.stock_site
     (tenant_id,brand_id,store_id,stock_site_id,site_kind,code,is_default,created_at,created_by_actor_id)
     VALUES ($1,$2,$3,$4,'Store',$5,false,$6,$7) ON CONFLICT DO NOTHING`,
    [tenantId, brandId, storeId, stockSiteId, code("S", stockSiteId), at, actorId],
  );
  if (site.rowCount === 1)
    await admin.query(
      `INSERT INTO rms_inventory.stock_site_version
       (tenant_id,brand_id,store_id,stock_site_id,version,lifecycle,snapshot_json,recorded_at)
       VALUES ($1,$2,$3,$4,1,'Active',$5,$6)`,
      [
        tenantId,
        brandId,
        storeId,
        stockSiteId,
        {
          schemaVersion: 1,
          tenantReference: tenantId,
          brandReference: brandId,
          storeReference: storeId,
          stockSiteReference: stockSiteId,
          siteKind: "Store",
          code: code("S", stockSiteId),
          isDefault: false,
          aggregateVersion: 1,
          lifecycle: "Active",
          localizedNames: { en: "Synthetic stock site" },
          createdBy: actorId,
          createdAt: at,
          updatedBy: actorId,
          updatedAt: at,
        },
        at,
      ],
    );
  const location = await admin.query(
    `INSERT INTO rms_inventory.storage_location
     (tenant_id,brand_id,store_id,location_id,stock_site_id,code,is_default,created_at,created_by_actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8) ON CONFLICT DO NOTHING`,
    [tenantId, brandId, storeId, locationId, stockSiteId, code("L", locationId), at, actorId],
  );
  if (location.rowCount === 1)
    await admin.query(
      `INSERT INTO rms_inventory.storage_location_version
       (tenant_id,brand_id,store_id,location_id,version,lifecycle,snapshot_json,recorded_at)
       VALUES ($1,$2,$3,$4,1,'Active',$5,$6)`,
      [
        tenantId,
        brandId,
        storeId,
        locationId,
        {
          schemaVersion: 1,
          tenantReference: tenantId,
          brandReference: brandId,
          storeReference: storeId,
          locationReference: locationId,
          stockSiteReference: stockSiteId,
          code: code("L", locationId),
          isDefault: false,
          aggregateVersion: 1,
          lifecycle: "Active",
          temperatureZone: "Ambient",
          sortOrder: 0,
          localizedNames: { en: "Synthetic location" },
          createdBy: actorId,
          createdAt: at,
          updatedBy: actorId,
          updatedAt: at,
        },
        at,
      ],
    );
}
