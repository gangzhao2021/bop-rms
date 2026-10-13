import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createIdentityActor,
  generateHotp,
  totpTimeStep,
  verifyTotp,
} from "../../bop/identity/src/index.ts";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
} from "../../bop/membership/src/index.ts";
import { createPostgresCurrentPermissionPolicySource } from "../../bop/permission/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createPostgresSoleOperatorRefundSummaryReader } from "../../rms/payment/src/index.ts";
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
import { createMerchantOrdinaryRefundCommand } from "../../../apps/api/src/merchant-ordinary-refund-command.ts";
import { createMerchantOrdinaryRefundSendCommand } from "../../../apps/api/src/merchant-ordinary-refund-send-command.ts";
import { createMerchantRefundSoleOperatorResolver } from "../../../apps/api/src/merchant-sole-operator.ts";
import {
  createMerchantSoleOperator,
  MerchantSoleOperatorError,
} from "../../../apps/api/src/merchant-sole-operator-setting.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { standardRefundRoleMapping } from "../../../tooling/environment/pilot-refund-role-mapping.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedOrdinaryRefundStorePublication } from "../test-support/ordinary-refund-store-publication.mjs";
import { createPaidPickupOrderSeeder } from "../test-support/ordinary-refund-paid-pickup-order.mjs";

// Only the browser-session lookup is a test double: the cookie names which synthetic staff member
// is signed in at the selected Store (and, for Brand actions, the Brand). Organization, Membership,
// roles, permissions, MFA, Payment, Ordering, Pricing and Store owners are the real code over real
// rows, run as a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (with
// the proposed WP-2423 Q19 additions).
const signedIn = vi.hoisted(() => ({ scopeFor: null, brandScopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action) =>
    signedIn.scopeFor(tx, cookie, action),
}));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope: () => async (tx, cookie) => signedIn.brandScopeFor(tx, cookie),
}));

const { Client } = pg;
const id = (n) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const [tenant, brand, store, provider, owner, mia, noah] = [1, 2, 3, 4, 5, 6, 7].map(id);
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
const minutes = (n) => n * 60_000;
let references = 0xa000;
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
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner turns sole operator on (others are
 * refused, a stale second factor is refused), then requests and approves their own escalated
 * refund after re-verifying (a verification older than 15 minutes is refused); the approval and
 * its Audit say SoleOperator and the day close counts it. The Owner may withdraw their own request.
 * When a second person gains refund approval the waiver lapses at once: self-approval and Owner
 * requests are refused, the screen names the other approver, and that person may decline. Turning
 * it off is recorded; history cannot be changed.
 */
