import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  BrowserSessionService,
  createCognitoWorkforceInvitation,
  createPostgresBrowserSessionSelectionStore,
  createPostgresBrowserSessionStore,
} from "../../bop/identity/src/index.ts";
import { createPostgresPaymentCaptureWindowSource } from "../../rms/payment/src/index.ts";
import { createApp } from "../../../apps/api/src/app.ts";
import {
  PaymentProviderWebhookHandler,
  paymentProviderWebhookRoute,
} from "../../../apps/api/src/payment-provider-webhook.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { startCognitoTestProvider } from "../../../tooling/environment/cognito-test-provider.mjs";
import { createInternalCredentialLoaders } from "../../../tooling/environment/pilot-credentials.mjs";
import { registerInternalDiningEntry } from "../../../tooling/environment/pilot-dining-launcher.mjs";
import {
  checkConfiguredPilotCapabilities,
  currentPilotEnvironment,
  pilotProviderEnvironment,
} from "../../../tooling/environment/pilot-environment.mjs";
import {
  checkCertificateFiles,
  checkPilotTls,
} from "../../../tooling/environment/pilot-hosting.mjs";
import { createInternalMerchantCognitoSession } from "../../../tooling/environment/pilot-merchant-cognito-session.mjs";
import { createInternalMerchantSession } from "../../../tooling/environment/pilot-merchant-session.mjs";
import {
  loadPilotPaymentConfig,
  parsePilotPaymentConfig,
} from "../../../tooling/environment/pilot-payment-config.mjs";
import { createInternalSimulatedProvider } from "../../../tooling/environment/pilot-payment-provider.mjs";
import { createInternalPricingPolicy } from "../../../tooling/environment/pilot-pricing-policy.mjs";
import { generateManagedSecrets } from "../../../tooling/environment/pilot-secrets.mjs";
import { installInternalStaffLogin } from "../../../tooling/environment/pilot-staff-login.mjs";
import { createPilotStaffSessionFactory } from "../../../tooling/environment/pilot-staff-session.mjs";
import {
  loadPilotStaffSignIn,
  readPilotStaffSignInReadiness,
} from "../../../tooling/environment/pilot-staff-sign-in.mjs";
import { startStripeFake } from "../../../tooling/environment/pilot-stripe-fake.mjs";
import {
  createPilotPaymentProvider,
  isStripeProvider,
} from "../../../tooling/environment/pilot-stripe-provider.mjs";
import { createPilotStripeWebhookReceiver } from "../../../tooling/environment/pilot-stripe-webhook.mjs";
import { checkPilotStartReadiness } from "../../../tooling/environment/pilot-supervisor.mjs";
import { createTestCertificates } from "../../../tooling/environment/pilot-test-certificates.mjs";
import { inviteThroughOperator } from "../../../tooling/environment/store-staff-sign-in.mjs";
import { seedJourneyPayment } from "../test-support/dine-in-journey-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
const { Client } = pg;
const id = (n) => "0190c4c0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const [tenant, brand, store, account] = [1, 2, 3, 4].map(id);
const owner = id(10);
// TEST-ONLY public-looking Store name: nothing resolves or connects to it.
const host = "order.store-pilot.ca",
  origin = "https://" + host;

