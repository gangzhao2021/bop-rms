import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
const { Client } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };

/** Local synthetic policy/selection, real owner Cart/history/Audit transactions. */
export async function seedCart({ admin, context, dining }) {
  const role = `wp2325_o_${context.runId}`;
  assert.match(role, /^wp2325_o_[a-f0-9]+$/u);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await admin.query(
    `GRANT USAGE ON SCHEMA rms_ordering,platform_helpers,platform_audit TO ${role}`,
  );
  await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
  );
  await admin.query(`GRANT SELECT,INSERT,UPDATE ON rms_ordering.cart TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO ${role}`);
  await admin.query(
    `GRANT SELECT,INSERT ON rms_ordering.cart_operation_record,rms_ordering.dining_cart_operation,platform_audit.audit_record TO ${role}`,
  );
  await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
  let sequence = 2000;
  function runner(readOnly = false) {
    return {
      async run(action) {
        const client = new Client({
          ...context.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await client.connect();
        try {
          await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query("SET LOCAL lock_timeout='5s'");
          const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          const cleared = (
            await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
            )
          ).rows[0];
          assert(!cleared.brand && !cleared.store);
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
  }
  const audit = (action, input, reasonCode) => ({
    auditId: id(++sequence),
    brandId: id(1),
    storeId: id(2),
    actor: { type: "System" },
    actionCode: action,
    targetType: "OrderingCart",
    targetId: input.cartReference,
    reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt ?? input.observedAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return {
    cartTransactions: runner(true),
    diningCart: {
      participation: dining.participation,
      selectionTransactions: runner(),
      selection: {
        sourceChannel: "Qr",
        generateReference: () => id(++sequence),
        policy: {
          policyVersionReference: id(2990),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          validFrom: new Date(Date.parse(at) - 60000).toISOString(),
          validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
        },
        audit: (input) =>
          audit(
            `ORDERING_DINING_CART_${input.action.toUpperCase()}`,
            input,
            "AUTHORIZED_CART_SELECTION",
          ),
      },
      items: {
        writeTransactions: runner(),
        references: {
          generate: () => id(++sequence),
          hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
          equals: (a, b) => a === b,
        },
        catalog: {
          async validateSelection(input) {
            assert.equal(input.brandReference, scope.brandReference);
            assert.equal(input.storeReference, scope.storeReference);
            assert.equal(input.sellableReference, id(13));
            assert.equal(input.orderType, "DineIn");
            assert.deepEqual(input.optionSelections, []);
            return {
              ...input,
              status: "Accepted",
              menuVersionReference: id(4),
              productVersionReference: id(14),
              catalogChannelCode: "DINE_IN",
              catalogOrderTypeCode: "TABLE_SERVICE",
              ruleEvidence: [],
              validatedAt: input.observedAt,
            };
          },
        },
        audit: (input) =>
          audit(
            `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
            input,
            "AUTHORIZED_CART_MUTATION",
          ),
      },
    },
    async verify(journeys) {
      const rows = (
        await admin.query(
          "SELECT aggregate_version,lifecycle_status FROM rms_ordering.cart ORDER BY cart_id",
        )
      ).rows;
      assert.equal(rows.length, journeys);
      for (const row of rows)
        assert.deepEqual(row, { aggregate_version: 4, lifecycle_status: "Active" });
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.cart_line")).rows[0].n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.cart_operation_record"))
          .rows[0].n,
        journeys * 3,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE target_type='OrderingCart'",
          )
        ).rows[0].n,
        journeys * 4,
      );
    },
  };
}
