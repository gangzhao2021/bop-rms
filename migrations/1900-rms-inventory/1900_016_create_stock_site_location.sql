-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-INV-LOCATIONS (Section 30.4): Inventory-owned Stock Site and Storage Location master
-- data with append-only versions, idempotent operations and Store-scoped RLS. Stock accounts may only
-- be opened at a registered, active location of the account's site.
CREATE TABLE rms_inventory.stock_site (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  stock_site_id platform_helpers.uuid_v7 NOT NULL,
  site_kind text NOT NULL CHECK (site_kind IN ('Store','Warehouse')),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  is_default boolean NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,stock_site_id),
  UNIQUE (tenant_id,brand_id,store_id,code),
  CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at)
);
CREATE UNIQUE INDEX stock_site_one_default ON rms_inventory.stock_site (tenant_id,brand_id,store_id)
  WHERE is_default;
CREATE TABLE rms_inventory.stock_site_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  stock_site_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active','Inactive')),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,stock_site_id,version),
  FOREIGN KEY (tenant_id,brand_id,store_id,stock_site_id)
    REFERENCES rms_inventory.stock_site (tenant_id,brand_id,store_id,stock_site_id),
  CHECK (isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
  CHECK ((
    snapshot_json->>'schemaVersion'='1'
    AND snapshot_json->>'tenantReference'=tenant_id::text
    AND snapshot_json->>'brandReference'=brand_id::text
    AND snapshot_json->>'storeReference'=store_id::text
    AND snapshot_json->>'stockSiteReference'=stock_site_id::text
    AND snapshot_json->>'aggregateVersion'=version::text
    AND snapshot_json->>'lifecycle'=lifecycle
    AND snapshot_json->>'updatedAt'=to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) IS TRUE)
);
CREATE TABLE rms_inventory.storage_location (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  location_id platform_helpers.uuid_v7 NOT NULL,
  stock_site_id platform_helpers.uuid_v7 NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  is_default boolean NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,location_id),
  UNIQUE (tenant_id,brand_id,store_id,code),
  UNIQUE (tenant_id,brand_id,store_id,stock_site_id,location_id),
  FOREIGN KEY (tenant_id,brand_id,store_id,stock_site_id)
    REFERENCES rms_inventory.stock_site (tenant_id,brand_id,store_id,stock_site_id),
  CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at)
);
CREATE UNIQUE INDEX storage_location_one_default ON rms_inventory.storage_location
  (tenant_id,brand_id,store_id,stock_site_id) WHERE is_default;
CREATE TABLE rms_inventory.storage_location_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  location_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active','Inactive')),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,location_id,version),
  FOREIGN KEY (tenant_id,brand_id,store_id,location_id)
    REFERENCES rms_inventory.storage_location (tenant_id,brand_id,store_id,location_id),
  CHECK (isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
  CHECK ((
    snapshot_json->>'schemaVersion'='1'
    AND snapshot_json->>'tenantReference'=tenant_id::text
    AND snapshot_json->>'brandReference'=brand_id::text
    AND snapshot_json->>'storeReference'=store_id::text
    AND snapshot_json->>'locationReference'=location_id::text
    AND snapshot_json->>'aggregateVersion'=version::text
    AND snapshot_json->>'lifecycle'=lifecycle
    AND snapshot_json->>'temperatureZone' IN ('Ambient','Chilled','Frozen')
    AND snapshot_json->>'updatedAt'=to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) IS TRUE)
);
CREATE TABLE rms_inventory.stock_place_operation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('StockSite','StorageLocation')),
  target_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('Create','Update','Activate','Deactivate')),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (tenant_id,brand_id,store_id,operation_id),
  UNIQUE (tenant_id,brand_id,store_id,target_kind,target_id,version),
  CHECK ((action='Create')=(version=1))
);

