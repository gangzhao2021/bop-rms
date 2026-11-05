import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import { it, vi } from "vitest";
import {
  createIdentityActor,
  generateHotp,
  totpTimeStep,
  verifyTotp,
} from "../../bop/identity/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createDiningGuestBindingQuery,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningGuestTableStartStore,
  createPostgresDiningPaymentTimingStore,
  loadDiningGuestTableStart,
} from "../../rms/dining/src/index.ts";
import { createPostgresReceiptOrderSource } from "../../rms/ordering/src/index.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createPostgresOrdinaryRefundPositionSource } from "../../rms/payment/src/infrastructure/ordinary-refund-position-source.ts";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-reconciliation-runtime.ts";
import { createCustomerReceiptRead } from "../../../apps/api/src/customer-receipt-read.ts";
import { createDiningOrderCloseConfiguration } from "../../../apps/api/src/dining-order-close-configuration.ts";
import { createMerchantDiningClosingCommand } from "../../../apps/api/src/merchant-dining-closing-command.ts";
import { createMerchantDiningOrderCloseCommand } from "../../../apps/api/src/merchant-dining-order-close-command.ts";
import { createMerchantGuestTableStartOff } from "../../../apps/api/src/merchant-dining-guest-table-start.ts";
import { createMerchantDiningOrderProgress } from "../../../apps/api/src/merchant-dining-order-progress.ts";
import { createMerchantDiningServeCommand } from "../../../apps/api/src/merchant-dining-serve-command.ts";
import { createMerchantDiningTableClosePlan } from "../../../apps/api/src/merchant-dining-table-close-plan.ts";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantMfaStepUp } from "../../../apps/api/src/merchant-mfa-step-up.ts";
import { createMerchantOrdinaryRefundCommand } from "../../../apps/api/src/merchant-ordinary-refund-command.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import { createMerchantOrdinaryRefundSendCommand } from "../../../apps/api/src/merchant-ordinary-refund-send-command.ts";
import { createMerchantStoreFeatures } from "../../../apps/api/src/merchant-store-features.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import { createOriginalReceiptIssuance } from "../../../apps/api/src/original-receipt-issuance.ts";
import { createPersistentMerchantSettlement } from "../../../apps/api/src/persistent-merchant-settlement.ts";
import { createPersistentMerchantStoreReports } from "../../../apps/api/src/persistent-merchant-store-reports.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { standardRefundRoleMapping } from "../../../tooling/environment/pilot-refund-role-mapping.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import {
  closer,
  digest,
  finishKitchen,
  fresh,
  id,
  minutes,
  provider,
  scope,
  seedPaidGuestTable,
  setup,
} from "../test-support/dining-guest-table-fixture.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { exerciseReceiptTemplate } from "../test-support/receipt-template.mjs";

// Only the merchant session lookup for the refund staff is a test double, as in the dine-in journey:
// the cookie names which synthetic staff member is signed in. Any other cookie (the staff session
// that closes tables and reads the reports) goes to the real scope resolution.
const signedIn = vi.hoisted(() => ({ cookies: new Set(), scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createMerchantStoreScope: (source) => {
      let real = null;
      return async (tx, cookie, action, ...rest) => {
        if (signedIn.cookies.has(cookie)) return signedIn.scopeFor(tx, cookie, action);
        real ??= actual.createMerchantStoreScope(source);
        return real(tx, cookie, action, ...rest);
      };
    },
  };
});

const now = () => new Date().toISOString();

/** The table's facts as one read, and the Store's business day (today, started three hours ago). */
async function openDay(admin, ownerScope, base) {
  const time = (offset) => new Date(base + offset).toISOString();
  const local = (instant, options) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Toronto",
      hourCycle: "h23",
      ...options,
    }).format(new Date(instant));
  const dayStart = local(time(-minutes(180)), { hour: "2-digit", minute: "2-digit" }) + ":00";
  const today = local(time(-minutes(180)), { year: "numeric", month: "2-digit", day: "2-digit" })
    .split("/")
    .reverse()
    .join("-");
  const yesterdayNoon = Date.parse(today + "T12:00:00.000Z") - 86_400_000;
  const published = await seedJourneyStorePublication({
    client: admin,
    scope: ownerScope,
    publishedAt: new Date(
      Math.min(base - minutes(60 * 30), yesterdayNoon - minutes(120)),
    ).toISOString(),
    businessDayStart: dayStart,
    prefix: "01a7d100",
  });
  return { today, ...published };
}

