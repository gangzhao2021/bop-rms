-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.submission_final_validation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 validation_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 cart_version bigint NOT NULL CHECK (cart_version BETWEEN 1 AND 9007199254740991),
 quote_id platform_helpers.uuid_v7 NOT NULL,
 demand_id platform_helpers.uuid_v7 NOT NULL,
 demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
 workflow_id platform_helpers.uuid_v7 NOT NULL,
 workflow_version_id platform_helpers.uuid_v7 NOT NULL,
 workflow_version bigint NOT NULL CHECK (workflow_version BETWEEN 1 AND 9007199254740991),
 transition_id platform_helpers.uuid_v7 NOT NULL,
 reservation_set_id platform_helpers.uuid_v7,
 observed_at timestamptz NOT NULL,
 record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
 record_json jsonb NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,store_id,validation_id),
 UNIQUE (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (tenant_id,brand_id,store_id,submission_id),
 UNIQUE (tenant_id,brand_id,store_id,order_id),
 FOREIGN KEY (tenant_id,brand_id,store_id,reservation_set_id)
   REFERENCES rms_inventory.stock_reservation_set (tenant_id,brand_id,store_id,set_id),
 CHECK (isfinite(observed_at) AND date_trunc('milliseconds',observed_at)=observed_at),
 CHECK (octet_length(record_json::text)<=4194304),
 CHECK ((
   jsonb_typeof(record_json)='object'
   AND jsonb_typeof(record_json->'items')='array'
   AND jsonb_array_length(record_json->'items')<=4096
   AND record_json->>'schemaVersion'='1'
   AND record_json->>'tenantReference'=tenant_id::text
   AND record_json->>'brandReference'=brand_id::text
   AND record_json->>'storeReference'=store_id::text
   AND record_json->>'validationReference'=validation_id::text
   AND record_json->>'operationReference'=operation_id::text
   AND record_json->>'actorReference'=actor_id::text
   AND record_json->>'auditReference'=audit_id::text
   AND record_json->>'orderReference'=order_id::text
   AND record_json->>'submissionReference'=submission_id::text
   AND record_json->>'cartReference'=cart_id::text
   AND record_json->>'cartVersion'=cart_version::text
   AND record_json->>'quoteReference'=quote_id::text
   AND record_json->>'demandReference'=demand_id::text
   AND record_json->>'demandDigest'=demand_digest
   AND record_json->>'workflowReference'=workflow_id::text
   AND record_json->>'workflowVersionReference'=workflow_version_id::text
   AND record_json->>'workflowVersion'=workflow_version::text
   AND record_json->>'transitionReference'=transition_id::text
   AND (record_json->>'observedAt')::timestamptz=observed_at
   AND ((reservation_set_id IS NULL AND record_json->'reservationSet'='null'::jsonb)
     OR (reservation_set_id IS NOT NULL
       AND record_json->'reservationSet'->>'setReference'=reservation_set_id::text))
 ) IS TRUE)
);
CREATE FUNCTION rms_inventory.verify_final_validation_set() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE stored rms_inventory.stock_reservation_set%ROWTYPE;
DECLARE has_reserved boolean;
BEGIN
 SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.record_json->'items') item
   WHERE item->>'disposition'='Reserved') INTO has_reserved;
 IF has_reserved IS DISTINCT FROM (NEW.reservation_set_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Final inventory reservation mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.reservation_set_id IS NOT NULL THEN
   SELECT * INTO stored FROM rms_inventory.stock_reservation_set
   WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
     AND set_id=NEW.reservation_set_id;
   IF NOT FOUND OR stored.record_json IS DISTINCT FROM NEW.record_json->'reservationSet'
     OR stored.submission_id<>NEW.submission_id OR stored.cart_id<>NEW.cart_id
     OR stored.cart_version<>NEW.cart_version OR stored.quote_id<>NEW.quote_id
     OR stored.demand_id<>NEW.demand_id OR stored.demand_digest<>NEW.demand_digest
     OR stored.workflow_id<>NEW.workflow_id OR stored.workflow_version<>NEW.workflow_version
     OR stored.actor_id<>NEW.actor_id OR stored.created_at<>NEW.observed_at THEN
     RAISE EXCEPTION 'Final inventory reservation mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.verify_final_validation_set() FROM PUBLIC;
CREATE TRIGGER final_validation_set BEFORE INSERT ON rms_inventory.submission_final_validation
FOR EACH ROW EXECUTE FUNCTION rms_inventory.verify_final_validation_set();
CREATE TRIGGER final_validation_immutable BEFORE UPDATE OR DELETE ON rms_inventory.submission_final_validation
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_reservation_set_mutation();
CREATE TRIGGER final_validation_no_truncate BEFORE TRUNCATE ON rms_inventory.submission_final_validation
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_reservation_set_mutation();
ALTER TABLE rms_inventory.submission_final_validation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.submission_final_validation FORCE ROW LEVEL SECURITY;
CREATE POLICY final_validation_scope ON rms_inventory.submission_final_validation
USING ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE)
WITH CHECK ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.submission_final_validation FROM PUBLIC;
