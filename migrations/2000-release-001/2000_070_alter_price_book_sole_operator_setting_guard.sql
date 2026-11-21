-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (defence in depth after the v15 defect 2026-10-16, Owner
-- standing approval 2026-10-14 WP-2423 sole operator): the same database check as 2000_067 for
-- the price book. A price book sole-operator mark (2000_033) is recorded only while the Brand's
-- sole-operator setting was On at the marked approval instant and is still On (Organization read,
-- 2000_066; the setting is held until the publication commits). The check runs after the row's
-- own checks, so a mark that is invalid for its own reason is still refused for that reason.
-- Rows already recorded are kept.
CREATE FUNCTION rms_pricing.check_price_book_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'price book sole operator approval needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.check_price_book_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER price_book_sole_operator_approval_setting_on AFTER INSERT ON rms_pricing.price_book_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.check_price_book_sole_operator_setting();
