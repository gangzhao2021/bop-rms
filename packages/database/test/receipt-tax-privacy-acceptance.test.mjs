import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction, validateAuditRecord } from "../../bop/audit/src/index.ts";
import {
  createOrderNumberAllocation,
  createOriginalReceiptSnapshotFromOrder,
  createPostgresDigitalReceiptStore,
  createRefundReceiptSnapshot,
  readCheckoutContactPresence,
  redactExpiredCheckoutContacts,
  removeCheckoutContactOnCustomerRequest,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import {
  createPostgresStoreReceiptProfileStore,
  readCurrentStoreReceiptProfile,
  storeReceiptProfileSetupGaps,
} from "../../rms/store/src/index.ts";
import {
  createStorePrivacyNoticeReader,
  createStoreReceiptDetailsSource,
} from "../../../apps/api/src/store-receipt-details-source.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareCurrentEntryProfile } from "../test-support/current-entry-profile.mjs";

const { Client } = pg;
const id = (n) => "0190ab20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "d".repeat(64);
// TEST-ONLY registration numbers and link: shaped like real ones, not real registrations.
const testOnly = {
  gstHstNumber: "000000000RT0001",
  qstNumber: null,
  pstNumber: null,
  privacyNoticeUrl: "https://example.test/privacy",
};

/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY) under a restricted NOBYPASSRLS role holding the
 * pilot api grants (pilot ACL matrix + the Q10/Q15/Q16 additions): the Owner's receipt details are
 * versioned append-only; a new receipt freezes the registration, the published Store address and
 * one line per tax type and rate from the order's tax snapshot; a refund version keeps them; later
 * Owner changes never rewrite issued receipts; a Store without registrations prints none; the
 * privacy link is visible only once entered; a customer's removal request clears the contact once.
 */
