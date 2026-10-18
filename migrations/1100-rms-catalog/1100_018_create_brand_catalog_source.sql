-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Identity for the existing Brand catalogue only. No Product FK or publication fact.
CREATE TABLE rms_catalog.brand_catalog_source (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 source_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
 -- JS string length counts each supplementary code point as two UTF-16 units.
 -- NUL cannot inhabit PostgreSQL text; the other exact JS control ranges are explicit.
 label text NOT NULL CHECK(length(label)>=1
   AND length(label)+length(regexp_replace(label,U&'[^\+010000-\+10FFFF]','','g'))<=200
   AND label !~ U&'[\0001-\001F\007F-\009F]'
   AND label !~ U&'^[\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'),
 registered_at timestamptz NOT NULL CHECK(isfinite(registered_at) AND date_trunc('milliseconds',registered_at)=registered_at),
 identity_json jsonb NOT NULL CHECK(jsonb_typeof(identity_json)='object' AND octet_length(identity_json::text)<=4096),
 identity_digest text NOT NULL CHECK(identity_digest ~ '^sha256:[0-9a-f]{64}$'),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 PRIMARY KEY(tenant_id,brand_id),
 UNIQUE(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,registered_at),
 CHECK((identity_json ?& ARRAY['profile','tenantReference','brandReference','sourceReference','code','label','registeredByReference','operationReference','auditReference','registeredAt','dataClassification']
   AND identity_json-ARRAY['profile','tenantReference','brandReference','sourceReference','code','label','registeredByReference','operationReference','auditReference','registeredAt','dataClassification']='{}'::jsonb) IS TRUE),
 CHECK((identity_json->>'profile') IS NOT DISTINCT FROM 'BrandCatalogSourceRegisteredIdentityV1'),
 CHECK((identity_json->'tenantReference') IS NOT DISTINCT FROM to_jsonb(tenant_id::text)),
 CHECK((identity_json->'brandReference') IS NOT DISTINCT FROM to_jsonb(brand_id::text)),
 CHECK((identity_json->'sourceReference') IS NOT DISTINCT FROM to_jsonb(source_id::text)),
 CHECK((identity_json->'code') IS NOT DISTINCT FROM to_jsonb(code)),
 CHECK((identity_json->'label') IS NOT DISTINCT FROM to_jsonb(label)),
 CHECK((identity_json->'registeredByReference') IS NOT DISTINCT FROM to_jsonb(actor_id::text)),
 CHECK((identity_json->'operationReference') IS NOT DISTINCT FROM to_jsonb(operation_id::text)),
 CHECK((identity_json->'auditReference') IS NOT DISTINCT FROM to_jsonb(audit_id::text)),
 CHECK((identity_json->'registeredAt') IS NOT DISTINCT FROM to_jsonb(to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
 CHECK((identity_json->'dataClassification') IS NOT DISTINCT FROM to_jsonb(data_classification))
);
CREATE TABLE rms_catalog.brand_catalog_source_operation (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('Committed','Abandoned')),
 source_id platform_helpers.uuid_v7,
 original_command_json jsonb CHECK(original_command_json IS NULL OR (jsonb_typeof(original_command_json)='object' AND octet_length(original_command_json::text)<=4096)),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=12288),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,occurred_at),
 CHECK((outcome='Committed' AND source_id IS NOT NULL AND original_command_json IS NOT NULL)
    OR (outcome='Abandoned' AND source_id IS NULL AND original_command_json IS NULL)),
 CHECK((receipt_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','operationReference','intentDigest','outcome','originalCommand','source','auditReference','occurredAt']
   AND receipt_json-ARRAY['profile','tenantReference','brandReference','actorReference','operationReference','intentDigest','outcome','originalCommand','source','auditReference','occurredAt']='{}'::jsonb) IS TRUE),
 CHECK((receipt_json->>'profile') IS NOT DISTINCT FROM 'BrandCatalogSourceReceiptV1'),
 CHECK((receipt_json->'tenantReference') IS NOT DISTINCT FROM to_jsonb(tenant_id::text)),
 CHECK((receipt_json->'brandReference') IS NOT DISTINCT FROM to_jsonb(brand_id::text)),
 CHECK((receipt_json->'actorReference') IS NOT DISTINCT FROM to_jsonb(actor_id::text)),
 CHECK((receipt_json->'operationReference') IS NOT DISTINCT FROM to_jsonb(operation_id::text)),
 CHECK((receipt_json->'intentDigest') IS NOT DISTINCT FROM to_jsonb(intent_digest)),
 CHECK((receipt_json->'outcome') IS NOT DISTINCT FROM to_jsonb(outcome)),
 CHECK((receipt_json->'auditReference') IS NOT DISTINCT FROM to_jsonb(audit_id::text)),
 CHECK((receipt_json->'occurredAt') IS NOT DISTINCT FROM to_jsonb(to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
 CHECK((receipt_json->'originalCommand') IS NOT DISTINCT FROM COALESCE(original_command_json,'null'::jsonb)),
 CHECK((outcome='Abandoned' AND (receipt_json->'source') IS NOT DISTINCT FROM 'null'::jsonb)
    OR (outcome='Committed' AND jsonb_typeof(receipt_json->'source')='object')),
 CHECK(outcome='Abandoned' OR (
   original_command_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','operationReference','code','label']
   AND original_command_json-ARRAY['profile','tenantReference','brandReference','actorReference','operationReference','code','label']='{}'::jsonb
   AND (original_command_json->>'profile') IS NOT DISTINCT FROM 'BrandCatalogSourceRegisterV1'
   AND (original_command_json->'tenantReference') IS NOT DISTINCT FROM to_jsonb(tenant_id::text)
   AND (original_command_json->'brandReference') IS NOT DISTINCT FROM to_jsonb(brand_id::text)
   AND (original_command_json->'actorReference') IS NOT DISTINCT FROM to_jsonb(actor_id::text)
   AND (original_command_json->'operationReference') IS NOT DISTINCT FROM to_jsonb(operation_id::text)
 ) IS TRUE)
);
ALTER TABLE rms_catalog.brand_catalog_source ADD CONSTRAINT brand_catalog_source_original_fk
 FOREIGN KEY(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,registered_at)
 REFERENCES rms_catalog.brand_catalog_source_operation(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,occurred_at)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rms_catalog.brand_catalog_source_operation ADD CONSTRAINT brand_catalog_source_result_fk
 FOREIGN KEY(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,occurred_at)
 REFERENCES rms_catalog.brand_catalog_source(tenant_id,brand_id,source_id,operation_id,actor_id,audit_id,registered_at)
 DEFERRABLE INITIALLY DEFERRED;

-- Narrow operation admission, no hidden identity/result returned. The actual server
-- Tenant/IAM authority is held first; the actor argument does not prove IAM authorization.
CREATE FUNCTION rms_catalog.brand_catalog_source_operation_admit(
 p_operation_id platform_helpers.uuid_v7,p_actor_id platform_helpers.uuid_v7
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF p_operation_id IS NULL OR p_actor_id IS NULL OR current_setting('transaction_isolation')<>'read committed'
   OR current_setting('bop.tenant_id',true) IS NULL OR current_setting('bop.tenant_id',true)=''
   OR platform_helpers.current_brand_id() IS NULL OR platform_helpers.current_store_id() IS NOT NULL
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('BrandCatalogSourceOperation:'||p_operation_id::text,0));
 IF EXISTS(SELECT 1 FROM rms_catalog.brand_catalog_source_operation o WHERE o.operation_id=p_operation_id
   AND (o.tenant_id::text=current_setting('bop.tenant_id',true) AND o.brand_id=platform_helpers.current_brand_id() AND o.actor_id=p_actor_id) IS NOT TRUE)
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_OPERATION_CONFLICT' USING ERRCODE='P0001'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.brand_catalog_source_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) FROM PUBLIC;
CREATE FUNCTION rms_catalog.brand_catalog_source_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('brand_catalog_source','brand_catalog_source_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 -- Correct runtime writers already hold operation -> singleton admission. Raw
 -- writers must not wait here while holding the opposite lock order.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('BrandCatalogSourceOperation:'||NEW.operation_id::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('BrandCatalogSource:'||NEW.tenant_id::text||':'||NEW.brand_id::text,0))
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_ADMISSION_UNAVAILABLE' USING ERRCODE='55P03'; END IF;
 PERFORM rms_catalog.brand_catalog_source_operation_admit(NEW.operation_id,NEW.actor_id);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.brand_catalog_source_insert_guard() FROM PUBLIC;
CREATE TRIGGER brand_catalog_source_insert_guard BEFORE INSERT ON rms_catalog.brand_catalog_source
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.brand_catalog_source_insert_guard();
CREATE TRIGGER brand_catalog_source_operation_insert_guard BEFORE INSERT ON rms_catalog.brand_catalog_source_operation
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.brand_catalog_source_insert_guard();

-- Each new source and Committed terminal must originate in the same top-level
-- transaction, including full identity/original/result consistency in either insert order.
CREATE FUNCTION rms_catalog.brand_catalog_source_coherence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 source rms_catalog.brand_catalog_source%ROWTYPE;
 original rms_catalog.brand_catalog_source_operation%ROWTYPE;
 current_xid xid;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('brand_catalog_source','brand_catalog_source_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
 SELECT * INTO original FROM rms_catalog.brand_catalog_source_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_INCOHERENT' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM rms_catalog.brand_catalog_source WHERE operation_id=NEW.operation_id;
 IF original.outcome='Abandoned' THEN
   IF FOUND THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_INCOHERENT' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO source FROM rms_catalog.brand_catalog_source WHERE operation_id=NEW.operation_id AND xmin=current_xid;
 IF NOT FOUND OR source.tenant_id<>original.tenant_id OR source.brand_id<>original.brand_id
    OR source.source_id<>original.source_id OR source.actor_id<>original.actor_id
    OR source.audit_id<>original.audit_id OR source.registered_at<>original.occurred_at
    OR source.identity_json IS DISTINCT FROM original.receipt_json->'source'
    OR (original.original_command_json->'code') IS DISTINCT FROM to_jsonb(source.code)
    OR (original.original_command_json->'label') IS DISTINCT FROM to_jsonb(source.label)
 THEN RAISE EXCEPTION 'BRAND_CATALOG_SOURCE_INCOHERENT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.brand_catalog_source_coherence_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER brand_catalog_source_coherence AFTER INSERT ON rms_catalog.brand_catalog_source
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.brand_catalog_source_coherence_guard();
CREATE CONSTRAINT TRIGGER brand_catalog_source_operation_coherence AFTER INSERT ON rms_catalog.brand_catalog_source_operation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.brand_catalog_source_coherence_guard();

CREATE TRIGGER brand_catalog_source_immutable BEFORE UPDATE OR DELETE ON rms_catalog.brand_catalog_source
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER brand_catalog_source_no_truncate BEFORE TRUNCATE ON rms_catalog.brand_catalog_source
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER brand_catalog_source_operation_immutable BEFORE UPDATE OR DELETE ON rms_catalog.brand_catalog_source_operation
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER brand_catalog_source_operation_no_truncate BEFORE TRUNCATE ON rms_catalog.brand_catalog_source_operation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.brand_catalog_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.brand_catalog_source FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_catalog_source_scope ON rms_catalog.brand_catalog_source
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
ALTER TABLE rms_catalog.brand_catalog_source_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.brand_catalog_source_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_catalog_source_operation_scope ON rms_catalog.brand_catalog_source_operation
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.brand_catalog_source,rms_catalog.brand_catalog_source_operation FROM PUBLIC;
