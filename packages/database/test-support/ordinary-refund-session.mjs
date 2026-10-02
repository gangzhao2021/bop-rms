import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  BrowserSessionService,
  createIdentityActor,
  createPostgresBrowserSessionStore,
  sessionPolicies,
} from "../../bop/identity/src/index.ts";

/** Actual encrypted session/selection/CSRF. Synthetic OIDC actor and Tenant
 * association origin; credentials stay local to this isolated fixture. */
export async function seedOrdinaryRefundSession({
  client,
  runner,
  scope,
  requester,
  at,
  referencePrefix = "01909971",
  policyCode = "WorkforceStandard",
}) {
  const record = { actorReference: requester };
  const id = (n) => referencePrefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const from = new Date(Date.parse(at) - 60000).toISOString();
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: record.actorReference,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: from,
    recentMfaAt: null,
  });
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const policy = sessionPolicies[policyCode];
  const key = randomBytes(32),
    pepper = randomBytes(32);
  const hasher = {
    hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
    equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  };
  const context = "synthetic:session:" + id(1) + ":" + record.actorReference;
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ tokenBundle: "synthetic-unused", csrf }), "utf8"),
    cipher.final(),
  ]);
  const secret = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  await client.query(
    "INSERT INTO bop_identity.authentication_session (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),$11,'Active',$5,'SYNTHETIC_AES_256_GCM','ephemeral-serving-key',$6,$7,$7,$8,$9,$10,1)",
    [
      id(1),
      record.actorReference,
      hasher.hash(cookie),
      hasher.hash(csrf),
      secret,
      context,
      from,
      at,
      new Date(Date.parse(at) + policy.idleTimeoutMinutes * 60000).toISOString(),
      new Date(Date.parse(from) + policy.absoluteTimeoutMinutes * 60000).toISOString(),
      policyCode,
    ],
  );
  await client.query(
    "INSERT INTO bop_identity.browser_session_selection VALUES ($1,$2,$3,$4,$5,$6)",
    [
      id(1),
      record.actorReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      from,
    ],
  );
  const configuration = {
    issuer: "https://provider.example.test",
    clientId: "synthetic-serving",
    redirectUri: "https://merchant.example.test/callback",
    environment: "synthetic",
    allowedPostLoginPaths: ["/operations/orders"],
  };
  const store = createPostgresBrowserSessionStore({
    ...configuration,
    transactions: runner(),
    now: () => at,
    currentActor: async () => actor,
  });
  const unavailable = async () => {
    throw new Error("unused synthetic login operation");
  };
  const identity = {
    configuration,
    hasher,
    credentials: { generate: () => randomBytes(32).toString("base64url") },
    provider: {
      createAuthorizationUrl: unavailable,
      exchangeCode: unavailable,
      revokeOrLogout: unavailable,
    },
    pkce: {
      challenge: () => {
        throw new Error("unused");
      },
    },
    envelopes: {
      encrypt: unavailable,
      decrypt: async (envelope, expected) => {
        assert.equal(envelope.encryptionContext, expected);
        const raw = Buffer.from(envelope.ciphertext, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(expected));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      },
    },
  };
  const browser = new BrowserSessionService({ ...identity, store, now: () => at });
  const authentication = { authorize: (input) => browser.authorize(input) };
  const persistence = {
    transactions: runner(),
    identity,
    currentActor: async () => actor,
    now: () => at,
    validateAssociation: async (_tx, session, selected) =>
      session.actor.actorReference === record.actorReference &&
      selected.tenantReference === scope.tenantReference &&
      selected.brandReference === scope.brandReference &&
      selected.storeReference === scope.storeReference,
  };
  return { persistence, authentication, sessionCookie: cookie, csrf };
}
