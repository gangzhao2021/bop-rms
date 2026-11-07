import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import {
  createIdentityActor,
  generateHotp,
  totpTimeStep,
  verifyTotp,
} from "../../bop/identity/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-reconciliation-runtime.ts";
import { createPostgresOrdinaryRefundPositionSource } from "../../rms/payment/src/infrastructure/ordinary-refund-position-source.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import { createMerchantMfaStepUp } from "../../../apps/api/src/merchant-mfa-step-up.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import {
  createMerchantOrdinaryRefundApproval,
  MerchantRefundApprovalError,
} from "../../../apps/api/src/merchant-ordinary-refund-approval.ts";
import { createMerchantOrdinaryRefundApprovals } from "../../../apps/api/src/merchant-ordinary-refund-approvals.ts";
import { createMerchantOrdinaryRefundDecline } from "../../../apps/api/src/merchant-ordinary-refund-decline.ts";
import { createMerchantOrdinaryRefundItems } from "../../../apps/api/src/merchant-ordinary-refund-items.ts";
import { createMerchantOrdinaryRefundStatus } from "../../../apps/api/src/merchant-ordinary-refund-status.ts";
import { createMerchantOrdinaryRefundProgress } from "../../../apps/api/src/merchant-ordinary-refund-progress.ts";
import { createMerchantOrdinaryRefundCommand } from "../../../apps/api/src/merchant-ordinary-refund-command.ts";
import { createMerchantOrdinaryRefundSendCommand } from "../../../apps/api/src/merchant-ordinary-refund-send-command.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { standardRefundRoleMapping } from "../../../tooling/environment/pilot-refund-role-mapping.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedOrdinaryRefundStorePublication } from "../test-support/ordinary-refund-store-publication.mjs";
import { seedStaffItemCancellationQuote } from "../test-support/staff-item-cancellation-pricing.mjs";
import { exerciseReceiptTemplate } from "../test-support/receipt-template.mjs";
import { createOriginalReceiptIssuance } from "../../../apps/api/src/original-receipt-issuance.ts";
import { createRefundReceiptIssuance } from "../../../apps/api/src/refund-receipt-issuance.ts";
import { createPostgresReceiptOrderSource } from "../../rms/ordering/src/index.ts";

// Only the browser-session lookup is a test double: the cookie names which synthetic staff member
// is signed in at the selected Store. Membership, roles, permissions, MFA enrollment and step-ups,
// Payment, Ordering, Pricing and Store owners are the real code over real rows, run as a
// restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (with the proposed
// WP-2423 Q5 additions).
const signedIn = vi.hoisted(() => ({ scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action) =>
    signedIn.scopeFor(tx, cookie, action),
}));

const { Client } = pg;
const id = (n) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const [tenant, brand, store, provider, requester, approver, dual] = [1, 2, 3, 4, 5, 6, 7].map(id);
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
const minutes = (n) => n * 60_000;
let references = 0x9000;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");
// Two lines, synthetic test-only prices and 13% exclusive tax: 90.40 + 22.60, tip 3.00 = CAD 116.00.
const LINES = [
  { unitAmountMinor: 2000, quantity: 4 },
  { unitAmountMinor: 1000, quantity: 2 },
];
const TIP_MINOR = 300n,
  CAPTURED_MINOR = 11600n;

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): a Store Manager requests an ordinary refund above
 * CAD 100 after re-verifying a second factor; a different Finance/Owner member re-verifies and
 * approves in person; the refund is sent at once to a simulated Stripe and refunded, once.
 * Approval is refused without a current verification of either party, to the requester
 * themself, and never sends twice when the same approval is retried.
 */
