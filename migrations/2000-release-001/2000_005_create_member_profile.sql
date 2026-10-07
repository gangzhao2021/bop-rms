-- bop-rms-migration: 1
-- owner: @bop/membership
-- schema: bop_membership
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: the display name a Brand shows for a member on staff screens (Section 88 IAM-USER-LIST).
-- Maintained by an authorized administrator, versioned and append-only; personal data (a name),
-- never placed in logs, URLs or audit summaries.
CREATE TABLE bop_membership.member_profile_version (
  membership_id platform_helpers.uuid_v7 NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  display_name text NOT NULL CHECK (
    char_length(display_name) BETWEEN 1 AND 80
    AND display_name !~ '[[:cntrl:]]'
    AND display_name = btrim(display_name)
  ),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  changed_by platform_helpers.uuid_v7 NOT NULL,
  changed_at timestamp with time zone NOT NULL CHECK (changed_at = date_trunc('milliseconds', changed_at)),
  data_classification text NOT NULL CHECK (data_classification = 'PersonalData'),
  CONSTRAINT member_profile_version_pkey PRIMARY KEY (membership_id, version),
  CONSTRAINT member_profile_version_operation_unique UNIQUE (brand_id, operation_id),
  CONSTRAINT member_profile_version_membership_fkey FOREIGN KEY (membership_id, actor_id, brand_id)
    REFERENCES bop_membership.membership (membership_id, actor_id, brand_id)
);
CREATE FUNCTION bop_membership.reject_member_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Member profile versions are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_membership.reject_member_profile_change() FROM PUBLIC;
CREATE TRIGGER member_profile_version_append_only
  BEFORE UPDATE OR DELETE ON bop_membership.member_profile_version
  FOR EACH ROW EXECUTE FUNCTION bop_membership.reject_member_profile_change();
ALTER TABLE bop_membership.member_profile_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_membership.member_profile_version FORCE ROW LEVEL SECURITY;
CREATE POLICY member_profile_version_scope ON bop_membership.member_profile_version
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
REVOKE ALL ON TABLE bop_membership.member_profile_version FROM PUBLIC;
