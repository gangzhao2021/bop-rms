import process from "node:process";
import { verifyEntryDiningBrowser } from "./entry-dining-browser.mjs";
import { exerciseEntryDiningReceipt } from "./entry-dining-receipt.mjs";
import { exerciseEntryDiningService, inspectEntryDiningDelivery } from "./entry-dining-service.mjs";
import { prepareEntryDiningStatusHttp, exerciseEntryDiningStatus } from "./entry-dining-status.mjs";
import { exerciseEntryDiningWorker } from "./entry-dining-worker.mjs";
import { exerciseEntryDiningKitchen } from "./entry-dining-kitchen.mjs";
import { prepareEntryDiningResultHttp, exerciseEntryDiningResult } from "./entry-dining-result.mjs";
import {
  prepareEntryDiningHandoffHttp,
  exerciseEntryDiningHandoff,
} from "./entry-dining-handoff.mjs";
import {
  prepareEntryDiningPaymentHttp,
  exerciseEntryDiningPayment,
} from "./entry-dining-payment.mjs";
import { exerciseEntryDiningPaymentPreparation } from "./entry-dining-payment-preparation.mjs";
import { exerciseEntryDiningOrder } from "./entry-dining-order.mjs";
import { prepareEntryDiningOrderSources } from "./entry-dining-order-sources.mjs";
import {
  prepareEntryDiningDetailsHttp,
  exerciseEntryDiningDetails,
} from "./entry-dining-details.mjs";
import {
  exerciseEntryDiningCheckoutSession,
  prepareEntryDiningCheckoutRuntime,
} from "./entry-dining-checkout-session.mjs";
import { exerciseEntryDiningCommitment } from "./entry-dining-commitment.mjs";
import {
  prepareEntryDiningCart,
  exerciseEntryDiningCart,
  exerciseSharedDiningMember,
} from "./entry-dining-cart.mjs";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
} from "../../bop/tenant/src/index.ts";
import {
  createDiningSessionService,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningTableStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningAdmissionConsumptionStore,
  createPostgresDiningGuestBindingStore,
} from "../../rms/dining/src/index.ts";
import {
  createPostgresGuestDiningBindingStore,
  createGuestDiningBindingCredentialProvider,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createCustomerDiningJoinComposition } from "../../../apps/api/src/customer-dining-join-composition.ts";
