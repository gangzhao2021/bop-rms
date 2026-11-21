-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 v15 batch 9 (DEC-TAX-WHOLE-RECEIPT rule version 2, docs/spec/design/tax-whole-receipt.md):
-- a bill holding the Orders of tables merged into it records its whole tax rounding on the rounds
-- of the Order that holds the bill, so a merged table's part is what its Order says it ordered.
-- Version 1 shared it over every round. Versions already recorded keep their rule version and
-- lines (append-only); an unpaid bill records a version 2 the next time a payment is planned or
-- taken. No new grant: api keeps SELECT/INSERT on the table.
ALTER TABLE rms_ordering.order_tax_rounding_adjustment
  DROP CONSTRAINT order_tax_rounding_adjustment_rule_version_check;
ALTER TABLE rms_ordering.order_tax_rounding_adjustment
  ADD CONSTRAINT order_tax_rounding_adjustment_rule_version_check CHECK (rule_version IN (1, 2));
