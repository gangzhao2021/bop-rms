import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  BrowserSessionService,
  createArgon2idStaffPinKdf,
  createCognitoStoreWorkforceProvider,
  createCognitoWorkforceInvitation,
  createIdentityActor,
  createPostgresBrowserSessionSelectionStore,
  createPostgresBrowserSessionStore,
  createStaffPinChoiceTokens,
  createStoreDeviceSecretHasher,
} from "../../packages/bop/identity/src/index.ts";
import { isActiveStoreMember } from "../../packages/bop/membership/src/index.ts";
import { createStoreStaffSignIn } from "../../apps/api/dist/store-staff-sign-in.js";
import { createMerchantProviderStepUp } from "../../apps/api/dist/merchant-provider-step-up.js";
import { startNamedKdsOperatorShift } from "./pilot-merchant-session.mjs";
import { createTestProviderFetch, testProviderAuthorizationUrl } from "./pilot-staff-sign-in.mjs";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: the pilot Store's staff sessions when staff sign in with their
 * own Cognito account. Same session rules as the TEST-ONLY sign-in (WorkforceStandard 30-minute
 * idle / 12-hour absolute, kitchen display sessions, PIN switching on a registered tablet, Store
 * selection), but the person comes from the verified Cognito sign-in and their bound account, and
 * the Store selection holds only while they are an Active member assigned to the Store.
 * The session envelope and selector keys still come from the internal test key file (capability
 * gap "Secrets"); the PIN pepper and tablet keys come from their own secret files.
 */
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const denied = () => {
  throw new Error("INTERNAL_MERCHANT_DENIED");
};
/** The paths a full sign-in may return to; the kitchen display start opens a kitchen session. */
export const cognitoPostLoginPaths = Object.freeze([
  "/app",
  "/operations/orders",
  "/operations/kitchen/start",
]);
export const kitchenDisplayStartPath = "/operations/kitchen/start";
export const pilotStaffOrigin = "https://127.0.0.1:4443";