/**
 * WP-2423 DEC-PILOT-RUNTIME-ENVIRONMENT — Pilot-mode smoke (NODE_ENV=production,
 * BOP_PILOT_ENVIRONMENT=Pilot) composed at the level of the pilot DB acceptance tests, with the
 * restricted NOBYPASSRLS role holding exactly the rendered pilot grants:
 *
 * 0. Start check: a throwaway runtime directory with hosting.json (test origin, `front` test
 *    certificate), managed secrets generated into a temp secrets folder, payment.json in Stripe
 *    live mode and staff-sign-in.json in Cognito mode. The supervisor's start check meets every
 *    configurable gap and still refuses with exactly `PricingCurrencyMetadata` (the reviewed tax
 *    configuration; no override exists anywhere). The only harness routes are code arguments: a
 *    test certificate root for the TLS check, and api.stripe.com / the Cognito hosts mapped to
 *    their local stand-ins. Every InternalTest-only stand-in refuses in this process.
 * 1. Staff sign-in: the installation's staff session (pilot-staff-session → Cognito, from
 *    staff-sign-in.json, managed client secret and envelope keys) — the operator links the
 *    existing Owner (store-staff-sign-in link-existing-member), the Owner's first sign-in at
 *    Cognito binds the account, and the sign-in is recorded as a step-up; the customer-side
 *    dining composition shares the same session.
 * 2. Pickup payment: the configured Provider (payment.json → Stripe live, Provider environment
 *    `Live`); Stripe's signed live webhook records the Live terminal fact and PaymentSucceeded.
 * 3. Refund with step-up: the Owner signs in again at Cognito ("Verify it's you") → a recorded
 *    PAYMENT_REFUND_APPROVAL step-up; the refund goes to Stripe live through the same Provider.
 * 4. Day-end: Payment's Live capture window and Stripe's live balance transactions for the same
 *    window agree (capture), and Stripe reports the refund.
 *
 * Not covered here (see the design note): cart, Quote and checkout (they need the reviewed tax
 * configuration — the remaining gap), order acceptance, kitchen and handover (environment-neutral
 * owner flows behind `isPilotRuntime()` guards, covered in InternalTest by their own acceptance
 * tests), the supervisor's child processes (Linux /proc; run in the pilot image) and the browser.
 * Test-only: owner facts are seeded by the database owner (triggers/FKs skipped for the seed).
 */
