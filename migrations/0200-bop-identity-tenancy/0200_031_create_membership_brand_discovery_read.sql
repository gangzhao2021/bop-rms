-- bop-rms-migration: 1
-- owner: @bop/membership
-- schema: bop_membership
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Candidate discovery only. No Brand permission or selection is inferred.
CREATE FUNCTION bop_membership.membership_brand_discovery_read(p_actor uuid,p_observed_at timestamptz,p_after uuid,p_limit integer)
RETURNS TABLE(brand_references jsonb,transition_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_actor IS NULL OR p_observed_at IS NULL OR p_limit IS NULL
  OR NOT platform_helpers.is_uuid_v7(p_actor)
  OR (p_after IS NOT NULL AND NOT platform_helpers.is_uuid_v7(p_after))
  OR p_limit NOT BETWEEN 1 AND 20
  OR NOT isfinite(p_observed_at)
  OR p_observed_at < '0001-01-01T00:00:00Z'::timestamptz
  OR p_observed_at >= '10000-01-01T00:00:00Z'::timestamptz
  OR date_trunc('milliseconds',p_observed_at) <> p_observed_at
  OR p_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.membership_discovery_actor_id',true),'')
  OR NULLIF(current_setting('bop.membership_discovery_purpose',true),'') IS DISTINCT FROM 'BRAND_DISCOVERY'
  OR NULLIF(current_setting('bop.tenant_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.brand_id',true),'') IS NOT NULL
  OR NULLIF(current_setting('bop.store_id',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'membership discovery unavailable' USING ERRCODE='23514'; END IF;
 -- SHARE protects row updates and absent/new candidates through actual COMMIT.
 -- PG18 non-bypass function owner needs SELECT and MAINTAIN, never DML grants.
 LOCK TABLE bop_membership.membership IN SHARE MODE;
 RETURN QUERY
 WITH actor_members AS (
  SELECT m.brand_id,m.effective_from,m.effective_until
  FROM bop_membership.membership m
  WHERE m.actor_id=p_actor AND m.lifecycle='Active'
   AND m.workforce_relationship_reference IS NOT NULL
   AND m.created_at<=p_observed_at AND m.updated_at<=p_observed_at
   AND isfinite(m.effective_from)
   AND (m.effective_until IS NULL OR isfinite(m.effective_until))
 ), candidates AS (
  SELECT DISTINCT m.brand_id FROM actor_members m
  WHERE m.effective_from<=p_observed_at
   AND (m.effective_until IS NULL OR m.effective_until>p_observed_at)
   AND (p_after IS NULL OR m.brand_id>p_after)
  ORDER BY m.brand_id LIMIT p_limit+1
 ), boundary AS (
  SELECT min(v.at) at FROM actor_members m
  CROSS JOIN LATERAL (VALUES(m.effective_from),(m.effective_until)) v(at)
  WHERE v.at>p_observed_at
 )
 SELECT COALESCE((SELECT jsonb_agg(c.brand_id::text ORDER BY c.brand_id) FROM candidates c),'[]'::jsonb),
  CASE WHEN b.at IS NULL THEN NULL ELSE to_char(b.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
 FROM boundary b;
END;
$$;
REVOKE ALL ON FUNCTION bop_membership.membership_brand_discovery_read(uuid,timestamptz,uuid,integer) FROM PUBLIC;
-- FORCE RLS permits only the precise function owner, named Actor and discovery
-- purpose. Runtime callers receive EXECUTE only; ordinary Brand policies stay.
CREATE POLICY membership_brand_discovery_read ON bop_membership.membership FOR SELECT USING (
 current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_membership.membership_brand_discovery_read(uuid,timestamptz,uuid,integer)'::regprocedure)
 AND actor_id::text=current_setting('bop.membership_discovery_actor_id',true)
 AND current_setting('bop.membership_discovery_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.membership_discovery_purpose',true)='BRAND_DISCOVERY'
 AND NULLIF(current_setting('bop.tenant_id',true),'') IS NULL
 AND NULLIF(current_setting('bop.brand_id',true),'') IS NULL
 AND NULLIF(current_setting('bop.store_id',true),'') IS NULL
);
