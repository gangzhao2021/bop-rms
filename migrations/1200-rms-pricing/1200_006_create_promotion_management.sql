-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.promotion (
  promotion_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT promotion_brand_code_unique UNIQUE (brand_id, stable_code),
  CONSTRAINT promotion_scope_identity_unique UNIQUE (promotion_id, brand_id),
  CONSTRAINT promotion_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_pricing.promotion_version (
  promotion_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  promotion_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Published','Paused','Archived')),
  promotion_type text NOT NULL CHECK (promotion_type IN ('ItemPercentage','ItemFixed','OrderPercentage','OrderFixed','Threshold','BuyXGetY','HappyHour','Coupon','ManualDiscount')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  threshold_minor numeric,
  benefit_scope text NOT NULL CHECK (benefit_scope IN ('Item','Order')),
  benefit_calculation text NOT NULL CHECK (benefit_calculation IN ('Percentage','Fixed')),
  benefit_rate numeric(18,12),
  benefit_fixed_minor numeric,
  maximum_discount_minor numeric,
  stacking text NOT NULL CHECK (stacking IN ('Exclusive','SameGroupExclusive','Stackable')),
  stacking_group_code text,
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  budget_minor numeric NOT NULL,
  usage_minor numeric NOT NULL,
  usage_count integer NOT NULL CHECK (usage_count >= 0),
  redemption_limit integer NOT NULL CHECK (redemption_limit > 0),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  effective_time_zone text NOT NULL,
  customer_copy_code text NOT NULL CHECK (customer_copy_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT promotion_version_root_fk FOREIGN KEY (promotion_id,brand_id) REFERENCES rms_pricing.promotion(promotion_id,brand_id),
  CONSTRAINT promotion_version_scope_identity_unique UNIQUE (promotion_version_id,promotion_id,brand_id),
  CONSTRAINT promotion_version_number_unique UNIQUE (promotion_id,version_number),
  CONSTRAINT promotion_version_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT promotion_version_stacking_group_check CHECK ((stacking='SameGroupExclusive')=(stacking_group_code IS NOT NULL)),
  CONSTRAINT promotion_version_benefit_check CHECK ((benefit_calculation='Percentage' AND benefit_rate > 0 AND benefit_rate <= 1 AND benefit_fixed_minor IS NULL) OR (benefit_calculation='Fixed' AND benefit_fixed_minor > 0 AND benefit_fixed_minor=trunc(benefit_fixed_minor) AND benefit_rate IS NULL)),
  CONSTRAINT promotion_version_money_check CHECK (budget_minor > 0 AND budget_minor=trunc(budget_minor) AND usage_minor >= 0 AND usage_minor=trunc(usage_minor) AND usage_minor <= budget_minor AND (threshold_minor IS NULL OR (threshold_minor >= 0 AND threshold_minor=trunc(threshold_minor))) AND (maximum_discount_minor IS NULL OR (maximum_discount_minor >= 0 AND maximum_discount_minor=trunc(maximum_discount_minor)))),
  CONSTRAINT promotion_version_usage_check CHECK (usage_count <= redemption_limit)
);
ALTER TABLE rms_pricing.promotion ADD CONSTRAINT promotion_current_version_fk FOREIGN KEY (current_version_id,promotion_id,brand_id) REFERENCES rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id);

CREATE TABLE rms_pricing.promotion_eligibility_reference (
  promotion_eligibility_reference_id platform_helpers.uuid_v7 PRIMARY KEY,
  promotion_version_id platform_helpers.uuid_v7 NOT NULL,
  promotion_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  reference_kind text NOT NULL CHECK (reference_kind IN ('Sellable','Category','Segment')),
  public_reference_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT promotion_eligibility_version_fk FOREIGN KEY (promotion_version_id,promotion_id,brand_id) REFERENCES rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id),
  CONSTRAINT promotion_eligibility_unique UNIQUE (promotion_version_id,reference_kind,public_reference_id)
);

CREATE TABLE rms_pricing.promotion_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  promotion_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft','ReplaceDraft','Publish','Pause','Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_version_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT promotion_operation_root_fk FOREIGN KEY (promotion_id,brand_id) REFERENCES rms_pricing.promotion(promotion_id,brand_id),
  CONSTRAINT promotion_operation_version_fk FOREIGN KEY (result_version_id,promotion_id,brand_id) REFERENCES rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id)
);

