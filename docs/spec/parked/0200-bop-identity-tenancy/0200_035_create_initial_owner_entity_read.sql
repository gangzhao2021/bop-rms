-- bop-rms-migration: 1
-- owner: @bop/operating-entity
-- schema: bop_operating_entity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- No qualification verdict, assignment, Entity write or normal runtime grant.
CREATE FUNCTION bop_operating_entity.initial_owner_entity_read(p_entity uuid,p_operator uuid,p_purpose text)
RETURNS TABLE(entity_text text,precise boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_entity IS NULL OR p_operator IS NULL OR p_purpose IS DISTINCT FROM 'INITIAL_OWNER_ISSUANCE'
  OR NOT platform_helpers.is_uuid_v7(p_entity) OR NOT platform_helpers.is_uuid_v7(p_operator)
  OR p_entity::text IS DISTINCT FROM NULLIF(current_setting('bop.initial_owner_entity_id',true),'')
  OR p_operator::text IS DISTINCT FROM NULLIF(current_setting('bop.initial_owner_operator_id',true),'')
  OR p_purpose IS DISTINCT FROM NULLIF(current_setting('bop.initial_owner_purpose',true),'')
 THEN RAISE EXCEPTION 'initial owner entity unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY
 SELECT jsonb_build_object(
  'operatingEntityReference',e.operating_entity_id::text,'kind',e.kind,
  'legalName',e.legal_name,'tradeName',e.trade_name,'jurisdictionCode',e.jurisdiction_code,
  'registrationReference',e.registration_reference::text,'taxRegistrationReference',e.tax_registration_reference::text,
  'billingIdentityReference',e.billing_identity_reference::text,'settlementReference',e.settlement_reference::text,
  'evidenceReference',e.evidence_reference::text,'lifecycle',e.lifecycle,'version',e.version,
  'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,
  (isfinite(e.created_at) AND isfinite(e.updated_at)
   AND e.created_at>=TIMESTAMPTZ '0001-01-01' AND e.updated_at<TIMESTAMPTZ '10000-01-01'
   AND e.created_at=date_trunc('milliseconds',e.created_at) AND e.updated_at=date_trunc('milliseconds',e.updated_at))
 FROM bop_operating_entity.operating_entity e WHERE e.operating_entity_id=p_entity
 FOR SHARE OF e;
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.initial_owner_entity_read(uuid,uuid,text) FROM PUBLIC;
-- Exact function owner only; FORCE RLS remains in effect for non-bypass owners.
-- Deployment caller receives EXECUTE only. The definer needs SELECT and the
-- minimal UPDATE(version) privilege for FOR SHARE; WITH CHECK forbids writes.
-- Existing Brand context can become real during the same creation transaction;
-- this independent deployment scope never creates/changes an assignment.
CREATE POLICY initial_owner_entity_read ON bop_operating_entity.operating_entity FOR SELECT USING (
 current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_operating_entity.initial_owner_entity_read(uuid,uuid,text)'::regprocedure)
 AND operating_entity_id::text=current_setting('bop.initial_owner_entity_id',true)
 AND current_setting('bop.initial_owner_entity_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.initial_owner_operator_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.initial_owner_purpose',true)='INITIAL_OWNER_ISSUANCE'
);
CREATE POLICY initial_owner_entity_hold ON bop_operating_entity.operating_entity FOR UPDATE USING (
 current_user=(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
  WHERE p.oid='bop_operating_entity.initial_owner_entity_read(uuid,uuid,text)'::regprocedure)
 AND operating_entity_id::text=current_setting('bop.initial_owner_entity_id',true)
 AND current_setting('bop.initial_owner_entity_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.initial_owner_operator_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND current_setting('bop.initial_owner_purpose',true)='INITIAL_OWNER_ISSUANCE'
) WITH CHECK (false);
