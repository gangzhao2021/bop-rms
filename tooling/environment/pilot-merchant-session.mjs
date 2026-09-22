import process from "node:process";
import { randomBytes } from "node:crypto";
import {
  BrowserSessionService,
  createIdentityActor,
  createPostgresBrowserSessionStore,
  createPostgresBrowserSessionSelectionStore,
} from "../../packages/bop/identity/src/index.ts";
export async function createInternalMerchantSession(
  resources,
  { loadEmployee, expectedDatabaseName, createInternalMerchantCredentials },
) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
  const saved = await loadEmployee();
  const { scope, now, transactions, credentials } = resources;
  if (
    saved.environment !== "InternalTest" ||
    saved.database !== expectedDatabaseName ||
    saved.scope.brandReference !== scope.brandReference ||
    saved.scope.storeReference !== scope.storeReference
  )
    throw new Error("INTERNAL_MERCHANT_SCOPE_DENIED");
  const currentActor = async (_tx, reference, authenticatedAt, observedAt) => {
    if (
      reference !== saved.actorReference ||
      observedAt >= saved.validUntil ||
      authenticatedAt > observedAt
    )
      throw new Error("INTERNAL_MERCHANT_DENIED");
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
  const validateAssociation = async (_tx, session, selected, at = now()) =>
    at < saved.validUntil &&
    session.actor.actorReference === saved.actorReference &&
    selected.tenantReference === saved.scope.tenantReference &&
    selected.brandReference === scope.brandReference &&
    selected.storeReference === scope.storeReference;
  const selection = createPostgresBrowserSessionSelectionStore({ validate: validateAssociation });
  const crypto = await createInternalMerchantCredentials();
  const unavailable = async () => {
    throw new Error("INTERNAL_EXTERNAL_LOGIN_UNAVAILABLE");
  };
  const configuration = {
    issuer: "https://internal-test.invalid",
    clientId: "internal-test-merchant",
    redirectUri: "https://127.0.0.1:4443/merchant/callback",
    environment: "internal-test",
    allowedPostLoginPaths: ["/operations/orders"],
  };
  const identity = {
    configuration,
    ...crypto,
    credentials: {
      generate: () => randomBytes(32).toString("base64url"),
      generateUuidV7: credentials.reference,
    },
    provider: {
      createAuthorizationUrl: unavailable,
      exchangeCode: unavailable,
      revokeOrLogout: unavailable,
    },
    pkce: {
      challenge: () => {
        throw new Error("INTERNAL_EXTERNAL_LOGIN_UNAVAILABLE");
      },
    },
  };
  const store = createPostgresBrowserSessionStore({
    ...configuration,
    transactions,
    now,
    currentActor,
    onSessionCreated: async (tx, record) => selection.write(tx, record.session, saved.scope, now()),
  });
  const browser = new BrowserSessionService({ ...identity, store, now });
  return {
    identity,
    currentActor,
    validateAssociation,
    persistence: { identity, currentActor, transactions, now, validateAssociation },
    authentication: { authorize: (input) => browser.authorize(input) },
    async issue() {
      const at = now(),
        actor = await currentActor(null, saved.actorReference, at, at);
      const sessionReference = credentials.reference(),
        cookie = identity.credentials.generate(),
        csrf = identity.credentials.generate();
      const context =
        configuration.environment + ":session:" + sessionReference + ":" + actor.actorReference;
      await store.createSession({
        sessionReference,
        actor,
        policyCode: "WorkforceStandard",
        sessionSelectorHash: identity.hasher.hash(cookie),
        csrfSelectorHash: identity.hasher.hash(csrf),
        encryptedSecrets: await identity.envelopes.encrypt(
          JSON.stringify({ tokenBundle: "INTERNAL_TEST_NO_EXTERNAL_TOKEN", csrf }),
          context,
        ),
        observedAt: at,
      });
      return { sessionCookie: cookie, csrf };
    },
  };
}