it("WP-2423 Q15/Q16: receipt tax details, privacy link and customer contact removal", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_q15" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "wp2423_q15_api_" + context.runId;
    const readRole = "wp2423_q15_read_" + context.runId;
    let active = 0;
    try {
      const fixture = orderWriteFixture({ at: new Date(Date.now() - 60_000).toISOString() });
      const scope = fixture.scope;
      const otherStore = { brandReference: scope.brandReference, storeReference: id(99) };
      for (const role of [apiRole, readRole]) {
        await admin.query(
          "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_store,rms_ordering,platform_audit,platform_helpers TO " + role,
        );
        await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
            role,
        );
      }
      // Pilot api grants: Q15/Q16 additions, receipts (matrix), Q10 contact removal additions.
      await admin.query("GRANT SELECT,INSERT ON rms_store.store_receipt_profile TO " + apiRole);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.digital_receipt_record,platform_audit.audit_record TO " +
          apiRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + apiRole,
      );
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_checkout_details_link,rms_ordering.checkout_details_record,rms_ordering.checkout_contact_redaction TO " +
          apiRole,
      );
      await admin.query("GRANT UPDATE ON rms_ordering.checkout_details_record TO " + apiRole);
      await admin.query("GRANT UPDATE (order_id) ON rms_ordering.order_header TO " + apiRole);
      await admin.query("GRANT UPDATE ON rms_ordering.order_submission_record TO " + apiRole);
      await admin.query("GRANT INSERT ON rms_ordering.checkout_contact_redaction TO " + apiRole);
      // A role that may only read the details cannot change them.
      await admin.query("GRANT SELECT ON rms_store.store_receipt_profile TO " + readRole);

      const runAs = async (role, work) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
        await client.connect();
        active++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      };
      const api = (work) => runAs(apiRole, work);

      // The Store's published public profile (address), read the way the pilot api reads it.
      const publicProfile = await prepareCurrentEntryProfile({
        admin,
        role: apiRole,
        run: api,
        at: new Date(Date.now() - 30_000).toISOString(),
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      });

      // 1. Owner details: none yet → receipts print no registration; staff see both gaps.
      assert.equal(await api((tx) => readCurrentStoreReceiptProfile(tx, scope)), null);
      assert.deepEqual(storeReceiptProfileSetupGaps(null), {
        taxRegistrationMissing: true,
        privacyNoticeMissing: true,
      });
      assert.equal(
        await createStorePrivacyNoticeReader({ scope, transactions: { run: api } })(),
        null,
      );
      const actor = id(1);
      const store = createPostgresStoreReceiptProfileStore({
        authorize: async (_tx, query) =>
          query.storeReference === scope.storeReference && query.actorReference === actor,
        appendAudit: async (tx, record) =>
          appendAuditRecordInTransaction(
            tx,
            validateAuditRecord({
              ...record,
              actor: { ...record.actor },
              beforeSummary: { ...record.beforeSummary },
              afterSummary: { ...record.afterSummary },
            }),
          ),
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const save = (role, operation, expectedVersion, details, at = new Date().toISOString()) =>
        runAs(role, (tx) =>
          store(tx, {
            ...scope,
            actorReference: actor,
            operationReference: operation,
            auditReference: id(0x500 + Number.parseInt(operation.slice(-3), 16)),
            expectedVersion,
            recordedAt: at,
            details,
          }),
        );
      // Without INSERT the change is refused.
      await assert.rejects(save(readRole, id(0x101), 0, testOnly), {
        code: "STORE_RECEIPT_PROFILE_UNAVAILABLE",
      });
      const first = await save(apiRole, id(0x101), 0, testOnly);
      assert.equal(first.status, "Recorded");
      assert.equal(first.profile.version, 1);
      // Same operation again: the same version, nothing new.
      assert.equal((await save(apiRole, id(0x101), 0, testOnly)).status, "AlreadyRecorded");
      await assert.rejects(save(apiRole, id(0x102), 0, testOnly), {
        code: "STORE_RECEIPT_PROFILE_VERSION_CONFLICT",
      });
      await assert.rejects(save(apiRole, id(0x103), 1, testOnly), {
        code: "STORE_RECEIPT_PROFILE_NO_CHANGE",
      });
      await assert.rejects(save(apiRole, id(0x104), 1, { ...testOnly, gstHstNumber: "12345" }), {
        code: "STORE_RECEIPT_PROFILE_INVALID",
      });
      // The database itself refuses malformed numbers, out-of-sequence versions and rewrites.
      await assert.rejects(
        api(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query(
            "INSERT INTO rms_store.store_receipt_profile (brand_id,store_id,version,gst_hst_number,actor_id,operation_id,audit_id,recorded_at) VALUES ($1,$2,2,'123',$3,$4,$5,now()::timestamptz(3))",
            [scope.brandReference, scope.storeReference, actor, id(0x105), id(0x605)],
          );
        }),
        (error) => error.code === "23514",
      );
      await assert.rejects(
        api(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query(
            "INSERT INTO rms_store.store_receipt_profile (brand_id,store_id,version,gst_hst_number,actor_id,operation_id,audit_id,recorded_at) VALUES ($1,$2,5,'000000000RT0002',$3,$4,$5,now()::timestamptz(3))",
            [scope.brandReference, scope.storeReference, actor, id(0x106), id(0x606)],
          );
        }),
        (error) => error.code === "23514",
      );
      await assert.rejects(
        admin.query("UPDATE rms_store.store_receipt_profile SET gst_hst_number=NULL"),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_store.store_receipt_profile"),
        (error) => error.code === "55000",
      );
      // Another Store sees nothing (RLS); the audit names the Owner but holds no number.
      assert.equal(await api((tx) => readCurrentStoreReceiptProfile(tx, otherStore)), null);
      const audits = await admin.query(
        "SELECT a::text AS content FROM platform_audit.audit_record a WHERE a.action_code='STORE_RECEIPT_PROFILE_CHANGED'",
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0].content.includes("000000000RT0001"), false);
      assert.equal(
        await createStorePrivacyNoticeReader({ scope, transactions: { run: api } })(),
        "https://example.test/privacy",
      );

      // 2. A new receipt freezes registration, published address and per-tax lines.
      const details = await api((tx) =>
        createStoreReceiptDetailsSource({ scope, publicProfile })(tx, {
          observedAt: new Date().toISOString(),
          locale: "en-CA",
        }),
      );
      assert.deepEqual(details.taxRegistrations, [{ label: "GST/HST", number: "000000000RT0001" }]);
      assert.deepEqual(details.businessAddress, {
        addressLines: ["100 Example Avenue"],
        locality: "Exampleville",
        regionCode: "ON",
        postalCode: "A1A 1A1",
        countryCode: "CA",
      });
      // A Store whose Owner entered nothing prints no registration line.
      assert.deepEqual(
        (
          await api((tx) =>
            createStoreReceiptDetailsSource({ scope: otherStore })(tx, {
              observedAt: new Date().toISOString(),
              locale: "en-CA",
            }),
          )
        ).taxRegistrations,
        [],
      );
      const record = {
        ...fixture.request.record,
        orderNumberAllocation: createOrderNumberAllocation({
          orderReference: fixture.request.record.order.orderReference,
          allocatedAt: fixture.request.record.createdAt,
          sequence: 1n,
          businessDateResolution: fixture.request.businessDateResolution,
        }),
      };
      const orderReference = record.order.orderReference;
      const guest = record.guestSessionReference;
      const captured = record.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
      const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
      const issuedAt = new Date().toISOString();
      const snapshot = createOriginalReceiptSnapshotFromOrder({
        order: record,
        orderSnapshotVersion: 1,
        receiptReference: id(0x201),
        issuedAt,
        issuer: {
          ...scope,
          operatingEntityReference: id(0x202),
          displayName: "Synthetic Issuer Ltd.",
        },
        store: { ...scope, displayName: "Synthetic Store", currencyCode: "CAD" },
        template: { ...scope, locale: "en-CA", version: "RECEIPT_V1" },
        financial: {
          ...scope,
          orderReference,
          orderBatchReferences: record.order.batches.map((batch) => batch.orderBatchReference),
          captured: money(captured),
          tip: money(0n),
          refunded: money(0n),
          refundDisposition: "NonePending",
        },
        receiptDetails: details,
      });
      const expectedTax = record.items
        .flatMap((item) => item.pricing.taxComponents)
        .filter((component) => component.treatment === "Taxable")
        .reduce((sum, component) => sum + component.taxAmount.amountMinor, 0n);
      assert.equal(
        snapshot.taxDetails.taxLines.reduce((sum, line) => sum + line.amount.amountMinor, 0n),
        expectedTax,
      );
      assert.equal(snapshot.tax.amountMinor, expectedTax);
      // Seed the order rows the receipt references (FKs are not under test here).
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4::date,'1','Pickup','Qr',$5,$5,1,'Submitted','Open','NotReported',$6)",
        [
          orderReference,
          scope.brandReference,
          scope.storeReference,
          record.createdAt.slice(0, 10),
          guest,
          record.createdAt,
        ],
      );
      const submission = id(0x301),
        cart = id(0x302),
        detailsId = id(0x303);
      await admin.query(
        "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
        [
          submission,
          scope.brandReference,
          scope.storeReference,
          orderReference,
          guest,
          digest,
          cart,
          id(0x304),
          record.createdAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
        [
          scope.brandReference,
          scope.storeReference,
          detailsId,
          id(0x305),
          guest,
          cart,
          {
            schemaVersion: 1,
            detailsReference: detailsId,
            detailsVersion: 1,
            guestSessionReference: guest,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            cartReference: cart,
            cartVersion: 1,
            quoteReference: id(0x304),
            quoteVersion: 2,
            orderType: "Pickup",
            pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+14165550123" },
            receipt: { choice: "InSession", email: null },
            policies: [],
            recordedAt: record.createdAt,
          },
          record.createdAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
        [scope.brandReference, scope.storeReference, submission, orderReference, detailsId],
      );
      await admin.query("SET session_replication_role = origin");
      const receipts = createPostgresDigitalReceiptStore({
        ...scope,
        authorize: async () => true,
        validateSources: async (_tx, _candidate, source) => source === digest,
      });
      const audit = (recordReference, at, reasonCode, operation) => ({
        auditId: id(0x700 + Number.parseInt(recordReference.slice(-3), 16)),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DIGITAL_RECEIPT_APPEND",
        targetType: "DigitalReceipt",
        targetId: recordReference,
        reasonCode,
        correlationId: operation,
        occurredAt: at,
        sourceChannel: "SYSTEM",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const original = {
        recordReference: id(0x401),
        version: 1,
        kind: "Original",
        recordedAt: issuedAt,
        previousRecordReference: null,
        reasonCode: null,
        snapshot,
      };
      await api((transaction) =>
        receipts.issueOriginal({
          transaction,
          orderReference,
          create: async () => ({
            operationReference: id(0x402),
            sourceDigest: digest,
            record: original,
            audit: audit(original.recordReference, issuedAt, "SYNTHETIC_RECEIPT", id(0x402)),
          }),
        }),
      );
      // 3. A refund version keeps the issued tax details.
      const refundAt = new Date().toISOString();
      await api((transaction) =>
        receipts.issueRefund({
          transaction,
          orderReference,
          create: async (chain) => {
            const previous = chain.records.at(-1);
            const changed = createRefundReceiptSnapshot(previous, {
              ...scope,
              orderReference,
              observedAt: refundAt,
              captured: money(captured),
              refunded: money(1n),
              pendingRefund: money(0n),
            });
            return {
              operationReference: id(0x404),
              sourceDigest: digest,
              record: {
                recordReference: id(0x403),
                version: 2,
                kind: "Refund",
                recordedAt: refundAt,
                previousRecordReference: previous.recordReference,
                reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
                snapshot: changed,
              },
              audit: audit(id(0x403), refundAt, "PAYMENT_REFUND_STATUS_CHANGED", id(0x404)),
            };
          },
        }),
      );
      const issued = await api((transaction) => receipts.load({ transaction, orderReference }));
      assert.equal(issued.records.length, 2);
      for (const version of issued.records) {
        assert.deepEqual(version.snapshot.taxDetails, snapshot.taxDetails);
        assert.deepEqual(version.snapshot.taxDetails.taxRegistrations, [
          { label: "GST/HST", number: "000000000RT0001" },
        ]);
      }
      assert.equal(issued.records[1].snapshot.paymentStatus, "PartiallyRefunded");
      // WP-2423 D5: every version prints each item at its frozen price before tax; the items add
      // up to the subtotal and, with tax, to the captured total. The frozen line totals stay.
      for (const version of issued.records) {
        const lines = version.snapshot.lines;
        assert.deepEqual(
          lines.map((line) => line.lineSubtotal),
          record.items.map((item) => item.pricing.subtotal),
        );
        assert.deepEqual(
          lines.map((line) => line.lineTotal),
          record.items.map((item) => item.pricing.total),
        );
        const printed = lines.reduce((sum, line) => sum + line.lineSubtotal.amountMinor, 0n);
        assert.equal(printed, version.snapshot.subtotal.amountMinor);
        assert.equal(
          printed -
            version.snapshot.adjustments.discount.amountMinor +
            version.snapshot.adjustments.fee.amountMinor +
            version.snapshot.tax.amountMinor +
            version.snapshot.tip.amountMinor,
          captured,
        );
      }

      // 4. The Owner later clears the number: issued receipts are unchanged, new reads print none.
      const second = await save(apiRole, id(0x107), 1, { ...testOnly, gstHstNumber: null });
      assert.equal(second.profile.version, 2);
      assert.deepEqual(
        (await api((transaction) => receipts.load({ transaction, orderReference }))).records,
        issued.records,
      );
      assert.deepEqual(
        (
          await api((tx) =>
            createStoreReceiptDetailsSource({ scope })(tx, {
              observedAt: new Date().toISOString(),
              locale: "en-CA",
            }),
          )
        ).taxRegistrations,
        [],
      );

      // 5. The customer removes their contact: once, with evidence, only for their own order.
      const presence = (guestSession) =>
        api((tx) =>
          readCheckoutContactPresence(tx, scope, {
            orderReference,
            guestSessionReference: guestSession,
          }),
        );
      assert.equal(await presence(guest), "Stored");
      assert.equal(await presence(id(0x999)), "NotGiven");
      const remove = (guestSession, redaction) =>
        api((tx) =>
          removeCheckoutContactOnCustomerRequest(tx, scope, {
            orderReference,
            guestSessionReference: guestSession,
            observedAt: new Date().toISOString(),
            redactionReference: redaction,
          }),
        );
      await assert.rejects(remove(id(0x999), id(0x801)), {
        code: "CHECKOUT_CONTACT_REMOVAL_NOT_FOUND",
      });
      assert.deepEqual(await remove(guest, id(0x802)), { status: "Removed" });
      assert.deepEqual(await remove(guest, id(0x803)), { status: "AlreadyRemoved" });
      assert.equal(await presence(guest), "Removed");
      const evidence = await admin.query(
        "SELECT policy_code,retention_days FROM rms_ordering.checkout_contact_redaction WHERE details_id=$1",
        [detailsId],
      );
      assert.deepEqual(evidence.rows, [{ policy_code: "CUSTOMER_REQUEST", retention_days: null }]);
      const cleared = await admin.query(
        "SELECT snapshot_json->'pickupContact' AS contact,snapshot_json::text AS text FROM rms_ordering.checkout_details_record WHERE details_id=$1",
        [detailsId],
      );
      assert.equal(cleared.rows[0].contact, null);
      assert.equal(cleared.rows[0].text.includes("+14165550123"), false);
      // The retention removal later finds nothing left to remove.
      assert.deepEqual(
        await api((tx) =>
          redactExpiredCheckoutContacts(tx, scope, {
            observedAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
            limit: 10,
            generateRedactionReference: () => id(0x804),
          }),
        ),
        { redacted: 0 },
      );
      // The database still refuses a customer-request row that claims retention days.
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_ordering.checkout_contact_redaction (brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at) VALUES ($1,$2,$3,1,$4,'CUSTOMER_REQUEST',1,30,$5,now()::timestamptz(3))",
          [scope.brandReference, scope.storeReference, detailsId, id(0x805), record.createdAt],
        ),
        (error) => error.code === "23514" || error.code === "23505",
      );
      assert.equal(active, 0);
    } finally {
      try {
        for (const role of [apiRole, readRole]) {
          await admin.query("DROP OWNED BY " + role);
          await admin.query("DROP ROLE " + role);
        }
      } finally {
        await admin.end();
      }
    }
  });
});