it("sole operator: set by the Brand Owner, self-approval with MFA, lapse on a second approver", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_sole_op" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_so_" + context.runId,
      worker = "wp2423_so_w_" + context.runId;
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
                query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
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
      const dbNow = async () =>
        Date.parse(
          (
            await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
          ).rows[0].at.toISOString(),
        );
      const base = await dbNow();
      const time = (offset) => new Date(base + offset).toISOString();
      const from = time(-minutes(180)),
        until = time(minutes(600));

      // ── Organization and workforce: the Brand, real Membership, Store assignments, Brand and
      // Store roles, permission grants, names and MFA enrollment (verified two hours ago).
      const brandFact = createBrand({
        brandReference: brand,
        code: "SYNTHETIC_Q19",
        displayName: "Synthetic Q19 Brand",
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
        code: "SYNTHETIC_Q19",
        displayName: "Synthetic Q19 Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      await admin.query(
        "INSERT INTO bop_tenant.brand (brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,'SYNTHETIC_Q19','Synthetic Q19 Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
        [brand, id(900), from],
      );
      const roles = {
        manager: {
          id: id(910),
          store,
          code: "store_manager",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.request",
            "payment.refund.execute",
          ],
        },
        owner: {
          id: id(911),
          store,
          code: "store_owner",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.request",
            "payment.refund.approve",
            "payment.refund.execute",
          ],
        },
        brandOwner: {
          id: id(912),
          store: null,
          code: "brand_owner",
          actions: ["merchant.access", "organization.brand.manage"],
        },
      };
      let permissionNumber = 950;
      for (const r of Object.values(roles)) {
        await admin.query(
          "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [r.id, brand, r.store, r.code, from, until],
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
            [id(permissionNumber++), r.id, permission, brand, r.store, from, until],
          );
        }
      }
      const names = { [owner]: "Sam", [mia]: "Mia", [noah]: "Noah" };
      const memberNumber = { [owner]: 100, [mia]: 110, [noah]: 120 };
      async function addMember(actor, held) {
        const n = memberNumber[actor];
        await admin.query(
          "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [id(n), actor, brand, id(n + 1), from, until],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [id(n + 2), id(n), actor, brand, store, from, until],
        );
        await admin.query(
          "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
          [id(n), brand, actor, names[actor], id(n + 9), from],
        );
        await admin.query(
          "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
          [actor, id(n + 6), time(-minutes(120))],
        );
        await assignRoles(actor, held);
      }
      async function assignRoles(actor, held) {
        const n = memberNumber[actor];
        for (const [j, r] of held.entries())
          await admin.query(
            "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
            [
              id(n + 3 + j),
              r.id,
              id(n),
              r.store === null ? null : id(n + 2),
              actor,
              brand,
              r.store,
              from,
              until,
            ],
          );
      }
      await addMember(owner, [roles.owner, roles.brandOwner]);
      await addMember(mia, [roles.manager]);
      // Identity roster double (pilot `currentActor`): an active workforce actor per reference.
      const currentActor = async (_tx, reference, authenticatedAt) => {
        assert.ok([owner, mia, noah].includes(reference));
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
      const cookies = { owner, mia, noah };
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
        };
      };
      // Brand-scope decision: the real Permission owner over Brand-wide roles only.
      signedIn.brandScopeFor = async (tx, cookie) => {
        const actorReference = cookies[cookie];
        assert.ok(actorReference, "unknown synthetic session");
        return {
          authorizeAction: async (action) => {
            try {
              const at = new Date().toISOString();
              const actor = await currentActor(tx, actorReference, from, at);
              const memberships = createPostgresCurrentMembershipSource(
                tx,
                createTenantContext(actor, brandFact, storeFact, at),
              );
              const membership = resolveActiveMembership(
                await memberships.findMemberships(actorReference, brand),
                actorReference,
                brand,
                at,
              );
              const decision = await createPostgresCurrentPermissionPolicySource(tx).authorize({
                tenantContext: createTenantContext(actor, brandFact, null, at),
                membership,
                storeAssignment: null,
                action,
              });
              return decision.scopeKind === "Brand" ? decision : null;
            } catch {
              return null;
            }
          },
        };
      };
      const session = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });

      // ── Paid pickup Orders (CAD 116.00 each) and the published Store business day.
      const seedOrder = createPaidPickupOrderSeeder({
        admin,
        ownerRunner,
        scope,
        id,
        hash,
        fresh,
        time,
        minutes,
        acceptorReference: mia,
        provider,
        lines: LINES,
        tipMinor: TIP_MINOR,
        capturedMinor: CAPTURED_MINOR,
      });
      const orders = [];
      for (const n of [1000, 2000, 3000, 4000]) orders.push(await seedOrder(n));
      const { businessDate: businessDatePort, storeOptions } =
        await seedOrdinaryRefundStorePublication({
          client: admin,
          scope,
          firstCapturedAt: seedOrder.paidAt,
        });

      // ── Simulated Stripe (InternalTest): the real refund adapter over a fake transport.
      const providerRefunds = [];
      let providerSends = 0;
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
            id: "re_SYNTHETICQ19" + String(providerRefunds.length + 1).padStart(4, "0"),
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
        return standardRefundRoleMapping;
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
        soleOperator: true,
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
      const soleOperatorResolver = createMerchantRefundSoleOperatorResolver(escalatedConfiguration);
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
          roleMapping: standardRefundRoleMapping,
        }),
        newReference: fresh,
        locale: "en-CA",
        soleOperator: soleOperatorResolver,
      });
      const request = createMerchantOrdinaryRefundRequest({
        persistence,
        authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping: standardRefundRoleMapping,
        }),
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
        businessDate: businessDatePort,
        soleOperator: soleOperatorResolver,
      });
      const soleOperator = createMerchantSoleOperator({
        persistence,
        authentication,
        resolveConfiguration: escalatedConfiguration,
        retentionPolicyCode: "SECURITY_AUDIT",
        retentionPolicyVersion: 1,
      });
      // TEST-ONLY authenticator secrets, generated per run and kept in memory only.
      const secrets = new Map([owner, mia, noah].map((a) => [a, randomBytes(20)]));
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
      // A code is accepted once per person: a second verification in the same 30-second step
      // waits for the next code, as a person would.
      const verify = async (who, purpose) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await stepUp({
            ...session(who),
            command: {
              purpose,
              code: generateHotp(secrets.get(cookies[who]), totpTimeStep(Date.now())),
            },
          });
          if (result.status === "Verified") return result;
          assert.equal(result.reason, "CodeReused");
          await delay(30_000 - (Date.now() % 30_000) + 250);
        }
        throw new Error("STEP_UP_NOT_VERIFIED");
      };
      const fullRefund = (order, requestReference = fresh(), operationReference = fresh()) => ({
        orderReference: order.order,
        requestReference,
        operationReference,
        expectedClaimVersion: 0,
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
            "SELECT (SELECT count(*)::int FROM bop_tenant.brand_sole_operator_setting) AS settings," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_request) AS requests," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_approval) AS approvals," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_decline) AS declines," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_operation) AS operations," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch) AS dispatches",
          )
        ).rows[0];
      const settingCommand = (
        state,
        reasonCode,
        expectedVersion,
        operationReference = fresh(),
      ) => ({
        state,
        reasonCode,
        expectedVersion,
        operationReference,
      });
      const refusedWith = (code) => (error) => {
        assert.equal(error.code, code);
        return true;
      };

      // ── 1. Only the Brand Owner sees and changes the setting; it starts Off.
      await assert.rejects(soleOperator.read({ sessionCookie: "mia" }), (error) => {
        assert.ok(error instanceof MerchantSoleOperatorError);
        assert.equal(error.code, "Denied");
        return true;
      });
      const initial = await soleOperator.read({ sessionCookie: "owner" });
      assert.equal(initial.state, "Off");
      assert.equal(initial.version, 0);
      assert.deepEqual(initial.refundApproval, {
        status: "NotSet",
        youHoldApproval: true,
        otherApprovers: [],
      });
      assert.equal(initial.verifiedUntil, null);
      let before = await counts();
      await assert.rejects(
        soleOperator({
          ...session("mia"),
          command: settingCommand("On", "OWNER_RUNS_STORE_ALONE", 0),
        }),
        refusedWith("Denied"),
      );
      // The Owner's second factor is two hours old: turning it on needs a fresh verification.
      await assert.rejects(
        soleOperator({
          ...session("owner"),
          command: settingCommand("On", "OWNER_RUNS_STORE_ALONE", 0),
        }),
        refusedWith("NeedsReverification"),
      );
      await assert.rejects(
        soleOperator({ ...session("owner"), command: settingCommand("On", "OWNER_CHOICE", 0) }),
        refusedWith("Invalid"),
      );
      assert.deepEqual(await counts(), before);

      // ── 2. A verification that will turn 15 minutes old during this test (owner-seeded
      // evidence, 8 seconds short of 15 minutes) lets the Owner turn it on now.
      const ageingStepUpAt = new Date((await dbNow()) - minutes(15) + 8000).toISOString();
      await admin.query(
        "INSERT INTO bop_identity.workforce_mfa_step_up (step_up_id,brand_id,store_id,actor_id,session_id,method,purpose_code,outcome,rejection_reason,time_step,attempted_at,audit_id) VALUES ($1,$2,$3,$4,$5,'InternalTestTotp','ORGANIZATION_SOLE_OPERATOR_SETTING','Verified',NULL,1,$6,$7)",
        [id(990), brand, store, owner, id(800), ageingStepUpAt, id(991)],
      );
      const turnOn = settingCommand("On", "OWNER_RUNS_STORE_ALONE", 0);
      const enabled = await soleOperator({ ...session("owner"), command: turnOn });
      assert.equal(enabled.status, "Created");
      assert.equal(enabled.state, "On");
      assert.equal(enabled.version, 1);
      assert.equal(
        (await soleOperator({ ...session("owner"), command: turnOn })).status,
        "AlreadyCommitted",
      );
      await assert.rejects(
        soleOperator({
          ...session("owner"),
          command: settingCommand("On", "OWNER_RUNS_STORE_ALONE", 0),
        }),
        refusedWith("VersionConflict"),
      );
      await assert.rejects(
        soleOperator({
          ...session("owner"),
          command: settingCommand("On", "OWNER_RUNS_STORE_ALONE", 1),
        }),
        refusedWith("NoChange"),
      );
      const settingRows = (
        await admin.query(
          "SELECT version::int AS version,state,reason_code,actor_id::text AS actor,audit_id::text AS audit FROM bop_tenant.brand_sole_operator_setting ORDER BY version",
        )
      ).rows;
      assert.deepEqual(
        settingRows.map((row) => [row.version, row.state, row.reason_code, row.actor]),
        [[1, "On", "OWNER_RUNS_STORE_ALONE", owner]],
      );
      const settingAudit = (
        await admin.query(
          "SELECT action_code,actor_reference::text AS actor,reason_code,data_classification,before_summary_json::text AS before,after_summary_json::text AS after FROM platform_audit.audit_record WHERE audit_id=$1",
          [settingRows[0].audit],
        )
      ).rows;
      assert.equal(settingAudit.length, 1);
      assert.equal(settingAudit[0].action_code, "ORGANIZATION_SOLE_OPERATOR_ENABLED");
      assert.equal(settingAudit[0].actor, owner);
      assert.equal(settingAudit[0].reason_code, "OWNER_RUNS_STORE_ALONE");
      assert.deepEqual(JSON.parse(settingAudit[0].before), { state: "NotSet" });
      assert.deepEqual(JSON.parse(settingAudit[0].after), { state: "On", version: 1 });

      // ── 3. In effect: the Owner is the only person holding refund approval at the Store.
      const effective = await soleOperator.read({ sessionCookie: "owner" });
      assert.equal(effective.state, "On");
      assert.equal(effective.refundApproval.status, "Effective");
      assert.deepEqual(
        effective.history.map((entry) => [entry.version, entry.state, entry.changedByYou]),
        [[1, "On", true]],
      );
      assert.equal(effective.history[0].changedByName, "Sam");

      // ── 4. The Owner may start a refund request; escalation still applies (over CAD 100).
      const [first, second, third, fourth] = orders;
      assert.equal(
        (await items({ ...session("owner"), query: { orderReference: first.order } })).canRequest,
        true,
      );
      const firstRequest = fullRefund(first);
      const recorded = await request({ ...session("owner"), command: firstRequest });
      assert.equal(recorded.status, "Created");
      assert.equal(recorded.approvalRequired, true);
      assert.ok(recorded.escalationReasons.includes("OrderOrdinaryTotalAboveCad100"));
      // The owner is told they may approve it themself (sole operator in effect).
      assert.equal(recorded.approveAlone, true);
      const ownerQueue = await approvals({ sessionCookie: "owner" });
      assert.equal(ownerQueue.soleOperator, "Effective");
      assert.deepEqual(
        ownerQueue.entries.map((e) => [
          e.requestReference,
          e.requestedByYou,
          e.canApprove,
          e.soleOperatorApproval,
        ]),
        [[firstRequest.requestReference, true, true, true]],
      );

      // ── 5. Self-approval needs the explicit SoleOperator confirmation and a verification at
      // most 15 minutes old; refusals record and send nothing.
      const firstApproval = {
        orderReference: first.order,
        requestReference: firstRequest.requestReference,
        approvalReference: fresh(),
      };
      before = await counts();
      await assert.rejects(
        approve({ ...session("owner"), command: firstApproval }),
        refusedWith("SamePerson"),
      );
      while ((await dbNow()) - Date.parse(ageingStepUpAt) <= minutes(15)) await delay(250);
      await assert.rejects(
        approve({
          ...session("owner"),
          command: { ...firstApproval, approvalMode: "SoleOperator" },
        }),
        (error) => {
          assert.ok(error instanceof MerchantRefundApprovalError);
          assert.equal(error.code, "NeedsReverification");
          return true;
        },
      );
      assert.deepEqual(await counts(), before);
      assert.equal(providerSends, 0);

      // ── 6. After re-verifying, the Owner approves their own request: one send, marked
      // SoleOperator on the approval record and its Audit.
      await verify("owner", "RefundApproval");
      const soleApproval = { ...firstApproval, approvalMode: "SoleOperator" };
      const approved = await approve({ ...session("owner"), command: soleApproval });
      assert.equal(approved.status, "Approved");
      assert.equal(approved.replayed, false);
      assert.deepEqual(
        approved.payments.map((p) => p.state),
        ["SendRecorded"],
      );
      assert.equal(providerSends, 1);
      const approvalRow = (
        await admin.query(
          "SELECT requester_id::text AS requester,approver_id::text AS approver,approval_mode,record_json->>'approvalMode' AS json_mode,audit_id::text AS audit FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
          [firstApproval.approvalReference],
        )
      ).rows[0];
      assert.equal(approvalRow.requester, owner);
      assert.equal(approvalRow.approver, owner);
      assert.equal(approvalRow.approval_mode, "SoleOperator");
      assert.equal(approvalRow.json_mode, "SoleOperator");
      const approvalAudit = (
        await admin.query(
          "SELECT actor_reference::text AS actor,after_summary_json::text AS after FROM platform_audit.audit_record WHERE audit_id=$1",
          [approvalRow.audit],
        )
      ).rows[0];
      assert.equal(approvalAudit.actor, owner);
      assert.deepEqual(JSON.parse(approvalAudit.after), { approvalMode: "SoleOperator" });
      // Retrying the same approval never sends again; a replay without the mark is refused.
      const replay = await approve({ ...session("owner"), command: soleApproval });
      assert.equal(replay.replayed, true);
      assert.equal(providerSends, 1);

      // ── 7. Day close: today's self-approved refunds (count and amount) for the Owner's review.
      const summary = () =>
        transactions().run(async (tx) =>
          createPostgresSoleOperatorRefundSummaryReader({ scope, authorize: async () => true })(
            tx,
            {
              startsAt: new Date(base - minutes(240)).toISOString(),
              endsAt: new Date(base + minutes(240)).toISOString(),
            },
          ),
        );
      assert.deepEqual(
        [(await summary()).count, (await summary()).amountMinor],
        [1, CAPTURED_MINOR],
      );

      // ── 8. The Owner withdraws their own request only as entered in error or withdrawn by
      // the customer (marked SoleOperator); it then stops counting toward the Order.
      const secondRequest = fullRefund(second);
      await request({ ...session("owner"), command: secondRequest });
      const withdraw = (reasonCode) => ({
        orderReference: second.order,
        requestReference: secondRequest.requestReference,
        operationReference: fresh(),
        reasonCode,
      });
      await assert.rejects(
        decline({ ...session("owner"), command: withdraw("CUSTOMER_WITHDREW") }),
        refusedWith("SamePerson"),
      );
      await assert.rejects(
        decline({
          ...session("owner"),
          command: { ...withdraw("NOT_ELIGIBLE"), declineMode: "SoleOperator" },
        }),
        refusedWith("Denied"),
      );
      const withdrawn = await decline({
        ...session("owner"),
        command: { ...withdraw("CUSTOMER_WITHDREW"), declineMode: "SoleOperator" },
      });
      assert.equal(withdrawn.status, "Declined");
      assert.deepEqual(
        (
          await admin.query(
            "SELECT decliner_id::text AS decliner,requester_id::text AS requester,decline_mode,reason_code FROM rms_payment.ordinary_refund_decline WHERE request_id=$1",
            [secondRequest.requestReference],
          )
        ).rows,
        [
          {
            decliner: owner,
            requester: owner,
            decline_mode: "SoleOperator",
            reason_code: "CUSTOMER_WITHDREW",
          },
        ],
      );

      // ── 9. A second person gains refund approval: the waiver lapses at once (setting kept).
      const thirdRequest = fullRefund(third);
      await request({ ...session("owner"), command: thirdRequest });
      await addMember(noah, [roles.owner]);
      const lapsed = await soleOperator.read({ sessionCookie: "owner" });
      assert.equal(lapsed.state, "On");
      assert.deepEqual(lapsed.refundApproval, {
        status: "OtherApprovers",
        youHoldApproval: true,
        otherApprovers: [{ displayName: "Noah" }],
      });
      const thirdApproval = {
        orderReference: third.order,
        requestReference: thirdRequest.requestReference,
        approvalReference: fresh(),
      };
      before = await counts();
      await assert.rejects(
        approve({
          ...session("owner"),
          command: { ...thirdApproval, approvalMode: "SoleOperator" },
        }),
        refusedWith("SoleOperatorNotInEffect"),
      );
      const lapsedQueue = await approvals({ sessionCookie: "owner" });
      assert.equal(lapsedQueue.soleOperator, "OtherApprovers");
      assert.deepEqual(
        lapsedQueue.entries.map((e) => [e.requestReference, e.canApprove, e.soleOperatorApproval]),
        [[thirdRequest.requestReference, false, false]],
      );
      // The Owner may no longer start requests; Mia (Manager) still may.
      assert.equal(
        (await items({ ...session("owner"), query: { orderReference: fourth.order } })).canRequest,
        false,
      );
      await assert.rejects(request({ ...session("owner"), command: fullRefund(fourth) }));
      // The other approver cannot approve an Owner's request (requester must be a Manager), but
      // may decline it so it stops counting; nothing is sent.
      await verify("noah", "RefundApproval");
      await assert.rejects(
        approve({ ...session("noah"), command: thirdApproval }),
        refusedWith("RequesterNotEligible"),
      );
      assert.deepEqual(await counts(), before);
      const noahDeclined = await decline({
        ...session("noah"),
        command: {
          orderReference: third.order,
          requestReference: thirdRequest.requestReference,
          operationReference: fresh(),
          reasonCode: "NEEDS_MORE_INFORMATION",
        },
      });
      assert.equal(noahDeclined.status, "Declined");
      assert.equal(providerSends, 1);

      // ── 10. The Owner turns it off (recorded with the reason) — the read says Off.
      await verify("owner", "SoleOperatorSetting");
      const disabled = await soleOperator({
        ...session("owner"),
        command: settingCommand("Off", "SECOND_APPROVER_AVAILABLE", 1),
      });
      assert.deepEqual([disabled.state, disabled.version], ["Off", 2]);
      const off = await soleOperator.read({ sessionCookie: "owner" });
      assert.equal(off.state, "Off");
      assert.equal(off.refundApproval.status, "NotSet");
      assert.deepEqual(
        off.history.map((entry) => [entry.version, entry.state, entry.reasonCode]),
        [
          [2, "Off", "SECOND_APPROVER_AVAILABLE"],
          [1, "On", "OWNER_RUNS_STORE_ALONE"],
        ],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORGANIZATION_SOLE_OPERATOR_DISABLED' AND reason_code='SECOND_APPROVER_AVAILABLE'",
          )
        ).rows[0].n,
        1,
      );
      // Independent approvals are not counted as self-approved.
      assert.equal((await summary()).count, 1);

      // ── 11. History is immutable; the database refuses an unmarked one-person approval and a
      // SoleOperator mark on two people.
      await assert.rejects(
        admin.query("UPDATE bop_tenant.brand_sole_operator_setting SET state='Off'"),
        /append-only brand sole operator setting/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM bop_tenant.brand_sole_operator_setting"),
        /append-only brand sole operator setting/u,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_tenant.brand_sole_operator_setting (tenant_id,brand_id,setting_id,version,state,reason_code,actor_id,actor_mfa_at,recorded_at,operation_id,audit_id) VALUES ($1,$2,$3,4,'On','OWNER_RUNS_STORE_ALONE',$4,now(),date_trunc('milliseconds',now()),$5,$6)",
          [tenant, brand, id(980), owner, id(981), id(982)],
        ),
        /out of sequence/u,
      );
      const updated = await admin.query(
        "UPDATE rms_payment.ordinary_refund_approval SET approval_mode='Independent' WHERE approval_id=$1",
        [firstApproval.approvalReference],
      );
      assert.equal(updated.rowCount, 0);
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.ordinary_refund_approval SELECT tenant_id,brand_id,store_id,order_id,request_id,$2::uuid,$3::uuid,requester_id,approver_id,$4::uuid,claim_version,approved_at,requester_mfa_at,approver_mfa_at,claims_digest,allocation_digest,jsonb_set(record_json,'{approvalReference}',to_jsonb($2::text)) - 'approvalMode','Independent' FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
          [firstApproval.approvalReference, id(983), id(984), id(985)],
        ),
        /ordinary_refund_approval_independent/u,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.ordinary_refund_approval SELECT tenant_id,brand_id,store_id,order_id,request_id,$2::uuid,$3::uuid,requester_id,$5::uuid,$4::uuid,claim_version,approved_at,requester_mfa_at,approver_mfa_at,claims_digest,allocation_digest,jsonb_set(jsonb_set(record_json,'{approverReference}',to_jsonb($5::text)),'{approvalReference}',to_jsonb($2::text)),'SoleOperator' FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
          [firstApproval.approvalReference, id(986), id(987), id(988), noah],
        ),
        /ordinary_refund_approval_sole_operator_same_person/u,
      );
    } finally {
      await admin.end();
    }
  });
});
