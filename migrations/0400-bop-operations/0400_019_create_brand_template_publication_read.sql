-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Brand administrative consumption only. No Platform write admission is created.
CREATE FUNCTION bop_publishing.brand_template_publication_read(p_actor uuid,p_brand uuid,p_family uuid)
RETURNS TABLE(family_reference text,sequence integer,release_active boolean,selected_receipt_text text,selected_receipt_digest text,release_receipt_text text,release_receipt_digest text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_actor IS NULL OR p_brand IS NULL OR p_family IS NULL
  OR NOT platform_helpers.is_uuid_v7(p_actor) OR NOT platform_helpers.is_uuid_v7(p_brand) OR NOT platform_helpers.is_uuid_v7(p_family)
  OR p_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_template_actor_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.tenant_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_id',true),'')
  OR NULLIF(current_setting('bop.store_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.brand_template_purpose',true),'') IS DISTINCT FROM 'BRAND_ADMINISTRATION'
 THEN RAISE EXCEPTION 'brand template publication unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT h.family_id::text,h.sequence,h.release_active,s.receipt_text,s.receipt_digest,r.receipt_text,r.receipt_digest
 FROM bop_publishing.platform_template_publishing_head h
 LEFT JOIN bop_publishing.platform_template_publishing_operation s ON s.record_id=h.selected_record_id
 LEFT JOIN bop_publishing.platform_template_publishing_operation r ON r.record_id=h.release_record_id
 WHERE h.family_id=p_family;
END;
$$;
CREATE FUNCTION bop_publishing.brand_template_publication_hold(p_actor uuid,p_brand uuid,p_family uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_actor IS NULL OR p_brand IS NULL OR p_family IS NULL
  OR NOT platform_helpers.is_uuid_v7(p_actor) OR NOT platform_helpers.is_uuid_v7(p_brand) OR NOT platform_helpers.is_uuid_v7(p_family)
  OR p_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_template_actor_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.tenant_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_id',true),'')
  OR NULLIF(current_setting('bop.store_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.brand_template_purpose',true),'') IS DISTINCT FROM 'BRAND_ADMINISTRATION'
 THEN RAISE EXCEPTION 'brand template publication unavailable' USING ERRCODE='23514'; END IF;
 -- Tenant content admission comes first. The original owning head/operation
 -- guards require this same family's exclusive fence, including first INSERT.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('PlatformTemplatePublishingFamily:'||p_family::text,0));
END;
$$;
CREATE FUNCTION bop_publishing.brand_template_publication_list(p_actor uuid,p_brand uuid,p_after uuid,p_limit integer,p_hold boolean)
RETURNS TABLE(family_reference text,sequence integer,release_active boolean,selected_receipt_text text,selected_receipt_digest text,release_receipt_text text,release_receipt_digest text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_actor IS NULL OR p_brand IS NULL OR p_limit IS NULL OR p_hold IS NULL OR p_limit NOT BETWEEN 1 AND 20
  OR NOT platform_helpers.is_uuid_v7(p_actor) OR NOT platform_helpers.is_uuid_v7(p_brand)
  OR (p_after IS NOT NULL AND NOT platform_helpers.is_uuid_v7(p_after))
  OR p_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_template_actor_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.tenant_id',true),'')
  OR p_brand::text IS DISTINCT FROM NULLIF(current_setting('bop.brand_id',true),'')
  OR NULLIF(current_setting('bop.store_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.brand_template_purpose',true),'') IS DISTINCT FROM 'BRAND_ADMINISTRATION'
 THEN RAISE EXCEPTION 'brand template publication unavailable' USING ERRCODE='23514'; END IF;
 -- After reading each optimistic candidate through Tenant, the bounded final
 -- page holds all head mutations (including absent/new families) until COMMIT.
 -- The list holder must not acquire a family fence after this table lock.
 IF p_hold THEN LOCK TABLE bop_publishing.platform_template_publishing_head IN SHARE MODE; END IF;
 RETURN QUERY SELECT h.family_id::text,h.sequence,h.release_active,s.receipt_text,s.receipt_digest,r.receipt_text,r.receipt_digest
 FROM bop_publishing.platform_template_publishing_head h
 LEFT JOIN bop_publishing.platform_template_publishing_operation s ON s.record_id=h.selected_record_id
 LEFT JOIN bop_publishing.platform_template_publishing_operation r ON r.record_id=h.release_record_id
 WHERE h.release_active AND (p_after IS NULL OR h.family_id>p_after)
 ORDER BY h.family_id LIMIT p_limit+1;
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.brand_template_publication_read(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.brand_template_publication_hold(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_publishing.brand_template_publication_list(uuid,uuid,uuid,integer,boolean) FROM PUBLIC;
-- FORCE RLS applies to a non-bypass function owner too. Only the exact owning
-- definer may use this read policy; the application role receives EXECUTE only.
CREATE POLICY platform_template_publishing_brand_head_read ON bop_publishing.platform_template_publishing_head FOR SELECT USING (
 current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_publishing.brand_template_publication_read(uuid,uuid,uuid)'::regprocedure)
 AND current_setting('bop.brand_template_purpose',true)='BRAND_ADMINISTRATION'
 AND current_setting('bop.brand_template_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.brand_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.tenant_id',true)=current_setting('bop.brand_id',true)
 AND NULLIF(current_setting('bop.store_id',true),'') IS NULL
);
CREATE POLICY platform_template_publishing_brand_operation_read ON bop_publishing.platform_template_publishing_operation FOR SELECT USING (
 outcome='Committed'
 AND current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_publishing.brand_template_publication_read(uuid,uuid,uuid)'::regprocedure)
 AND current_setting('bop.brand_template_purpose',true)='BRAND_ADMINISTRATION'
 AND current_setting('bop.brand_template_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.brand_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.tenant_id',true)=current_setting('bop.brand_id',true)
 AND NULLIF(current_setting('bop.store_id',true),'') IS NULL
);
