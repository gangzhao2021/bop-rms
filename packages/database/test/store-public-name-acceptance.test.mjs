import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "../../bop/audit/src/index.ts";
import {
  createOrderNumberAllocation,
  createOriginalReceiptSnapshotFromOrder,
  createPostgresDigitalReceiptStore,
  createRefundReceiptSnapshot,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { createPostgresPublicStoreProfilePublisher } from "../../rms/store/src/index.ts";
import { createStoreReceiptDetailsSource } from "../../../apps/api/src/store-receipt-details-source.ts";
import { createPersistentPublicStoreProfileReader } from "../../../apps/api/src/persistent-public-store-profile.ts";
import { readCustomerStoreContact } from "../../../apps/api/src/customer-store-contact.ts";
import { approvalDerivedReference } from "../../../apps/api/src/merchant-ordinary-refund-approval.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareCurrentEntryProfile } from "../test-support/current-entry-profile.mjs";

const { Client } = pg;
const id = (n) => "0190ab30-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "d".repeat(64);
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// TEST-ONLY Store facts: shaped like real ones, not a real business.
const renamed = {
  storeDisplayNames: { "en-CA": "Maple Noodle House", "fr-CA": "Maison des nouilles Maple" },
  address: {
    addressLines: ["200 Example Street", "Unit 4"],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "a1a 1a1",
  },
  businessPhone: "(416) 555-0199",
};

/**
 * WP-2423 store name (DEC-STORE-CUSTOMER-NAME) under a restricted NOBYPASSRLS role holding the
 * pilot api grants (pilot ACL matrix; no new grant is needed): the Owner publishes a new public
 * profile version (Publishing lifecycle + release, effective period, immutable profile version,
 * audits) in one transaction; the customer read serves the latest published version without an
 * operator pin (a pin to the superseded version stops resolving); the order page contact, the
 * pickup panel name and a new receipt's name all follow it; a receipt issued before keeps its
 * name through later versions; another Store is unaffected; a role without write grants and a
 * caller without Owner authority change nothing; audits hold no address or phone.
 */
it("WP-2423 store name: the Owner renames the Store once and every customer surface follows", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_name" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "wp2423_name_api_" + context.runId;
    const readRole = "wp2423_name_read_" + context.runId;
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
          "GRANT USAGE ON SCHEMA bop_tenant,bop_publishing,rms_store,rms_ordering,platform_audit,platform_helpers TO " +
            role,
        );
        await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
            role,
        );
        await admin.query("GRANT SELECT ON bop_tenant.brand,bop_tenant.store TO " + role);
      }
      // Pilot api grants (docs/spec/pilot-acl-matrix.json): Publishing, Store profile and timing,
      // receipts and audit. The read-only role may read the same tables and change none.
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.digital_receipt_record,platform_audit.audit_record TO " +
          apiRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + apiRole,
      );
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_checkout_details_link,rms_ordering.checkout_details_record,rms_ordering.checkout_contact_redaction,rms_store.store_receipt_profile TO " +
          apiRole,
      );
      await admin.query("GRANT UPDATE (order_id) ON rms_ordering.order_header TO " + apiRole);
      await admin.query("GRANT UPDATE ON rms_ordering.order_submission_record TO " + apiRole);
      await admin.query(
        "GRANT SELECT ON rms_store.public_store_profile_version,rms_store.public_store_profile_timing,bop_publishing.publishing_mutation_record TO " +
          readRole,
      );

      const runAs = async (role, work) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 10000 });
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

      // Version 1: the Store's published profile ("Synthetic Harbour"), as the pilot has today.
      const published = await prepareCurrentEntryProfile({
        admin,
        role: apiRole,
        run: api,
        at: new Date(Date.now() - 30_000).toISOString(),
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      });
      // The pilot grant set has no DELETE on profile history (the fixture grants more).
      await admin.query("REVOKE DELETE ON rms_store.public_store_profile_version FROM " + apiRole);
      const { selection: pin, ...current } = published;
      const customer = createPersistentPublicStoreProfileReader({
        ...current,
        transactions: { run: api },
      });
      const pinned = createPersistentPublicStoreProfileReader({
        ...published,
        transactions: { run: api },
      });
      const lookup = (reader, locale = "en-CA") =>
        reader.getPublicStore({
          publicStoreReference: published.binding.publicStoreReference,
          requestedLocale: locale,
          evaluatedAt: new Date().toISOString(),
          purpose: "CustomerEntry",
        });
      const before = await lookup(customer);
      assert.equal(before.status, "Available");
      assert.equal(before.profile.storeDisplayName, "Synthetic Harbour");
      assert.equal(before.profile.profileVersion, 1);
      assert.ok(pin);

      // A receipt issued under version 1 freezes "Synthetic Harbour".
      const detailsAt = (locale = "en-CA") =>
        api((tx) =>
          createStoreReceiptDetailsSource({ scope, publicProfile: current })(tx, {
            observedAt: new Date().toISOString(),
            locale,
          }),
        );
      const oldDetails = await detailsAt();
      assert.equal(oldDetails.storeDisplayName, "Synthetic Harbour");
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
      const captured = record.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
      const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
      const snapshotWith = (details, receiptReference, issuedAt) =>
        createOriginalReceiptSnapshotFromOrder({
          order: record,
          orderSnapshotVersion: 1,
          receiptReference,
          issuedAt,
          issuer: {
            ...scope,
            operatingEntityReference: id(0x202),
            displayName: "Synthetic Issuer Ltd.",
          },
          // The name the issuance source freezes (receipt-issuance-sources.ts).
          store: {
            ...scope,
            displayName: details.storeDisplayName ?? "Store record name",
            currencyCode: "CAD",
          },
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
      const issuedAt = new Date().toISOString();
      const oldSnapshot = snapshotWith(oldDetails, id(0x201), issuedAt);
      assert.equal(oldSnapshot.storeDisplayName, "Synthetic Harbour");
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4::date,'1','Pickup','Qr',$5,$5,1,'Submitted','Open','NotReported',$6)",
        [
          orderReference,
          scope.brandReference,
          scope.storeReference,
          record.createdAt.slice(0, 10),
          record.guestSessionReference,
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
          record.guestSessionReference,
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
          record.guestSessionReference,
          cart,
          {
            schemaVersion: 1,
            detailsReference: detailsId,
            detailsVersion: 1,
            guestSessionReference: record.guestSessionReference,
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
      const receiptAudit = (recordReference, at, reasonCode, operation) => ({
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
      await api((transaction) =>
        receipts.issueOriginal({
          transaction,
          orderReference,
          create: async () => ({
            operationReference: id(0x402),
            sourceDigest: digest,
            record: {
              recordReference: id(0x401),
              version: 1,
              kind: "Original",
              recordedAt: issuedAt,
              previousRecordReference: null,
              reasonCode: null,
              snapshot: oldSnapshot,
            },
            audit: receiptAudit(id(0x401), issuedAt, "SYNTHETIC_RECEIPT", id(0x402)),
          }),
        }),
      );
      const issued = await api((transaction) => receipts.load({ transaction, orderReference }));

      // The Owner publishes the new name, address and phone.
      const actor = id(1);
      const audit = async (tx, entry) =>
        appendAuditRecordInTransaction(
          tx,
          validateAuditRecord({
            ...entry,
            actor: { ...entry.actor },
            beforeSummary: { ...entry.beforeSummary },
            afterSummary: { ...entry.afterSummary },
          }),
        );
      const publisher = (storeScope, authorize = async () => true) =>
        createPostgresPublicStoreProfilePublisher({
          tenantReference: published.binding.tenantReference,
          ...storeScope,
          authorize,
          hash,
          verifyMedia: async () => false,
          appendAudit: audit,
          retentionPolicyCode: "CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        });
      const firstPublication = {
        defaultLocale: "en-CA",
        timeZone: "America/Toronto",
        brandDisplayName: "Synthetic Brand",
      };
      const publish = (
        role,
        operation,
        expectedVersion,
        edit,
        storeScope = scope,
        authorize = undefined,
      ) =>
        runAs(role, (tx) =>
          publisher(storeScope, authorize).publish(tx, {
            actorReference: actor,
            operationReference: operation,
            expectedVersion,
            recordedAt: new Date().toISOString(),
            edit,
            firstPublication,
            reference: (purpose) =>
              approvalDerivedReference(operation, "store-public-profile:" + purpose),
          }),
        );
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_store.public_store_profile_version) AS profiles,(SELECT count(*)::int FROM rms_store.public_store_profile_timing) AS timings,(SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) AS publishing",
          )
        ).rows[0];
      const initial = await counts();
      // A role without write grants, and a caller without Owner authority, change nothing.
      await assert.rejects(publish(readRole, id(0x100), 1, renamed), {
        code: "STORE_PUBLIC_PROFILE_UNAVAILABLE",
      });
      await assert.rejects(
        publish(apiRole, id(0x100), 1, renamed, scope, async () => false),
        { code: "STORE_PUBLIC_PROFILE_DENIED" },
      );
      await assert.rejects(
        publish(apiRole, id(0x100), 1, {
          ...renamed,
          storeDisplayNames: { "en-CA": "Maple #1", "fr-CA": "Maple" },
        }),
        { code: "STORE_PUBLIC_PROFILE_INVALID" },
      );
      assert.deepEqual(await counts(), initial);

      const result = await publish(apiRole, id(0x101), 1, renamed);
      assert.equal(result.status, "Published");
      assert.equal(result.profile.profileVersion, 2);
      assert.equal(result.profile.profileReference, pin.profileReference);
      assert.deepEqual(await counts(), {
        profiles: initial.profiles + 1,
        timings: initial.timings + 1,
        publishing: initial.publishing + 4,
      });
      // The same operation again finds what it published; stale or unchanged edits are refused.
      assert.equal((await publish(apiRole, id(0x101), 1, renamed)).status, "AlreadyPublished");
      await assert.rejects(publish(apiRole, id(0x102), 1, renamed), {
        code: "STORE_PUBLIC_PROFILE_VERSION_CONFLICT",
      });
      await assert.rejects(publish(apiRole, id(0x103), 2, renamed), {
        code: "STORE_PUBLIC_PROFILE_NO_CHANGE",
      });

      // Customers read the latest version without any operator change, in each language.
      const after = await lookup(customer);
      assert.equal(after.status, "Available");
      assert.equal(after.profile.profileVersion, 2);
      assert.equal(after.profile.storeDisplayName, "Maple Noodle House");
      assert.equal(after.profile.brandDisplayName, "Synthetic Brand");
      assert.deepEqual(after.profile.address.addressLines, ["200 Example Street", "Unit 4"]);
      assert.equal(after.profile.address.postalCode, "A1A 1A1");
      assert.equal(after.profile.businessPhone, "+14165550199");
      assert.equal(
        (await lookup(customer, "fr-CA")).profile.storeDisplayName,
        "Maison des nouilles Maple",
      );
      // An operator pin to the superseded version no longer resolves (it is not current).
      assert.equal((await lookup(pinned)).status, "StoreUnavailable");

      // The order page contact, the pickup panel (same read) and a new receipt use one name.
      const contact = await api((tx) =>
        readCustomerStoreContact(
          tx,
          current,
          { publicStoreReference: published.binding.publicStoreReference, locale: "en-CA" },
          new Date().toISOString(),
        ),
      );
      assert.equal(contact.storeDisplayName, "Maple Noodle House");
      assert.equal(contact.phone, "+14165550199");
      const newDetails = await detailsAt();
      assert.equal(newDetails.storeDisplayName, "Maple Noodle House");
      assert.deepEqual(newDetails.businessAddress.addressLines, ["200 Example Street", "Unit 4"]);
      const newSnapshot = snapshotWith(newDetails, id(0x211), new Date().toISOString());
      assert.equal(newSnapshot.storeDisplayName, "Maple Noodle House");
      assert.equal(newSnapshot.storeDisplayName, after.profile.storeDisplayName);
      assert.equal(newSnapshot.storeDisplayName, contact.storeDisplayName);

      // The receipt issued before keeps its name, also in a later version of that receipt.
      assert.deepEqual(
        (await api((transaction) => receipts.load({ transaction, orderReference }))).records,
        issued.records,
      );
      const refundAt = new Date().toISOString();
      await api((transaction) =>
        receipts.issueRefund({
          transaction,
          orderReference,
          create: async (chain) => {
            const previous = chain.records.at(-1);
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
                snapshot: createRefundReceiptSnapshot(previous, {
                  ...scope,
                  orderReference,
                  observedAt: refundAt,
                  captured: money(captured),
                  refunded: money(1n),
                  pendingRefund: money(0n),
                }),
              },
              audit: receiptAudit(id(0x403), refundAt, "PAYMENT_REFUND_STATUS_CHANGED", id(0x404)),
            };
          },
        }),
      );
      const chain = await api((transaction) => receipts.load({ transaction, orderReference }));
      assert.deepEqual(
        chain.records.map((entry) => entry.snapshot.storeDisplayName),
        ["Synthetic Harbour", "Synthetic Harbour"],
      );

      // Another Store: its own first publication; the first Store's current profile is unchanged.
      const other = await publish(
        apiRole,
        id(0x104),
        0,
        {
          storeDisplayNames: { "en-CA": "Synthetic Uptown" },
          address: {
            addressLines: ["300 Example Road"],
            locality: "Exampleville",
            regionCode: "ON",
            postalCode: "A1A 1A2",
          },
          businessPhone: null,
        },
        otherStore,
      );
      assert.equal(other.profile.profileVersion, 1);
      assert.deepEqual(other.profile.supportedLocales, ["en-CA"]);
      assert.equal(
        (await api((tx) => publisher(otherStore).readCurrent(tx, new Date().toISOString())))
          .localizedFields["en-CA"].storeDisplayName,
        "Synthetic Uptown",
      );
      const stillFirst = await api((tx) =>
        publisher(scope).readCurrent(tx, new Date().toISOString()),
      );
      assert.equal(stillFirst.profileVersion, 2);
      assert.equal(stillFirst.localizedFields["en-CA"].storeDisplayName, "Maple Noodle House");
      assert.equal((await lookup(customer)).profile.storeDisplayName, "Maple Noodle House");
      // Row security: the first Store's role scope never sees the other Store's rows.
      const visible = await api(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        return (
          await tx.query(
            "SELECT count(*)::int AS n FROM rms_store.public_store_profile_version WHERE store_id=$1",
            [otherStore.storeReference],
          )
        ).rows[0].n;
      });
      assert.equal(visible, 0);

      // History is append-only, and the audits record who published what, not the details.
      await assert.rejects(
        admin.query("UPDATE rms_store.public_store_profile_version SET recorded_at=now()"),
        (error) => error.code === "55000",
      );
      const audits = await admin.query(
        "SELECT action_code,a::text AS content FROM platform_audit.audit_record a WHERE action_code IN ('STORE_PUBLIC_PROFILE_PUBLISHED','STORE_PUBLIC_PROFILE_TIMING_RECORDED','PUBLISHING_DRAFT_CREATED','PUBLISHING_REVIEW_SUBMITTED','PUBLISHING_REVIEW_APPROVED','PUBLISHING_RELEASE_PUBLISHED') AND correlation_id IN ($1,$2)",
        [id(0x101), id(0x104)],
      );
      const byAction = (code) => audits.rows.filter((row) => row.action_code === code).length;
      assert.equal(byAction("STORE_PUBLIC_PROFILE_PUBLISHED"), 2);
      assert.equal(byAction("STORE_PUBLIC_PROFILE_TIMING_RECORDED"), 2);
      assert.equal(byAction("PUBLISHING_RELEASE_PUBLISHED"), 2);
      for (const row of audits.rows) {
        assert.equal(row.content.includes("Example Street"), false);
        assert.equal(row.content.includes("4165550199"), false);
        assert.equal(row.content.includes(actor), true);
      }
      const changed = audits.rows.find(
        (row) =>
          row.action_code === "STORE_PUBLIC_PROFILE_PUBLISHED" && row.content.includes(id(0x101)),
      );
      assert.ok(changed.content.includes("storeDisplayName"));
    } finally {
      assert.equal(active, 0);
      await admin.end();
    }
  });
});
