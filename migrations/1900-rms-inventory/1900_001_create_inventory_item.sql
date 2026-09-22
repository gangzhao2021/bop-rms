-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_inventory;
REVOKE ALL ON SCHEMA rms_inventory FROM PUBLIC;

CREATE TABLE rms_inventory.inventory_item (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  item_type text NOT NULL CHECK (item_type IN ('RawMaterial','Packaging','SemiFinished','FinishedGood','NonFoodSupply')),
  created_at timestamptz NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,item_id),
  UNIQUE (tenant_id,brand_id,internal_code),
  CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at)
);
CREATE TABLE rms_inventory.inventory_item_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,item_id,version),
  FOREIGN KEY (tenant_id,brand_id,item_id)
    REFERENCES rms_inventory.inventory_item (tenant_id,brand_id,item_id),
  CHECK (isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
  CHECK ((
    snapshot_json->>'tenantReference'=tenant_id::text
    AND snapshot_json->>'brandReference'=brand_id::text
    AND snapshot_json->>'itemReference'=item_id::text
    AND snapshot_json->>'aggregateVersion'=version::text
    AND snapshot_json->>'updatedAt'=to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) IS TRUE)
);
CREATE TABLE rms_inventory.inventory_item_operation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  item_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('Create','Update','Activate','Deactivate','Archive','Restore','SetReorderPolicy')),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,operation_id),
  UNIQUE (tenant_id,brand_id,item_id,version),
  FOREIGN KEY (tenant_id,brand_id,item_id,version)
    REFERENCES rms_inventory.inventory_item_version (tenant_id,brand_id,item_id,version),
  CHECK ((action='Create')=(version=1))
);

CREATE FUNCTION rms_inventory.reject_item_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Inventory Item history is append-only' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.reject_item_history_mutation() FROM PUBLIC;

CREATE FUNCTION rms_inventory.enforce_item_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE root rms_inventory.inventory_item%ROWTYPE;
DECLARE previous rms_inventory.inventory_item_version%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Inventory writes require read committed' USING ERRCODE='25000';
  END IF;
  SELECT * INTO STRICT root FROM rms_inventory.inventory_item
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id FOR UPDATE;
  IF (NEW.snapshot_json->>'internalCode'=root.internal_code
      AND NEW.snapshot_json->>'itemType'=root.item_type
      AND NEW.snapshot_json->>'createdBy'=root.created_by_actor_id::text
      AND NEW.snapshot_json->>'createdAt'=to_char(root.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Inventory Item identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM rms_inventory.inventory_item_version
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND item_id=NEW.item_id
    ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.version<>previous.version+1 OR NEW.recorded_at<previous.recorded_at THEN
      RAISE EXCEPTION 'Inventory Item version conflict' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.version<>1 OR NEW.recorded_at<>root.created_at THEN
    RAISE EXCEPTION 'Inventory Item initial version invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_item_version() FROM PUBLIC;
CREATE TRIGGER inventory_item_version_sequence BEFORE INSERT ON rms_inventory.inventory_item_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_item_version();

CREATE TRIGGER inventory_item_immutable BEFORE UPDATE OR DELETE ON rms_inventory.inventory_item
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER inventory_item_no_truncate BEFORE TRUNCATE ON rms_inventory.inventory_item
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.inventory_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.inventory_item FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_scope ON rms_inventory.inventory_item
USING ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE)
WITH CHECK ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.inventory_item FROM PUBLIC;

CREATE TRIGGER inventory_item_version_immutable BEFORE UPDATE OR DELETE ON rms_inventory.inventory_item_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER inventory_item_version_no_truncate BEFORE TRUNCATE ON rms_inventory.inventory_item_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.inventory_item_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.inventory_item_version FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_version_scope ON rms_inventory.inventory_item_version
USING ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE)
WITH CHECK ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.inventory_item_version FROM PUBLIC;

CREATE TRIGGER inventory_item_operation_immutable BEFORE UPDATE OR DELETE ON rms_inventory.inventory_item_operation
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER inventory_item_operation_no_truncate BEFORE TRUNCATE ON rms_inventory.inventory_item_operation
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.inventory_item_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.inventory_item_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_operation_scope ON rms_inventory.inventory_item_operation
USING ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE)
WITH CHECK ((brand_id=platform_helpers.current_brand_id()
 AND tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.inventory_item_operation FROM PUBLIC;
