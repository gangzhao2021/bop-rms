// Explicit synthetic publication and commercial facts for WP-2402 composition acceptance.
export async function seedCartCatalog(admin, id, at, { taxClassificationReference = null } = {}) {
  const digest = "sha256:" + "a".repeat(64);
  await admin.query(
    `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
    [id(1), id(2), at, id(3)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
    [id(4), id(1), id(2), at],
  );
  // Menu content precedes its publication (a submitted version is frozen, DEC-MENU-REVISION).
  await admin.query(
    "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
    [id(4), id(1), id(2), id(20)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
    [id(4), id(1), id(2)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,'PICKUP')",
    [id(4), id(1), id(2)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
    [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
    [id(8), id(5), id(1), id(4), id(2), digest, at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
    [id(9), id(2), id(1), id(10), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["CUSTOMER_PWA"]'::jsonb,'["PICKUP"]'::jsonb,'UTC',$7)`,
    [id(9), id(2), id(1), id(4), id(8), digest, at, JSON.stringify([id(20)])],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
    [id(9), id(2), id(1), id(11)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Latte"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
    [id(9), id(2), id(1), id(11), id(12), id(13), id(14), JSON.stringify([])],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
    [id(2), id(1), id(9), id(10), at],
  );

  await admin.query(
    "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'UTC',$5,NULL,$6,$7,$5)",
    [id(50), id(8), id(1), id(2), at, digest, id(7)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC','PreparedFood','Active',1,$3,$4,$3)",
    [id(40), id(2), at, id(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at,tax_classification_id) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5,$6)",
    [
      id(14),
      id(40),
      id(2),
      JSON.stringify({ "en-CA": "Synthetic product" }),
      at,
      taxClassificationReference,
    ],
  );
  await admin.query(
    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)",
    [
      id(13),
      id(40),
      id(2),
      id(14),
      JSON.stringify({ "en-CA": "Synthetic SKU" }),
      digest,
      at,
      id(3),
    ],
  );
  await admin.query(
    "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_RULE',1,'Active',$3,$4,'[\"CUSTOMER_PWA\"]'::jsonb,'[\"PICKUP\"]'::jsonb,$5,NULL,'Available',10,'SYNTHETIC_AVAILABLE',$5,$6,$5)",
    [id(60), id(2), id(13), id(20), at, id(3)],
  );
}
export const cartCatalogTables = [
  "availability_rule",
  "menu_publication_revision",
  "menu_publication_release",
  "menu_release_effective_period",
  "menu_release_effective_end",
  "menu_version_store",
  "menu_version_channel",
  "menu_version_order_type",
  "published_menu_projection_generation",
  "published_menu_projection",
  "published_menu_projection_section",
  "published_menu_projection_sellable",
  "published_menu_projection_checkpoint",
  "product",
  "product_version",
  "sku",
  "option_set",
  "option_set_version",
  "option",
  "option_conflict",
  "product_option_binding",
  "product_option_binding_option",
  "product_option_binding_sku_scope",
  "product_option_binding_channel",
];

export async function seedCheckoutCatalog(admin, id, at, cart, scope) {
  const attached = cart.items[0].catalogSelectionEvidence;
  const catalogId = (n) =>
    n === 2
      ? scope.brandReference
      : n === 20
        ? scope.storeReference
        : n === 13
          ? cart.items[0].sellableReference
          : n === 14
            ? attached.productVersionReference
            : n === 4
              ? attached.menuVersionReference
              : id(200000 + n);
  // Seed the publication with the exact fixture channel from the start; published history is immutable.
  await seedCartCatalog(
    {
      query: (sql, values) =>
        admin.query(
          sql
            .replaceAll("CUSTOMER_PWA", attached.catalogChannelCode)
            .replaceAll("PICKUP", attached.catalogOrderTypeCode),
          values,
        ),
    },
    catalogId,
    at,
  );
  const names = JSON.stringify({ "en-CA": "Synthetic option" });
  const setId = id(200100),
    versionId = attached.ruleEvidence[0].optionSetVersionReference,
    bindingId = attached.ruleEvidence[0].bindingReference,
    optionId = cart.items[0].optionSelections[0].optionReference;
  await admin.query(
    "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_OPTION','Draft',1,$3,$4,$3)",
    [setId, scope.brandReference, at, catalogId(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'SingleChoice',1,1,false,1,1,$5,$5)",
    [versionId, setId, scope.brandReference, names, at],
  );
  await admin.query(
    "INSERT INTO rms_catalog.option(option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC','Active',$5::jsonb,'{}'::jsonb,0,true,$6,$7)",
    [optionId, versionId, setId, scope.brandReference, names, at, catalogId(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_option_binding(binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed) VALUES($1,$2,$3,$4,$5,$6,'CHOICE',0,1,1,false)",
    [
      bindingId,
      attached.productVersionReference,
      catalogId(40),
      scope.brandReference,
      setId,
      versionId,
    ],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_option_binding_option(binding_id,product_id,brand_id,option_id,option_set_id,default_quantity) VALUES($1,$2,$3,$4,$5,1)",
    [bindingId, catalogId(40), scope.brandReference, optionId, setId],
  );

  return { attached, catalogId };
}
