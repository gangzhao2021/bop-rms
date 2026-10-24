-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Authored immutable material only. Publishing owns release eligibility.
CREATE FUNCTION bop_tenant.platform_brand_template_reference_read(
 p_actor uuid,p_brand uuid,p_version uuid
) RETURNS TABLE(revision_row jsonb,operation_row jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_actor IS NULL OR p_brand IS NULL OR p_version IS NULL
  OR NOT platform_helpers.is_uuid_v7(p_actor) OR NOT platform_helpers.is_uuid_v7(p_brand) OR NOT platform_helpers.is_uuid_v7(p_version)
  OR p_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_template_actor_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.tenant_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_id',true),'')
  OR NULLIF(current_setting('bop.store_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.brand_template_purpose',true),'') IS DISTINCT FROM 'BRAND_ADMINISTRATION'
 THEN RAISE EXCEPTION 'brand template read refused' USING ERRCODE='23514'; END IF;
 -- Same owning global SHARE admission as the Platform reader; acquire before
 -- Publishing's family fence. Never synthesize a Platform Actor or purpose.
 LOCK TABLE bop_tenant.platform_brand_template_revision IN SHARE MODE;
 RETURN QUERY SELECT
  jsonb_build_object('template_id',r.template_id::text,'version_id',r.version_id::text,'revision',r.revision::text,
   'code',r.code,'actor_id',r.actor_id::text,'operation_id',r.operation_id::text,'audit_id',r.audit_id::text,
   'content_digest',r.content_digest,'source_digest',r.source_digest,'snapshot_json',r.snapshot_json,
   'precise',r.created_at=date_trunc('milliseconds',r.created_at) AND r.recorded_at=date_trunc('milliseconds',r.recorded_at)),
  CASE WHEN o.operation_id IS NULL THEN NULL ELSE jsonb_build_object(
   'actor_id',o.actor_id::text,'purpose_code',o.purpose_code,'operation_id',o.operation_id::text,
   'intent_digest',o.intent_digest,'receipt_json',o.receipt_json,'receipt_digest',o.receipt_digest,
   'precise',o.occurred_at=date_trunc('milliseconds',o.occurred_at)) END
 FROM bop_tenant.platform_brand_template_revision r
 LEFT JOIN bop_tenant.platform_brand_template_operation o ON o.actor_id=r.actor_id AND o.operation_id=r.operation_id
  AND o.purpose_code='PLATFORM_BRAND_TEMPLATE' AND o.outcome='Committed'
 WHERE r.version_id=p_version;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.platform_brand_template_reference_read(uuid,uuid,uuid) FROM PUBLIC;
-- FORCE RLS must also work for a non-bypass owning function role. Ordinary
-- callers have no table SELECT; these policies apply only inside this definer.
CREATE POLICY platform_brand_template_brand_revision_read ON bop_tenant.platform_brand_template_revision FOR SELECT USING (
 current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_tenant.platform_brand_template_reference_read(uuid,uuid,uuid)'::regprocedure)
 AND current_setting('bop.brand_template_purpose',true)='BRAND_ADMINISTRATION'
 AND current_setting('bop.brand_template_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.brand_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.tenant_id',true)=current_setting('bop.brand_id',true)
 AND NULLIF(current_setting('bop.store_id',true),'') IS NULL
);
CREATE POLICY platform_brand_template_brand_operation_read ON bop_tenant.platform_brand_template_operation FOR SELECT USING (
 outcome='Committed'
 AND current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_tenant.platform_brand_template_reference_read(uuid,uuid,uuid)'::regprocedure)
 AND current_setting('bop.brand_template_purpose',true)='BRAND_ADMINISTRATION'
 AND current_setting('bop.brand_template_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.brand_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.tenant_id',true)=current_setting('bop.brand_id',true)
 AND NULLIF(current_setting('bop.store_id',true),'') IS NULL
);