import {
  createCustomerDiningBindingComposition,
  createCustomerDiningSessionBinding,
} from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { CustomerDiningJoinHandler } from "../../../apps/api/src/customer-dining-join.ts";
import { CustomerDiningBindingHandler } from "../../../apps/api/src/customer-dining-binding.ts";
import { createApiServerRuntime, createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Actual owners and HTTP; Staff and abuse permission are synthetic test inputs. */
export async function exerciseEntryDiningJoin({
  customerEntry,
  acquire,
  contextsForTransaction,
  operating,
  currentClock = false,
  admin,
  role,
  run,
  binding,
  publicOptions,
  tableReference,
  at,
  contexts,
  session,
  cookie,
  csrfToken,
  enterAnother,
}) {
  const scope = {
    tenantReference: binding.tenantReference,
    brandReference: binding.brandReference,
    storeReference: binding.storeReference,
  };
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_participant,rms_dining.dining_identity_admission TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_dining.dining_session_start_operation,rms_dining.dining_session_join_operation,rms_dining.dining_admission_consumption_operation TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON bop_identity.guest_dining_binding_preparation TO " + role,
  );
  let sequence = 40000;
  const reference = () => id(++sequence);
  const key = randomBytes(32);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const credentials = {
    generateReference: reference,
    generateJoinCredential: () => randomBytes(16).toString("base64url"),
    hashJoinCredential: (kind, value) =>
      createHmac("sha256", key)
        .update("DiningJoin:" + kind + ":" + value)
        .digest("hex"),
    hashOperationIntent: hash,
    equals: (a, b) => a === b,
  };
  const audit = (actionCode, targetType, targetId, occurredAt, actor = { type: "System" }) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor,
    actionCode,
    targetType,
    targetId,
    occurredAt,
    correlationId: reference(),
    reasonCode: "AUTHORIZED_OPERATION",
    sourceChannel: "API",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const tables = createPostgresDiningTableStore({ run }, scope, {
    hashIntent: (value) => "sha256:" + hash(value),
    equals: credentials.equals,
  });
  const starts = createPostgresDiningSessionStartStore({ run }, scope, credentials);
  const regeneration = createPostgresDiningJoinRegenerationStore({ run }, scope, credentials);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_dining.dining_join_regeneration_operation TO " + role,
  );
  const staff = createDiningSessionService({
    pepperVersion: 1,
    credentials,
    staff: {
      authorize: async (input) => {
        const table = await tables.loadTable(input.tableReference);
        const boundJoin =
          input.operation === "RegenerateJoinCredential" &&
          table.activeDiningSessionReference !== null
            ? await regeneration.resolveActiveJoin(table.activeDiningSessionReference)
            : null;

        const organization = await run(async (tx) => {
          const source = createPostgresMerchantOrganizationSource(tx, {
            ...identityScope,
            observedAt: at,
          });
          return {
            brand: await source.getBrand(scope.brandReference),
            store: await source.getStore(scope.storeReference),
          };
        });
        return {
          tenantContext: createTenantContext(
            {
              actorType: "User",
              actorReference: id(49000),
              accountKind: "Workforce",
              status: "Active",
              authenticationMethod: "Oidc",
              verificationLevel: "SingleFactor",
              authenticatedAt: at,
              recentMfaAt: null,
            },
            organization.brand,
            organization.store,
            at,
          ),
          permission: Object.freeze({
            effect: "Allow",
            scopeKind: "Store",
            action: "dining.session.manage",
          }),
          table: {
            ...identityScope,
            tableReference,
            assignmentVersion: boundJoin?.session.tableAssignmentVersion ?? table.aggregateVersion,
            tableState:
              table.lifecycle === "Published" && table.operationalState === "Available"
                ? "Eligible"
                : "Unavailable",
            activeDiningSessionReference: table.activeDiningSessionReference,
            observedAt: at,
          },
          audit: audit(
            input.operation === "RegenerateJoinCredential"
              ? "DINING_JOIN_CREDENTIAL_REGENERATE"
              : "DINING_SESSION_START",
            "DiningTable",
            tableReference,
            at,
            {
              type: "User",
              reference: id(49000),
            },
          ),
        };
      },
    },
    guests: { resolve: async () => null },
    abuse: { admit: async () => "Cooldown" },
    store: { ...starts, ...regeneration },
  });
  const table = await tables.loadTable(tableReference);
  const started = await staff.start({
    tableReference,
    expectedAssignmentVersion: table.aggregateVersion,
    operationReference: reference(),
    joinKind: "Invitation",
    requestedAt: at,
  });
  const diningBinding = createPostgresDiningGuestBindingStore({ run }, scope);
  const join = createCustomerDiningJoinComposition({
    scope: identityScope,
    session,
    contexts,
    now: () => at,
    dining: {
      store: createPostgresDiningSessionJoinStore({ run }, scope, credentials, (record) => ({
        ...audit(
          "DINING_SESSION_JOIN",
          "DiningSession",
          record.diningSessionReference,
          record.occurredAt,
        ),
        reasonCode: "AUTHORIZED_DINING_JOIN",
        sourceChannel: "CUSTOMER_PWA",
      })),
      credentials,
      pepperVersion: 1,
    },
  });
  const bind = createCustomerDiningBindingComposition({
    scope: identityScope,
    session,
    contexts,
    now: () => at,
    bindings: createPostgresGuestDiningBindingStore(
      { run },
      identityScope,
      {
        append: (tx, record) =>
          appendAuditRecordInTransaction(tx, {
            ...audit(
              "IDENTITY_GUEST_DINING_BINDING_" + record.action.toUpperCase(),
              "GuestDiningBindingPreparation",
              record.operationReference,
              record.occurredAt,
            ),
            sourceChannel: "CUSTOMER_PWA",
          }),
      },
      credentials.equals,
    ),
    dining: {
      credentials,
      binding: diningBinding,
      store: createPostgresDiningAdmissionConsumptionStore(
        { run },
        scope,
        credentials,
        (record) => ({
          ...audit(
            "DINING_IDENTITY_ADMISSION_CONSUME",
            "DiningIdentityAdmission",
            record.admissionReference,
            record.occurredAt,
          ),
          reasonCode: "AUTHORIZED_DINING_ADMISSION_CONSUMPTION",
          sourceChannel: "CUSTOMER_PWA",
        }),
      ),
    },
    recovery: createGuestDiningBindingCredentialProvider(key),
    preparationLifetimeSeconds: 300,
  });
  const sessions = new GuestSessionService({
    ...session,
    admission: { consume: async () => null },
    now: () => at,
    binding: createCustomerDiningSessionBinding({
      scope: identityScope,
      binding: session.binding,
      contexts,
      repository: diningBinding,
      now: () => at,
    }),
  });

  const cart = await prepareEntryDiningCart({
    admin,
    role,
    run,
    scope,
    sessions,
    publicOptions,
    at,
  });
  const checkoutHttp = currentClock
    ? prepareEntryDiningCheckoutRuntime({
        run,
        scope,
        session,
        contexts,
        reference,
      })
    : null;
  const detailsHttp = currentClock ? prepareEntryDiningDetailsHttp() : null;
  const paymentHttp = currentClock
    ? prepareEntryDiningPaymentHttp(checkoutHttp.options, scope.tenantReference)
    : null;
  const handoffHttp = currentClock ? prepareEntryDiningHandoffHttp(checkoutHttp.options) : null;
  const resultHttp = currentClock ? prepareEntryDiningResultHttp(checkoutHttp.options) : null;
  const statusHttp = currentClock
    ? prepareEntryDiningStatusHttp(checkoutHttp.options, scope)
    : null;
  const runtime = createApiServerRuntime({
    ...(customerEntry ? { customerEntry } : {}),
    ...(statusHttp ? { customerOrderStatus: statusHttp.options } : {}),
    ...(checkoutHttp
      ? { customerReceipt: { ...checkoutHttp.options, allowedOrigin: "https://customer.invalid" } }
      : {}),
    ...(resultHttp ? { customerPaymentResult: resultHttp.options } : {}),
    ...(handoffHttp ? { customerPaymentHandoff: handoffHttp.options } : {}),
    ...(paymentHttp ? { customerPaymentIntent: paymentHttp.options } : {}),
    ...(detailsHttp ? { customerCheckoutDetails: detailsHttp.handler } : {}),
    ...(checkoutHttp ? { customerCheckoutSessions: checkoutHttp.options } : {}),
    customerCart: cart.handler,
    customerQuote: cart.quote.handler,
    port: 0,
    logger: createApiRuntimeLogger({ write: () => undefined }),
    customerDiningJoin: new CustomerDiningJoinHandler({
      allowedOrigin: "https://customer.invalid",
      port: join,
      resolveRequestContext: () => ({ abuse: { admit: async () => "Admitted" } }),
    }),
    customerDiningBinding: new CustomerDiningBindingHandler({
      allowedOrigin: "https://customer.invalid",
      port: bind,
      now: () => at,
    }),
  });
  try {
    await runtime.listen();
    const base = "http://127.0.0.1:" + runtime.server.address().port;
    const post = (path, operation, selectedCookie, csrf, body) =>
      globalThis.fetch(base + path, {
        method: "POST",
        headers: {
          origin: "https://customer.invalid",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          cookie: selectedCookie,
          "x-csrf-token": csrf,
          "idempotency-key": operation,
        },
        body: JSON.stringify(body),
      });
    const joinAndBind = async (cookie, csrfToken, joinCredential) => {
      const joined = await post("/bff/customer/dining/join", reference(), cookie, csrfToken, {
        joinCredential,
      });
      assert.equal(joined.status, 200);
      const joinedBody = await joined.json();
      assert.equal(joinedBody.status, "Joined");
      const operation = reference();
      const prepared = await post(
        "/bff/customer/dining-binding/prepare",
        operation,
        cookie,
        csrfToken,
        { admissionReference: joinedBody.admissionReference },
      );
      assert.equal(prepared.status, 200);
      const preparation = await prepared.json();
      const staged = prepared.headers.getSetCookie()[0].split(";")[0];
      const activated = await post(
        "/bff/customer/dining-binding/activate",
        operation,
        cookie + "; " + staged,
        csrfToken,
        {
          candidateCsrfToken: preparation.candidateCsrfToken,
          recoveryProof: preparation.recoveryProof,
        },
      );
      assert.equal(activated.status, 200);
      const activation = await activated.json();
      assert.equal(activation.status, "Activated");
      const currentCookie = activated.headers
        .getSetCookie()
        .find((v) => v.startsWith("__Host-bop-guest="))
        .split(";")[0];
      assert.notEqual(currentCookie, cookie);
      return { currentCookie, activation };
    };
    const { currentCookie, activation } = await joinAndBind(
      cookie,
      csrfToken,
      started.joinCredential,
    );
    const resolve = () =>
      sessions.resolve({
        sessionCredential: currentCookie.split("=")[1],
        activity: "Background",
        observedAt: at,
      });
    const bound = await resolve();
    assert.equal(bound.diningState, "DiningBound");
    assert.equal(bound.diningSessionReference, started.session.diningSessionReference);
    assert.ok(bound.diningParticipantReference);
    await assert.rejects(
      () =>
        sessions.resolve({
          sessionCredential: cookie.split("=")[1],
          activity: "Background",
          observedAt: at,
        }),
      { code: "GUEST_SESSION_UNAVAILABLE" },
    );
    await exerciseEntryDiningCart({
      base,
      cookie: currentCookie,
      csrfToken: activation.csrfToken,
      oldCookie: cookie,
      admin,
      scope,
      diningSessionReference: started.session.diningSessionReference,
    });
    const otherEntry = await enterAnother(customerEntry ? base : undefined);
    const currentJoin = await regeneration.resolveActiveJoin(
      started.session.diningSessionReference,
    );
    assert.ok(currentJoin);
    const invitation = await staff.regenerate({
      diningSessionReference: currentJoin.session.diningSessionReference,
      tableReference,
      expectedAssignmentVersion: currentJoin.session.tableAssignmentVersion,
      expectedSessionVersion: currentJoin.session.version,
      expectedCapabilityVersion: currentJoin.capability.version,
      expectedGeneration: currentJoin.capability.generation,
      operationReference: reference(),
      requestedAt: at,
    });
    assert.equal(invitation.status, "Issued");
    const other = await joinAndBind(
      otherEntry.cookie,
      otherEntry.csrfToken,
      invitation.joinCredential,
    );
    const secondGuest = await sessions.resolve({
      sessionCredential: other.currentCookie.split("=")[1],
      activity: "Background",
      observedAt: at,
    });
    assert.notEqual(secondGuest.sessionReference, bound.sessionReference);
    assert.notEqual(secondGuest.diningParticipantReference, bound.diningParticipantReference);
    assert.equal(secondGuest.diningSessionReference, bound.diningSessionReference);
    const sharedCart = await exerciseSharedDiningMember({
      base,
      admin,
      scope,
      firstCookie: currentCookie,
      cookie: other.currentCookie,
      csrfToken: other.activation.csrfToken,
      diningSessionReference: bound.diningSessionReference,
      guestSessionReference: secondGuest.sessionReference,
      participantReference: secondGuest.diningParticipantReference,
    });
    const quote = await cart.quote.exercise({
      base,
      cookie: other.currentCookie,
      csrfToken: other.activation.csrfToken,
      cart: sharedCart,
      guestSessionReference: secondGuest.sessionReference,
      oldCookie: otherEntry.cookie,
    });
    const commitment = await exerciseEntryDiningCommitment({
      currentClock,
      admin,
      role,
      run,
      scope,
      session,
      contexts,
      current: diningBinding,
      at,
      quote,
      cookie: other.currentCookie,
      csrfToken: other.activation.csrfToken,
      guest: secondGuest,
      oldCookie: otherEntry.cookie,
    });
    if (currentClock) {
      const checkout = await exerciseEntryDiningCheckoutSession({
        admin,
        role,
        run,
        scope: identityScope,
        quote,
        cookie: other.currentCookie,
        csrfToken: other.activation.csrfToken,
        oldCookie: otherEntry.cookie,
        commitment,
        sources: cart.checkoutSources,
        http: checkoutHttp,
        base,
      });
      const details = await exerciseEntryDiningDetails({
        admin,
        role,
        run,
        scope: identityScope,
        quote,
        cookie: other.currentCookie,
        csrfToken: other.activation.csrfToken,
        oldCookie: otherEntry.cookie,
        commitment,
        checkout,
        http: detailsHttp,
        base,
        reference,
      });
      const orderSources = await prepareEntryDiningOrderSources({
        run,
        scope: identityScope,
        sources: cart.checkoutSources,
        operating,
        checkout,
        details,
        commitment,
        reference,
      });
      const order = await exerciseEntryDiningOrder({
        admin,
        role,
        run,
        scope,
        commitment,
        checkout,
        details,
        orderSources,
        sources: cart.checkoutSources,
        cookie: other.currentCookie,
        csrfToken: other.activation.csrfToken,
        reference,
      });
      const paymentPreparation = await exerciseEntryDiningPaymentPreparation({
        admin,
        role,
        run,
        scope: identityScope,
        commitment,
        checkout,
        order,
        oldCookie: otherEntry.cookie,
        reference,
      });
      const payment = await exerciseEntryDiningPayment({
        contextsForTransaction,
        admin,
        role,
        run,
        scope,
        commitment,
        checkout,
        order,
        preparation: paymentPreparation,
        http: paymentHttp,
        base,
        oldCookie: otherEntry.cookie,
        reference,
      });
      await exerciseEntryDiningHandoff({
        scope: identityScope,
        checkout,
        order,
        payment,
        http: handoffHttp,
        base,
        oldCookie: otherEntry.cookie,
        now: commitment.allocated.options.now,
      });
      const paymentResult = await exerciseEntryDiningResult({
        admin,
        role,
        run,
        scope: identityScope,
        checkout,
        order,
        payment,
        http: resultHttp,
        base,
        oldCookie: otherEntry.cookie,
        now: commitment.allocated.options.now,
        reference,
      });
      await exerciseEntryDiningKitchen({
        admin,
        role,
        run,
        scope,
        order,
        result: paymentResult,
        now: commitment.allocated.options.now,
      });
      await exerciseEntryDiningWorker({
        admin,
        role,
        run,
        acquire,
        scope,
        order,
        result: paymentResult,
        now: commitment.allocated.options.now,
        reference,
      });
      await admin.query("GRANT SELECT,INSERT ON rms_dining.dining_item_service_record TO " + role);
      await inspectEntryDiningDelivery({ run, scope, order, commitment });
      const status = await exerciseEntryDiningStatus({
        http: statusHttp,
        result: paymentResult,
        base,
        order,
        oldCookie: otherEntry.cookie,
      });
      await exerciseEntryDiningService({
        run,
        scope,
        order,
        commitment,
        reference,
        status,
      });
      await exerciseEntryDiningReceipt({
        admin,
        operating,
        role,
        run,
        scope,
        order,
        result: paymentResult,
        preparation: paymentPreparation,
        server: runtime.server,
      });
      if (process.env.BOP_ENTRY_BROWSER === "1") await verifyEntryDiningBrowser({ base, order });
    }
    return { resolve };
  } finally {
    await runtime.shutdown("SIGTERM");
  }
}