it("a Pilot Store process starts with only the tax gap and runs sign-in, live payment, step-up refund and day-end", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pilot_runtime" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_prt_" + context.runId,
      worker = "wp2423_prt_w_" + context.runId;
    // TEST-ONLY stand-ins start before the process becomes a Pilot Store (the Cognito stand-in
    // refuses to start in production; that refusal is checked below).
    const stripe = await startStripeFake({
      secretKey: "sk_live_" + "FAKE".repeat(6),
      livemode: true,
    });
    const cognito = await startCognitoTestProvider({
      callbackUrls: [origin + "/merchant/callback", origin + "/merchant/identity/step-up/callback"],
    });
    const runtime = realpathSync(mkdtempSync(join(tmpdir(), "bop-pilot-runtime-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bop-pilot-hosting-")));
    let webhookServer, session;
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
      assert.equal(currentPilotEnvironment(), "Pilot");
      assert.equal(pilotProviderEnvironment(), "Live");

      // ── 0. The Pilot runtime directory and the supervisor's start check.
      chmodSync(runtime, 0o700);
      const privateFile = (name, value) => {
        writeFileSync(join(runtime, name), value, { mode: 0o600 });
        chmodSync(join(runtime, name), 0o600);
      };
      const secrets = join(outside, "secrets");
      await generateManagedSecrets(secrets);
      writeFileSync(join(secrets, "cognito-client-secret"), cognito.clientSecret + "\n", {
        mode: 0o400,
      });
      const tlsDirectory = join(outside, "tls");
      mkdirSync(tlsDirectory, { mode: 0o700 });
      const certificates = await createTestCertificates(tlsDirectory, { hostname: host });
      privateFile(
        "hosting.json",
        JSON.stringify({
          schemaVersion: 1,
          environment: "Pilot",
          customerOrigin: origin,
          secretsDirectory: secrets,
          tls: {
            mode: "front",
            certificateFile: certificates.certificateFile,
            keyFile: certificates.keyFile,
          },
        }),
      );
      privateFile("stripe-live-secret-key", stripe.secretKey);
      privateFile("stripe-live-webhook-secret", stripe.webhookSecret);
      const paymentJson = {
        schemaVersion: 1,
        provider: "stripe",
        stripe: {
          mode: "live",
          apiVersion: stripe.apiVersion,
          publishableKey: "pk_live_SYNTHETIC0001",
          secretKeyFile: "stripe-live-secret-key",
          webhookSecretFile: "stripe-live-webhook-secret",
          returnUrl: "https://pay-return.store-pilot.ca/return",
          webhookUrl: origin + paymentProviderWebhookRoute,
        },
      };
      privateFile("payment.json", JSON.stringify(paymentJson));
      const signInJson = {
        schemaVersion: 1,
        environment: "Pilot",
        mode: "cognito",
        exactOrigin: origin,
        cognito: {
          bindingEnvironment: "bop-pilot-smoke",
          issuer: cognito.issuer,
          clientId: cognito.clientId,
          managedLoginOrigin: cognito.managedLoginOrigin,
        },
      };
      privateFile("staff-sign-in.json", JSON.stringify(signInJson));
      // The harness's only TLS route: its own root stands in for the public trust store.
      const checkCapabilities = (directory) =>
        checkConfiguredPilotCapabilities(directory, {
          checkTls: (hosting) =>
            checkPilotTls(hosting, {
              checkFiles: (files) => checkCertificateFiles(files, { roots: [certificates.root] }),
            }),
        });
      const notReady = [];
      await assert.rejects(
        checkPilotStartReadiness({
          runtimeDirectory: runtime,
          absoluteDirectory: runtime,
          checkCapabilities,
          report: (line) => notReady.push(line),
        }),
        { message: "PILOT_CAPABILITY_MISSING:PricingCurrencyMetadata" },
      );
      assert.deepEqual(notReady, []);
      // Without the harness root the same certificate is not one phones trust: Tls stays open.
      await assert.rejects(
        checkPilotStartReadiness({
          runtimeDirectory: runtime,
          absoluteDirectory: runtime,
          report: (line) => notReady.push(line),
        }),
        { message: "PILOT_CAPABILITY_MISSING:Tls,PricingCurrencyMetadata" },
      );
      assert.deepEqual(notReady, ["PILOT_NOT_READY Tls: certificate-not-trusted"]);

      // InternalTest-only stand-ins and switches refuse in this process.
      const testOnlyPayment = (stripeChanges) =>
        parsePilotPaymentConfig(
          { ...paymentJson, stripe: { ...paymentJson.stripe, ...stripeChanges } },
          { environment: "Pilot" },
        );
      assert.throws(() =>
        parsePilotPaymentConfig(
          { schemaVersion: 1, provider: "simulated" },
          { environment: "Pilot" },
        ),
      );
      assert.throws(() => testOnlyPayment({ testApiBaseUrl: stripe.url }));
      assert.throws(() =>
        testOnlyPayment({
          mode: "test",
          publishableKey: "pk_test_SYNTHETIC0001",
        }),
      );
      privateFile(
        "staff-sign-in.json",
        JSON.stringify({ ...signInJson, testProvider: { origin: cognito.origin } }),
      );
      await assert.rejects(loadPilotStaffSignIn(runtime));
      assert.equal(await readPilotStaffSignInReadiness(runtime), "NotConfigured");
      privateFile("staff-sign-in.json", JSON.stringify(signInJson));
      assert.equal(await readPilotStaffSignInReadiness(runtime), "CognitoConfigured");
      await assert.rejects(startCognitoTestProvider(), { message: "TEST_ONLY" });
      const synthetic = { database: "synthetic", environment: "Pilot" };
      await assert.rejects(
        createInternalPricingPolicy({
          loadProfile: async () => synthetic,
          loadMenu: async () => synthetic,
          expectedDatabaseName: "synthetic",
        }),
        { message: "INTERNAL_PRICING_ONLY" },
      );
      await assert.rejects(
        createInternalSimulatedProvider(
          {},
          {
            path: join(runtime, "simulated-provider.sqlite"),
            loadProfile: async () => synthetic,
            expectedDatabaseName: "synthetic",
          },
        ),
        { message: "SIMULATION_ONLY" },
      );
      await assert.rejects(createInternalMerchantSession({}, {}), {
        message: "INTERNAL_TEST_ONLY",
      });
      assert.throws(() => registerInternalDiningEntry(express(), { profile: synthetic }), {
        message: "INTERNAL_TEST_ONLY",
      });
      assert.throws(() => installInternalStaffLogin(express(), {}), {
        message: "INTERNAL_TEST_ONLY",
      });

      // ── Database: the restricted pilot API role with exactly the rendered pilot grants.
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const docs = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, docs), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      const from = new Date(Date.now() - 86_400_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'PRT','Pilot Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'PRT_STORE','Pilot Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, from],
      );
      let n = 100;
      const next = () => id(++n);
      const membership = next(),
        assignment = next();
      await admin.query(
        "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
        [membership, owner, brand, next(), from],
      );
      await admin.query(
        "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
        [assignment, membership, owner, brand, store, from],
      );
      await admin.query(
        "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,'Olivia',$4,$3,$5,'PersonalData')",
        [membership, brand, owner, next(), from],
      );
      await openSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store,
        operator: id(20),
        approver: id(21),
        at: from,
        next,
        owner: {
          actorReference: owner,
          membershipReference: membership,
          storeAssignmentReference: assignment,
        },
      });
      const api = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query("SET LOCAL statement_timeout='15s'");
            let inFlight = 0;
            const result = await work({
              query: async (sql, values) => {
                assert.equal(inFlight, 0, "one query at a time");
                inFlight += 1;
                try {
                  return await client.query(sql, values === undefined ? [] : [...values]);
                } finally {
                  inFlight -= 1;
                }
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
      const now = () => new Date().toISOString();
      const scope = { brandReference: brand, storeReference: store };
      const resources = {
        scope,
        now,
        transactions: api,
        credentials: { reference: next },
        publicProfile: {
          binding: {
            tenantReference: tenant,
            validUntil: new Date(Date.now() + 864e5).toISOString(),
          },
        },
      };
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;
      const profile = { environment: "Pilot", database: "pilot_smoke", binding: { ...scope } };
      const credentials = createInternalCredentialLoaders({
        file: join(runtime, "internal-test-keys.json"),
        loadProfile: async () => profile,
        expectedDatabaseName: "pilot_smoke",
      });

      // ── 1. Staff sign-in through the installation's staff session (Cognito in a Pilot Store).
      // The harness maps the two Cognito hosts to the local stand-in (code only, never config).
      const cognitoHttp = async (input, init) => {
        const url = new URL(String(input));
        assert.ok(
          url.origin === cognito.managedLoginOrigin ||
            url.origin === "https://cognito-idp.ca-central-1.amazonaws.com",
        );
        const response = await globalThis.fetch(cognito.origin + url.pathname + url.search, init);
        return new globalThis.Response(
          response.status === 204 ? null : await response.arrayBuffer(),
          { status: response.status, headers: response.headers },
        );
      };
      const providerEndpoint = {
        url: cognito.origin + "/",
        credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
      };
      const staffSessions = (implementations) =>
        createPilotStaffSessionFactory(
          runtime,
          { database: "pilot_smoke", loadCustomerData: async () => assert.fail("DEMO roster") },
          {
            credentials,
            publicOrigin: origin,
            implementations: {
              createInternalMerchantCognitoSession: (r, options) =>
                createInternalMerchantCognitoSession(r, {
                  ...options,
                  harness: { http: cognitoHttp, providerEndpoint },
                }),
              ...implementations,
            },
          },
        );
      session = await staffSessions()(resources);
      assert.equal(session.mode, "cognito");
      assert.deepEqual(session.signInEntry, { path: "/operations/sign-in", testOnly: false });
      // The customer-side dining staff commands of the same process use the same session.
      assert.equal(await staffSessions()(resources), session);
      // Operator: the existing Owner gets their own Cognito sign-in (same tool a real Store uses).
      const pool = {
        environment: "bop-pilot-smoke",
        issuer: cognito.issuer,
        clientId: cognito.clientId,
      };
      const managedCrypto = await credentials.createInternalMerchantCredentials();
      const invitation = createCognitoWorkforceInvitation({
        configuration: { ...pool },
        clock: { now },
        hasher: managedCrypto.hasher,
        markEmailVerified: true,
        providerEndpoint,
      });
      const linked = await inviteThroughOperator(admin, {
        kind: "ExistingMember",
        scope,
        pool,
        provider: invitation,
        operatorReference: id(20),
        email: "olivia@store-pilot.ca",
        actorReference: owner,
        at: now(),
        next,
      });
      assert.equal(linked.delivery, "Sent");
      const user = cognito.users.get("bop_" + owner);
      const password = "Olivia-Real-Password-1";
      // The Pilot composition's own sign-in pieces: identity, Store selection and the sign-in
      // record (onFullSignIn), as the merchant BFF composes them.
      const selection = createPostgresBrowserSessionSelectionStore({
        validate: session.validateAssociation,
      });
      const selected = { tenantReference: tenant, ...scope };
      const service = new BrowserSessionService({
        ...session.identity,
        now,
        store: createPostgresBrowserSessionStore({
          ...session.identity.configuration,
          transactions: api,
          now,
          currentActor: session.currentActor,
          onSessionCreated: async (tx, record) => {
            await selection.write(tx, record.session, selected, now());
            await session.onFullSignIn(tx, record.session, selected);
          },
        }),
      });
      const started = await service.start("/app");
      assert.equal(new URL(started.authorizationUrl).origin, cognito.managedLoginOrigin);
      const callback = new URL(
        cognito.signIn(started.authorizationUrl, {
          email: "olivia@store-pilot.ca",
          password: user.temporaryPassword,
          newPassword: password,
        }),
      );
      assert.equal(callback.origin + callback.pathname, origin + "/merchant/callback");
      const signedIn = await service.callback({
        code: callback.searchParams.get("code"),
        state: callback.searchParams.get("state"),
        authCookie: started.cookie.value,
      });
      assert.equal(signedIn.session.actor.actorReference, owner);
      assert.equal(session.poolCheck.status().state, "Verified");
      const cookie = signedIn.cookies.find(
        (item) => item.descriptor.name === "__Host-bop-merchant",
      ).value;
      assert.deepEqual(
        await rows(
          "SELECT i.status,i.invitation_kind,m.lifecycle FROM bop_identity.store_staff_invitation i JOIN bop_membership.membership m ON m.membership_id=i.membership_id WHERE i.actor_id=$1",
          [owner],
        ),
        [{ status: "Accepted", invitation_kind: "ExistingMember", lifecycle: "Active" }],
      );
      // The session envelope is sealed with the hosting's managed key, not an internal test key.
      assert.deepEqual(
        await rows(
          "SELECT key_reference AS key FROM bop_identity.authentication_session WHERE session_id=$1",
          [signedIn.session.sessionReference],
        ),
        [{ key: "pilot-merchant-v1" }],
      );
      assert.deepEqual(
        await rows(
          "SELECT method,purpose_code FROM bop_identity.workforce_mfa_step_up WHERE session_id=$1",
          [signedIn.session.sessionReference],
        ),
        [{ method: "CognitoReauthentication", purpose_code: "IDENTITY_SIGN_IN" }],
      );

      // ── 2. The guest's pickup payment, through the installation's configured Provider.
      const toLocalStripe = (input, init) =>
        globalThis.fetch(stripe.url + String(input).slice("https://api.stripe.com".length), init);
      const provider = await createPilotPaymentProvider(
        {},
        {
          directory: runtime,
          path: join(runtime, "simulated-provider.sqlite"),
          loadProfile: async () => profile,
          expectedDatabaseName: "pilot_smoke",
          harness: { fetch: toLocalStripe },
        },
      );
      assert.ok(isStripeProvider(provider));
      const config = await loadPilotPaymentConfig(runtime, { environment: "Pilot" });
      assert.equal(config.stripe.environment, "Live");
      const refs = {
        paymentIntent: id(0x7001),
        attempt: id(0x7002),
        observation: id(0x7003),
        webhook: id(0x7004),
        transaction: id(0x7005),
        paymentEvent: id(0x7006),
        projection: id(0x7007),
        preparation: id(0x7008),
        commitment: id(0x7009),
        paymentOperation: id(0x700a),
        providerIntent: "pi_SYNTHETICPILOTSMOKE1",
        providerEvent: "evt_SYNTHETICPILOTSMOKE1",
      };
      const requestedAt = new Date(Date.now() - 120_000).toISOString();
      const windowStart = new Date(Date.now() - 3_600_000).toISOString();
      await admin.query("SET session_replication_role = replica");
      try {
        await seedJourneyPayment(admin, {
          scope,
          providerAccountReference: account,
          round: {
            f: {
              request: {
                record: { order: { orderReference: id(0x101) }, guestSessionReference: id(0x111) },
              },
            },
            batch: {
              orderBatchReference: id(0x121),
              submissionReference: id(0x131),
              sourceCartReference: id(0x141),
              sourceCartVersion: 1,
              quoteReference: id(0x151),
            },
          },
          refs,
          outcome: "Open",
          requestedAt,
          occurredAt: new Date(Date.parse(requestedAt) + 1000).toISOString(),
          totalMinor: 1689,
          idempotencyDigest: digest("create-intent:" + refs.attempt),
          providerEnvironment: "Live",
        });
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      stripe.seedIntent({
        id: refs.providerIntent,
        amount: 1689,
        metadata: {
          bop_payment_operation: refs.paymentOperation,
          bop_payment_attempt: refs.attempt,
        },
      });
      const rejected = [];
      const receiver = createPilotStripeWebhookReceiver(resources, {
        provider,
        directory: runtime,
        stripe: config.stripe,
        providerAccountReference: account,
        onRejected: (code) => rejected.push(code),
      });
      webhookServer = createServer(
        createApp({
          paymentProviderWebhook: new PaymentProviderWebhookHandler({ port: receiver }),
        }),
      );
      await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
      stripe.setWebhookTarget(
        "http://127.0.0.1:" + webhookServer.address().port + paymentProviderWebhookRoute,
      );
      const succeeded = stripe.confirm(refs.providerIntent, "succeeded");
      assert.equal(succeeded.livemode, true);
      assert.equal(
        await stripe.deliver(succeeded, { timestamp: Math.floor(Date.now() / 1000) }),
        200,
      );
      assert.deepEqual(rejected, []);
      assert.deepEqual(
        await rows(
          "SELECT f.terminal_outcome AS outcome,f.authoritative_source AS source,f.provider_environment AS fact,r.provider_environment AS receipt FROM rms_payment.payment_terminal_fact f JOIN rms_payment.provider_webhook_record r ON r.webhook_receipt_id=f.webhook_receipt_id WHERE f.payment_intent_id=$1",
          [refs.paymentIntent],
        ),
        [{ outcome: "Succeeded", source: "VerifiedWebhook", fact: "Live", receipt: "Live" }],
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int n FROM platform_eventing.outbox_event WHERE event_type='PaymentSucceeded'",
          )
        )[0].n,
        1,
      );

      // ── 3. Refund with step-up: "Verify it's you" signs in again at Cognito.
      // Cognito authentication times are whole seconds and each step is single use: the step-up
      // sign-in gets its own second after the full sign-in.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1100));
      // The session's own persistence, as the merchant composition passes it.
      const stepUp = session.createProviderStepUp(session.persistence, {
        bootstrap: (value) => service.bootstrap(value),
      });
      const stepStart = await stepUp.start({
        sessionCookie: cookie,
        purpose: "RefundApproval",
        returnTo: "/app/payments/refunds",
      });
      const stepCallback = new URL(
        cognito.signIn(stepStart.authorizationUrl, { email: "olivia@store-pilot.ca", password }),
      );
      assert.equal(stepCallback.pathname, "/merchant/identity/step-up/callback");
      assert.deepEqual(
        await stepUp.callback({
          code: stepCallback.searchParams.get("code"),
          state: stepCallback.searchParams.get("state"),
          error: undefined,
          stepUpCookie: stepStart.cookie,
          sessionCookie: cookie,
        }),
        { result: "verified", returnTo: "/app/payments/refunds" },
      );
      assert.notEqual((await stepUp.status({ sessionCookie: cookie })).validUntil, null);
      assert.deepEqual(
        await rows(
          "SELECT method,purpose_code FROM bop_identity.workforce_mfa_step_up WHERE session_id=$1 ORDER BY attempted_at",
          [signedIn.session.sessionReference],
        ),
        [
          { method: "CognitoReauthentication", purpose_code: "IDENTITY_SIGN_IN" },
          { method: "CognitoReauthentication", purpose_code: "PAYMENT_REFUND_APPROVAL" },
        ],
      );
      const refundOperation = id(0x7100);
      const refund = await provider.adapter.refundPayment({
        operation: "RefundPayment",
        purpose: "RefundPayment",
        context: {
          provider: "Stripe",
          environment: "Live",
          ...scope,
          paymentAttemptReference: refs.attempt,
          operationReference: refundOperation,
        },
        providerIntentReference: refs.providerIntent,
        originalPaymentMethod: "OnlineCard",
        amount: { amountMinor: 500n, currencyCode: "CAD" },
        idempotencyKey: "ordinary-refund:" + refundOperation,
      });
      assert.notEqual(refund.kind, "Failure");
      assert.equal(stripe.refunds.size, 1);
      // A Test-environment request never reaches the live Provider of a Pilot Store.
      await assert.rejects(
        provider.adapter.refundPayment({
          operation: "RefundPayment",
          purpose: "RefundPayment",
          context: {
            provider: "Stripe",
            environment: "Test",
            ...scope,
            paymentAttemptReference: refs.attempt,
            operationReference: id(0x7101),
          },
          providerIntentReference: refs.providerIntent,
          originalPaymentMethod: "OnlineCard",
          amount: { amountMinor: 100n, currencyCode: "CAD" },
          idempotencyKey: "ordinary-refund:" + id(0x7101),
        }),
      );
      assert.equal(stripe.refunds.size, 1);

      // ── 4. Day-end: Payment's Live captures and Stripe's live balance for the same window.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1100));
      const windowEnd = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
      const statement = await provider.readSettlementWindow({
        ...scope,
        environment: "Live",
        startsAt: windowStart,
        endsAt: windowEnd,
      });
      const captures = await api.run((tx) =>
        createPostgresPaymentCaptureWindowSource({
          scope: { ...scope, providerAccountReference: account, environment: "Live" },
          authorize: async () => true,
        })(tx, { startsAt: windowStart, endsAt: windowEnd, observedAt: now() }),
      );
      assert.equal(statement.environment, "Live");
      assert.equal(statement.capturedAmountMinor, 1689n);
      assert.equal(captures.capturedAmountMinor, statement.capturedAmountMinor);
      assert.equal(captures.captureCount, statement.captureCount);
      assert.equal(statement.refundedAmountMinor, 500n);
    } finally {
      vi.unstubAllEnvs();
      session?.poolCheck?.stop();
      await new Promise((resolve) => (webhookServer ? webhookServer.close(resolve) : resolve()));
      await stripe.close();
      await cognito.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