/**
 * A manager and an owner with real Membership, roles, grants and MFA; the refund commands composed
 * as the pilot API composes them, over the real Stripe adapter on a simulated transport (TEST).
 */
async function refundStaff({ admin, transactions, ownerScope, base, storeOptions, businessDate }) {
  const from = new Date(base - minutes(240)).toISOString(),
    until = new Date(base + minutes(600)).toISOString();
  const { tenantReference: tenant, brandReference, storeReference } = ownerScope;
  const [manager, boss] = [id(0xc01), id(0xc02)];
  const brandFact = createBrand({
    brandReference,
    code: "SYNTHETIC_JOURNEY",
    displayName: "Synthetic Journey Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: from,
    updatedAt: from,
  });
  const storeFact = createStore({
    storeReference,
    brandReference,
    code: "SYNTHETIC_JOURNEY",
    displayName: "Synthetic Journey Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: from,
    updatedAt: from,
  });
  const roleSets = {
    manager: {
      id: id(0xc10),
      code: "store_manager",
      actions: [
        "merchant.access",
        "workflow.operate",
        "payment.refund.request",
        "payment.refund.execute",
      ],
    },
    owner: {
      id: id(0xc11),
      code: "store_owner",
      actions: [
        "merchant.access",
        "workflow.operate",
        "payment.refund.approve",
        "payment.refund.execute",
      ],
    },
  };
  let number = 0xc50;
  for (const role of Object.values(roleSets)) {
    await admin.query(
      "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [role.id, brandReference, storeReference, role.code, from, until],
    );
    for (const action of role.actions) {
      let permission = (
        await admin.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
          [action],
        )
      ).rows[0]?.permission_id;
      if (!permission) {
        permission = id(number++);
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
          [permission, action, from],
        );
      }
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [id(number++), role.id, permission, brandReference, storeReference, from, until],
      );
    }
  }
  for (const [i, [actor, held]] of [
    [manager, roleSets.manager],
    [boss, roleSets.owner],
  ].entries()) {
    const n = 0xd00 + i * 0x10;
    await admin.query(
      "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [id(n), actor, brandReference, id(n + 1), from, until],
    );
    await admin.query(
      "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(n + 2), id(n), actor, brandReference, storeReference, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
      [id(n + 3), held.id, id(n), id(n + 2), actor, brandReference, storeReference, from, until],
    );
    await admin.query(
      "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
      [actor, id(n + 6), new Date(base - minutes(120)).toISOString()],
    );
  }
  const currentActor = async (_tx, reference, authenticatedAt) => {
    assert.ok([manager, boss].includes(reference));
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
  const cookies = { manager, owner: boss };
  signedIn.cookies = new Set(Object.keys(cookies));
  signedIn.scopeFor = async (tx, cookie, action) => {
    const actorReference = cookies[cookie];
    const actor = await currentActor(tx, actorReference, from);
    const decide = async (requested) => {
      try {
        const at = now();
        const result = await createMerchantWorkforcePermissionSource({
          resolveContext: async () => ({
            tenantReference: tenant,
            context: createTenantContext(actor, brandFact, storeFact, at),
          }),
        })(tx, { ...ownerScope, actorReference, observedAt: at, permissionCode: requested });
        return result.decision;
      } catch {
        return null;
      }
    };
    return {
      selected: { tenantReference: tenant },
      context: createTenantContext(actor, brandFact, storeFact, now()),
      store: storeFact,
      actorReference,
      sessionReference: id(0xe00 + Object.keys(cookies).indexOf(cookie)),
      kdsOperatorProfileAllows: (requested) =>
        kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
      allowed: async () => (await decide(action))?.effect === "Allow",
      authorizeAction: decide,
    };
  };
  const session = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });
  const providerRefunds = [];
  const stripe = createStripeOrdinaryRefundAdapter({
    brandReference,
    storeReference,
    environment: "Test",
    apiVersion: "2024-06-20",
    secretKey: "sk_test_SYNTHETICONLY",
    connectedAccount: null,
    now,
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
        id: "re_SYNTHETICGUEST" + String(providerRefunds.length + 1).padStart(4, "0"),
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
  const persistence = { transactions: transactions(), now };
  const authentication = {
    authorize: async (input) => ({
      sessionReference: id(0xe00 + Object.keys(cookies).indexOf(input.sessionCookie)),
    }),
  };
  const workforceFor = (actorReference, sessionContext, current) => ({
    resolveContext: createInternalRefundWorkforceContext({
      expected: ownerScope,
      persistence: { currentActor },
      sessionActorReference: actorReference,
      sessionContext,
      current,
    }),
    resolveRoleMapping: async () => standardRefundRoleMapping,
    stepUp: true,
  });
  const refundAudit = {
    reasonCode: "REFUND_REQUEST_EXECUTION",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  };
  const prepare = createMerchantOrdinaryRefundCommand({
    persistence,
    authentication,
    audit: refundAudit,
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
    audit: refundAudit,
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
      provider: { refundPayment: (request) => stripe.refundPayment(request) },
      generateObservationIdentity: () => ({
        observationReference: fresh(),
        auditReference: fresh(),
      }),
    }),
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
    businessDate,
  });
  const secrets = new Map([manager, boss].map((actor) => [actor, randomBytes(20)]));
  const stepUp = createMerchantMfaStepUp({
    persistence,
    authentication,
    method: "InternalTestTotp",
    verify: async ({ actorReference, code, atMilliseconds }) =>
      verifyTotp({ secret: secrets.get(actorReference), code, atMilliseconds }),
    newReference: fresh,
    retentionPolicyCode: "SECURITY_AUDIT",
    retentionPolicyVersion: 1,
  });
  return {
    manager,
    session,
    request,
    prepare,
    send,
    stepUp,
    stripe,
    providerRefunds,
    codeFor: (actor) => generateHotp(secrets.get(actor), totpTimeStep(Date.now())),
  };
}