it("escalated ordinary refund: request, step-ups, independent approval and one Provider refund", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_rf_escal" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_rfe_" + context.runId,
      worker = "wp2423_rfe_w_" + context.runId;
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));

      /** Statements the restricted role ran (the refund reads' query budgets). */
      const queryCount = { value: 0 };
      function transactions() {
        return {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='10s'");
              await client.query("SET LOCAL statement_timeout='20s'");
              const result = await work({
                query: (sql, values) => {
                  queryCount.value += 1;
                  return client.query(sql, values === undefined ? [] : [...values]);
                },
              });
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK").catch(() => undefined);
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }
      const ownerRunner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, brand, store],
            );
            const result = await work({
              query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
            });
            await admin.query("COMMIT");
            return result;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const from = time(-minutes(180)),
        until = time(minutes(600));
      // The commands read the database clock (clock_timestamp() in the Payment refund stores) as
      // well as this process's clock, so the fixture cannot pin "now". Instead it pins the Store's
      // Business Day to `base`, the database's own reading: the day starts on the hour four to
      // five hours before `base` (Toronto offsets are whole hours, so a UTC hour is a local hour).
      // Every fixture time (roles 3 h ago, captures 39-41 min ago, refunds now) then lies inside
      // one Business Date at any wall-clock time. A fixed 04:00 start put the captures on the
      // previous Business Date during 04:00-04:41 Toronto and escalated the small refund with
      // DifferentBusinessDate.
      const businessDayStartsAt = Math.floor((base - minutes(240)) / 3_600_000) * 3_600_000;
      const torontoParts = (format) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", ...format }).format(
          new Date(businessDayStartsAt),
        );
      const businessDayStartLocalTime = `${torontoParts({ hour: "2-digit", hourCycle: "h23" })}:00:00`;
      const businessDate = torontoParts({});

      // ── Workforce: real Membership, Store assignment, roles, permission grants and MFA
      // enrollment (verified two hours ago, so only a step-up can make it recent).
      const brandFact = createBrand({
        brandReference: brand,
        code: "SYNTHETIC_Q5",
        displayName: "Synthetic Q5 Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      const storeFact = createStore({
        storeReference: store,
        brandReference: brand,
        code: "SYNTHETIC_Q5",
        displayName: "Synthetic Q5 Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      await admin.query(
        "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
        [brand, id(900), from],
      );
      const roles = {
        manager: {
          id: id(910),
          code: "store_manager",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.request",
            "payment.refund.execute",
          ],
        },
        finance: {
          id: id(911),
          code: "store_owner",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.approve",
            "payment.refund.execute",
          ],
        },
      };
      // The pilot's refund role mapping by real Store roles (WP-2423 Q5).
      const roleMapping = standardRefundRoleMapping;
      let permissionNumber = 950;
      for (const r of Object.values(roles)) {
        await admin.query(
          "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [r.id, brand, store, r.code, from, until],
        );
        for (const action of r.actions) {
          let permission = (
            await admin.query(
              "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
              [action],
            )
          ).rows[0]?.permission_id;
          if (!permission) {
            permission = id(permissionNumber++);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
              [permission, action, from],
            );
          }
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
            [id(permissionNumber++), r.id, permission, brand, store, from, until],
          );
        }
      }
      const people = [
        [requester, [roles.manager]],
        [approver, [roles.finance]],
        [dual, [roles.manager, roles.finance]],
      ];
      for (const [i, [actor, held]] of people.entries()) {
        const n = 100 + i * 10;
        await admin.query(
          "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [id(n), actor, brand, id(n + 1), from, until],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [id(n + 2), id(n), actor, brand, store, from, until],
        );
        for (const [j, r] of held.entries())
          await admin.query(
            "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
            [id(n + 3 + j), r.id, id(n), id(n + 2), actor, brand, store, from, until],
          );
        // The dual-role member never enrolled (status Required, as on v15): only a verified
        // step-up can make their second factor recent.
        if (actor === dual)
          await admin.query(
            "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'Required',NULL,NULL,NULL,1)",
            [actor],
          );
        else
          await admin.query(
            "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
            [actor, id(n + 6), time(-minutes(120))],
          );
      }
      // Identity roster double (pilot `currentActor`): an active workforce actor per reference.
      const currentActor = async (_tx, reference, authenticatedAt) => {
        assert.ok([requester, approver, dual].includes(reference));
        return createIdentityActor({
          actorType: "User",
          actorReference: reference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        });
      };
      // The signed-in session: cookie names the staff member; permission is the real owner decision.
      const cookies = { requester, approver, dual };
      signedIn.scopeFor = async (tx, cookie, action) => {
        const actorReference = cookies[cookie];
        assert.ok(actorReference, "unknown synthetic session");
        const resolvedAt = new Date().toISOString();
        const actor = await currentActor(tx, actorReference, from, resolvedAt);
        const tenantContext = createTenantContext(actor, brandFact, storeFact, resolvedAt);
        const decide = async (requested) => {
          try {
            const at = new Date().toISOString();
            const result = await createMerchantWorkforcePermissionSource({
              resolveContext: async () => ({
                tenantReference: tenant,
                context: createTenantContext(actor, brandFact, storeFact, at),
              }),
            })(tx, { ...scope, actorReference, observedAt: at, permissionCode: requested });
            return result.decision;
          } catch {
            return null;
          }
        };
        return {
          selected: { tenantReference: tenant },
          context: tenantContext,
          store: storeFact,
          actorReference,
          sessionReference: id(800 + Object.keys(cookies).indexOf(cookie)),
          allowed: async () => (await decide(action))?.effect === "Allow",
          authorizeAction: decide,
          // As the real Store scope for a browser sign-in (not a kitchen display): the profile
          // limit allows every action and the roles still decide.
          kdsOperatorProfileAllows: (requested) =>
            kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
        };
      };
      const session = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });

      // ── Owner facts: two paid pickup Orders (CAD 116.00 each), the Pricing quote, Payment's
      // captured terminal fact and Ordering's Confirmed payment disposition.
      const submittedAt = time(-minutes(40)),
        paidAt = time(-minutes(39)),
        acceptedAt = time(-minutes(38));
      async function seedOrder(n) {
        const b = n + 100;
        const order = { order: id(n + 1), guest: id(n + 2) };
        const refs = {
          batch: id(b + 1),
          submission: id(b + 2),
          cart: id(b + 3),
          quote: id(b + 4),
          checkout: id(b + 9),
          cartLines: [id(b + 40), id(b + 41)],
          items: [id(b + 50), id(b + 51)],
          intent: id(b + 80),
          attempt: id(b + 81),
          transaction: id(b + 82),
          event: id(b + 83),
          disposition: id(b + 84),
          confirmation: id(b + 85),
          confirmedEvent: id(b + 86),
          observation: id(b + 87),
          webhook: id(b + 88),
          acceptance: id(b + 89),
          paymentOperation: id(b + 90),
          correlation: id(b + 91),
          providerIntent: "pi_SYNTHETICQ5" + b,
        };
        order.batch = refs;
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto',$10,$11,'Exact')",
          [
            order.order,
            brand,
            store,
            businessDate,
            n / 1000,
            String(n / 1000),
            submittedAt,
            id(50),
            hash("bd"),
            businessDayStartLocalTime.slice(0, 5),
            new Date(businessDayStartsAt).toISOString(),
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4,$5,'Pickup','Web',NULL,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [order.order, brand, store, businessDate, String(n / 1000), order.guest, submittedAt],
        );
        const inputDigest = hash(["quote-input", b]);
        const { quote, snapshots } = await seedStaffItemCancellationQuote({
          runner: ownerRunner,
          scope,
          orderBatchReference: refs.batch,
          quoteReference: refs.quote,
          cartReference: refs.cart,
          cartVersion: 1,
          inputDigest,
          quotedAt: time(-minutes(42)),
          capturedAt: time(-minutes(41)),
          addedAt: time(-minutes(45)),
          actorReference: order.guest,
          nextReference: fresh,
          lines: LINES.map((line, j) => ({
            ...line,
            cartLineReference: refs.cartLines[j],
            orderItemReference: refs.items[j],
            sellableReference: id(600 + j),
            priceEntryReference: id(b + 92 + j),
          })),
        });
        const orderAllocationMinor = quote.total.amountMinor;
        assert.equal(orderAllocationMinor + TIP_MINOR, CAPTURED_MINOR);
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'Initial')",
          [
            refs.submission,
            brand,
            store,
            order.order,
            order.guest,
            hash(["intent", b]),
            refs.cart,
            refs.quote,
            submittedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            refs.batch,
            brand,
            store,
            order.order,
            refs.submission,
            refs.cart,
            refs.checkout,
            refs.quote,
            order.guest,
            submittedAt,
          ],
        );
        // The receipt and refund item readers check each row against its immutable snapshot.
        const snapshot = (j) =>
          typeof snapshots[j] === "string" ? JSON.parse(snapshots[j]) : snapshots[j];
        for (const [j, orderItem] of refs.items.entries())
          await admin.query(
            "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
            [
              orderItem,
              brand,
              store,
              order.order,
              refs.batch,
              refs.cartLines[j],
              LINES[j].quantity,
              snapshot(j).catalog.snapshotDigest,
              snapshot(j).pricing.quoteInputDigest,
              snapshots[j],
              snapshot(j).snapshotCapturedAt,
              j + 1,
            ],
          );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, store, order.order, submittedAt],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$18,$19,$18)",
          [
            refs.intent,
            brand,
            store,
            refs.paymentOperation,
            order.order,
            refs.batch,
            refs.submission,
            order.guest,
            refs.cart,
            refs.quote,
            id(b + 95),
            id(b + 96),
            hash(["payment-intent", b]),
            hash(["preparation", b]),
            orderAllocationMinor,
            TIP_MINOR,
            CAPTURED_MINOR,
            submittedAt,
            time(-minutes(10)),
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
          [refs.attempt, brand, store, refs.intent, hash(["idempotency", b]), submittedAt],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            refs.paymentOperation,
            brand,
            store,
            refs.intent,
            order.guest,
            hash(["payment-intent", b]),
            submittedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','Captured',$6,$7,$8,$8,$8,0,'CAD',$9,$10,$10)",
          [
            refs.observation,
            brand,
            store,
            refs.intent,
            refs.attempt,
            refs.providerIntent,
            "ch_SYNTHETICQ5" + b,
            CAPTURED_MINOR,
            hash(["observation", b]),
            paidAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.succeeded',$6,$6,$6,$7,$6,$6::timestamptz+interval '30 days',$6::timestamptz+interval '90 days')",
          [
            refs.webhook,
            brand,
            store,
            provider,
            "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
            paidAt,
            hash(["webhook", b]),
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook','Succeeded',$12,'CAD',NULL,NULL,$13,$13,$14,$15,$7)",
          [
            refs.transaction,
            brand,
            store,
            refs.intent,
            refs.attempt,
            order.order,
            refs.webhook,
            "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
            provider,
            refs.providerIntent,
            refs.observation,
            CAPTURED_MINOR,
            paidAt,
            hash(["terminal", b]),
            refs.event,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,'User',$7,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$8,$9,$10,$11)",
          [
            refs.acceptance,
            id(b + 97),
            brand,
            store,
            order.order,
            refs.batch,
            requester,
            id(b + 98),
            id(b + 99),
            hash(["acceptance", b]),
            acceptedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Acceptance',2,1,$5,NULL,$6)",
          [refs.acceptance, brand, store, order.order, refs.submission, acceptedAt],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,confirmation_id,source_snapshot_digest,confirmed_at,order_confirmed_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13,$14,'Confirmed',$15,$16,$14,$17)",
          [
            refs.disposition,
            brand,
            store,
            order.order,
            refs.batch,
            refs.submission,
            refs.transaction,
            refs.intent,
            refs.attempt,
            refs.event,
            refs.acceptance,
            refs.correlation,
            hash(["disposition", b]),
            acceptedAt,
            refs.confirmation,
            hash(["snapshot", b]),
            refs.confirmedEvent,
          ],
        );
        return order;
      }
      const first = await seedOrder(1000);
      const second = await seedOrder(2000);
      const third = await seedOrder(3000);
      const fourth = await seedOrder(4000);
      const { businessDate: businessDatePort, storeOptions } =
        await seedOrdinaryRefundStorePublication({
          client: admin,
          scope,
          firstCapturedAt: paidAt,
          businessDayStartLocalTime,
        });

      // ── Simulated Stripe (InternalTest): the real refund adapter over a fake transport.
      const providerRefunds = [];
      let providerSends = 0,
        providerLookups = 0;
      const stripe = createStripeOrdinaryRefundAdapter({
        brandReference: brand,
        storeReference: store,
        environment: "Test",
        apiVersion: "2024-06-20",
        secretKey: "sk_test_SYNTHETICONLY",
        connectedAccount: null,
        now: () => new Date().toISOString(),
        fetch: async (url, init) => {
          if (init.method === "GET") {
            const intent = new URL(String(url)).searchParams.get("payment_intent");
            return globalThis.Response.json({
              object: "list",
              url: "/v1/refunds",
              has_more: false,
              data: providerRefunds.filter((refund) => refund.payment_intent === intent),
            });
          }
          const body = new globalThis.URLSearchParams(String(init.body));
          const refund = {
            object: "refund",
            id: "re_SYNTHETICQFIVE" + String(providerRefunds.length + 1).padStart(4, "0"),
            payment_intent: body.get("payment_intent"),
            amount: Number(body.get("amount")),
            currency: "cad",
            status: "succeeded",
            created: Math.floor(Date.now() / 1000),
            metadata: { bop_refund_binding: body.get("metadata[bop_refund_binding]") },
          };
          providerRefunds.push(refund);
          return globalThis.Response.json(refund);
        },
      });

      // ── The merchant commands, composed as the pilot API composes them.
      const persistence = { transactions: transactions(), now: () => new Date().toISOString() };
      const authentication = {
        authorize: async (input) => ({
          sessionReference: id(800 + Object.keys(cookies).indexOf(input.sessionCookie)),
        }),
      };
      const roleMappingFor = async (_t, query) => {
        for (const key of ["tenantReference", "brandReference", "storeReference"])
          assert.equal(query[key], scope[key]);
        return roleMapping;
      };
      const workforceFor = (actorReference, sessionContext, current) => ({
        resolveContext: createInternalRefundWorkforceContext({
          expected: scope,
          persistence: { currentActor },
          sessionActorReference: actorReference,
          sessionContext,
          current,
        }),
        resolveRoleMapping: roleMappingFor,
        stepUp: true,
      });
      const audit = {
        reasonCode: "REFUND_REQUEST_EXECUTION",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      };
      const prepare = createMerchantOrdinaryRefundCommand({
        persistence,
        authentication,
        audit,
        resolveConfiguration: async (_tx, selected, authority) => ({
          providerAccountReference: provider,
          environment: "Test",
          workforce: workforceFor(
            selected.actorReference,
            async () => authority.context,
            async () => authority.authorize(),
          ),
          store: storeOptions,
        }),
      });
      const send = createMerchantOrdinaryRefundSendCommand({
        persistence,
        authentication,
        audit,
        resolveConfiguration: async ({ actorReference, resolveAuthority }) => ({
          providerAccountReference: provider,
          environment: "Test",
          workforce: workforceFor(
            actorReference,
            async (tx) => (await resolveAuthority(tx)).context,
            async (tx) => {
              await resolveAuthority(tx);
              return true;
            },
          ),
          store: storeOptions,
          provider: {
            refundPayment: async (request) => {
              providerSends++;
              return stripe.refundPayment(request);
            },
          },
          generateObservationIdentity: () => ({
            observationReference: fresh(),
            auditReference: fresh(),
          }),
        }),
      });
      const escalatedConfiguration = async (_tx, selected, authority) => ({
        providerAccountReference: provider,
        environment: "Test",
        businessDate: businessDatePort,
        workforce: workforceFor(
          selected.actorReference,
          async () => authority.context,
          async () => authority.authorize(),
        ),
      });
      const approve = createMerchantOrdinaryRefundApproval({
        persistence,
        authentication,
        resolveConfiguration: escalatedConfiguration,
        prepare,
        send,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const approvals = createMerchantOrdinaryRefundApprovals({
        persistence,
        resolveConfiguration: escalatedConfiguration,
      });
      const decline = createMerchantOrdinaryRefundDecline({
        persistence,
        authentication,
        resolveConfiguration: escalatedConfiguration,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const items = createMerchantOrdinaryRefundItems({
        persistence,
        authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping,
        }),
        newReference: fresh,
        locale: "en-CA",
      });
      const request = createMerchantOrdinaryRefundRequest({
        persistence,
        authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping,
        }),
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
        businessDate: businessDatePort,
      });
      // TEST-ONLY authenticator secrets, generated per run and kept in memory only.
      const secrets = new Map([requester, approver, dual].map((a) => [a, randomBytes(20)]));
      const stepUp = createMerchantMfaStepUp({
        persistence,
        authentication,
        method: "InternalTestTotp",
        verify: async ({ actorReference, code, atMilliseconds }) => {
          const secret = secrets.get(actorReference);
          if (!secret) throw new Error("NOT_PROVISIONED");
          return verifyTotp({ secret, code, atMilliseconds });
        },
        newReference: fresh,
        retentionPolicyCode: "SECURITY_AUDIT",
        retentionPolicyVersion: 1,
      });
      const codeFor = (actor, offset = 0) =>
        generateHotp(secrets.get(actor), totpTimeStep(Date.now()) + offset);
      const verify = (who, code, purpose = "RefundRequest") =>
        stepUp({ ...session(who), command: { purpose, code } });
      const fullRefund = (
        order,
        requestReference,
        operationReference,
        expectedClaimVersion = 0,
      ) => ({
        orderReference: order.order,
        requestReference,
        operationReference,
        expectedClaimVersion,
        reasonCode: "WRONG_ITEM",
        items: order.batch.items.map((orderItemReference, j) => ({
          orderBatchReference: order.batch.batch,
          orderItemReference,
          quantity: LINES[j].quantity,
        })),
      });
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_request) AS requests," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_approval) AS approvals," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_operation) AS operations," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch) AS dispatches," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_observation) AS observations," +
              "(SELECT count(*)::int FROM bop_identity.workforce_mfa_step_up) AS step_ups",
          )
        ).rows[0];

      // ── 1. The Manager previews a full refund (CAD 116.00): an Owner/Finance approval is needed.
      const firstRequest = fullRefund(first, fresh(), fresh());
      const preview = await request.preview({ ...session("requester"), command: firstRequest });
      assert.equal(preview.amountMinor, String(CAPTURED_MINOR));
      assert.equal(preview.approvalRequired, true);
      assert.ok(preview.escalationReasons.includes("OrderOrdinaryTotalAboveCad100"));
      await assert.rejects(
        request.preview({
          ...session("requester"),
          command: { ...firstRequest, reasonCode: "OTHER" },
        }),
      );

      // ── 2. The Manager re-verifies: a wrong code and a reused code are refused and counted;
      // no code or secret is stored.
      assert.deepEqual(await verify("requester", "000000"), {
        status: "Rejected",
        reason: "CodeMismatch",
      });
      const requesterCode = codeFor(requester);
      const verified = await verify("requester", requesterCode);
      assert.equal(verified.status, "Verified");
      assert.equal(Date.parse(verified.validUntil) - Date.parse(verified.verifiedAt), minutes(15));
      assert.deepEqual(await verify("requester", requesterCode), {
        status: "Rejected",
        reason: "CodeReused",
      });
      const stepRows = (
        await admin.query(
          "SELECT outcome,rejection_reason,purpose_code,session_id::text AS session,row_to_json(s)::text AS raw FROM bop_identity.workforce_mfa_step_up s WHERE actor_id=$1 ORDER BY attempted_at,outcome",
          [requester],
        )
      ).rows;
      assert.deepEqual(
        stepRows.map((row) => [row.outcome, row.rejection_reason, row.purpose_code]),
        [
          ["Rejected", "CodeMismatch", "PAYMENT_REFUND_REQUEST"],
          ["Verified", null, "PAYMENT_REFUND_REQUEST"],
          ["Rejected", "CodeReused", "PAYMENT_REFUND_REQUEST"],
        ],
      );
      assert.ok(stepRows.every((row) => !row.raw.includes(requesterCode)));
      const stepAudits = (
        await admin.query(
          "SELECT action_code,actor_reference::text AS actor,before_summary_json::text AS before,after_summary_json::text AS after FROM platform_audit.audit_record WHERE target_type='WorkforceMfaStepUp' ORDER BY recorded_at",
        )
      ).rows;
      assert.deepEqual(
        stepAudits.map((row) => row.action_code),
        [
          "IDENTITY_MFA_STEP_UP_REJECTED",
          "IDENTITY_MFA_STEP_UP_VERIFIED",
          "IDENTITY_MFA_STEP_UP_REJECTED",
        ],
      );
      assert.ok(
        stepAudits.every(
          (row) => row.actor === requester && row.before === "{}" && row.after === "{}",
        ),
      );
      // A staff member without an authenticator is not set up; nothing is recorded.
      secrets.delete(dual);
      await assert.rejects(verify("dual", "123456"), { code: "NotSetUp" });
      secrets.set(dual, randomBytes(20));

      // ── 3. The request is recorded with its reason and needs approval.
      const recorded = await request({ ...session("requester"), command: firstRequest });
      assert.equal(recorded.status, "Created");
      assert.equal(recorded.approvalRequired, true);
      assert.equal(
        (
          await admin.query(
            "SELECT reason_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_REQUESTED' AND target_id=$1",
            [firstRequest.requestReference],
          )
        ).rows[0]?.reason_code,
        "WRONG_ITEM",
      );

      // ── 4. Both see it awaiting approval; only a different approver may approve.
      /** WP-2423 query budgets: statements each refund read ran (asserted after step 7). */
      const queries = {};
      const counted = async (name, read) => {
        queryCount.value = 0;
        const value = await read();
        queries[name] = queryCount.value;
        return value;
      };
      const approverView = await counted("approvals", () =>
        approvals({ sessionCookie: "approver" }),
      );
      assert.equal(approverView.canApprove, true);
      assert.equal(approverView.entries.length, 1);
      const entry = approverView.entries[0];
      assert.equal(entry.requestReference, firstRequest.requestReference);
      assert.equal(entry.orderNumber, "1");
      assert.equal(entry.amountMinor, String(CAPTURED_MINOR));
      assert.equal(entry.reasonCode, "WRONG_ITEM");
      assert.equal(entry.state, "AwaitingApproval");
      assert.equal(entry.requestedByYou, false);
      assert.equal(entry.canApprove, true);
      assert.equal(entry.requesterVerifiedUntil, verified.validUntil);
      assert.ok(entry.escalationReasons.includes("OrderOrdinaryTotalAboveCad100"));
      const requesterView = await approvals({ sessionCookie: "requester" });
      assert.equal(requesterView.canApprove, false);
      assert.deepEqual(
        requesterView.entries.map((e) => [e.requestReference, e.requestedByYou, e.canApprove]),
        [[firstRequest.requestReference, true, false]],
      );

      // ── 5. Refusals record nothing and send nothing.
      let before = await counts();
      const approvalReference = fresh();
      const approveCommand = {
        orderReference: first.order,
        requestReference: firstRequest.requestReference,
        approvalReference,
      };
      // The requester holds no approval permission.
      await assert.rejects(approve({ ...session("requester"), command: approveCommand }), {
        code: "Denied",
      });
      // The approver has not re-verified (enrollment two hours ago).
      await assert.rejects(
        approve({ ...session("approver"), command: approveCommand }),
        (error) => {
          assert.ok(error instanceof MerchantRefundApprovalError);
          assert.equal(error.code, "NeedsReverification");
          assert.equal(error.party, "Approver");
          return true;
        },
      );
      assert.deepEqual(await counts(), before);
      assert.equal(providerSends, 0);
      // A Manager may not prepare the escalated request without an approval.
      await assert.rejects(
        prepare({
          ...session("requester"),
          command: {
            orderReference: first.order,
            requestReference: firstRequest.requestReference,
            paymentAttemptReference: first.batch.attempt,
            operationReference: fresh(),
            auditReference: fresh(),
            approvalReference: null,
          },
        }),
      );
      assert.deepEqual(await counts(), before);

      // ── 6. The approver re-verifies and approves in person: approval, operation and one send.
      assert.equal(
        (await verify("approver", codeFor(approver), "RefundApproval")).status,
        "Verified",
      );
      before = await counts();
      const approved = await approve({ ...session("approver"), command: approveCommand });
      assert.equal(approved.status, "Approved");
      assert.equal(approved.replayed, false);
      assert.deepEqual(
        approved.payments.map((p) => [p.paymentAttemptReference, p.state]),
        [[first.batch.attempt, "SendRecorded"]],
      );
      assert.equal(providerSends, 1);
      assert.deepEqual(
        providerRefunds.map((r) => [r.payment_intent, r.amount, r.status]),
        [[first.batch.providerIntent, Number(CAPTURED_MINOR), "succeeded"]],
      );
      assert.deepEqual(await counts(), {
        ...before,
        approvals: before.approvals + 1,
        operations: before.operations + 1,
        dispatches: before.dispatches + 1,
        observations: before.observations + 1,
      });
      const approvalRow = (
        await admin.query(
          "SELECT requester_id::text AS requester,approver_id::text AS approver,approved_at-requester_mfa_at AS requester_age,approved_at-approver_mfa_at AS approver_age FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
          [approvalReference],
        )
      ).rows[0];
      assert.equal(approvalRow.requester, requester);
      assert.equal(approvalRow.approver, approver);
      const approvedAudit = (
        await admin.query(
          "SELECT actor_reference::text AS actor,reason_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_APPROVED' AND target_id=$1",
          [approvalReference],
        )
      ).rows;
      assert.deepEqual(approvedAudit, [{ actor: approver, reason_code: "WRONG_ITEM" }]);
      const operation = (
        await admin.query(
          "SELECT approval_id::text AS approval,executor_id::text AS executor,amount_minor::text AS amount FROM rms_payment.ordinary_refund_operation WHERE request_id=$1",
          [firstRequest.requestReference],
        )
      ).rows;
      assert.deepEqual(operation, [
        { approval: approvalReference, executor: approver, amount: String(CAPTURED_MINOR) },
      ]);
      const observation = (
        await admin.query(
          "SELECT outcome_kind,record_json#>>'{outcome,providerRefundReference}' AS refund FROM rms_payment.ordinary_refund_observation WHERE request_id=$1",
          [firstRequest.requestReference],
        )
      ).rows;
      assert.deepEqual(observation, [
        { outcome_kind: "RefundObservation", refund: providerRefunds[0].id },
      ]);

      // ── 7. Retrying the same approval never sends again.
      before = await counts();
      const replay = await approve({ ...session("approver"), command: approveCommand });
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        replay.payments.map((p) => p.operationReference),
        approved.payments.map((p) => p.operationReference),
      );
      assert.equal(providerSends, 1);
      assert.deepEqual(await counts(), before);
      assert.deepEqual((await approvals({ sessionCookie: "approver" })).entries, []);

      // Reconciling after the send reuses the succeeded observation: no Provider lookup and no
      // second observation of the same refund.
      const lookups = () => providerLookups;
      const lookupsBefore = lookups();
      const firstOperation = approved.payments[0].operationReference;
      const reconcile = createPostgresOrdinaryRefundReconciliationRuntime({
        scope,
        providerAccountReference: provider,
        environment: "Test",
        authorize: async () => true,
        transactions: transactions(),
        provider: {
          lookupRefund: async (request) => {
            providerLookups++;
            return stripe.lookupRefund(request);
          },
        },
      });
      const observationsOf = async (operation) =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_observation WHERE operation_id=$1",
            [operation],
          )
        ).rows[0].n;
      const reconciled = await reconcile({
        orderReference: first.order,
        operationReference: firstOperation,
        observationReference: fresh(),
        auditReference: fresh(),
      });
      assert.equal(reconciled.status, "AlreadyConfirmed");
      assert.equal(lookups(), lookupsBefore);
      assert.equal(await observationsOf(firstOperation), 1);
      // Even a second succeeded observation of the same Provider refund (as recorded on v15 before
      // this change) is counted once: positions are per operation, never per observation.
      await admin.query(
        "INSERT INTO rms_payment.ordinary_refund_observation (tenant_id,brand_id,store_id,order_id,request_id,operation_id,provider_operation_id,payment_attempt_id,dispatch_id,observation_id,audit_id,provider_request_digest,provider_environment,outcome_kind,recorded_at,record_json) " +
          "SELECT tenant_id,brand_id,store_id,order_id,request_id,operation_id,provider_operation_id,payment_attempt_id,dispatch_id,$2::uuid,$3::uuid,provider_request_digest,provider_environment,outcome_kind,recorded_at,jsonb_set(jsonb_set(record_json,'{observationReference}',to_jsonb($2::text)),'{auditReference}',to_jsonb($3::text)) " +
          "FROM rms_payment.ordinary_refund_observation WHERE operation_id=$1",
        [firstOperation, id(995), id(996)],
      );
      assert.equal(await observationsOf(firstOperation), 2);
      const position = await transactions().run((tx) =>
        createPostgresOrdinaryRefundPositionSource({
          scope,
          providerAccountReference: provider,
          environment: "Test",
          authorize: async () => true,
        })(tx, {
          orderReference: first.order,
          paymentTransactionReference: first.batch.transaction,
          paymentIntentReference: first.batch.intent,
          paymentAttemptReference: first.batch.attempt,
          observedAt: new Date().toISOString(),
        }),
      );
      assert.equal(position.confirmedMinor, CAPTURED_MINOR);
      assert.equal(position.pendingMinor, 0n);

      // The Owner reads the payment's refunds (not as a requester); progress reads "Refunded".
      const ownerView = await counted("items", () =>
        items({
          ...session("approver"),
          query: { orderReference: first.order },
        }),
      );
      assert.equal(ownerView.canRequest, false);
      assert.deepEqual(
        ownerView.recentRequests.map((r) => [r.requestReference, r.progress]),
        [[firstRequest.requestReference, "Refunded"]],
      );
      assert.equal(
        (await items({ ...session("requester"), query: { orderReference: first.order } }))
          .canRequest,
        true,
      );

      // The request's status and progress, as the Approvals page follows them after an approval.
      const statusOf = await counted("status", () =>
        createMerchantOrdinaryRefundStatus({
          persistence,
          authentication,
          resolveConfiguration: async () => ({
            providerAccountReference: provider,
            environment: "Test",
            roleMapping,
          }),
        })({
          ...session("approver"),
          query: {
            orderReference: first.order,
            operationReference: firstRequest.operationReference,
          },
        }),
      );
      assert.ok(statusOf.payments.length > 0);
      const progressOf = await counted("progress", () =>
        createMerchantOrdinaryRefundProgress({
          persistence,
          authentication,
          resolveConfiguration: async () => ({
            providerAccountReference: provider,
            environment: "Test",
            roleMapping,
          }),
          newReference: fresh,
        })({
          ...session("approver"),
          query: {
            orderReference: first.order,
            requestReference: firstRequest.requestReference,
          },
        }),
      );
      assert.equal(progressOf.progress, "Refunded");
      // Measured 2026-10-14 (before → after): approvals with one request 451 → 126, the order's
      // refund items 865 → 111, request status 537 → 95, request progress 660 → 101.
      const budgets = { approvals: 160, items: 140, status: 120, progress: 130 };
      for (const [name, budget] of Object.entries(budgets))
        assert.ok(queries[name] <= budget, "refund read queries " + JSON.stringify(queries));

      // ── 8. Another Manager's request with no recent verification: approval names the requester,
      // a step-up older than 15 minutes does not count, and nobody approves their own request.
      const secondRequest = fullRefund(second, fresh(), fresh());
      assert.equal(
        (await request({ ...session("dual"), command: secondRequest })).approvalRequired,
        true,
      );
      const secondApproval = {
        orderReference: second.order,
        requestReference: secondRequest.requestReference,
        approvalReference: fresh(),
      };
      const needsRequester = (error) => {
        assert.equal(error.code, "NeedsReverification");
        assert.equal(error.party, "Requester");
        return true;
      };
      before = await counts();
      await assert.rejects(
        approve({ ...session("approver"), command: secondApproval }),
        needsRequester,
      );
      // A verification recorded 16 minutes ago (owner-seeded evidence) is too old.
      await admin.query(
        "INSERT INTO bop_identity.workforce_mfa_step_up (step_up_id,brand_id,store_id,actor_id,session_id,method,purpose_code,outcome,rejection_reason,time_step,attempted_at,audit_id) VALUES ($1,$2,$3,$4,$5,'InternalTestTotp','PAYMENT_REFUND_REQUEST','Verified',NULL,1,$6,$7)",
        [
          id(990),
          brand,
          store,
          dual,
          id(802),
          new Date(Date.now() - minutes(16)).toISOString(),
          id(991),
        ],
      );
      await assert.rejects(
        approve({ ...session("approver"), command: secondApproval }),
        needsRequester,
      );
      // The step-up record is append-only: it cannot be back-dated or removed.
      await assert.rejects(
        admin.query(
          "UPDATE bop_identity.workforce_mfa_step_up SET attempted_at=now() WHERE step_up_id=$1",
          [id(990)],
        ),
        /append-only workforce MFA step-up/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM bop_identity.workforce_mfa_step_up WHERE step_up_id=$1", [
          id(990),
        ]),
        /append-only workforce MFA step-up/u,
      );
      assert.equal((await verify("dual", codeFor(dual))).status, "Verified");
      await assert.rejects(approve({ ...session("dual"), command: secondApproval }), {
        code: "SamePerson",
      });
      assert.deepEqual({ ...(await counts()), step_ups: before.step_ups }, before);
      const secondApproved = await approve({ ...session("approver"), command: secondApproval });
      assert.deepEqual(
        secondApproved.payments.map((p) => p.state),
        ["SendRecorded"],
      );
      assert.equal(providerSends, 2);
      assert.equal(
        (
          await admin.query(
            "SELECT requester_id::text AS r FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
            [secondApproval.approvalReference],
          )
        ).rows[0].r,
        dual,
      );

      // ── 9. Decline (RF-D04): an owner says no to a refund nothing was prepared for. It stops
      // occupying the Order, so a smaller request that would otherwise exceed CAD 100 (and the
      // captured balance) now fits and is sent without approval.
      const thirdRequest = fullRefund(third, fresh(), fresh());
      assert.equal(
        (await request({ ...session("requester"), command: thirdRequest })).approvalRequired,
        true,
      );
      const declineCommand = {
        orderReference: third.order,
        requestReference: thirdRequest.requestReference,
        operationReference: fresh(),
        reasonCode: "ENTERED_IN_ERROR",
      };
      const declineCount = async () =>
        (await admin.query("SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_decline"))
          .rows[0].n;
      // The requester may not decline (no approval permission); nothing is recorded.
      await assert.rejects(decline({ ...session("requester"), command: declineCommand }), {
        code: "Denied",
      });
      // A sent refund cannot be declined.
      await assert.rejects(
        decline({
          ...session("approver"),
          command: {
            orderReference: first.order,
            requestReference: firstRequest.requestReference,
            operationReference: fresh(),
            reasonCode: "NOT_ELIGIBLE",
          },
        }),
        { code: "AlreadyPrepared" },
      );
      assert.equal(await declineCount(), 0);
      const declined = await decline({ ...session("approver"), command: declineCommand });
      assert.equal(declined.status, "Declined");
      assert.equal(declined.replayed, false);
      const replayedDecline = await decline({ ...session("approver"), command: declineCommand });
      assert.deepEqual(replayedDecline, { ...declined, replayed: true });
      await assert.rejects(
        decline({
          ...session("dual"),
          command: { ...declineCommand, operationReference: fresh() },
        }),
        { code: "AlreadyDeclined" },
      );
      assert.equal(await declineCount(), 1);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT actor_reference::text AS actor,reason_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_DECLINED'",
          )
        ).rows,
        [{ actor: approver, reason_code: "ENTERED_IN_ERROR" }],
      );
      // Closed for good: not listed, never approved.
      assert.ok(
        !(await approvals({ sessionCookie: "approver" })).entries.some(
          (e) => e.requestReference === thirdRequest.requestReference,
        ),
      );
      await assert.rejects(
        approve({
          ...session("approver"),
          command: {
            orderReference: third.order,
            requestReference: thirdRequest.requestReference,
            approvalReference: fresh(),
          },
        }),
        { code: "AlreadyDeclined" },
      );
      // The requester sees who declined, when and why; every unit is refundable again.
      const thirdItems = await items({
        ...session("requester"),
        query: { orderReference: third.order },
      });
      assert.deepEqual(
        thirdItems.recentRequests.map((r) => [r.requestReference, r.decline?.reasonCode]),
        [[thirdRequest.requestReference, "ENTERED_IN_ERROR"]],
      );
      assert.equal(thirdItems.recentRequests[0].decline.declinedAt, declined.declinedAt);
      assert.deepEqual(
        thirdItems.items.map((i) => i.unclaimedQuantity),
        LINES.map((line) => line.quantity),
      );
      // Line B alone: without the release it would push the Order above CAD 100 and the captured
      // balance; now it needs no approval and the Manager sends it herself.
      const smallRequest = {
        ...fullRefund(third, fresh(), fresh(), 1),
        reasonCode: "MISSING_ITEM",
        items: [
          {
            orderBatchReference: third.batch.batch,
            orderItemReference: third.batch.items[1],
            quantity: LINES[1].quantity,
          },
        ],
      };
      // v15 2026-10-18 regression (dd750045, order 40): the Owner's refund item list was refused
      // with "your permissions do not allow this refund workflow" while a Manager recorded a
      // request for the same Order. The list fixed its observation time when it resolved the
      // signed-in session, then read the Order's request history on its own connection after the
      // request committed: a request recorded after that time read as inconsistent history
      // (ORDINARY_REFUND_HISTORY_UNAVAILABLE), answered as a permission refusal. Here the list
      // resolves its session, the request is recorded and committed on another connection, then
      // the list continues: it must show the new request, read at a time after the refund fence.
      let small;
      {
        let releaseList, listPaused;
        const paused = new Promise((resolve) => (listPaused = resolve));
        const gate = new Promise((resolve) => (releaseList = resolve));
        const gatedItems = createMerchantOrdinaryRefundItems({
          persistence,
          authentication,
          resolveConfiguration: async () => {
            listPaused();
            await gate;
            return { providerAccountReference: provider, environment: "Test", roleMapping };
          },
          newReference: fresh,
          locale: "en-CA",
        });
        const listing = gatedItems({
          ...session("approver"),
          query: { orderReference: third.order },
        });
        await paused;
        small = await request({ ...session("requester"), command: smallRequest });
        releaseList();
        const listed = await listing;
        assert.equal(listed.claimVersion, 2);
        assert.deepEqual(
          listed.recentRequests.map((r) => r.requestReference),
          [thirdRequest.requestReference, smallRequest.requestReference],
        );
        assert.equal(listed.recentRequests[1].progress, "Recorded");
      }
      assert.equal(small.approvalRequired, false);
      assert.ok(BigInt(small.amountMinor) < 10000n);
      const sendsBefore = providerSends;
      const smallOperation = fresh();
      await prepare({
        ...session("requester"),
        command: {
          orderReference: third.order,
          requestReference: smallRequest.requestReference,
          paymentAttemptReference: third.batch.attempt,
          operationReference: smallOperation,
          auditReference: fresh(),
          approvalReference: null,
        },
      });
      await send({
        ...session("requester"),
        command: {
          operationReference: smallOperation,
          orderReference: third.order,
          requestReference: smallRequest.requestReference,
          dispatchReference: fresh(),
          auditReference: fresh(),
          approvalReference: null,
        },
      });
      assert.equal(providerSends, sendsBefore + 1);
      assert.equal(providerRefunds.at(-1).amount, Number(small.amountMinor));

      // ── 10. "Other" needs a short note, kept off Audit and shown to the approver; nobody may
      // decline their own request.
      const otherRequest = {
        ...fullRefund(third, fresh(), fresh(), 2),
        reasonCode: "OTHER",
        items: [
          {
            orderBatchReference: third.batch.batch,
            orderItemReference: third.batch.items[0],
            quantity: LINES[0].quantity,
          },
        ],
      };
      await assert.rejects(request({ ...session("dual"), command: otherRequest }));
      await assert.rejects(
        request({
          ...session("dual"),
          command: { ...otherRequest, reasonCode: "WRONG_ITEM", note: "Not allowed here" },
        }),
      );
      const noted = await request({
        ...session("dual"),
        command: { ...otherRequest, note: "  Customer left before the food arrived  " },
      });
      assert.equal(noted.approvalRequired, true);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT note,actor_id::text AS actor FROM rms_payment.ordinary_refund_request_note WHERE request_id=$1",
            [otherRequest.requestReference],
          )
        ).rows,
        [{ note: "Customer left before the food arrived", actor: dual }],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE before_summary_json::text LIKE '%food arrived%' OR after_summary_json::text LIKE '%food arrived%' OR reason_code LIKE '%food%'",
          )
        ).rows[0].n,
        0,
      );
      const queued = (await approvals({ sessionCookie: "approver" })).entries.find(
        (e) => e.requestReference === otherRequest.requestReference,
      );
      assert.equal(queued?.reasonCode, "OTHER");
      assert.equal(queued?.note, "Customer left before the food arrived");
      await assert.rejects(
        decline({
          ...session("dual"),
          command: {
            orderReference: third.order,
            requestReference: otherRequest.requestReference,
            operationReference: fresh(),
            reasonCode: "CUSTOMER_WITHDREW",
          },
        }),
        { code: "SamePerson" },
      );
      // ── 10b. Approval answers at once and sends in the background (pilot composition); the
      // refund then completes without the approver waiting on the Provider.
      const background = createMerchantOrdinaryRefundApproval({
        persistence,
        authentication,
        resolveConfiguration: escalatedConfiguration,
        prepare,
        send,
        sendInBackground: true,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const sendsBeforeBackground = providerSends;
      const queuedApproval = await background({
        ...session("approver"),
        command: {
          orderReference: third.order,
          requestReference: otherRequest.requestReference,
          approvalReference: fresh(),
        },
      });
      assert.deepEqual(
        queuedApproval.payments.map((p) => p.state),
        ["Sending"],
      );
      const observed = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_observation WHERE request_id=$1",
            [otherRequest.requestReference],
          )
        ).rows[0].n;
      for (let i = 0; i < 100 && (await observed()) === 0; i++) await delay(200);
      assert.equal(await observed(), 1);
      assert.equal(providerSends, sendsBeforeBackground + 1);

      // The decline and note records are append-only.
      await assert.rejects(
        admin.query("DELETE FROM rms_payment.ordinary_refund_decline"),
        /append-only ordinary refund decline or note/u,
      );
      await assert.rejects(
        admin.query("UPDATE rms_payment.ordinary_refund_request_note SET note='changed'"),
        /append-only ordinary refund decline or note/u,
      );

      // ── 11. A dine-in order whose second round was cancelled because its payment failed (never
      // charged): the original receipt and the refund receipt cover the paid round only, and the
      // failed round neither appears on nor blocks them.
      {
        const b = 4900,
          round = {
            batch: id(b + 1),
            submission: id(b + 2),
            cart: id(b + 3),
            quote: id(b + 4),
            cartLine: id(b + 5),
            item: id(b + 6),
            intent: id(b + 7),
            attempt: id(b + 8),
            paymentOperation: id(b + 9),
            webhook: id(b + 10),
            transaction: id(b + 11),
            event: id(b + 12),
            observation: id(b + 13),
          };
        const roundAt = time(-minutes(30)),
          failedAt = time(-minutes(29));
        const { snapshots } = await seedStaffItemCancellationQuote({
          runner: ownerRunner,
          scope,
          orderBatchReference: round.batch,
          quoteReference: round.quote,
          cartReference: round.cart,
          cartVersion: 1,
          inputDigest: hash(["quote-input", b]),
          quotedAt: time(-minutes(31)),
          capturedAt: time(-minutes(31)),
          addedAt: time(-minutes(32)),
          actorReference: fourth.guest,
          nextReference: fresh,
          lines: [
            {
              ...LINES[1],
              cartLineReference: round.cartLine,
              orderItemReference: round.item,
              sellableReference: id(601),
              priceEntryReference: id(b + 20),
            },
          ],
        });
        const snap = typeof snapshots[0] === "string" ? JSON.parse(snapshots[0]) : snapshots[0];
        // Owner facts of the failed, cancelled round (seeded as the owners record them).
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
            [
              round.batch,
              brand,
              store,
              fourth.order,
              round.submission,
              round.cart,
              id(b + 21),
              round.quote,
              fourth.guest,
              roundAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,1)",
            [
              round.item,
              brand,
              store,
              fourth.order,
              round.batch,
              round.cartLine,
              LINES[1].quantity,
              snap.catalog.snapshotDigest,
              snap.pricing.quoteInputDigest,
              snapshots[0],
              snap.snapshotCapturedAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,2260,0,2260,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$15,$16,$15)",
            [
              round.intent,
              brand,
              store,
              round.paymentOperation,
              fourth.order,
              round.batch,
              round.submission,
              fourth.guest,
              round.cart,
              round.quote,
              id(b + 22),
              id(b + 23),
              hash(["payment-intent", b]),
              hash(["preparation", b]),
              roundAt,
              time(0),
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
            [round.attempt, brand, store, round.intent, hash(["idempotency", b]), roundAt],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              round.paymentOperation,
              brand,
              store,
              round.intent,
              fourth.guest,
              hash(["payment-intent", b]),
              roundAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','Failed',$6,NULL,2260,0,0,0,'CAD',$7,$8,$8)",
            [
              round.observation,
              brand,
              store,
              round.intent,
              round.attempt,
              "pi_SYNTHETICQ5" + b,
              hash(["observation", b]),
              failedAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.payment_failed',$6,$6,$6,$7,$6,$6::timestamptz+interval '30 days',$6::timestamptz+interval '90 days')",
            [
              round.webhook,
              brand,
              store,
              provider,
              "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
              failedAt,
              hash(["webhook", b]),
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$14,'VerifiedWebhook','Failed',NULL,NULL,'Declined','NewOperation',$11,$11,$12,$13,$7)",
            [
              round.transaction,
              brand,
              store,
              round.intent,
              round.attempt,
              fourth.order,
              round.webhook,
              "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
              provider,
              "pi_SYNTHETICQ5" + b,
              failedAt,
              hash(["terminal", b]),
              round.event,
              round.observation,
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,3,4,$12,$13,$14,$15,$16,'Cancelled','CHECKOUT_DEADLINE_REACHED')",
            [
              id(b + 30),
              id(b + 31),
              tenant,
              brand,
              store,
              fourth.order,
              round.batch,
              round.submission,
              round.paymentOperation,
              id(b + 32),
              hash(["expiry", b]),
              id(b + 33),
              id(b + 34),
              id(b + 35),
              [round.item],
              time(-minutes(5)),
            ],
          );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        // Receipt issuer, Store identity and published template (synthetic legal facts).
        const at = new Date().toISOString();
        await admin.query(
          "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic Q5 issuer','Synthetic Q5 Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
          [
            id(b + 40),
            id(b + 41),
            id(b + 42),
            id(b + 43),
            id(b + 44),
            id(b + 45),
            time(-minutes(120)),
          ],
        );
        await admin.query(
          "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
          [id(b + 46), brand, store, id(b + 40), time(-minutes(120))],
        );
        await admin.query(
          "INSERT INTO bop_tenant.brand(brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES($1,'SYNTHETIC_Q5','Synthetic Q5 Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
          [brand, time(-minutes(180))],
        );
        await admin.query(
          "INSERT INTO bop_tenant.store(store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,'SYNTHETIC_Q5','Synthetic Q5 Store','America/Toronto','en-CA','CAD','Active',1,$3,$3) ON CONFLICT (store_id) DO NOTHING",
          [store, brand, time(-minutes(180))],
        );
        const templateSource = await exerciseReceiptTemplate({
          admin,
          runner: transactions(),
          role,
          scope: { brandReference: brand, storeReference: store },
          at: time(-minutes(60)),
          tenantReference: tenant,
        });
        const paymentScope = { ...scope, providerAccountReference: provider, environment: "Test" };
        const receiptAudit = (actionReason) => async (record, operationReference) => ({
          auditId: fresh(),
          brandId: brand,
          storeId: store,
          actor: { type: "System" },
          actionCode: "DIGITAL_RECEIPT_APPEND",
          targetType: "DigitalReceipt",
          targetId: record.recordReference,
          reasonCode: actionReason,
          correlationId: operationReference,
          occurredAt: record.recordedAt,
          sourceChannel: "PAYMENT_RECONCILIATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        });
        const original = createOriginalReceiptIssuance({
          sources: {
            scope: paymentScope,
            authorize: async () => true,
            order: (tx, request) =>
              createPostgresReceiptOrderSource({
                brandReference: brand,
                storeReference: store,
                authorize: async () => true,
              })(tx, request),
            template: (tx) => templateSource(tx),
          },
          authorize: async () => true,
          identities: () => ({
            recordReference: fresh(),
            receiptReference: fresh(),
            operationReference: fresh(),
          }),
          audit: receiptAudit("SYNTHETIC_RECEIPT_RETRIEVAL"),
        });
        const issuedOriginal = await transactions().run((tx) =>
          original(tx, { orderReference: fourth.order, observedAt: at, freshAfter: paidAt }),
        );
        assert.equal(issuedOriginal.status, "Created");
        const originalLines = issuedOriginal.record.snapshot.lines;
        assert.equal(originalLines.length, fourth.batch.items.length);
        assert.equal(issuedOriginal.record.snapshot.total.amountMinor, CAPTURED_MINOR);
        // Refund round 1 through the escalated approval (above CAD 100), then the refund receipt.
        const roundOneRequest = fullRefund(fourth, fresh(), fresh());
        assert.equal(
          (await request({ ...session("requester"), command: roundOneRequest })).approvalRequired,
          true,
        );
        assert.equal((await verify("requester", codeFor(requester, 1))).status, "Verified");
        assert.equal(
          (await verify("approver", codeFor(approver, 1), "RefundApproval")).status,
          "Verified",
        );
        const roundOneApproved = await approve({
          ...session("approver"),
          command: {
            orderReference: fourth.order,
            requestReference: roundOneRequest.requestReference,
            approvalReference: fresh(),
          },
        });
        assert.deepEqual(
          roundOneApproved.payments.map((p) => p.state),
          ["SendRecorded"],
        );
        const refundReceipt = await transactions().run((tx) =>
          createRefundReceiptIssuance({
            scope: paymentScope,
            authorize: async () => true,
            authorizeSources: async () => true,
            authorizeOrder: async () => true,
            identities: () => ({ recordReference: fresh(), operationReference: fresh() }),
            audit: receiptAudit("PAYMENT_REFUND_STATUS_CHANGED"),
          })(tx, {
            orderReference: fourth.order,
            observedAt: new Date().toISOString(),
            freshAfter: paidAt,
          }),
        );
        assert.equal(refundReceipt.status, "Created");
        assert.equal(refundReceipt.record.kind, "Refund");
        assert.equal(refundReceipt.record.snapshot.paymentStatus, "Refunded");
        assert.equal(refundReceipt.record.snapshot.refundedTotal.amountMinor, CAPTURED_MINOR);
        assert.deepEqual(refundReceipt.record.snapshot.lines, originalLines);

        // v15 2026-10-18 regression (40P01, order 37): a refund receipt issuance locks the
        // Order's header and Initial submission (Ordering's receipt order source), then takes the
        // Payment refund fence `PaymentReceiptOrder` for the coverage read. The staff refund item
        // list took that fence first and then locked the same Order rows FOR UPDATE: two
        // connections at once deadlocked. Canonical order (acquireOrdinaryRefundRequestFences):
        // Ordering's Order rows, then the refund fences. The issuance here pauses with the Order
        // rows locked until the item list is waiting on a lock, then takes the fence.
        {
          const waiting = async () => {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const rows = (
                await admin.query(
                  // A row lock wait is a wait on the holder's transaction id (no database).
                  "SELECT count(*)::int AS waiting FROM pg_catalog.pg_locks l WHERE NOT l.granted AND (l.database IS NULL OR l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()))",
                )
              ).rows;
              if (rows[0].waiting > 0) return;
              await delay(25);
            }
            throw new Error("the refund item list never waited on a lock");
          };
          const deadlocks = async () =>
            (
              await admin.query(
                "SELECT deadlocks::int AS deadlocks FROM pg_catalog.pg_stat_database WHERE datname=current_database()",
              )
            ).rows[0].deadlocks;
          const deadlocksBefore = await deadlocks();
          let orderSourceCalls = 0;
          let rowsLocked;
          const locked = new Promise((resolve) => (rowsLocked = resolve));
          const issuing = transactions().run((tx) =>
            createRefundReceiptIssuance({
              scope: paymentScope,
              authorize: async () => true,
              authorizeSources: async () => true,
              // The order source asks before and after it locks the Order rows: pause after.
              authorizeOrder: async () => {
                orderSourceCalls += 1;
                if (orderSourceCalls === 2) {
                  rowsLocked();
                  await waiting();
                }
                return true;
              },
              identities: () => ({ recordReference: fresh(), operationReference: fresh() }),
              audit: receiptAudit("PAYMENT_REFUND_STATUS_CHANGED"),
            })(tx, {
              orderReference: fourth.order,
              observedAt: new Date().toISOString(),
              freshAfter: paidAt,
            }),
          );
          await locked;
          const listing = items({
            ...session("requester"),
            query: { orderReference: fourth.order },
          });
          const [issued, listed] = await Promise.allSettled([issuing, listing]);
          const reason = (result) =>
            result.status === "rejected"
              ? String(result.reason?.code ?? "") +
                " " +
                String(result.reason?.message ?? result.reason) +
                " " +
                String(result.reason?.cause?.code ?? "")
              : "";
          // The victim's deadlock is counted once its connection reports (both close above).
          let deadlocksAfter = await deadlocks();
          for (let attempt = 0; attempt < 20 && deadlocksAfter === deadlocksBefore; attempt += 1) {
            await delay(100);
            deadlocksAfter = await deadlocks();
          }
          assert.equal(deadlocksAfter - deadlocksBefore, 0, "deadlocks detected (40P01)");
          assert.equal(issued.status, "fulfilled", "refund receipt issuance: " + reason(issued));
          assert.equal(listed.status, "fulfilled", "refund item list: " + reason(listed));
          // Already current: the receipt's refund version stays the latest; the list still reads.
          assert.equal(issued.value.status, "Existing");
          assert.equal(issued.value.record.recordReference, refundReceipt.record.recordReference);
          assert.equal(listed.value.orderReference, fourth.order);
        }
      }

      // ── 12. RLS: another Store's scope sees no step-ups or approvals.
      const isolated = await transactions().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, id(999)],
        );
        return (
          await tx.query(
            "SELECT (SELECT count(*)::int FROM bop_identity.workforce_mfa_step_up) AS s,(SELECT count(*)::int FROM rms_payment.ordinary_refund_approval) AS a",
          )
        ).rows[0];
      });
      assert.deepEqual(isolated, { s: 0, a: 0 });
    } finally {
      signedIn.scopeFor = null;
      await admin.end();
    }
  });
});
