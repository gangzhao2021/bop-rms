-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (v15 defect 2026-10-16, Owner standing approval 2026-10-14
-- WP-2423 sole operator): the Organization owner's database read of a Brand's sole-operator
-- setting, so the approval records that rely on it check it themselves (defence in depth: an
-- application defect read version 9 "On" as the latest after version 10 turned it off, and an
-- approval given alone was recorded). The state in force is the highest version (by number,
-- never by text) recorded at or before the instant. Both functions read as the migration owner
-- (SECURITY DEFINER, row_security off: fails closed if the owner cannot bypass forced RLS) and
-- are not granted to anyone: only the approval guards (same owner) call them.

-- Was sole operator On for the Brand at that instant? (Unset or Off: false.)
CREATE FUNCTION bop_tenant.brand_sole_operator_was_on(target_brand_id uuid, observed_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 state_then text;
BEGIN
 IF target_brand_id IS NULL OR observed_at IS NULL OR NOT isfinite(observed_at) THEN
  RETURN false;
 END IF;
 SELECT s.state INTO state_then FROM bop_tenant.brand_sole_operator_setting s
  WHERE s.brand_id=target_brand_id AND s.recorded_at<=observed_at
  ORDER BY s.version DESC LIMIT 1;
 RETURN state_then IS NOT DISTINCT FROM 'On';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_sole_operator_was_on(uuid,timestamptz) FROM PUBLIC;

-- For an approval being given now: was sole operator On at the approval instant, and is it still
-- On? Holds the Brand's setting (the same lock a change of the setting takes) until the approving
-- transaction ends, so turning sole operator off waits for the approval, or the approval sees it.
CREATE FUNCTION bop_tenant.hold_brand_sole_operator_on(target_brand_id uuid, approved_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 state_now text;
BEGIN
 IF target_brand_id IS NULL OR approved_at IS NULL OR NOT isfinite(approved_at) THEN
  RETURN false;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('BrandSoleOperatorSetting:'||target_brand_id::text,0));
 SELECT s.state INTO state_now FROM bop_tenant.brand_sole_operator_setting s
  WHERE s.brand_id=target_brand_id
  ORDER BY s.version DESC LIMIT 1;
 RETURN state_now IS NOT DISTINCT FROM 'On'
  AND bop_tenant.brand_sole_operator_was_on(target_brand_id, approved_at);
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.hold_brand_sole_operator_on(uuid,timestamptz) FROM PUBLIC;