/** A manager refunds the whole round; returns once the Provider has it and Payment confirmed it. */
async function refundWholeRound({ staff, seeded, transactions, requestOnly = false, recorded }) {
  const { ownerScope, orderReference, refs, roundTotal, round, items } = seeded;
  const command = recorded ?? {
    orderReference,
    requestReference: fresh(),
    operationReference: fresh(),
    expectedClaimVersion: 0,
    reasonCode: "WRONG_ITEM",
    items: items.map((item) => ({
      orderBatchReference: round.batch.orderBatchReference,
      orderItemReference: item.orderItemReference,
      quantity: item.quantity,
    })),
  };
  const manager = staff.session("manager");
  if (recorded === undefined) {
    const preview = await staff.request.preview({ ...manager, command });
    assert.equal(preview.amountMinor, String(roundTotal));
    assert.equal(preview.approvalRequired, false);
    assert.equal(
      (
        await staff.stepUp({
          ...manager,
          command: { purpose: "RefundRequest", code: staff.codeFor(staff.manager) },
        })
      ).status,
      "Verified",
    );
    assert.equal((await staff.request({ ...manager, command })).status, "Created");
    if (requestOnly) return command;
  }
  const operationReference = fresh();
  await staff.prepare({
    ...manager,
    command: {
      orderReference,
      requestReference: command.requestReference,
      paymentAttemptReference: refs.attempt,
      operationReference,
      auditReference: fresh(),
      approvalReference: null,
    },
  });
  await staff.send({
    ...manager,
    command: {
      operationReference,
      orderReference,
      requestReference: command.requestReference,
      dispatchReference: fresh(),
      auditReference: fresh(),
      approvalReference: null,
    },
  });
  assert.deepEqual(
    staff.providerRefunds.map((refund) => [refund.payment_intent, refund.amount, refund.status]),
    [[refs.providerIntent, Number(roundTotal), "succeeded"]],
  );
  assert.equal(
    (
      await createPostgresOrdinaryRefundReconciliationRuntime({
        scope: ownerScope,
        providerAccountReference: provider,
        environment: "Test",
        authorize: async () => true,
        transactions: transactions(),
        provider: { lookupRefund: (input) => staff.stripe.lookupRefund(input) },
      })({
        orderReference,
        operationReference,
        observationReference: fresh(),
        auditReference: fresh(),
      })
    ).status,
    "AlreadyConfirmed",
  );
  const position = await transactions().run((tx) =>
    createPostgresOrdinaryRefundPositionSource({
      scope: ownerScope,
      providerAccountReference: provider,
      environment: "Test",
      authorize: async () => true,
    })(tx, {
      orderReference,
      paymentTransactionReference: refs.transaction,
      paymentIntentReference: refs.paymentIntent,
      paymentAttemptReference: refs.attempt,
      observedAt: now(),
    }),
  );
  assert.equal(position.confirmedMinor, roundTotal);
  assert.equal(position.pendingMinor, 0n);
  return command;
}

