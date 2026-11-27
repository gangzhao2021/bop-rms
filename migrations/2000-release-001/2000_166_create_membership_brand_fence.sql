-- bop-rms-migration: 1
-- owner: @bop/membership
-- schema: bop_membership
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-MERCHANT-LOCK-SCOPE: a fence's scope is the fact it protects. Table locks on these
-- tables made one merchant's write stop every other merchant's reads. Readers now take the key
-- shared; this trigger takes it exclusive for every write, whatever the path, so none can skip it
-- (as the table lock caught every writer). "a0_" fires it before every other row trigger.
-- Brand discovery spans one person's Brands, so no Brand's fence covers it, and it locked every
-- merchant's memberships. It holds that person's fence instead: their late membership change still
-- waits for it, nobody else's does.
LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION bop_membership.take_brand_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.brand_id IS DISTINCT FROM NEW.brand_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_membership.take_brand_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_membership.membership FOR EACH ROW EXECUTE FUNCTION bop_membership.take_brand_fence('MembershipFence');
CREATE FUNCTION bop_membership.take_actor_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('MembershipActorFence:'||OLD.actor_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.actor_id IS DISTINCT FROM NEW.actor_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('MembershipActorFence:'||OLD.actor_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('MembershipActorFence:'||NEW.actor_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_membership.take_actor_fence() FROM PUBLIC;
CREATE TRIGGER a1_membership_actor_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_membership.membership FOR EACH ROW EXECUTE FUNCTION bop_membership.take_actor_fence();
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_membership.store_assignment FOR EACH ROW EXECUTE FUNCTION bop_membership.take_brand_fence('MembershipFence');
CREATE OR REPLACE FUNCTION bop_membership.membership_brand_discovery_read(p_actor uuid,p_observed_at timestamptz,p_after uuid,p_limit integer)
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
 -- This person's fence protects row updates and absent/new candidates through actual COMMIT.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('MembershipActorFence:'||p_actor::text,0));
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
