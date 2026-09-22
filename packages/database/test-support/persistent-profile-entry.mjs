import process from "node:process";
import { verifyEntryDiningBrowser } from "./entry-dining-browser.mjs";
import { exerciseEntryDiningReceipt } from "./entry-dining-receipt.mjs";
import { exerciseEntryPickupCompletion } from "./entry-pickup-completion.mjs";
import { exerciseEntryPickupHandoff } from "./entry-pickup-handoff.mjs";
import { exerciseEntryDiningKitchen } from "./entry-dining-kitchen.mjs";
import { exerciseEntryDiningWorker } from "./entry-dining-worker.mjs";
import { exerciseEntryDiningStatus } from "./entry-dining-status.mjs";
import { prepareEntryDiningPaymentHttp } from "./entry-dining-payment.mjs";
import {
  prepareEntryDiningHandoffHttp,
  exerciseEntryDiningHandoff,
} from "./entry-dining-handoff.mjs";
import { prepareEntryDiningResultHttp, exerciseEntryDiningResult } from "./entry-dining-result.mjs";
import { exerciseEntryPickupPayment } from "./entry-pickup-payment.mjs";
import { exerciseEntryPickupPaymentPreparation } from "./entry-pickup-payment-preparation.mjs";
import { prepareEntryPickupOrderHttp } from "./entry-pickup-order-http.mjs";
import { prepareEntryDiningOrderSources } from "./entry-dining-order-sources.mjs";
import { exerciseEntryDiningOrder } from "./entry-dining-order.mjs";
import {
  prepareEntryDiningDetailsHttp,
  exerciseEntryDiningDetails,
} from "./entry-dining-details.mjs";
import {
  prepareEntryPickupCheckout,
  exerciseEntryPickupCheckout,
} from "./entry-pickup-checkout.mjs";
import { prepareEntryPickupQuote } from "./entry-dining-quote.mjs";
import { prepareEntryPickupItems, exerciseEntryPickupItems } from "./entry-pickup-items.mjs";
import { createEntryAbuseAdmission } from "./guest-entry-abuse.mjs";
import { CustomerEntryHandler } from "../../../apps/api/src/customer-entry.ts";
import { createPersistentCustomerEntryComposition } from "../../../apps/api/src/persistent-customer-entry.ts";
import { exerciseEntryDiningJoin } from "./entry-dining-join.mjs";
import { createConfiguredDiningGuestContext } from "../../../apps/api/src/configured-dining-guest-context.ts";
import { prepareEntryDiningTable } from "./entry-dining-table.mjs";
import { createConfiguredDiningQrContext } from "../../../apps/api/src/configured-dining-qr-context.ts";
import { createConfiguredPickupSessionBinding } from "../../../apps/api/src/configured-pickup-session-binding.ts";
import { prepareEntryPickupCart, exerciseEntryPickupCart } from "./entry-pickup-cart.mjs";
import {
  createPostgresGuestEntryAdmissionStore,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { prepareEntryOperatingPublication } from "./entry-operating-publication.mjs";
import { createPersistentEntryOperatingReader } from "../../../apps/api/src/persistent-entry-operating.ts";
import { createConfiguredPickupQrContext } from "../../../apps/api/src/configured-pickup-qr-context.ts";
import assert from "node:assert/strict";
import { fixture, id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";

/** Actual signature verification, profile owners and GuestSession persistence.
 * Key registry, registration approval and abuse policy
 * are explicitly synthetic. QR context now reads actual Tenant organization facts.
 */
export async function exercisePersistentProfileEntry({
  admin,
  role,
  run,
  publicOptions,
  at,
  currentClock = false,
  pickupOnly = false,
  acquire,
}) {
  const f = fixture(at);
  const operating = await prepareEntryOperatingPublication({
    admin,
    role,
    binding: publicOptions.binding,
    at,
    currentWindow: currentClock,
  });
  let currentTime = at;
  let pickupCheckoutActive = false;
  let admissionAttempts = 0;
  const consumedInputs = [];
  const admissionStore = createPostgresGuestEntryAdmissionStore({
    brandReference: publicOptions.binding.brandReference,
    storeReference: publicOptions.binding.storeReference,
    authorize: async () => true, // Explicit synthetic current abuse/purpose policy.
    appendAudit: (tx, record) =>
      appendAuditRecordInTransaction(tx, {
        auditId: record.auditReference,
        brandId: record.evidence.brandReference,
        storeId: record.evidence.storeReference,
        actor: { type: "System" },
        actionCode: "GUEST_ENTRY_ADMISSION_CONSUMED",
        targetType: "GuestEntryAdmission",
        targetId: record.evidence.entryRequestReference,
        reasonCode: "SYNTHETIC_ENTRY_POLICY",
        correlationId: record.operationReference,
        occurredAt: record.consumedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Internal",
        retentionPolicyCode: "IDENTITY_SECURITY",
        retentionPolicyVersion: 1,
      }),
  });
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON bop_identity.guest_entry_admission TO " + role,
  );
  const scope = {
    brandReference: publicOptions.binding.brandReference,
    storeReference: publicOptions.binding.storeReference,
  };
  f.payload.channel = f.context.channel = "Pickup";
  f.payload.publicStoreReference = f.context.publicStoreReference =
    publicOptions.binding.publicStoreReference;
  f.payload.publicTableReference = f.context.publicTableReference = f.context.tableReference = null;
  f.context.tableLifecycle = f.context.assignmentState = null;
  Object.assign(f.context, scope);
  Object.assign(f.resolution, scope, {
    publicStoreReference: publicOptions.binding.publicStoreReference,
  });
  Object.assign(f.operating, scope);
  for (const metadata of [
    f.operating.publishingLifecycle,
    f.operating.publishingRelease,
    f.operating.effectiveVersion,
  ])
    metadata.scope = { kind: "Store", ...scope };
  await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation TO " +
      role,
  );
  await admin.query(
    "GRANT UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO " +
      role,
  );
  let failCommit = false,
    sequence = 10000,
    sourceCalls = 0,
    commitFailures = 0,
    registrationAllowed = true;
  const transactions = {
    run: (work) =>
      run(async (tx) => {
        const result = await work(tx);
        if (failCommit) {
          commitFailures++;
          throw new Error("synthetic outer commit failure");
        }
        return result;
      }),
  };
  const sessionBinding = (runner) =>
    createConfiguredPickupSessionBinding({
      transactions: runner,
      binding: publicOptions.binding,
      authorize: publicOptions.authorize,
      registration: {
        payload: f.payload,
        state: "Enabled",
        contextEvidenceReference: f.context.contextEvidenceReference,
        validFrom: f.payload.issuedAt,
        validUntil: f.payload.expiresAt,
      },
      authorizeRegistration: async () => registrationAllowed,
    });
  const pickupQuote = pickupOnly
    ? await prepareEntryPickupQuote({
        admin,
        role,
        run,
        scope,
        at,
        skuReference: id(70013),
      })
    : null;
  const pickupCheckout = pickupOnly
    ? await prepareEntryPickupCheckout({
        admin,
        role,
        run,
        scope,
        at,
        session: { ...f.options.session, binding: sessionBinding({ run }) },
        binding: (tx) => sessionBinding({ run: (work) => work(tx) }),
      })
    : null;
  const pickupDetails = pickupOnly ? prepareEntryDiningDetailsHttp() : null;
  const pickupOrder = pickupOnly ? prepareEntryPickupOrderHttp() : null;
  const pickupPayment = pickupOnly
    ? prepareEntryDiningPaymentHttp(pickupCheckout.options, publicOptions.binding.tenantReference)
    : null;
  const pickupHandoff = pickupOnly ? prepareEntryDiningHandoffHttp(pickupCheckout.options) : null;
  const pickupResult = pickupOnly ? prepareEntryDiningResultHttp(pickupCheckout.options) : null;
  let diningTable;
  const runtimeOptions = {
    entryRequestAdmission: currentClock
      ? await createEntryAbuseAdmission({ admin, role, acquire, scope, now: () => currentTime })
      : { consume: async () => ({ status: "Allowed" }) }, // Historical fixture only.
    scope,
    entry: {
      session: { ...f.options.session, binding: sessionBinding({ run }) },
      persistent: {
        profile: publicOptions,
        transactions,
        sources: async (tx, input) => {
          assert.equal(typeof tx.query, "function");
          sourceCalls++;
          return {
            qr: {
              ...f.options.qr,
              contexts: (f.payload.channel === "DineIn"
                ? createConfiguredDiningQrContext
                : createConfiguredPickupQrContext)({
                transaction: tx,
                binding: publicOptions.binding,
                authorize: publicOptions.authorize,
                evaluatedAt: input.requestedAt,
                registration: {
                  payload: f.payload,
                  ...(diningTable ? { tableReference: diningTable.tableReference } : {}),
                  state: "Enabled",
                  contextEvidenceReference: f.context.contextEvidenceReference,
                  validFrom: f.payload.issuedAt,
                  validUntil: f.payload.expiresAt,
                },
                authorizeRegistration: async () => registrationAllowed,
              }),
            },
            operatingReader: createPersistentEntryOperatingReader({
              transaction: tx,
              publicStore: { binding: publicOptions.binding, authorize: publicOptions.authorize },
              operating,
            }),
            admission: {
              async consume(input) {
                admissionAttempts++;
                const record = {
                  evidence: {
                    ...f.admissionEvidence(input),
                    evidenceReference: input.entryRequestReference,
                  },
                  operationReference: input.operationReference,
                  auditReference: input.operationReference,
                  requestedAt: input.requestedAt,
                };
                const evidence = await admissionStore.consume(tx, record);
                if (evidence) consumedInputs.push(record);
                return evidence;
              },
            },
            binding: sessionBinding({ run: async (work) => work(tx) }),
          };
        },
      },
    },
    ...(await prepareEntryPickupCart({ admin, role, run, scope, at })),
    ...(pickupOnly
      ? await prepareEntryPickupItems({
          admin,
          role,
          run,
          scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
          at,
        })
      : {}),
    ...(pickupQuote ? { cartQuote: pickupQuote.configuration } : {}),
    ...(pickupCheckout ? { checkoutSessions: pickupCheckout.options } : {}),
    ...(pickupDetails ? { checkoutDetails: pickupDetails.port } : {}),
    ...(pickupOrder ? { orderSubmission: pickupOrder.port } : {}),
    ...(pickupOnly ? { receipt: pickupCheckout.options } : {}),
    ...(pickupOnly
      ? {
          orderStatus: {
            ...pickupCheckout.options,
            paymentScope: { ...scope, providerAccountReference: id(97000), environment: "Test" },
          },
        }
      : {}),
    ...(pickupPayment
      ? {
          payment: {
            access: pickupCheckout.options,
            history: pickupPayment.options.history,
            intent: pickupPayment.options,
            handoff: pickupHandoff.options,
            result: pickupResult.options,
          },
        }
      : {}),
    menuStores: { resolvePublic: async () => null },
    sessionTransactions: { run },
    menuTransactions: { run },
    allowedOrigin: "https://customer.invalid",
    now: () => (pickupCheckoutActive ? new Date().toISOString() : currentTime),
    uuidV7Factory: () => id(++sequence),
    runtime: { port: 0, logger: createApiRuntimeLogger({ write: () => undefined }) },
  };
  const runtime = createLocalCustomerRuntime(runtimeOptions);
  const customerEntry = currentClock
    ? new CustomerEntryHandler({
        requestAdmission: runtimeOptions.entryRequestAdmission,
        port: createPersistentCustomerEntryComposition({
          ...runtimeOptions.entry.persistent,
          session: runtimeOptions.entry.session,
        }),
        allowedOrigin: runtimeOptions.allowedOrigin,
        now: runtimeOptions.now,
        uuidV7Factory: runtimeOptions.uuidV7Factory,
      })
    : undefined;
  const count = async () => {
    const session = await admin.query(
      "SELECT count(*)::int AS n FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    );
    const history = await admin.query(
      "SELECT count(*)::int AS n FROM bop_identity.guest_session_operation WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    );
    const admissions = await admin.query(
      "SELECT count(*)::int AS n FROM bop_identity.guest_entry_admission WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    );
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='GUEST_ENTRY_ADMISSION_CONSUMED'",
      [scope.brandReference, scope.storeReference],
    );
    return {
      sessions: session.rows[0].n,
      history: history.rows[0].n,
      admissions: admissions.rows[0].n,
      admissionAudits: audits.rows[0].n,
    };
  };
  try {
    await runtime.listen();
    const address = runtime.server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const request = (base = "http://127.0.0.1:" + address.port) =>
      globalThis.fetch(base + "/bff/customer/entry", {
        method: "POST",
        headers: {
          origin: "https://customer.invalid",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        },
        body: JSON.stringify({ qrToken: f.token() }),
      });
    const before = await count();
    const successful = await request();
    assert.equal(successful.status, 201);
    const body = await successful.json();
    assert.equal(body.status, "Established");
    assert.equal(body.channel, "Pickup");
    assert.equal(body.publicTableReference, null);
    assert.equal(Object.hasOwn(body, "sessionCredential"), false);
    assert.equal(Object.hasOwn(body, "brandReference"), false);
    assert.equal(successful.headers.getSetCookie().length, 1);
    assert.equal(typeof body.csrfToken, "string");
    let saved = await count();
    assert.equal(saved.sessions, before.sessions + 1);
    assert.equal(saved.history, before.history + 1);
    assert.equal(saved.admissions, before.admissions + 1);
    assert.equal(saved.admissionAudits, before.admissionAudits + 1);
    assert.equal(await run((tx) => admissionStore.consume(tx, consumedInputs[0])), null);
    assert.deepEqual(await count(), saved);
    failCommit = true;
    const rejected = await request();
    assert.equal(rejected.status, 422);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.code, "entry_unavailable");
    assert.equal(Object.hasOwn(rejectedBody, "csrfToken"), false);
    assert.equal(rejected.headers.getSetCookie().length, 0);
    assert.deepEqual(await count(), saved);
    assert.equal(commitFailures, 1, "failure reached commit after successful entry creation");
    if (currentClock) {
      const attempts = await admin.query(
        "SELECT limit_count,sum(attempt_count)::int AS attempts FROM security.abuse_bucket WHERE bucket_class='GUEST_SESSION' GROUP BY limit_count ORDER BY limit_count",
      );
      assert.deepEqual(
        attempts.rows,
        [
          { limit_count: 20, attempts: 2 },
          { limit_count: 300, attempts: 2 },
        ],
        "both budgets persist the failed Entry transaction's attempt",
      );
    }
    failCommit = false;
    const retryRollback = new Error("synthetic retry probe rollback");
    await assert.rejects(
      run(async (tx) => {
        assert.ok(await admissionStore.consume(tx, consumedInputs[1]));
        throw retryRollback;
      }),
      (error) => error === retryRollback,
    );
    assert.deepEqual(await count(), saved);
    await assert.rejects(
      run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query("UPDATE bop_identity.guest_entry_admission SET consumed_at=consumed_at", []);
      }),
    );
    assert.equal(sourceCalls, 2);
    registrationAllowed = false;
    const revokedRegistration = await request();
    assert.equal(revokedRegistration.status, 422);
    await revokedRegistration.text();
    assert.equal(revokedRegistration.headers.getSetCookie().length, 0);
    assert.deepEqual(await count(), saved);
    registrationAllowed = true;
    if (!currentClock) {
      const admissionsBeforeClosure = admissionAttempts;
      currentTime = "2026-01-15T13:00:00.000Z"; // Published 08:00 Toronto closing boundary.
      const closed = await request();
      assert.equal(closed.status, 422);
      await closed.text();
      assert.equal(closed.headers.getSetCookie().length, 0);
      assert.equal(admissionAttempts, admissionsBeforeClosure);
      assert.deepEqual(await count(), saved);
      currentTime = at;
    }
    const pickup = await exerciseEntryPickupCart({
      base: "http://127.0.0.1:" + address.port,
      entryResponse: successful,
      entryBody: body,
      admin,
      scope,
      setRegistrationAllowed: (value) => {
        registrationAllowed = value;
      },
    });
    if (pickupOnly) {
      const added = await exerciseEntryPickupItems({
        base: "http://127.0.0.1:" + address.port,
        pickup,
        admin,
      });
      const session = await new GuestSessionService({
        ...runtimeOptions.entry.session,
        store: createPostgresGuestSessionEntryStore({ run }, scope),
        admission: { consume: async () => null },
        now: () => currentTime,
      }).authorize({
        sessionCredential: added.cookie.split("=")[1],
        csrfCredential: added.csrfToken,
        observedAt: currentTime,
      });
      const quote = await pickupQuote.exercise({
        base: "http://127.0.0.1:" + address.port,
        ...added,
        guestSessionReference: String(session.sessionReference),
      });
      assert.equal(quote.cartReference, added.cart.cartReference);
      assert.equal(quote.cartVersion, added.cart.version);
      pickupCheckoutActive = true;
      const checkout = await exerciseEntryPickupCheckout({
        admin,
        run,
        scope,
        base: "http://127.0.0.1:" + address.port,
        pickup: added,
        quote,
        http: pickupCheckout,
        catalogOptions: runtimeOptions.catalogCartItems,
      });
      let detailsSequence = 96000;
      const details = await exerciseEntryDiningDetails({
        admin,
        role,
        run,
        scope,
        quote,
        ...added,
        checkout,
        http: pickupDetails,
        base: "http://127.0.0.1:" + address.port,
        reference: () => id(++detailsSequence),
        mode: "Pickup",
        pickupPreparation: checkout.preparation,
      });
      const reference = () => id(++detailsSequence);
      const sources = {
        reads: runtimeOptions.catalogCartItems.catalogTransactions,
        catalogOptions: runtimeOptions.catalogCartItems,
        inventoryScope: runtimeOptions.catalogCartItems.selectedInventory.scope,
      };
      const orderSources = await prepareEntryDiningOrderSources({
        run,
        scope,
        sources,
        operating,
        checkout,
        details,
        reference,
        mode: "Pickup",
        clock: checkout.access.now,
      });
      const order = await exerciseEntryDiningOrder({
        http: pickupOrder,
        base: "http://127.0.0.1:" + address.port,
        admin,
        role,
        run,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        checkout,
        details,
        orderSources,
        sources,
        ...added,
        reference,
        mode: "Pickup",
      });
      const paymentPreparation = await exerciseEntryPickupPaymentPreparation({
        admin,
        role,
        run,
        scope,
        checkout,
        order,
        oldCookie: added.oldCookie,
        reference,
      });
      const payment = await exerciseEntryPickupPayment({
        admin,
        role,
        run,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        checkout,
        order,
        preparation: paymentPreparation,
        http: pickupPayment,
        base: "http://127.0.0.1:" + address.port,
        oldCookie: added.oldCookie,
        reference,
      });
      await exerciseEntryDiningHandoff({
        scope,
        checkout,
        order,
        payment,
        http: pickupHandoff,
        base: "http://127.0.0.1:" + address.port,
        oldCookie: added.oldCookie,
        now: checkout.access.now,
        amountMinor: 2260,
      });
      const paymentResult = await exerciseEntryDiningResult({
        providerAccountReference: id(97000),
        admin,
        role,
        run,
        scope,
        checkout,
        order,
        payment,
        http: pickupResult,
        base: "http://127.0.0.1:" + address.port,
        oldCookie: added.oldCookie,
        now: checkout.access.now,
        reference,
        amountMinor: 2260,
      });
      let pickupReady;
      await exerciseEntryDiningKitchen({
        onPickupReady: (current) => {
          pickupReady = current;
        },
        admin,
        role,
        run,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        order,
        result: paymentResult,
        now: checkout.access.now,
        orderType: "Pickup",
      });
      assert(pickupReady);
      assert.equal(pickupReady.state.canonicalPhase, "Ready");
      assert(pickupReady.state.items.every((item) => item.state === "Ready"));
      await exerciseEntryDiningWorker({
        admin,
        role,
        run,
        acquire,
        scope,
        order,
        result: paymentResult,
        now: checkout.access.now,
        reference,
        orderType: "Pickup",
      });
      const customerStatus = await exerciseEntryDiningStatus({
        base: "http://127.0.0.1:" + address.port,
        order,
        oldCookie: added.oldCookie,
        orderType: "Pickup",
        amountMinor: "2260",
      });
      const handoff = await exerciseEntryPickupHandoff({
        admin,
        role,
        run,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        ready: pickupReady,
        reference,
      });
      await exerciseEntryPickupCompletion({
        admin,
        role,
        run,
        acquire,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        order,
        event: handoff.event,
        reference,
      });
      assert.equal((await customerStatus.read()).order.canonicalPhase, "Fulfilled");
      await exerciseEntryDiningReceipt({
        admin,
        operating,
        role,
        run,
        scope: { ...scope, tenantReference: publicOptions.binding.tenantReference },
        order,
        result: paymentResult,
        preparation: paymentPreparation,
        server: runtime.server,
      });
      if (process.env.BOP_ENTRY_BROWSER === "1")
        await verifyEntryDiningBrowser({
          base: "http://127.0.0.1:" + address.port,
          order,
          orderType: "Pickup",
        });
      return { close: () => runtime.shutdown("SIGTERM") };
    }
    saved = await count();
    diningTable = await prepareEntryDiningTable({
      admin,
      role,
      run,
      binding: publicOptions.binding,
      at,
    });
    const pickupPayload = { ...f.payload };
    Object.assign(f.payload, {
      channel: "DineIn",
      publicTableReference: diningTable.publicTableReference,
      qrReference: diningTable.qrReference,
      revocationVersion: diningTable.qrVersion,
    });
    const diningResponse = await request();
    assert.equal(diningResponse.status, 201);
    const diningBody = await diningResponse.json();
    assert.equal(diningBody.channel, "DineIn");
    assert.equal(diningBody.publicTableReference, diningTable.publicTableReference);
    assert.equal(diningResponse.headers.getSetCookie().length, 1);
    assert.equal(Object.hasOwn(diningBody, "sessionCredential"), false);
    const diningRows = await admin.query(
      "SELECT dining_state,public_table_id FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2 AND qr_id=$3",
      [scope.brandReference, scope.storeReference, diningTable.qrReference],
    );
    assert.equal(diningRows.rows.length, 1);
    assert.equal(diningRows.rows[0].dining_state, "ContextOnly");
    assert.equal(diningRows.rows[0].public_table_id, diningTable.publicTableReference);
    const afterDining = await count();
    assert.equal(afterDining.sessions, saved.sessions + 1);
    assert.equal(afterDining.admissions, saved.admissions + 1);
    assert.equal(afterDining.admissionAudits, saved.admissionAudits + 1);
    const diningContextOptions = {
      transactions: { run },
      binding: publicOptions.binding,
      authorize: publicOptions.authorize,
      registration: {
        payload: { ...f.payload },
        tableReference: diningTable.tableReference,
        state: "Enabled",
        contextEvidenceReference: f.context.contextEvidenceReference,
        validFrom: f.payload.issuedAt,
        validUntil: f.payload.expiresAt,
      },
      authorizeRegistration: async (_tx, _registration, _at, purpose) =>
        registrationAllowed &&
        ["GuestSessionBinding", "DiningJoin", "DiningAdmission"].includes(purpose),
    };
    const diningContext = createConfiguredDiningGuestContext(diningContextOptions);
    const contextsForTransaction = (tx) =>
      createConfiguredDiningGuestContext({
        ...diningContextOptions,
        transactions: { run: (work) => work(tx) },
      });
    const diningSessions = new GuestSessionService({
      ...f.options.session,
      store: createPostgresGuestSessionEntryStore({ run }, scope),
      binding: diningContext,
      admission: { consume: async () => null },
      now: () => currentTime,
    });
    const diningCredential = diningResponse.headers.getSetCookie()[0].split(";")[0].split("=")[1];
    const resolveDiningSession = () =>
      diningSessions.resolve({
        sessionCredential: diningCredential,
        activity: "Background",
        observedAt: at,
      });
    const authenticatedDining = await resolveDiningSession();
    assert.equal(authenticatedDining.diningState, "ContextOnly");
    for (const purpose of ["DiningJoin", "DiningAdmission"]) {
      const context = await diningContext.resolve({
        session: authenticatedDining,
        observedAt: at,
        purpose,
      });
      assert.equal(context.tableReference, diningTable.tableReference);
    }
    const joinedDining = await exerciseEntryDiningJoin({
      customerEntry,
      acquire,
      contextsForTransaction,
      operating,
      currentClock,
      publicOptions,
      admin,
      role,
      run,
      binding: publicOptions.binding,
      tableReference: diningTable.tableReference,
      at,
      contexts: diningContext,
      session: {
        ...f.options.session,
        binding: diningContext,
        store: createPostgresGuestSessionEntryStore({ run }, scope),
      },
      enterAnother: async (base) => {
        const response = await request(base);
        assert.equal(response.status, 201);
        const body = await response.json();
        return {
          cookie: response.headers.getSetCookie()[0].split(";")[0],
          csrfToken: body.csrfToken,
        };
      },
      cookie: diningResponse.headers.getSetCookie()[0].split(";")[0],
      csrfToken: diningBody.csrfToken,
    });
    const afterBinding = await count();
    await diningTable.revoke();
    await assert.rejects(joinedDining.resolve, { code: "GUEST_SESSION_UNAVAILABLE" });

    await assert.rejects(resolveDiningSession, { code: "GUEST_SESSION_UNAVAILABLE" });

    const revokedDining = await request();
    assert.equal(revokedDining.status, 422);
    const revokedBody = await revokedDining.json();
    assert.equal(Object.hasOwn(revokedBody, "csrfToken"), false);
    assert.equal(revokedDining.headers.getSetCookie().length, 0);
    assert.deepEqual(await count(), afterBinding);
    if (currentClock) {
      let limited = false;
      for (let attempt = 0; attempt < 21; attempt++) {
        const response = await request();
        if (response.status === 429) {
          assert.ok(Number(response.headers.get("retry-after")) > 0);
          assert.equal(response.headers.getSetCookie().length, 0);
          assert.equal((await response.json()).code, "entry_rate_limited");
          limited = true;
          break;
        }
        assert.equal(response.status, 422); // Revoked table; still consumes abuse budget.
        await response.text();
      }
      assert.equal(limited, true);
      assert.deepEqual(await count(), afterBinding);
      const budgets = await admin.query(
        "SELECT limit_count,sum(attempt_count)::int AS attempts FROM security.abuse_bucket WHERE bucket_class='GUEST_SESSION' GROUP BY limit_count ORDER BY limit_count",
      );
      assert.deepEqual(budgets.rows, [
        { limit_count: 20, attempts: 21 },
        { limit_count: 300, attempts: 20 },
      ]);
    }
    Object.assign(f.payload, pickupPayload);
    diningTable = undefined;
    saved = afterBinding;
    return {
      async assertUnavailable() {
        const response = await request();
        assert.equal(response.status, 422);
        await response.text();
        assert.equal(response.headers.getSetCookie().length, 0);
        assert.deepEqual(await count(), saved);
      },
      close: () => runtime.shutdown("SIGTERM"),
    };
  } catch (error) {
    await runtime.shutdown("SIGTERM");
    throw error;
  }
}
