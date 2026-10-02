import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createGuestBindingCredentialProvider } from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createEffectivePeriod } from "../../bop/effective-period/src/index.ts";
import { createPriceQuote } from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { prepareEntryPickupItems } from "./entry-pickup-items.mjs";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

const { Client } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };

/** Synthetic selection/commercial facts, real scoped owner stores and public Audit. */
export async function seedPickup({ admin, context, sessionRole, observedAt }) {
  const orderingRole = "wp2401_o_" + context.runId;
  const pricingRole = "wp2401_p_" + context.runId;
  for (const role of [orderingRole, pricingRole]) {
    assert.match(role, /^wp2401_[op]_[a-f0-9]+$/u);
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
    await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + role);
    await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
  }
  for (const role of [orderingRole, pricingRole, sessionRole]) {
    await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
    await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  }
  await admin.query(
    "GRANT SELECT,INSERT ON bop_identity.guest_binding_preparation TO " + sessionRole,
  );
  await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + orderingRole);
  await admin.query(
    "GRANT SELECT ON bop_identity.guest_session,bop_identity.guest_session_operation TO " +
      orderingRole,
  );
  await admin.query(
    "GRANT UPDATE (status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO " +
      sessionRole,
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_ordering TO " + orderingRole);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_ordering.cart TO " + orderingRole);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO " + orderingRole,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.cart_operation_record,rms_ordering.cart_binding_record,rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line,rms_ordering.cart_quote_expiry_record TO " +
      orderingRole,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.checkout_details_record TO " + orderingRole,
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + pricingRole);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,rms_pricing.price_quote_request TO " +
      pricingRole,
  );

  const diagnostics = [];
  let sequence = 4000;
  let active = 0;
  const key = randomBytes(32);
  const references = {
    generate: () => id(++sequence),
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  };
  const rawOwnerRunner = runner(orderingRole);
  const diagnosticOwnerRunner = {
    run: (work) =>
      rawOwnerRunner.run((tx) =>
        work({
          query: async (sql, values) => {
            const result = await tx.query(sql, values);
            if (sql.includes("recipe_operation_record"))
              diagnostics.push({
                component: "recipe-operation-read",
                rowCount: Array.isArray(result?.rows) ? result.rows.length : null,
                columns: result?.rows?.[0] ? Object.keys(result.rows[0]).length : 0,
              });
            return result;
          },
        }),
      ),
  };
  function runner(role, readOnly = false) {
    return {
      async run(action) {
        const client = new Client({
          ...context.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await client.connect();
        active++;
        try {
          await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query("SET LOCAL lock_timeout='5s'");
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          const cleared = (
            await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
            )
          ).rows[0];
          assert(!cleared.brand && !cleared.store);
          return result;
        } catch (error) {
          diagnostics.push({
            component: "owner-transaction",
            code: typeof error?.code === "string" ? error.code : (error?.name ?? "unknown"),
          });
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      },
    };
  }
  const audit = (actionCode, targetType, targetId, occurredAt, correlationId) => ({
    auditId: id(++sequence),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    correlationId,
    reasonCode: actionCode.startsWith("IDENTITY_GUEST_BINDING_")
      ? "AUTHORIZED_GUEST_BINDING"
      : actionCode.startsWith("ORDERING_CART_BINDING_")
        ? "AUTHORIZED_CART_BINDING"
        : actionCode === "ORDERING_CART_QUOTE_EXPIRE"
          ? "QUOTE_VALIDITY_ENDED"
          : actionCode === "ORDERING_CART_ATTACH_QUOTE" || actionCode === "PRICING_QUOTE_CREATE"
            ? "AUTHORIZED_CART_QUOTE"
            : "AUTHORIZED_CART_MUTATION",
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const orderingAudit = (descriptor) =>
    audit(
      "ORDERING_CART_ITEM_" + descriptor.action.toUpperCase(),
      "OrderingCart",
      descriptor.cartReference,
      descriptor.observedAt,
      descriptor.operationReference,
    );
  let catalogItems;
  try {
    catalogItems = await prepareEntryPickupItems({
      admin,
      role: orderingRole,
      run: (work) => diagnosticOwnerRunner.run(work),
      scope: { ...scope, tenantReference: id(29990) },
      at: observedAt,
    });
  } catch (error) {
    throw new Error(
      JSON.stringify({ stage: "pickup-catalog-seed", ownerDiagnostics: diagnostics }),
      { cause: error },
    );
  }
  const source = quoteInput();
  const period = createEffectivePeriod({
    timeZone: "UTC",
    effectiveFrom: {
      instant: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
      localDateTime: new Date(Date.parse(observedAt) - 86_400_000).toISOString().slice(0, -1),
      utcOffsetMinutes: 0,
    },
    effectiveUntil: null,
  });
  const priceBook = {
    ...source.priceBook,
    brandReference: scope.brandReference,
    createdAt: observedAt,
    entries: source.priceBook.entries.map((entry) => ({
      ...entry,
      sellableReference: id(70013),
      effectivePeriod: period,
      amount: { ...entry.amount, amountMinor: 500n },
    })),
  };
  const taxConfiguration = {
    ...source.taxConfiguration,
    ...scope,
    createdAt: observedAt,
    effectivePeriod: period,
    registrationEvidence: {
      ...source.taxConfiguration.registrationEvidence,
      validUntil: new Date(Date.parse(observedAt) + 86_400_000).toISOString(),
    },
    professionalEvidence: {
      ...source.taxConfiguration.professionalEvidence,
      reviewedAt: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
      validUntil: new Date(Date.parse(observedAt) + 86_400_000).toISOString(),
    },
  };
  const options = {
    cartTransactions: runner(orderingRole, true),
    cartBinding: {
      orderingTransactions: runner(orderingRole),
      identityAudit: {
        append: (tx, descriptor) =>
          appendAuditRecordInTransaction(
            tx,
            audit(
              "IDENTITY_GUEST_BINDING_" + descriptor.action.toUpperCase(),
              "GuestBindingPreparation",
              descriptor.operationReference,
              descriptor.occurredAt,
              descriptor.operationReference,
            ),
          ),
      },
      ordering: {
        policy: {
          policyVersionReference: id(4990),
          policyDigest: "sha256:" + "a".repeat(64),
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          validFrom: new Date(Date.parse(observedAt) - 86_400_000).toISOString(),
          validUntil: new Date(Date.parse(observedAt) + 86_400_000).toISOString(),
        },
        sourceChannel: "Qr",
        generateReference: references.generate,
        audit: (descriptor) =>
          audit(
            "ORDERING_CART_BINDING_" + descriptor.action.toUpperCase(),
            "OrderingCart",
            descriptor.cartReference,
            descriptor.occurredAt,
            descriptor.operationReference,
          ),
      },
      recovery: createGuestBindingCredentialProvider(key),
      preparationLifetimeSeconds: 300,
    },
    catalogCartItems: catalogItems.catalogCartItems,
    cartRemoval: { writeTransactions: runner(orderingRole), references, audit: orderingAudit },
    cartQuote: {
      attachmentTransactions: runner(orderingRole),
      pricingTransactions: runner(pricingRole),
      references,
      pricingReferences: { ...references, generateReference: references.generate },
      audit: (descriptor) =>
        audit(
          "ORDERING_CART_ATTACH_QUOTE",
          "OrderingCart",
          descriptor.cartReference,
          descriptor.observedAt,
          descriptor.operationReference,
        ),
      expiryAudit: (descriptor) =>
        audit(
          "ORDERING_CART_QUOTE_EXPIRE",
          "OrderingCart",
          descriptor.cartReference,
          descriptor.expiredAt,
          descriptor.operationReference,
        ),
      async candidate(input, identity) {
        assert.equal(input.orderType, "Pickup");
        const quote = createPriceQuote({
          ...source,
          ...scope,
          priceBook,
          taxConfiguration,
          quoteReference: references.generate(),
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          createdAt: input.requestedAt,
          expiresAt: new Date(Date.parse(input.requestedAt) + 300000).toISOString(),
          lines: input.lines.map((item) => {
            assert.equal(item.sellableReference, id(70013));
            assert.deepEqual(item.optionSelections, []);
            const template = source.lines[0];
            return {
              ...template,
              lineReference: item.lineReference,
              sellableReference: item.sellableReference,
              productVersionReference: item.catalogSelectionEvidence.productVersionReference,
              menuVersionReference: item.catalogSelectionEvidence.menuVersionReference,
              quantity: item.quantity,
              priceContext: {
                ...template.priceContext,
                ...scope,
                sellableReference: item.sellableReference,
                channelCode: "PICKUP",
                evaluatedAt: input.requestedAt,
              },
              taxContext: { ...template.taxContext, ...scope, evaluatedAt: input.requestedAt },
            };
          }),
        });
        return {
          quote,
          audit: audit(
            "PRICING_QUOTE_CREATE",
            "PricingPriceQuote",
            quote.quoteReference,
            quote.createdAt,
            identity.operationReference,
          ),
        };
      },
    },
  };
  const candidate = options.cartQuote.candidate;
  options.cartQuote.candidate = async (...args) => {
    try {
      return await candidate(...args);
    } catch (error) {
      diagnostics.push({
        component: "pricing-candidate",
        code: typeof error?.code === "string" ? error.code : (error?.name ?? "unknown"),
      });
      throw error;
    }
  };
  return {
    options,
    orderingRole,
    orderingTransactions: runner(orderingRole),
    checkoutDetailsTransactions: runner(orderingRole),
    diagnostics,
    async inspect() {
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.cart_line) AS lines, (SELECT count(*)::int FROM rms_ordering.cart_operation_record) AS operations",
      );
      return counts.rows[0];
    },
    async verify(journeys) {
      const counts = (
        await admin.query(
          "SELECT " +
            "(SELECT count(*)::int FROM rms_ordering.cart) AS carts," +
            "(SELECT count(*)::int FROM rms_ordering.cart_line) AS lines," +
            "(SELECT coalesce(sum(quantity),0)::int FROM rms_ordering.cart_line) AS quantity," +
            "(SELECT count(*)::int FROM rms_pricing.price_quote) AS quotes," +
            "(SELECT count(*)::int FROM rms_ordering.cart_quote_attachment) AS attachments," +
            "(SELECT count(*)::int FROM rms_ordering.cart_quote_attachment_line) AS attachment_lines",
        )
      ).rows[0];
      assert.deepEqual(counts, {
        carts: journeys,
        lines: journeys,
        quantity: journeys * 2,
        quotes: journeys * 2,
        attachments: journeys * 2,
        attachment_lines: journeys * 2,
      });
      const totals = (
        await admin.query(
          "SELECT total_minor::text AS total FROM rms_pricing.price_quote ORDER BY total_minor",
        )
      ).rows;
      assert.deepEqual(
        totals.map((r) => r.total),
        [...Array(journeys).fill("565"), ...Array(journeys).fill("1130")],
      );
      assert.equal(active, 0);
    },
    async verifyCheckoutDetails(journeys) {
      const rows = (
        await admin.query(
          "SELECT snapshot_json FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 ORDER BY details_id,details_version",
          [scope.brandReference, scope.storeReference],
        )
      ).rows;
      assert.equal(rows.length, journeys);
      for (const row of rows) {
        assert.equal(row.snapshot_json.orderType, "Pickup");
        assert.equal(row.snapshot_json.pickupContact.name, "Synthetic Guest");
        assert.equal(row.snapshot_json.pickupContact.channel, "Email");
        assert.equal(row.snapshot_json.pickupContact.value, "synthetic@example.invalid");
        assert.deepEqual(row.snapshot_json.receipt, { choice: "InSession", email: null });
        assert.deepEqual(row.snapshot_json.policies, []);
      }
    },
    async verifyCheckoutSessions(journeys) {
      const counts = (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) allocations,(SELECT count(*)::int FROM rms_ordering.checkout_session_record) sessions,(SELECT count(*)::int FROM rms_fulfillment.capacity_asap_commitment) commitments,(SELECT count(*)::int FROM rms_ordering.order_header) orders,(SELECT count(*)::int FROM rms_inventory.stock_reservation_version) reservations",
        )
      ).rows[0];
      assert.deepEqual(counts, {
        allocations: journeys,
        sessions: journeys,
        commitments: journeys,
        orders: 0,
        reservations: 0,
      });
    },
    close() {
      key.fill(0);
    },
  };
}
