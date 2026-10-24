-- bop-rms-migration: 1
-- owner: @rms/kitchen
-- schema: rms_kitchen
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_kitchen.kitchen_creation_record (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_ticket_id platform_helpers.uuid_v7 NOT NULL,
  kitchen_action_record_id platform_helpers.uuid_v7 NOT NULL,
  source_event_id platform_helpers.uuid_v7 NOT NULL,
  confirmation_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL,
  effect_digest text NOT NULL CHECK (effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  creation_record_json jsonb NOT NULL CHECK (
    jsonb_typeof(creation_record_json)='object'
    AND creation_record_json @> '{"recordVersion":1}'::jsonb
    AND jsonb_typeof(creation_record_json->'effect')='object'
  ),
  created_at timestamptz NOT NULL CHECK (
    isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)
  ),
  PRIMARY KEY (brand_id,store_id,kitchen_ticket_id),
  UNIQUE (brand_id,store_id,source_event_id),
  UNIQUE (brand_id,store_id,confirmation_id),
  UNIQUE (brand_id,store_id,order_batch_id),
  UNIQUE (brand_id,store_id,kitchen_action_record_id),
  UNIQUE (brand_id,store_id,audit_id),
  UNIQUE (brand_id,store_id,outbox_event_id),
  FOREIGN KEY (brand_id,store_id,kitchen_ticket_id)
    REFERENCES rms_kitchen.kitchen_ticket(brand_id,store_id,kitchen_ticket_id),
  FOREIGN KEY (brand_id,store_id,kitchen_action_record_id)
    REFERENCES rms_kitchen.kitchen_action_record(brand_id,store_id,kitchen_action_record_id),
  CHECK ((creation_record_json #>> '{effect,ticket,ticketReference}') IS NOT DISTINCT FROM kitchen_ticket_id::text),
  CHECK ((creation_record_json #>> '{effect,ticket,brandReference}') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((creation_record_json #>> '{effect,ticket,storeReference}') IS NOT DISTINCT FROM store_id::text),
  CHECK ((creation_record_json #>> '{effect,ticket,sourceEventReference}') IS NOT DISTINCT FROM source_event_id::text),
  CHECK ((creation_record_json #>> '{effect,ticket,confirmationReference}') IS NOT DISTINCT FROM confirmation_id::text),
  CHECK ((creation_record_json #>> '{effect,ticket,orderBatchReference}') IS NOT DISTINCT FROM order_batch_id::text),
  CHECK ((creation_record_json #>> '{effect,action,actionReference}') IS NOT DISTINCT FROM kitchen_action_record_id::text),
  CHECK ((creation_record_json #>> '{effect,audit,auditId}') IS NOT DISTINCT FROM audit_id::text),
  CHECK ((creation_record_json #>> '{effect,event,eventId}') IS NOT DISTINCT FROM outbox_event_id::text),
  CHECK ((creation_record_json #>> '{effect,effectDigest}') IS NOT DISTINCT FROM effect_digest)
);
CREATE RULE kitchen_creation_record_no_update AS
  ON UPDATE TO rms_kitchen.kitchen_creation_record DO INSTEAD NOTHING;
CREATE RULE kitchen_creation_record_no_delete AS
  ON DELETE TO rms_kitchen.kitchen_creation_record DO INSTEAD NOTHING;
ALTER TABLE rms_kitchen.kitchen_creation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_kitchen.kitchen_creation_record FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_creation_record_scope ON rms_kitchen.kitchen_creation_record
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_kitchen.kitchen_creation_record FROM PUBLIC;