export async function createInternalMerchantCognitoSession(
  resources,
  { signIn, createInternalMerchantCredentials, staffOrigin = pilotStaffOrigin, harness },
) {
  // `harness` ({ http, providerEndpoint }): an in-process test harness's route to a local Cognito
  // stand-in for a Pilot-mode smoke (DEC-PILOT-RUNTIME-ENVIRONMENT). Code only: no file,
  // environment variable or request can set it, and no runtime entry point passes it.
  if (signIn?.mode !== "cognito") return denied();
  // The Cognito callbacks are registered on the origin this HTTPS server answers on.
  if (signIn.exactOrigin !== staffOrigin) return denied();
  if (signIn.testProvider !== null && process.env.NODE_ENV !== "development") return denied();
  const { now, transactions, credentials } = resources,
    clock = now.bind(resources),
    scope = Object.freeze({
      tenantReference: resources.publicProfile?.binding?.tenantReference,
      brandReference: resources.scope?.brandReference,
      storeReference: resources.scope?.storeReference,
    });
  if (
    Object.values(scope).some((value) => typeof value !== "string" || !referencePattern.test(value))
  )
    return denied();
  const crypto = await createInternalMerchantCredentials();
  const http =
    harness?.http ?? (signIn.testProvider === null ? undefined : createTestProviderFetch(signIn));
  const pool = Object.freeze({
    environment: signIn.cognito.environment,
    issuer: signIn.cognito.issuer,
    clientId: signIn.cognito.clientId,
  });
  const origin = signIn.exactOrigin;
  // TEST-ONLY loopback stand-in with static synthetic credentials (admin API and pool check).
  const providerEndpoint =
    harness?.providerEndpoint ??
    (signIn.testProvider === null
      ? null
      : {
          url: signIn.testProvider.origin + "/",
          credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
        });
  const invitation = createCognitoWorkforceInvitation({
    configuration: { ...pool },
    clock: { now: clock },
    hasher: crypto.hasher,
    markEmailVerified: true,
    ...(providerEndpoint === null ? {} : { providerEndpoint }),
  });
  const people = createStoreStaffSignIn({
    transactions,
    pool,
    hasher: crypto.hasher,
    now: clock,
    nextReference: () => credentials.reference(),
    inspector: invitation,
  });
  const realProvider = createCognitoStoreWorkforceProvider({
    configuration: {
      issuer: signIn.cognito.issuer,
      clientId: signIn.cognito.clientId,
      clientSecret: signIn.cognito.clientSecret,
      managedLoginOrigin: signIn.cognito.managedLoginOrigin,
      redirectUri: origin + "/merchant/callback",
      logoutReturnUri: origin + "/app",
    },
    stepUpRedirectUri: origin + "/merchant/identity/step-up/callback",
    clock: { now: clock },
    nextReference: () => credentials.reference(),
    resolveSubject: people.resolveSubject,
    ...(providerEndpoint === null ? {} : { providerEndpoint }),
    ...(http === undefined ? {} : { http }),
  });
  // Real Cognito tokens carry no acr/amr: sign-in and step-up need the pool's MFA settings
  // (required, authenticator app only) checked within five minutes. Checked now and every four
  // minutes; a refusal is logged once per change with its setting name only.
  let reported = null;
  const reportPool = (status) => {
    const key = status.state + ":" + status.reason;
    if (status.state !== "Verified" && key !== reported)
      console.error(
        JSON.stringify({
          event: "STAFF_SIGN_IN_POOL_CHECK_REFUSED",
          state: status.state,
          reason: status.reason,
        }),
      );
    reported = key;
    return status;
  };
  const stopPoolCheck = realProvider.pool.monitor(240_000, reportPool);
  // TEST-ONLY: with a loopback stand-in the browser is sent to its HTTPS sign-in page.
  const browserUrl = (url) => testProviderAuthorizationUrl(signIn, url);
  const provider = Object.freeze({
    createAuthorizationUrl: async (request) =>
      browserUrl(await realProvider.createAuthorizationUrl(request)),
    exchangeCode: realProvider.exchangeCode,
    revokeOrLogout: realProvider.revokeOrLogout,
  });
  const stepUpProvider = Object.freeze({
    redirectUri: realProvider.stepUp.redirectUri,
    createAuthorizationUrl: async (request) =>
      browserUrl(await realProvider.stepUp.createAuthorizationUrl(request)),
    verify: realProvider.stepUp.verify,
  });
  const configuration = Object.freeze({
    issuer: signIn.cognito.issuer,
    clientId: signIn.cognito.clientId,
    redirectUri: origin + "/merchant/callback",
    environment: signIn.cognito.environment,
    allowedPostLoginPaths: cognitoPostLoginPaths,
  });
  const identity = {
    configuration,
    ...crypto,
    credentials: {
      generate: () => randomBytes(32).toString("base64url"),
      generateUuidV7: credentials.reference,
    },
    provider,
    pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
    postLoginPolicies: Object.freeze({ [kitchenDisplayStartPath]: "NamedKdsOperator" }),
  };
  const currentActor = (tx, reference, authenticatedAt, observedAt) =>
    people.currentActor(tx, reference, authenticatedAt, observedAt);
  const validateAssociation = async (tx, session, selected, at = clock()) => {
    try {
      return (
        selected.tenantReference === scope.tenantReference &&
        selected.brandReference === scope.brandReference &&
        selected.storeReference === scope.storeReference &&
        session.actor.actorReference !== null &&
        (await isActiveStoreMember(tx, {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          actorReference: session.actor.actorReference,
          at,
        }))
      );
    } catch {
      return false;
    }
  };
  const selection = createPostgresBrowserSessionSelectionStore({ validate: validateAssociation });
  const finalizers = new Map();
  // Sessions issued here are PIN sessions on a registered tablet (the full sign-in goes through
  // the merchant sign-in routes and `onFullSignIn`).
  const store = createPostgresBrowserSessionStore({
    ...configuration,
    transactions,
    now: clock,
    currentActor,
    onSessionCreated: async (tx, record) => {
      await selection.write(tx, record.session, scope, clock());
      const finalize = finalizers.get(record.session.sessionReference);
      if (finalize !== undefined) await finalize(tx, record.session);
    },
  });
  const browser = new BrowserSessionService({ ...identity, store, now: clock });
  return {
    mode: "cognito",
    /** The pool MFA check's latest result (state and setting name only) and its stop. */
    poolCheck: Object.freeze({
      status: () => realProvider.pool.status(),
      stop: stopPoolCheck,
    }),
    identity,
    currentActor,
    validateAssociation,
    persistence: { identity, currentActor, transactions, now: clock, validateAssociation },
    authentication: { authorize: (input) => browser.authorize(input) },
    signInEntry: Object.freeze({ path: "/operations/sign-in", testOnly: false }),
    /**
     * A full Cognito sign-in, in its session's creation transaction: a kitchen display sign-in
     * starts the named operator's shift (IDR-0039), and the sign-in's own authenticator check is
     * recorded as a step-up for this session. Recording is best effort: a sign-in older than the
     * step-up freshness window just needs "Verify it's you" later.
     */
    async onFullSignIn(tx, session, selected) {
      if (session.policy.code === "NamedKdsOperator")
        await startNamedKdsOperatorShift(tx, session, selected, {
          nextReference: () => credentials.reference(),
          recordedAt: clock(),
        });
      await people.recordSignInVerification(tx, {
        brandReference: selected.brandReference,
        storeReference: selected.storeReference,
        actorReference: session.actor.actorReference,
        sessionReference: session.sessionReference,
        authenticatedAt: session.authenticatedAt,
      });
    },
    /** In-app invitations go to this pool through Cognito's own email. */
    invitations: Object.freeze({ pool, provider: invitation }),
    /** The production step-up: sign in again with the authenticator. */
    createProviderStepUp: (persistence, service) =>
      createMerchantProviderStepUp({
        persistence,
        authentication: service,
        provider: stepUpProvider,
        issuer: configuration.issuer,
        clientId: configuration.clientId,
        environment: configuration.environment,
        boundActor: people.boundActor,
        newReference: () => credentials.reference(),
      }),
    /**
     * InternalTest: the PIN pepper, tablet and lock-screen keys from their own secret files. A
     * Pilot store leaves this out and uses the managed secrets (DEC-PILOT-SECRETS).
     */
    ...(signIn.staffPinKeys === null
      ? {}
      : {
          async staffPinCredentials() {
            const { pepper, device, choice } = signIn.staffPinKeys;
            return Object.freeze({
              kdf: createArgon2idStaffPinKdf({
                peppers: new Map([[1, Buffer.from(pepper)]]),
                currentPepperVersion: 1,
              }),
              deviceHasher: createStoreDeviceSecretHasher(Buffer.from(device)),
              choiceTokens: createStaffPinChoiceTokens(Buffer.from(choice)),
            });
          },
        }),
    /** A verified staff PIN on a registered tablet issues this person's ordinary session. */
    async issueForPin(actorReference, finalize) {
      if (typeof finalize !== "function" || !referencePattern.test(actorReference)) return denied();
      const at = clock();
      const actor = createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      });
      const sessionReference = credentials.reference(),
        cookie = identity.credentials.generate(),
        csrf = identity.credentials.generate();
      const context =
        configuration.environment + ":session:" + sessionReference + ":" + actorReference;
      finalizers.set(sessionReference, finalize);
      try {
        await store.createSession({
          sessionReference,
          actor,
          policyCode: "WorkforceStandard",
          sessionSelectorHash: identity.hasher.hash(cookie),
          csrfSelectorHash: identity.hasher.hash(csrf),
          encryptedSecrets: await identity.envelopes.encrypt(
            JSON.stringify({ tokenBundle: "STAFF_PIN_NO_PROVIDER_TOKEN", csrf }),
            context,
          ),
          observedAt: at,
        });
      } finally {
        finalizers.delete(sessionReference);
      }
      return { sessionCookie: cookie };
    },
  };
}