CREATE TABLE rms_pricing.promotion_admin_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT promotion_admin_generation_brand_unique UNIQUE (generation_id,brand_id)
);
CREATE TABLE rms_pricing.promotion_admin_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  promotion_id platform_helpers.uuid_v7 NOT NULL,
  promotion_version_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Published','Paused','Archived')),
  promotion_type text NOT NULL,
  scope_summary text NOT NULL,
  stacking text NOT NULL CHECK (stacking IN ('Exclusive','SameGroupExclusive','Stackable')),
  budget_minor numeric NOT NULL CHECK (budget_minor >= 0 AND budget_minor=trunc(budget_minor)),
  usage_minor numeric NOT NULL CHECK (usage_minor >= 0 AND usage_minor=trunc(usage_minor)),
  usage_count integer NOT NULL CHECK (usage_count >= 0),
  conflict_count integer NOT NULL CHECK (conflict_count >= 0),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  schedule_status text NOT NULL CHECK (schedule_status IN ('Active','Scheduled','Ended')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (generation_id,promotion_id),
  CONSTRAINT promotion_admin_projection_generation_fk FOREIGN KEY (generation_id,brand_id) REFERENCES rms_pricing.promotion_admin_projection_generation(generation_id,brand_id)
);
CREATE TABLE rms_pricing.promotion_admin_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT promotion_admin_checkpoint_generation_fk FOREIGN KEY (active_generation_id,brand_id) REFERENCES rms_pricing.promotion_admin_projection_generation(generation_id,brand_id)
);

CREATE RULE promotion_version_no_update AS ON UPDATE TO rms_pricing.promotion_version DO INSTEAD NOTHING;
CREATE RULE promotion_version_no_delete AS ON DELETE TO rms_pricing.promotion_version DO INSTEAD NOTHING;
CREATE RULE promotion_eligibility_no_update AS ON UPDATE TO rms_pricing.promotion_eligibility_reference DO INSTEAD NOTHING;
CREATE RULE promotion_eligibility_no_delete AS ON DELETE TO rms_pricing.promotion_eligibility_reference DO INSTEAD NOTHING;
CREATE RULE promotion_operation_no_update AS ON UPDATE TO rms_pricing.promotion_operation_record DO INSTEAD NOTHING;
CREATE RULE promotion_operation_no_delete AS ON DELETE TO rms_pricing.promotion_operation_record DO INSTEAD NOTHING;
CREATE RULE promotion_generation_no_update AS ON UPDATE TO rms_pricing.promotion_admin_projection_generation DO INSTEAD NOTHING;
CREATE RULE promotion_generation_no_delete AS ON DELETE TO rms_pricing.promotion_admin_projection_generation DO INSTEAD NOTHING;

ALTER TABLE rms_pricing.promotion ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_eligibility_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_eligibility_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_admin_projection_generation ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_admin_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_admin_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_admin_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.promotion_admin_projection_checkpoint ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_pricing.promotion_admin_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY promotion_brand_scope_policy ON rms_pricing.promotion USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_version_brand_scope_policy ON rms_pricing.promotion_version USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_eligibility_brand_scope_policy ON rms_pricing.promotion_eligibility_reference USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_operation_brand_scope_policy ON rms_pricing.promotion_operation_record USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_generation_brand_scope_policy ON rms_pricing.promotion_admin_projection_generation USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_projection_brand_scope_policy ON rms_pricing.promotion_admin_projection USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());
CREATE POLICY promotion_checkpoint_brand_scope_policy ON rms_pricing.promotion_admin_projection_checkpoint USING (brand_id=platform_helpers.current_brand_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id());

REVOKE ALL ON TABLE rms_pricing.promotion,rms_pricing.promotion_version,rms_pricing.promotion_eligibility_reference,rms_pricing.promotion_operation_record,rms_pricing.promotion_admin_projection_generation,rms_pricing.promotion_admin_projection,rms_pricing.promotion_admin_projection_checkpoint FROM PUBLIC;