/** The staff close as the Tables page runs it: Served, then table, Order and table again. */
function staffClose({ manager, persistence, ownerScope, seeded }) {
  const { orderReference, session } = seeded;
  const diningSessionReference = session.diningSessionReference;
  const as = { sessionCookie: manager.sessionCookie, csrf: manager.csrf };
  const refundConfiguration = async () => ({
    providerAccountReference: provider,
    environment: "Test",
  });
  const closeOrder = createMerchantDiningOrderCloseCommand({
    persistence,
    authentication: manager.authentication,
    resolveConfiguration: createDiningOrderCloseConfiguration({
      ...ownerScope,
      providerAccountReference: provider,
      environment: "Test",
    }),
    newReference: fresh,
    audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
  const closeTable = createMerchantDiningClosingCommand({
    persistence,
    authentication: manager.authentication,
    providerAccountReference: provider,
    environment: "Test",
    newReference: fresh,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const plan = () =>
    createMerchantDiningTableClosePlan({
      persistence,
      authentication: manager.authentication,
      resolveRefundConfiguration: refundConfiguration,
    })({ ...as, query: { orderReference, diningSessionReference } });
  const serve = createMerchantDiningServeCommand({
    persistence,
    authentication: manager.authentication,
    reference: fresh,
    audit: {
      reasonCode: "DINING_ITEM_SERVED",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const progress = createMerchantDiningOrderProgress({
    persistence,
    locale: "en-CA",
    authentication: manager.authentication,
  });
  return async function close() {
    const ready = await progress({ ...as, query: { orderReference } });
    for (const item of ready.items)
      await serve({
        ...as,
        command: {
          operationReference: fresh(),
          orderReference,
          orderItemReference: String(item.orderItemReference),
          quantity: item.remainingQuantity,
          expectedOrderVersion: ready.currentOrderVersion,
          expectedItemServiceVersion: item.itemServiceVersion,
          expectedSessionVersion: ready.sessionVersion,
          expectedTableAssignmentVersion: ready.tableAssignmentVersion,
        },
      });
    const served = await progress({ ...as, query: { orderReference } });
    const begun = await closeTable({
      ...as,
      command: {
        action: "Begin",
        diningSessionReference,
        operationReference: fresh(),
        expectedSessionVersion: served.sessionVersion,
      },
    });
    assert.equal(begun.status, "Applied");
    const current = await plan();
    assert.deepEqual([...current.closeBlockers], []);
    await closeOrder({
      ...as,
      command: {
        orderReference,
        operationReference: fresh(),
        expectedOrderVersion: current.orderVersion,
        expectedClosureVersion: 0,
        reasonCode: "ORDER_COMPLETED",
      },
    });
    const finished = await closeTable({
      ...as,
      command: {
        action: "Finalize",
        diningSessionReference,
        operationReference: fresh(),
        expectedSessionVersion: begun.sessionVersion,
      },
    });
    assert.equal(finished.phase, "Closed");
  };
}

const tableState = async (admin, seeded) =>
  (
    await admin.query(
      "SELECT s.phase,t.table_snapshot->>'operationalState' AS state,t.table_snapshot->>'blockReasonCode' AS block,t.table_snapshot->>'activeDiningSessionReference' AS active FROM rms_dining.dining_session s JOIN rms_dining.dining_table t USING (table_id) WHERE s.session_id=$1",
      [seeded.session.diningSessionReference],
    )
  ).rows[0];

/** The same day at one table, opened and closed by the guest and System or by staff. */
async function aDayAtOneTable(context, kind, base, costs) {
  const { admin, transactions, ownerRunner, opened, matrices } = await setup(context);
  vi.stubEnv("NODE_ENV", "development");
  try {
    const guestStarted = kind === "Guest";
    const seeded = await seedPaidGuestTable(admin, transactions, {
      base,
      prefix: "01a00001",
      refsAt: 0x1000,
      ownerRunner,
      guestStarted,
    });
    const { ownerScope, session, orderReference, roundTotal } = seeded;
    const manager = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions(),
      scope: ownerScope,
      actor: id(0x703),
      at: now(),
      extraPermissions: [
        "dining.operate",
        "dining.item.serve",
        "dining.session.close",
        "order.close",
        "operations.order-exception.manage",
        "reporting.sales.read",
        "reporting.sales.export",
        "payment.settlement.read",
      ],
      referencePrefix: "01909962",
      sessionReferencePrefix: "01909961",
    });
    const day = await openDay(admin, ownerScope, base);
    const persistence = {
      ...manager.persistence,
      transactions: transactions(),
      now,
      publication: {
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
      },
    };
    const resolveConfiguration = async () => ({
      providerAccountReference: provider,
      environment: "Test",
    });
    const reports = createPersistentMerchantStoreReports({ persistence, resolveConfiguration });
    const settlement = createPersistentMerchantSettlement({
      persistence,
      resolveConfiguration,
      settlementRunReference: async () => null,
    });
    /** What the owner reads tonight: the report, the closing summary and the day-end settlement. */
    const books = async () => {
      const report = await reports.read({
        sessionCookie: manager.sessionCookie,
        from: null,
        to: null,
      });
      assert.equal(report.reconciliation.matchesSettlement, true);
      const tonight = await reports.tonight({ sessionCookie: manager.sessionCookie });
      const settled = await settlement({
        sessionCookie: manager.sessionCookie,
        businessDate: day.today,
      });
      return JSON.parse(
        JSON.stringify({ report, tonight, settled }, (key, entry) =>
          ["endsAt", "generatedAt", "projectedAt", "openedMinutes"].includes(key)
            ? undefined
            : typeof entry === "bigint"
              ? String(entry)
              : entry,
        ),
      );
    };

    await finishKitchen({
      admin,
      transactions,
      ownerScope,
      orderReference,
      at: new Date(base - minutes(120)).toISOString(),
    });
    const open = await books();
    assert.equal(open.tonight.openTables.length, 1);
    assert.equal(open.tonight.openTables[0].owedMinor, "0");

    // The guest's receipt was issued when the round was paid.
    const templateRole = "wp2423_gs_t_" + context.runId,
      templateWorker = "wp2423_gs_tw_" + context.runId;
    for (const name of [templateRole, templateWorker])
      await admin.query(
        "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
    await admin.query(renderPilotAclSql(matrices, { api: templateRole, worker: templateWorker }));
    await admin.query(
      "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic guest table issuer','Synthetic Guest Table Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
      [
        id(0xb01),
        id(0xb02),
        id(0xb03),
        id(0xb04),
        id(0xb05),
        id(0xb06),
        new Date(base - minutes(300)).toISOString(),
      ],
    );
    await admin.query(
      "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
      [
        id(0xb07),
        ownerScope.brandReference,
        ownerScope.storeReference,
        id(0xb01),
        new Date(base - minutes(300)).toISOString(),
      ],
    );
    const brandAndStore = {
      brandReference: ownerScope.brandReference,
      storeReference: ownerScope.storeReference,
    };
    const templateSource = await exerciseReceiptTemplate({
      admin,
      runner: transactions(templateRole),
      role: templateRole,
      scope: brandAndStore,
      at: new Date(base - minutes(200)).toISOString(),
      tenantReference: ownerScope.tenantReference,
    });
    const original = await transactions().run((tx) =>
      createOriginalReceiptIssuance({
        sources: {
          scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
          authorize: async () => true,
          order: (t2, input) =>
            createPostgresReceiptOrderSource({ ...brandAndStore, authorize: async () => true })(
              t2,
              input,
            ),
          template: (t2) => templateSource(t2),
        },
        authorize: async () => true,
        identities: () => ({
          recordReference: fresh(),
          receiptReference: fresh(),
          operationReference: fresh(),
        }),
        audit: async (record, operationReference) => ({
          auditId: fresh(),
          brandId: ownerScope.brandReference,
          storeId: ownerScope.storeReference,
          actor: { type: "System" },
          actionCode: "DIGITAL_RECEIPT_APPEND",
          targetType: "DigitalReceipt",
          targetId: record.recordReference,
          reasonCode: "SYNTHETIC_RECEIPT_RETRIEVAL",
          correlationId: operationReference,
          occurredAt: record.recordedAt,
          sourceChannel: "PAYMENT_RECONCILIATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      })(tx, {
        orderReference,
        observedAt: now(),
        freshAfter: new Date(base - minutes(128)).toISOString(),
      }),
    );
    assert.equal(original.status, "Created");
    const guest = await seedAdditionalDiningGuest({
      client: admin,
      runner: ownerRunner,
      f: seeded.round.f,
      dining: {
        ...seeded.dining,
        participant: seeded.dining.host,
        link: { paymentOperationReference: id(0x100) },
      },
      at: new Date(base - minutes(140)).toISOString(),
    });
    const binding = (transaction) => ({
      validate: async (guestSession, observedAt) => {
        const evidence = await createDiningGuestBindingQuery({
          scope: brandAndStore,
          now: () => observedAt,
          repository: createPostgresDiningGuestBindingStore(
            { run: (work) => work(transaction) },
            ownerScope,
          ),
        }).resolve({
          purpose: "GuestSessionBinding",
          diningSessionReference: guestSession.diningSessionReference,
          participantReference: guestSession.diningParticipantReference,
          tableReference: session.tableReference,
        });
        return evidence ? "Current" : "Unavailable";
      },
    });
    const receipt = () =>
      createCustomerReceiptRead({
        scope: brandAndStore,
        transactions: transactions(),
        credentials: guest.identity.session.credentials,
        binding,
        now,
        financial: { scope: ownerScope, providerAccountReference: provider, environment: "Test" },
      }).readView({
        sessionCredential: guest.sessionCredential,
        csrfCredential: guest.csrfCredential,
        orderReference,
      });
    assert.equal((await receipt()).visitEnded, undefined);

    if (guestStarted) {
      // Nobody tapped Served; hours later the System frees the table. Its cost is on the record: the
      // table row is held for this long, and a scan waits for it.
      const statementsBefore = opened.statements,
        started = performance.now();
      const closed = await closer(transactions, ownerScope, now).closeQuiet(
        session.diningSessionReference,
      );
      costs.close = {
        statements: opened.statements - statementsBefore,
        ms: Math.round(performance.now() - started),
      };
      assert.equal(closed.status, "Closed");
      assert.deepEqual(await tableState(admin, seeded), {
        phase: "Closed",
        state: "Available",
        block: null,
        active: null,
      });
    } else {
      await staffClose({ manager, persistence, ownerScope, seeded })();
      // Staff-opened tables at a Store without the switch still wait for Cleaned.
      const state = await tableState(admin, seeded);
      assert.equal(state.phase, "Closed");
      assert.equal(state.block, "CLEANING");
    }
    const closedBooks = await books();
    assert.deepEqual(closedBooks.tonight.openTables, []);
    // The close changed nothing on the books but the open table.
    assert.deepEqual(closedBooks.report, open.report);
    assert.deepEqual(closedBooks.settled, open.settled);

    // The phone that paid: its visit has ended, its receipt still opens, with what it paid.
    const ended = await receipt();
    assert.ok(ended.visitEnded);
    assert.equal(ended.chain.records.length, 1);
    assert.equal(ended.financial.capturedMinor, roundTotal);
    const guests = async () =>
      (await admin.query("SELECT count(*)::int AS n FROM bop_identity.guest_session")).rows[0].n;
    const guestsBefore = await guests();
    if (guestStarted) {
      // The rescan offers the table and makes nothing: only the tap starts a visit.
      const offer = await transactions().run((tx) =>
        loadDiningGuestTableStart(tx, ownerScope, session.tableReference, now()),
      );
      assert.equal(offer.kind, "MayStart");
      assert.equal(await guests(), guestsBefore);
      assert.ok((await receipt()).visitEnded);
    }

    // An ordinary refund of the whole round goes through after the close, on the real commands.
    const staff = await refundStaff({
      admin,
      transactions,
      ownerScope,
      base,
      storeOptions: day.storeOptions,
      businessDate: day.businessDate,
    });
    await refundWholeRound({ staff, seeded, transactions });
    const refunded = await books();
    assert.equal(refunded.report.summary.refundCount, 1);
    assert.equal(refunded.report.summary.refundsMinor, String(roundTotal));
    assert.equal(refunded.settled.refunded.amountMinor, String(roundTotal));
    return { open, closed: closedBooks, refunded };
  } finally {
    vi.unstubAllEnvs();
    signedIn.cookies = new Set();
    signedIn.scopeFor = null;
    await admin.end();
  }
}

it("report, closing summary and settlement read a guest-started table the System closed as they read a staff-opened one; a refund goes through after the close", async () => {
  const base = Date.now();
  const costs = {};
  const guest = await withIsolatedDatabase({ caseId: "wp2423_gm_guest" }, (context) =>
    aDayAtOneTable(context, "Guest", base, costs),
  );
  const staff = await withIsolatedDatabase({ caseId: "wp2423_gm_staff" }, (context) =>
    aDayAtOneTable(context, "Staff", base, costs),
  );
  assert.deepEqual(guest.open, staff.open);
  assert.deepEqual(guest.closed, staff.closed);
  assert.deepEqual(guest.refunded, staff.refunded);
  assert.equal(guest.refunded.report.summary.paymentCount, 1);
  if (process.env.WP2423_COST_LOG)
    await appendFile(
      process.env.WP2423_COST_LOG,
      "system close " + JSON.stringify(costs.close) + "\n",
    );
  // The System's close is one transaction holding the table; a busy Store has to afford it.
  assert.ok(costs.close.statements <= 1200, "the close ran " + costs.close.statements);
}, 600_000);

it("staff closing a guest-started table leave it free for the next guest, with no Cleaned tap", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gm_hand" }, async (context) => {
    const { admin, transactions, credentials, ownerRunner } = await setup(context);
    vi.stubEnv("NODE_ENV", "development");
    try {
      const base = Date.now();
      const seeded = await seedPaidGuestTable(admin, transactions, {
        base,
        prefix: "01a00001",
        refsAt: 0x1000,
        ownerRunner,
      });
      const { ownerScope, session, orderReference } = seeded;
      const manager = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: ownerScope,
        actor: id(0x703),
        at: now(),
        extraPermissions: [
          "dining.operate",
          "dining.item.serve",
          "dining.session.close",
          "order.close",
        ],
        referencePrefix: "01909962",
        sessionReferencePrefix: "01909961",
      });
      await finishKitchen({
        admin,
        transactions,
        ownerScope,
        orderReference,
        at: new Date(base - minutes(120)).toISOString(),
      });
      const persistence = { ...manager.persistence, transactions: transactions(), now };
      await staffClose({ manager, persistence, ownerScope, seeded })();
      assert.deepEqual(await tableState(admin, seeded), {
        phase: "Closed",
        state: "Available",
        block: null,
        active: null,
      });
      // The close is the person's: the audit names them, not the System.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT DISTINCT actor_type,source_channel FROM platform_audit.audit_record WHERE target_id=$1 AND action_code LIKE 'DINING_SESSION_CLOSING_%'",
            [session.diningSessionReference],
          )
        ).rows,
        [{ actor_type: "User", source_channel: "MERCHANT_WEB" }],
      );
      // The next guest at this table scans and starts it.
      const offer = await transactions().run((tx) =>
        loadDiningGuestTableStart(tx, ownerScope, session.tableReference, now()),
      );
      assert.equal(offer.kind, "MayStart");
      const started = await createPostgresDiningGuestTableStartStore(transactions(), {
        scope: ownerScope,
        credentials,
        pepperVersion: 1,
        now,
        newReference: fresh,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
        takingDineIn: async () => true,
      }).startIfFree({ tableReference: session.tableReference, guestSessionReference: fresh() });
      assert.equal(started.status, "Started");
      assert.notEqual(started.diningSessionReference, session.diningSessionReference);
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
}, 300_000);

it("a refund on its way holds a guest-started table; once the money is back the System frees it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gm_refund" }, async (context) => {
    const { admin, transactions, ownerRunner } = await setup(context);
    vi.stubEnv("NODE_ENV", "development");
    try {
      const base = Date.now();
      const seeded = await seedPaidGuestTable(admin, transactions, {
        base,
        prefix: "01a00001",
        refsAt: 0x1000,
        ownerRunner,
      });
      const { ownerScope, session, orderReference } = seeded;
      // The workforce fixtures read the Brand and Store the staff session seeds.
      await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: ownerScope,
        actor: id(0x703),
        at: now(),
        referencePrefix: "01909962",
        sessionReferencePrefix: "01909961",
      });
      const day = await openDay(admin, ownerScope, base);
      await finishKitchen({
        admin,
        transactions,
        ownerScope,
        orderReference,
        at: new Date(base - minutes(120)).toISOString(),
      });
      const staff = await refundStaff({
        admin,
        transactions,
        ownerScope,
        base,
        storeOptions: day.storeOptions,
        businessDate: day.businessDate,
      });
      const system = closer(transactions, ownerScope, now);
      const recorded = await refundWholeRound({
        staff,
        seeded,
        transactions,
        requestOnly: true,
      });
      assert.deepEqual(await system.closeQuiet(session.diningSessionReference), {
        status: "Held",
        hold: "Owed",
      });
      assert.equal(await system.asksNewParty(session.tableReference), false);
      assert.equal((await tableState(admin, seeded)).phase, "Active");
      await refundWholeRound({ staff, seeded, transactions, recorded });
      const closed = await system.closeQuiet(session.diningSessionReference);
      assert.equal(closed.status, "Closed");
    } finally {
      vi.unstubAllEnvs();
      signedIn.cookies = new Set();
      signedIn.scopeFor = null;
      await admin.end();
    }
  });
}, 300_000);