CREATE FUNCTION rms_inventory.enforce_stock_place_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous_version bigint;
DECLARE previous_at timestamptz;
DECLARE created timestamptz;
DECLARE target uuid;
DECLARE is_default_place boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Inventory writes require read committed' USING ERRCODE='25000';
  END IF;
  IF TG_TABLE_NAME='stock_site_version' THEN
    target:=NEW.stock_site_id;
    -- Serialize versions of one place without a row lock, so writers need no UPDATE privilege.
    PERFORM pg_advisory_xact_lock(hashtextextended('StockPlaceVersion:'||NEW.tenant_id||':'||target,0));
    SELECT created_at,is_default INTO STRICT created,is_default_place FROM rms_inventory.stock_site
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND stock_site_id=NEW.stock_site_id;
    SELECT version,recorded_at INTO previous_version,previous_at FROM rms_inventory.stock_site_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND stock_site_id=NEW.stock_site_id ORDER BY version DESC LIMIT 1;
  ELSE
    target:=NEW.location_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('StockPlaceVersion:'||NEW.tenant_id||':'||target,0));
    SELECT created_at,is_default INTO STRICT created,is_default_place FROM rms_inventory.storage_location
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND location_id=NEW.location_id;
    SELECT version,recorded_at INTO previous_version,previous_at FROM rms_inventory.storage_location_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND location_id=NEW.location_id ORDER BY version DESC LIMIT 1;
  END IF;
  IF previous_version IS NULL THEN
    IF NEW.version<>1 OR NEW.recorded_at<>created OR NEW.lifecycle<>'Active' THEN
      RAISE EXCEPTION 'Stock place initial version invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.version<>previous_version+1 OR NEW.recorded_at<previous_at THEN
    RAISE EXCEPTION 'Stock place version conflict' USING ERRCODE='23514';
  END IF;
  IF NEW.lifecycle='Inactive' THEN
    IF is_default_place THEN
      RAISE EXCEPTION 'Default stock place cannot be deactivated' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b
        ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.account_id=a.account_id
      WHERE a.tenant_id=NEW.tenant_id AND a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id
        AND (CASE WHEN TG_TABLE_NAME='stock_site_version' THEN a.stock_site_id ELSE a.location_id END)=target
        AND (b.on_hand<>0 OR b.reserved<>0 OR b.in_transit<>0)
    ) THEN
      RAISE EXCEPTION 'Stock place still holds stock' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_stock_place_version() FROM PUBLIC;
CREATE TRIGGER stock_site_version_sequence BEFORE INSERT ON rms_inventory.stock_site_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_stock_place_version();
CREATE TRIGGER storage_location_version_sequence BEFORE INSERT ON rms_inventory.storage_location_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_stock_place_version();

-- New stock accounts must sit at a registered, currently active location of their own site.
-- Accounts opened before this migration keep their history (NOT VALID); every new row is checked.
ALTER TABLE rms_inventory.stock_account ADD CONSTRAINT stock_account_location_fk
  FOREIGN KEY (tenant_id,brand_id,store_id,stock_site_id,location_id)
  REFERENCES rms_inventory.storage_location (tenant_id,brand_id,store_id,stock_site_id,location_id)
  NOT VALID;
CREATE FUNCTION rms_inventory.enforce_stock_account_location() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (SELECT lifecycle FROM rms_inventory.storage_location_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND location_id=NEW.location_id ORDER BY version DESC LIMIT 1) IS DISTINCT FROM 'Active'
   OR (SELECT lifecycle FROM rms_inventory.stock_site_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND stock_site_id=NEW.stock_site_id ORDER BY version DESC LIMIT 1) IS DISTINCT FROM 'Active' THEN
    RAISE EXCEPTION 'Stock account location is not active' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_inventory.enforce_stock_account_location() FROM PUBLIC;
CREATE TRIGGER stock_account_active_location BEFORE INSERT ON rms_inventory.stock_account
FOR EACH ROW EXECUTE FUNCTION rms_inventory.enforce_stock_account_location();

CREATE TRIGGER stock_site_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_site
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_site_version_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_site_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER storage_location_immutable BEFORE UPDATE OR DELETE ON rms_inventory.storage_location
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER storage_location_version_immutable BEFORE UPDATE OR DELETE ON rms_inventory.storage_location_version
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_place_operation_immutable BEFORE UPDATE OR DELETE ON rms_inventory.stock_place_operation
FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_site_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_site
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_site_version_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_site_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER storage_location_no_truncate BEFORE TRUNCATE ON rms_inventory.storage_location
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER storage_location_version_no_truncate BEFORE TRUNCATE ON rms_inventory.storage_location_version
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER stock_place_operation_no_truncate BEFORE TRUNCATE ON rms_inventory.stock_place_operation
FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();

ALTER TABLE rms_inventory.stock_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_site FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_site_scope ON rms_inventory.stock_site
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
ALTER TABLE rms_inventory.stock_site_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_site_version FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_site_version_scope ON rms_inventory.stock_site_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
ALTER TABLE rms_inventory.storage_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.storage_location FORCE ROW LEVEL SECURITY;
CREATE POLICY storage_location_scope ON rms_inventory.storage_location
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
ALTER TABLE rms_inventory.storage_location_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.storage_location_version FORCE ROW LEVEL SECURITY;
CREATE POLICY storage_location_version_scope ON rms_inventory.storage_location_version
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
ALTER TABLE rms_inventory.stock_place_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.stock_place_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_place_operation_scope ON rms_inventory.stock_place_operation
USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE)
WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id()
 AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_inventory.stock_site,rms_inventory.stock_site_version,rms_inventory.storage_location,
  rms_inventory.storage_location_version,rms_inventory.stock_place_operation FROM PUBLIC;
