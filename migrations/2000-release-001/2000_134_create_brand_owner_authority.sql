-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31, a revision of
-- Owner trade-off 7 under the Owner's standing authority; the Owner may overrule it): at a Brand
-- with several Stores, a Brand menu change (names, options, new dishes, combos, allergens, prices)
-- is listed directly only by someone with Brand Owner authority, recorded as BrandOwnerListing
-- with who listed it, as a single-store listing is. Anyone else's Brand change stays a draft for
-- the Brand Owner. The single-store rule (2000_108) is unchanged.
-- Pilot access: api EXECUTE (Owner standing approval 2026-10-14, WP-2423).
-- Does this person hold Brand Owner authority now: an Active Brand-level role assignment (no
-- Store) of an Active role that holds `organization.brand.manage`, all in effect.
CREATE FUNCTION bop_permission.actor_holds_brand_owner_authority(target_brand_id uuid, target_actor_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
 SELECT target_brand_id IS NOT NULL AND target_actor_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM bop_permission.role_assignment a
  JOIN bop_permission.role r ON r.role_id=a.role_id AND r.brand_id=a.brand_id
  JOIN bop_permission.permission_grant g ON g.role_id=r.role_id AND g.brand_id=r.brand_id
  JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id
  WHERE a.brand_id=target_brand_id AND a.actor_id=target_actor_id AND a.store_id IS NULL
   AND a.lifecycle='Active' AND a.effective_from<=now() AND (a.effective_until IS NULL OR a.effective_until>now())
   AND r.lifecycle='Active' AND r.store_id IS NULL
   AND r.effective_from<=now() AND (r.effective_until IS NULL OR r.effective_until>now())
   AND g.lifecycle='Active' AND g.store_id IS NULL
   AND g.effective_from<=now() AND (g.effective_until IS NULL OR g.effective_until>now())
   AND d.lifecycle='Active' AND d.action_code='organization.brand.manage'
 );
$$;
REVOKE ALL ON FUNCTION bop_permission.actor_holds_brand_owner_authority(uuid,uuid) FROM PUBLIC;
