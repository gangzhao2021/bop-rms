import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { BrowserSessionService } from "../../bop/identity/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

/** Local Provider substitute and ephemeral keys. No network or real identity claim. */
export async function verifyPersistedBrowserSessionService({ store, actor, admin }) {
  const key = randomBytes(32),
    pepper = randomBytes(32);
  let reference = 200;
  const credentials = {
    generate: () => randomBytes(32).toString("base64url"),
    generateUuidV7: () => f.uuid(String(reference++)),
  };
  const hasher = {
    hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
    equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  };
  const envelopes = {
    async encrypt(plaintext, encryptionContext) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(encryptionContext));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "ephemeral-service-test-key",
        encryptionContext,
        ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
      };
    },
    async decrypt(envelope, encryptionContext) {
      assert.equal(envelope.encryptionContext, encryptionContext);
      const raw = Buffer.from(envelope.ciphertext, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(encryptionContext));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  let authorization,
    exchanges = 0,
    revocations = 0;
  const challenge = (value) => createHash("sha256").update(value).digest("base64url");
  const provider = {
    async createAuthorizationUrl(request) {
      authorization = request;
      return "https://provider.example.test/authorize";
    },
    async exchangeCode(request) {
      assert.equal(request.nonce, authorization.nonce);
      assert.equal(challenge(request.codeVerifier), authorization.codeChallenge);
      assert.equal(request.redirectUri, authorization.redirectUri);
      exchanges++;
      return { actor, tokenBundle: "synthetic-provider-token-bundle" };
    },
    async revokeOrLogout(bundle) {
      assert.equal(bundle, "synthetic-provider-token-bundle");
      revocations++;
      return "unknown";
    },
  };
  const configuration = {
    issuer: "https://provider.example.test",
    clientId: "synthetic-client",
    redirectUri: "https://merchant.example.test/callback",
    environment: "synthetic",
    allowedPostLoginPaths: ["/operations/order-exceptions"],
  };
  const service = () =>
    new BrowserSessionService({
      configuration,
      store: store(),
      provider,
      credentials,
      hasher,
      envelopes,
      pkce: { challenge },
      now: () => f.AT,
    });
  const initial = service();
  const start = await initial.start("/operations/order-exceptions");
  const callback = {
    code: credentials.generate(),
    state: authorization.state,
    authCookie: start.cookie.value,
  };
  const login = await initial.callback(callback);
  assert.equal(exchanges, 1);
  assert.equal(login.postLoginPath, "/operations/order-exceptions");
  assert(login.cookies.some((cookie) => cookie.clear));
  const cookie = login.cookies.find((value) => !value.clear);
  assert(cookie);
  await assert.rejects(initial.callback(callback));
  assert.equal(exchanges, 1);
  const restarted = service();
  const bootstrap = await restarted.bootstrap(cookie.value);
  assert.equal(bootstrap.session.sessionReference, login.session.sessionReference);
  await assert.rejects(
    restarted.authorize({ sessionCookie: cookie.value, csrf: credentials.generate() }),
  );
  assert.equal(
    (await restarted.authorize({ sessionCookie: cookie.value, csrf: bootstrap.csrf }))
      .sessionReference,
    login.session.sessionReference,
  );
  const rotation = await restarted.rotate(cookie.value, "StoreContextElevation");
  await assert.rejects(service().bootstrap(cookie.value));
  const refreshed = await service().bootstrap(rotation.cookie.value);
  assert.notEqual(refreshed.csrf, bootstrap.csrf);
  await assert.rejects(
    service().authorize({ sessionCookie: rotation.cookie.value, csrf: bootstrap.csrf }),
  );
  assert.equal(
    (await service().authorize({ sessionCookie: rotation.cookie.value, csrf: refreshed.csrf }))
      .sessionReference,
    rotation.session.sessionReference,
  );
  const logout = await service().logout(rotation.cookie.value);
  assert.equal(logout.clear, true);
  assert.equal(revocations, 1);
  await assert.rejects(service().bootstrap(rotation.cookie.value));
  assert.equal((await service().logout(rotation.cookie.value)).clear, true);
  const persisted = await admin.query(
    "SELECT status,revocation_reason FROM bop_identity.authentication_session WHERE session_id=$1",
    [rotation.session.sessionReference],
  );
  assert.equal(persisted.rows[0].status, "Revoked");
  assert.equal(persisted.rows[0].revocation_reason, "Logout");
}
