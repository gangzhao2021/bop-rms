-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (defence in depth after the v15 defect 2026-10-16, Owner
-- standing approval 2026-10-14 WP-2423 sole operator): the same database check as 2000_067 for
-- escalated ordinary refunds (2000_032). An approval marked SoleOperator (the Owner approving
-- their own request) and a decline marked SoleOperator (the Owner withdrawing their own request)
-- are recorded only while the Brand's sole-operator setting was On at that instant and is still
-- On (Organization read, 2000_066; the setting is held until the approval or decline commits).
-- The check runs after the row's own checks, so a record that is invalid for its own reason is
-- still refused for that reason. Independent records and rows already recorded are unchanged.
CREATE FUNCTION rms_payment.check_ordinary_refund_approval_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'ordinary refund sole operator approval needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_ordinary_refund_approval_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER ordinary_refund_approval_sole_operator_setting_on AFTER INSERT ON rms_payment.ordinary_refund_approval
  FOR EACH ROW WHEN (NEW.approval_mode='SoleOperator')
  EXECUTE FUNCTION rms_payment.check_ordinary_refund_approval_sole_operator_setting();

CREATE FUNCTION rms_payment.check_ordinary_refund_decline_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.declined_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'ordinary refund sole operator decline needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_ordinary_refund_decline_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER ordinary_refund_decline_sole_operator_setting_on AFTER INSERT ON rms_payment.ordinary_refund_decline
  FOR EACH ROW WHEN (NEW.decline_mode='SoleOperator')
  EXECUTE FUNCTION rms_payment.check_ordinary_refund_decline_sole_operator_setting();