it("the owner turns it on on Store features, never at a pay-later Store; whoever may pause turns it off, not on", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gm_switch" }, async (context) => {
    const { admin, transactions } = await setup(context);
    vi.stubEnv("NODE_ENV", "development");
    try {
      const signedInAs = (actor, permission, prefixes) =>
        seedMerchantAcceptanceSession({
          admin,
          runner: transactions(),
          scope,
          actor,
          at: now(),
          extraPermissions: [permission],
          referencePrefix: prefixes[0],
          sessionReferencePrefix: prefixes[1],
        });
      const boss = await signedInAs(id(0x703), "organization.manage", ["01909962", "01909961"]);
      const manager = await signedInAs(id(0x704), "operations.ordering.pause", [
        "01909964",
        "01909963",
      ]);
      const as = (who) => ({ sessionCookie: who.sessionCookie, csrf: who.csrf });
      const features = (who) => (command) =>
        createMerchantStoreFeatures({
          persistence: { ...who.persistence, transactions: transactions(), now },
          authentication: who.authentication,
          now,
        })({ ...as(who), command });
      const turnOff = (who) => (expectedVersion) =>
        createMerchantGuestTableStartOff({
          persistence: { ...who.persistence, transactions: transactions(), now },
          authentication: who.authentication,
        })({ ...as(who), command: { operationReference: fresh(), expectedVersion } });
      const change = (who, expectedVersion, guestTableStart) =>
        features(who)({
          action: "ChangeServices",
          operationReference: fresh(),
          expectedVersion,
          staffCall: false,
          chaseDish: false,
          guestTableStart,
        });
      const latest = async () =>
        (
          await admin.query(
            "SELECT version::int AS version,guest_table_start AS on,actor_id::text AS actor FROM rms_dining.dining_service_setting ORDER BY version DESC LIMIT 1",
          )
        ).rows[0] ?? null;

      const before = await features(boss)({ action: "Read" });
      assert.equal(before.guestTableStartAllowed, true);
      assert.equal(Object.hasOwn(before.services, "guestTableStart"), false);
      // Someone who may only pause can't turn it on.
      await assert.rejects(change(manager, before.services.version, true));
      assert.equal(await latest(), null);
      // The owner can, and the version says who.
      const on = await change(boss, before.services.version, true);
      assert.equal(on.services.guestTableStart, true);
      assert.deepEqual(await latest(), { version: 1, on: true, actor: id(0x703) });
      // Turning it off takes the pause permission, and the version says who again.
      await assert.rejects(turnOff(boss)(1), { code: "Denied" });
      await assert.rejects(turnOff(manager)(99), { code: "Changed" });
      await turnOff(manager)(1);
      assert.deepEqual(await latest(), { version: 2, on: false, actor: id(0x704) });

      // A Store that takes payment at the end can't have it, whoever asks.
      const moved = await transactions().run((tx) =>
        createPostgresDiningPaymentTimingStore({
          scope,
          hashIntent: digest,
          equals: (a, b) => a === b,
        }).change(
          tx,
          {
            operationReference: fresh(),
            paymentTiming: "PayLater",
            expectedVersion: 0,
            actorReference: id(0x703),
            observedAt: now(),
          },
          async () => true,
        ),
      );
      assert.equal(moved.status, "Changed");
      const payLater = await features(boss)({ action: "Read" });
      assert.equal(payLater.guestTableStartAllowed, false);
      await assert.rejects(change(boss, payLater.services.version, true), {
        code: "STORE_FEATURES_GUEST_START_NEEDS_PAY_FIRST",
      });
      assert.deepEqual(await latest(), { version: 2, on: false, actor: id(0x704) });
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
}, 300_000);
