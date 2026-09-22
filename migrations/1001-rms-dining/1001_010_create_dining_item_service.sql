-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_item_service_record (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 order_item_id platform_helpers.uuid_v7 NOT NULL,
 service_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 previous_version integer,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
 served_at timestamptz NOT NULL CHECK (isfinite(served_at) AND served_at=date_trunc('milliseconds',served_at)),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=served_at),
 record_json jsonb NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,order_item_id,version),
 UNIQUE (tenant_id,brand_id,store_id,service_id),
 UNIQUE (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (tenant_id,brand_id,store_id,audit_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
 REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,order_item_id,previous_version)
 REFERENCES rms_dining.dining_item_service_record(tenant_id,brand_id,store_id,order_item_id,version),
 CHECK ((version=1 AND previous_version IS NULL) OR (version>1 AND previous_version=version-1)),
 CHECK ((
   jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=8192
   AND record_json->>'tenantReference'=tenant_id::text
   AND record_json->>'brandReference'=brand_id::text
   AND record_json->>'storeReference'=store_id::text
   AND record_json->>'diningSessionReference'=session_id::text
   AND record_json->>'orderReference'=order_id::text
   AND record_json->>'orderBatchReference'=order_batch_id::text
   AND record_json->>'orderItemReference'=order_item_id::text
   AND record_json->>'serviceReference'=service_id::text
   AND record_json->>'operationReference'=operation_id::text
   AND record_json->>'auditReference'=audit_id::text
   AND (record_json->>'itemServiceVersion')::integer=version
   AND (record_json->>'expectedItemServiceVersion')::integer=version-1
   AND (record_json->>'quantity')::integer=quantity
   AND (record_json->>'servedAt')::timestamptz=served_at
   AND (record_json->>'recordedAt')::timestamptz=recorded_at
 ) IS TRUE)
);
CREATE INDEX dining_item_service_order ON rms_dining.dining_item_service_record
 (tenant_id,brand_id,store_id,order_id,order_batch_id);
CREATE RULE dining_item_service_no_update AS ON UPDATE TO rms_dining.dining_item_service_record DO INSTEAD NOTHING;
CREATE RULE dining_item_service_no_delete AS ON DELETE TO rms_dining.dining_item_service_record DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_item_service_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_item_service_record FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_item_service_scope ON rms_dining.dining_item_service_record
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_item_service_record FROM PUBLIC;
