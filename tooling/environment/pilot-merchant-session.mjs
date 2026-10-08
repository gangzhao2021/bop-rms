import process from "node:process";
import { randomBytes } from "node:crypto";
import {
  BrowserSessionService,
  createIdentityActor,
  createPostgresBrowserSessionStore,
  createPostgresBrowserSessionSelectionStore,
  loadSessionEnds,
} from "../../packages/bop/identity/src/index.ts";
import { createPostgresKdsOperatorShiftStore } from "../../packages/rms/kitchen/src/index.ts";
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const selectorPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const denied = () => {
  throw new Error("INTERNAL_MERCHANT_DENIED");
};
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return denied();
  return value;
};
function data(value, keys, exact = true) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    (exact && Reflect.ownKeys(value).length !== keys.length)
  )
    return denied();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return denied();
    result[key] = descriptor.value;
  }
  return result;
}
export async function createInternalMerchantSession(
  resources,
  { loadEmployee, expectedDatabaseName, createInternalMerchantCredentials },
) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
  const { now, transactions, credentials } = resources,
    scope = Object.freeze({
      tenantReference: resources.publicProfile?.binding?.tenantReference,
      brandReference: resources.scope?.brandReference,
      storeReference: resources.scope?.storeReference,
    }),
    load = loadEmployee,
    clock = now.bind(resources);
  if (
    Object.values(scope).some(
      (value) => typeof value !== "string" || !referencePattern.test(value),
    ) ||
    typeof load !== "function"
  )
    return denied();
  async function roster() {
    try {
      if (process.env.NODE_ENV !== "development") return denied();
      const value = await load(),
        schema = Object.getOwnPropertyDescriptor(value ?? {}, "schemaVersion");
      if (schema && (!("value" in schema) || ![1, 2].includes(schema.value))) return denied();
      const multiple = schema?.value === 2,
        saved = data(
          value,
          multiple
            ? ["schemaVersion", "environment", "database", "scope", "actors"]
            : ["environment", "database", "scope", "actorReference", "validUntil"],
          multiple,
        ),
        selected = data(saved.scope, ["tenantReference", "brandReference", "storeReference"]);
      if (
        saved.environment !== "InternalTest" ||
        saved.database !== expectedDatabaseName ||
        Object.entries(scope).some(([key, ref]) => selected[key] !== ref) ||
        (!multiple && Object.hasOwn(value, "actors"))
      )
        return denied();
      const raw = multiple
        ? saved.actors
        : [
            {
              selector: "staff",
              actorReference: saved.actorReference,
              validUntil: saved.validUntil,
            },
          ];
      if (
        !Array.isArray(raw) ||
        Object.getPrototypeOf(raw) !== Array.prototype ||
        raw.length < 1 ||
        raw.length > 16 ||
        Reflect.ownKeys(raw).length !== raw.length + 1
      )
        return denied();
      const selectors = new Set(),
        actors = new Set(),
        entries = [];
      for (let index = 0; index < raw.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return denied();
        const entry = data(descriptor.value, ["selector", "actorReference", "validUntil"]);
        if (
          typeof entry.selector !== "string" ||
          !selectorPattern.test(entry.selector) ||
          referencePattern.test(entry.selector) ||
          typeof entry.actorReference !== "string" ||
          !referencePattern.test(entry.actorReference) ||
          selectors.has(entry.selector) ||
          actors.has(entry.actorReference)
        )
          return denied();
        selectors.add(entry.selector);
        actors.add(entry.actorReference);
        entries.push(Object.freeze({ ...entry, validUntil: instant(entry.validUntil) }));
      }
      return Object.freeze(entries);
    } catch {
      return denied();
    }
  }
  await roster();
  const currentActor = async (_tx, reference, authenticatedAt, observedAt) => {
    const entries = await roster(),
      entry = entries.find((value) => value.actorReference === reference),
      currentAt = instant(clock());
    if (
      !entry ||
      instant(observedAt) >= entry.validUntil ||
      currentAt >= entry.validUntil ||
      instant(authenticatedAt) > observedAt ||
      observedAt > currentAt
    )
      return denied();
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
  const validateAssociation = async (_tx, session, selected, at = clock()) => {
    try {
      const entries = await roster(),
        entry = entries.find((value) => value.actorReference === session.actor.actorReference);
      return (
        entry !== undefined &&
        instant(at) < entry.validUntil &&
        instant(clock()) < entry.validUntil &&
        selected.tenantReference === scope.tenantReference &&
        selected.brandReference === scope.brandReference &&
        selected.storeReference === scope.storeReference
      );
    } catch {
      return false;
    }
  };
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
    now: clock,
    currentActor,
    onSessionCreated: async (tx, record) => {
      await selection.write(tx, record.session, scope, clock());
      if (record.session.policy.code !== "NamedKdsOperator") return;
      // IDR-0039 / WP-2423: Kitchen records the named operator Start in the same transaction and
      // derives a handover from the latest prior operator at this Store whose shift ended.
      const session = record.session,
        validUntil =
          Date.parse(session.idleExpiresAt) < Date.parse(session.absoluteExpiresAt)
            ? session.idleExpiresAt
            : session.absoluteExpiresAt;
      await createPostgresKdsOperatorShiftStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        references: { next: () => credentials.reference() },
      }).start({
        transaction: tx,
        session: {
          sessionReference: session.sessionReference,
          actorReference: session.actor.actorReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          sessionVersion: session.version,
          sessionKind: "NamedKdsOperator",
          state: "Active",
          observedAt: session.createdAt,
          validUntil,
        },
        recordedAt: instant(clock()),
        // A prior operator who left without Release ended their shift when their session ended.
        sessionEnds: (sessionReferences) =>
          loadSessionEnds(tx, { sessionReferences, at: session.createdAt }),
      });
    },
  });
  const browser = new BrowserSessionService({ ...identity, store, now: clock });
  return {
    identity,
    currentActor,
    validateAssociation,
    persistence: { identity, currentActor, transactions, now: clock, validateAssociation },
    authentication: { authorize: (input) => browser.authorize(input) },
    async staffChoices() {
      const entries = await roster(),
        at = instant(clock());
      return Object.freeze(
        entries
          .filter((entry) => at < entry.validUntil)
          .map((entry) =>
            Object.freeze({ selector: entry.selector, label: "DEMO staff " + entry.selector }),
          ),
      );
    },
    /** `KitchenDisplay` issues the IDR-0039 named KDS Operator Session for the same named Actor. */
    async issue(selector, purpose = "Workforce") {
      if (purpose !== "Workforce" && purpose !== "KitchenDisplay") return denied();
      const entries = await roster(),
        entry =
          selector === undefined
            ? entries.length === 1
              ? entries[0]
              : undefined
            : typeof selector === "string" && selectorPattern.test(selector)
              ? entries.find((value) => value.selector === selector)
              : undefined;
      if (!entry) return denied();
      const at = instant(clock()),
        actor = await currentActor(null, entry.actorReference, at, at);
      const sessionReference = credentials.reference(),
        cookie = identity.credentials.generate(),
        csrf = identity.credentials.generate();
      const context =
        configuration.environment + ":session:" + sessionReference + ":" + actor.actorReference;
      await store.createSession({
        sessionReference,
        actor,
        policyCode: purpose === "KitchenDisplay" ? "NamedKdsOperator" : "WorkforceStandard",
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
