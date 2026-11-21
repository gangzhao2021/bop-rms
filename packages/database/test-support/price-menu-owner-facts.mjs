// Synthetic rows in an isolated acceptance database; no candidate Store activation.
export async function seedPriceMenuOwnerFacts(admin, role, base, id, at) {
  const brand = base.brandReference,
    store = id(704),
    menu = id(800),
    version = id(801);
  const catalogTables = [
    "menu",
    "menu_version",
    "menu_version_store",
    "menu_version_channel",
    "menu_version_order_type",
    "menu_section",
    "sellable_placement",
    "sku",
    "product",
    "product_version",
  ];
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant,rms_catalog TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_tenant.brand,bop_tenant.store," +
      catalogTables.map((table) => "rms_catalog." + table).join(",") +
      " TO " +
      role,
  );
  for (const [table, column] of [
    ["bop_tenant.brand", "brand_id"],
    ["bop_tenant.store", "store_id"],
    ["rms_catalog.menu", "menu_id"],
    ["rms_catalog.menu_version", "menu_version_id"],
    ["rms_catalog.product", "product_id"],
    ["rms_catalog.product_version", "product_version_id"],
    ["rms_catalog.sku", "sku_id"],
  ])
    await admin.query("GRANT UPDATE(" + column + ") ON " + table + " TO " + role);
  await admin.query(
    "INSERT INTO bop_tenant.brand VALUES($1,'PRICE_TEST','Synthetic pricing','en-CA','CAD','Active',1,$2,$2)",
    [brand, at],
  );
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES($1,$2,'PRICE_STORE','Synthetic store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [store, brand, at],
  );
  await admin.query("INSERT INTO rms_catalog.menu VALUES($1,$2,'PRICE_MENU',1,$3,$4,$3)", [
    menu,
    brand,
    at,
    id(701),
  ]);
  await admin.query(
    "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
    [version, menu, brand, JSON.stringify({ "en-CA": "Synthetic" }), at],
  );
  await admin.query("INSERT INTO rms_catalog.menu_version_store VALUES($1,$2,$3,$4)", [
    version,
    menu,
    brand,
    store,
  ]);
  for (const code of ["WEB", "QR"])
    await admin.query("INSERT INTO rms_catalog.menu_version_channel VALUES($1,$2,$3,$4)", [
      version,
      menu,
      brand,
      code,
    ]);
  for (const code of ["DINE_IN", "PICKUP"])
    await admin.query("INSERT INTO rms_catalog.menu_version_order_type VALUES($1,$2,$3,$4)", [
      version,
      menu,
      brand,
      code,
    ]);
  await admin.query(
    "INSERT INTO rms_catalog.product VALUES($1,$2,'PRICE_PRODUCT','PreparedFood','Active',1,$3,$4,$3)",
    [id(802), brand, at, id(701)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
    [id(803), id(802), brand, JSON.stringify({ "en-CA": "Synthetic" }), at],
  );
  await admin.query(
    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'PRICE_SKU','Active',$5,'[]',$6,$9,$10,$7,$8)",
    [
      base.entries[0].sellableReference,
      id(802),
      brand,
      id(803),
      JSON.stringify({ "en-CA": "Synthetic" }),
      "sha256:" + "a".repeat(64),
      at,
      id(701),
      base.unitOfSale ?? "EACH",
      base.unitQuantity ?? "1",
    ],
  );
  await admin.query(
    "INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,'PRICE_SECTION',$5,0)",
    [id(804), version, menu, brand, JSON.stringify({ "en-CA": "Synthetic" })],
  );
  await admin.query(
    "INSERT INTO rms_catalog.sellable_placement VALUES($1,$2,$3,$4,$5,'Sku','Standard',0,false,'{}',$6,$7)",
    [id(805), id(804), menu, brand, base.entries[0].sellableReference, at, id(701)],
  );
  return { brandReference: brand, storeReference: store, menuReference: menu, now: () => at };
}
