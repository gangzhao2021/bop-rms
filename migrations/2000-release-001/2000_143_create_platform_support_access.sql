-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 取舍 15 (Owner 2026-10-28): platform support staff, who are not a Store role.
-- platform_support_person: who is support, with their own permissions; each change the next version.
-- store_support_permission: whether the Store's Owner lets support change settings: Off, Standing
-- or Limited until a time. No row or an expired time means Off, by itself. Append-only.
-- store_support_access_log: every view, change and refusal by support, for the Owner. Append-only.
-- Grants: api SELECT/INSERT on the Store tables, SELECT on people (Owner standing approval
-- 2026-10-14, WP-2423 取舍 15).
CREATE TABLE bop_permission.platform_support_person (
 actor_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
 lifecycle text NOT NULL CHECK (lifecycle IN ('Active','Ended')),
 actions text[] NOT NULL CHECK (actions <@ ARRAY['platform.support.view','platform.support.change']::text[]),
 effective_until timestamptz NOT NULL CHECK (isfinite(effective_until)),
 recorded_by_reason text NOT NULL CHECK (char_length(recorded_by_reason) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 PRIMARY KEY (actor_id,version)
);

CREATE TABLE bop_permission.store_support_permission (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 mode text NOT NULL CHECK (mode IN ('Off','Standing','Limited')),
 allowed_until timestamptz CHECK (allowed_until IS NULL OR isfinite(allowed_until)),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
 PRIMARY KEY (brand_id,store_id,version),
 CONSTRAINT store_support_permission_operation UNIQUE (brand_id,store_id,operation_id),
 CONSTRAINT store_support_permission_until CHECK (
  (mode='Limited' AND allowed_until IS NOT NULL AND allowed_until>occurred_at)
  OR (mode<>'Limited' AND allowed_until IS NULL)
 )
);

CREATE TABLE bop_permission.store_support_access_log (
 log_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 support_actor_id platform_helpers.uuid_v7 NOT NULL,
 kind text NOT NULL CHECK (kind IN ('Viewed','Changed','Refused')),
 subject_code text NOT NULL CHECK (subject_code ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at))
);
CREATE INDEX store_support_access_log_recent
 ON bop_permission.store_support_access_log (brand_id,store_id,occurred_at DESC);

CREATE FUNCTION bop_permission.validate_store_support_permission() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('StoreSupportPermission:'||NEW.brand_id||':'||NEW.store_id,0));
 SELECT max(version) INTO latest FROM bop_permission.store_support_permission
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id;
 IF NEW.version<>coalesce(latest,0)+1 THEN
  RAISE EXCEPTION 'store support permission version out of order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER store_support_permission_order BEFORE INSERT ON bop_permission.store_support_permission
 FOR EACH ROW EXECUTE FUNCTION bop_permission.validate_store_support_permission();

CREATE FUNCTION bop_permission.reject_platform_support_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only platform support record' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER platform_support_person_append_only BEFORE UPDATE OR DELETE ON bop_permission.platform_support_person
 FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_platform_support_mutation();
CREATE TRIGGER store_support_permission_append_only BEFORE UPDATE OR DELETE ON bop_permission.store_support_permission
 FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_platform_support_mutation();
CREATE TRIGGER store_support_access_log_append_only BEFORE UPDATE OR DELETE ON bop_permission.store_support_access_log
 FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_platform_support_mutation();

ALTER TABLE bop_permission.store_support_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.store_support_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY store_support_permission_scope ON bop_permission.store_support_permission
 USING (brand_id::uuid=platform_helpers.current_brand_id() AND store_id::uuid=platform_helpers.current_store_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id() AND store_id::uuid=platform_helpers.current_store_id());
ALTER TABLE bop_permission.store_support_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.store_support_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY store_support_access_log_scope ON bop_permission.store_support_access_log
 USING (brand_id::uuid=platform_helpers.current_brand_id() AND store_id::uuid=platform_helpers.current_store_id())
 WITH CHECK (brand_id::uuid=platform_helpers.current_brand_id() AND store_id::uuid=platform_helpers.current_store_id());

-- Store permissions reach a person only through a role assignment: a support person can never hold
-- one, and someone holding one can't become support. Money and access stay out of their reach.
CREATE FUNCTION bop_permission.reject_support_person_role() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM bop_permission.platform_support_person WHERE actor_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'platform support person cannot hold a Store role' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER role_assignment_not_platform_support BEFORE INSERT ON bop_permission.role_assignment
 FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_support_person_role();
CREATE FUNCTION bop_permission.reject_role_holder_as_support() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM bop_permission.role_assignment WHERE actor_id=NEW.actor_id AND lifecycle='Active') THEN
  RAISE EXCEPTION 'someone holding a Store role cannot be platform support' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER platform_support_person_no_role BEFORE INSERT ON bop_permission.platform_support_person
 FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_holder_as_support();
