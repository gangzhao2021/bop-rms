import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createApp } from "../../../apps/api/src/app.ts";
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
} from "../../bop/identity/src/index.ts";
import { createMerchantDiningItemService } from "../../../apps/api/src/merchant-dining-item-service.ts";
import { encodeAdditionalDiningBatchSnapshot } from "../../rms/ordering/src/index.ts";

// Synthetic identity/association origins; actual persisted session, CSRF, membership and policy.
export async function seedAdditionalDiningMerchant({
  client,
  runner,
  scope,
  record,
  snapshot,
  at,
  hash,
}) {
  const id = (n) => "01909984-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const from = new Date(Date.parse(at) - 60000).toISOString();
  const until = new Date(Date.parse(at) + 3600000).toISOString();
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
    "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC_SERVING','Synthetic Serving Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT DO NOTHING",
    [scope.brandReference, from],
  );
  await client.query(
    "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_SERVING','Synthetic Serving Store','America/Toronto','en-CA','CAD','Active',1,$3,$3) ON CONFLICT DO NOTHING",
    [scope.storeReference, scope.brandReference, from],
  );
  await client.query(
    "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
    [id(2), record.actorReference, scope.brandReference, id(3), from, until],
  );
  await client.query(
    "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [id(4), id(2), record.actorReference, scope.brandReference, scope.storeReference, from, until],
  );
  await client.query(
    "INSERT INTO bop_identity.authentication_session (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM','ephemeral-serving-key',$6,$7,$7,$8,$9,$10,1)",
    [
      id(1),
      record.actorReference,
      hasher.hash(cookie),
      hasher.hash(csrf),
      secret,
      context,
      from,
      at,
      new Date(Date.parse(at) + 30 * 60000).toISOString(),
      new Date(Date.parse(from) + 12 * 60 * 60000).toISOString(),
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
  await client.query(
    "INSERT INTO bop_permission.policy_state VALUES ($1,$2,1,$3) ON CONFLICT (brand_id) DO NOTHING",
    [scope.brandReference, id(5), from],
  );
  await client.query(
    "INSERT INTO bop_permission.role VALUES ($1,$2,$3,'synthetic_server','Active',$4,$5,1,$4,$4)",
    [id(6), scope.brandReference, scope.storeReference, from, until],
  );
  await client.query(
    "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
    [
      id(7),
      id(6),
      id(2),
      id(4),
      record.actorReference,
      scope.brandReference,
      scope.storeReference,
      from,
      until,
    ],
  );
  for (const [n, action] of [
    [8, "merchant.access"],
    [10, "dining.item.serve"],
  ]) {
    let permission = (
      await client.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = id(n);
      await client.query(
        "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    await client.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(n + 1), id(6), permission, scope.brandReference, scope.storeReference, from, until],
    );
  }
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
  const browser = new BrowserSessionService({
    configuration,
    store,
    now: () => at,
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
  });
  const authentication = { authorize: (input) => browser.authorize(input) };
  const serving = createMerchantDiningItemService({
    persistence: {
      transactions: runner(),
      identity: { hasher },
      currentActor: async () => actor,
      now: () => at,
      validateAssociation: async (_tx, session, selected) =>
        session.actor.actorReference === record.actorReference &&
        selected.tenantReference === scope.tenantReference &&
        selected.brandReference === scope.brandReference &&
        selected.storeReference === scope.storeReference,
    },
    authentication,
    validateSource: async (_tx, fact) =>
      fact.sourceCheckpoint === snapshot.batch.submissionReference &&
      fact.sourceDigest === hash(encodeAdditionalDiningBatchSnapshot(snapshot)).slice(7),
    audit: {
      reasonCode: "SYNTHETIC_SERVICE",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
  const commit = async (candidate, csrfValue = csrf, expectedStatus = 200) => {
    let stage = "transport";
    const app = createApp({
      merchantBff: {
        exactOrigin: "https://merchant.example.test",
        acceptedHost: "merchant.example.test",
        service: {
          ...authentication,
          start: unavailable,
          callback: unavailable,
          bootstrap: unavailable,
          logout: unavailable,
          switchStore: unavailable,
        },
        diningItemService: async (input) => {
          stage = "application";
          try {
            return await serving(input);
          } catch (error) {
            stage =
              typeof error?.code === "string"
                ? error.code
                : typeof error?.message === "string" && /^[A-Z_]+$/.test(error.message)
                  ? error.message
                  : "application_error";
            throw error;
          }
        },
      },
    });
    const server = createServer(app).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/merchant/dining/item-service",
            method: "POST",
            headers: {
              Host: "merchant.example.test",
              Origin: "https://merchant.example.test",
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/json",
              Cookie: "__Host-bop-merchant=" + cookie,
              "X-BOP-CSRF": csrfValue,
            },
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode,
                headers: incoming.headers,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
            incoming.on("error", reject);
          },
        );
        call.on("error", reject);
        call.end(
          JSON.stringify({
            record: candidate,
            guestSessionReference: snapshot.guestSessionReference,
          }),
        );
      });
      assert.equal(response.status, expectedStatus, "serving stage " + stage);
      assert.equal(response.headers["cache-control"], "no-store");
      return response.body;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
  return {
    commit,
    async denyCsrf() {
      await commit(record, randomBytes(32).toString("base64url"), 403);
    },
    async revokePermission() {
      await client.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2,updated_at=$1 WHERE grant_id=$2",
        [at, id(11)],
      );
      await commit(record, csrf, 403);
    },
  };
}
