import {
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
const scope = { brandReference: id(1), storeReference: id(2) };
const digest = `sha256:${"a".repeat(64)}`;
const optionRules = [];

export async function seedMenu(admin) {
  await admin.query(
    `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
    [id(1), scope.brandReference, at, id(3)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
    [id(4), id(1), scope.brandReference, at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
    [id(5), id(1), id(4), scope.brandReference, digest, id(6), id(7), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
    [id(8), id(5), id(1), id(4), scope.brandReference, digest, at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
    [id(9), scope.brandReference, id(1), id(10), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,'UTC',$7)`,
    [
      id(9),
      scope.brandReference,
      id(1),
      id(4),
      id(8),
      digest,
      at,
      JSON.stringify([scope.storeReference]),
    ],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
    [id(9), scope.brandReference, id(1), id(11)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Latte"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
    [
      id(9),
      scope.brandReference,
      id(1),
      id(11),
      id(12),
      id(13),
      id(14),
      JSON.stringify(optionRules),
    ],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
    [scope.brandReference, id(1), id(9), id(10), at],
  );
}
