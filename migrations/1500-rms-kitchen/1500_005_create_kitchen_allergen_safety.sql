-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kitchen_allergen_review (
  kitchen_allergen_review_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  allergen_references platform_helpers.uuid_v7[] NOT NULL,
  policy_version_id platform_helpers.uuid_v7 NOT NULL,
  recipe_version_references platform_helpers.uuid_v7[] NOT NULL,
  reviewer_actor_id platform_helpers.uuid_v7 NOT NULL,
  review_outcome text NOT NULL CHECK (review_outcome IN ('Accepted', 'CannotSafelyAccommodate')),
  reviewed_at timestamp with time zone NOT NULL,
  valid_until timestamp with time zone NOT NULL,
  retain_until timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Restricted'),
  CONSTRAINT kitchen_allergen_review_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_allergen_review_id),
  CONSTRAINT kitchen_allergen_review_ticket_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id)
    REFERENCES rms_kitchen.kitchen_ticket (brand_id, store_id, kitchen_ticket_id),
  CONSTRAINT kitchen_allergen_review_time_check CHECK (
    reviewed_at < valid_until AND valid_until <= retain_until
  ),
  CONSTRAINT kitchen_allergen_review_controlled_references_check CHECK (
    cardinality(allergen_references) BETWEEN 1 AND 64
    AND cardinality(recipe_version_references) BETWEEN 1 AND 64
  )
);

CREATE UNIQUE INDEX kitchen_allergen_review_exact_attempt_unique
  ON rms_kitchen.kitchen_allergen_review (
    brand_id, store_id, order_item_id, configuration_digest, kitchen_allergen_review_id
  );
CREATE INDEX kitchen_allergen_review_ticket_history_idx
  ON rms_kitchen.kitchen_allergen_review (
    brand_id, store_id, kitchen_ticket_id, reviewed_at, kitchen_allergen_review_id
  );

CREATE TABLE rms_kitchen.kitchen_allergen_acknowledgement (
  kitchen_allergen_acknowledgement_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_allergen_review_id platform_helpers.uuid_v7 NOT NULL,
  review_digest text NOT NULL CHECK (review_digest ~ '^sha256:[0-9a-f]{64}$'),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_work_item_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  acknowledgement_stage text NOT NULL CHECK (
    acknowledgement_stage IN ('BeforeStart', 'BeforeHandoff')
  ),
  operator_actor_id platform_helpers.uuid_v7 NOT NULL,
  acknowledged_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Restricted'),
  CONSTRAINT kitchen_allergen_acknowledgement_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_allergen_acknowledgement_id),
  CONSTRAINT kitchen_allergen_acknowledgement_review_fk
    FOREIGN KEY (brand_id, store_id, kitchen_allergen_review_id)
    REFERENCES rms_kitchen.kitchen_allergen_review (
      brand_id, store_id, kitchen_allergen_review_id
    ),
  CONSTRAINT kitchen_allergen_acknowledgement_work_item_fk
    FOREIGN KEY (brand_id, store_id, kitchen_ticket_id, kitchen_work_item_id)
    REFERENCES rms_kitchen.kitchen_work_item (
      brand_id, store_id, kitchen_ticket_id, kitchen_work_item_id
    )
);

CREATE UNIQUE INDEX kitchen_allergen_acknowledgement_stage_unique
  ON rms_kitchen.kitchen_allergen_acknowledgement (
    brand_id, store_id, kitchen_allergen_review_id, kitchen_work_item_id,
    acknowledgement_stage, operator_actor_id
  );

CREATE TABLE rms_kitchen.kitchen_allergen_incident_link (
  kitchen_allergen_incident_link_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_allergen_review_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  incident_type text NOT NULL CHECK (
    incident_type IN ('AllergenMismatch', 'UnapprovedSubstitution', 'AllergenExposure')
  ),
  configuration_snapshot_digest text NOT NULL CHECK (
    configuration_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  recipe_snapshot_digest text NOT NULL CHECK (recipe_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  handling_snapshot_digest text NOT NULL CHECK (
    handling_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  compliance_case_id platform_helpers.uuid_v7 NOT NULL,
  availability_kill_switch_action_id platform_helpers.uuid_v7 NOT NULL,
  reporter_actor_id platform_helpers.uuid_v7 NOT NULL,
  reported_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Restricted'),
  CONSTRAINT kitchen_allergen_incident_link_pkey
    PRIMARY KEY (brand_id, store_id, kitchen_allergen_incident_link_id),
  CONSTRAINT kitchen_allergen_incident_link_review_fk
    FOREIGN KEY (brand_id, store_id, kitchen_allergen_review_id)
    REFERENCES rms_kitchen.kitchen_allergen_review (
      brand_id, store_id, kitchen_allergen_review_id
    ),
  CONSTRAINT kitchen_allergen_incident_link_case_unique
    UNIQUE (brand_id, store_id, compliance_case_id),
  CONSTRAINT kitchen_allergen_incident_link_kill_switch_unique
    UNIQUE (brand_id, store_id, availability_kill_switch_action_id)
);

CREATE TRIGGER kitchen_allergen_review_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_allergen_review
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kitchen_allergen_review_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_allergen_review DO INSTEAD NOTHING;
CREATE TRIGGER kitchen_allergen_acknowledgement_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_allergen_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kitchen_allergen_acknowledgement_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_allergen_acknowledgement DO INSTEAD NOTHING;
CREATE TRIGGER kitchen_allergen_incident_link_no_update_trigger
  BEFORE UPDATE ON rms_kitchen.kitchen_allergen_incident_link
  FOR EACH ROW EXECUTE FUNCTION rms_kitchen.reject_kitchen_work_lifecycle_append_only_update();
CREATE RULE kitchen_allergen_incident_link_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_allergen_incident_link DO INSTEAD NOTHING;

ALTER TABLE rms_kitchen.kitchen_allergen_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_allergen_review FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_allergen_acknowledgement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_allergen_acknowledgement FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_allergen_incident_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_allergen_incident_link FORCE ROW LEVEL SECURITY;

CREATE POLICY kitchen_allergen_review_store_scope_policy ON rms_kitchen.kitchen_allergen_review
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kitchen_allergen_acknowledgement_store_scope_policy
  ON rms_kitchen.kitchen_allergen_acknowledgement
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kitchen_allergen_incident_link_store_scope_policy
  ON rms_kitchen.kitchen_allergen_incident_link
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_kitchen.kitchen_allergen_review FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_allergen_acknowledgement FROM PUBLIC;
REVOKE ALL ON TABLE rms_kitchen.kitchen_allergen_incident_link FROM PUBLIC;
