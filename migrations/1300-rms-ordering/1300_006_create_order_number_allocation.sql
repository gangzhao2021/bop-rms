-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_number_counter (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  business_date date NOT NULL,
  next_sequence bigint NOT NULL CHECK (next_sequence BETWEEN 2 AND 9223372036854775807),
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id, store_id, business_date)
);

CREATE TABLE rms_ordering.order_number_allocation (
  order_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  business_date date NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  order_number text NOT NULL CHECK (order_number ~ '^[1-9][0-9]{0,18}$'),
  allocated_at timestamp with time zone NOT NULL,
  business_date_configuration_id platform_helpers.uuid_v7 NOT NULL,
  business_date_configuration_version integer NOT NULL CHECK (business_date_configuration_version > 0),
  business_date_content_digest text NOT NULL
    CHECK (business_date_content_digest ~ '^sha256:[0-9a-f]{64}$'),
  time_zone text NOT NULL CHECK (
    time_zone ~ '^[A-Za-z][A-Za-z0-9_+.-]{0,63}(?:/[A-Za-z0-9_+.-]{1,64})+$'
  ),
  business_day_start time without time zone NOT NULL,
  business_date_boundary_at timestamp with time zone NOT NULL,
  boundary_disambiguation text NOT NULL
    CHECK (boundary_disambiguation IN ('Exact', 'GapForward', 'OverlapEarlier')),
  CONSTRAINT order_number_allocation_scope_sequence_unique
    UNIQUE (brand_id, store_id, business_date, sequence),
  CONSTRAINT order_number_allocation_scope_number_unique
    UNIQUE (brand_id, store_id, business_date, order_number),
  CONSTRAINT order_number_allocation_decimal_check CHECK (order_number = sequence::text)
);

CREATE RULE order_number_allocation_no_update AS
  ON UPDATE TO rms_ordering.order_number_allocation DO INSTEAD NOTHING;
CREATE RULE order_number_allocation_no_delete AS
  ON DELETE TO rms_ordering.order_number_allocation DO INSTEAD NOTHING;

ALTER TABLE rms_ordering.order_number_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_number_counter FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_number_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_number_allocation FORCE ROW LEVEL SECURITY;

CREATE POLICY order_number_counter_store_scope_policy ON rms_ordering.order_number_counter
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY order_number_allocation_store_scope_policy ON rms_ordering.order_number_allocation
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.order_number_counter FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_number_allocation FROM PUBLIC;
