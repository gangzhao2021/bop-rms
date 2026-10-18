import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createPostgresOidcAuthorizationStore,
  createAuthorizationTransaction,
} from "../../bop/identity/src/index.ts";

export async function verifyOidcAuthorizationStore({ admin, client, role }) {
  await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON bop_identity.oidc_authorization_transaction TO " + role,
  );
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  const config = {
    environment: "synthetic",
    redirectUri: "https://merchant.example.test/callback",
    allowedPostLoginPaths: ["/operations/order-exceptions"],
  };
  let databaseFailure = null;
  function store(connection) {
    return createPostgresOidcAuthorizationStore({
      ...config,
      transactions: {
        async run(work) {
          await connection.query("BEGIN");
          try {
            await connection.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: async (sql, values) => {
                try {
                  return await connection.query(sql, [...values]);
                } catch (error) {
                  databaseFailure = error.code;
                  throw error;
                }
              },
            });
            await connection.query("COMMIT");
            return result;
          } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
          }
        },
      },
    });
  }
  const first = store(client),
    second = store(admin);
  const reference = "0190ed60-0000-7000-8000-000000000095";
  const state = "a".repeat(64),
    cookie = "b".repeat(64);
  const record = createAuthorizationTransaction({
    transactionReference: reference,
    stateSelectorHash: state,
    authCookieSelectorHash: cookie,
    encryptedSecrets: {
      algorithm: "SYNTHETIC_AES_256_GCM",
      keyReference: "synthetic-key",
      ciphertext: Buffer.alloc(40, 9).toString("base64url"),
      encryptionContext: "synthetic:oidc:" + reference,
    },
    redirectUri: config.redirectUri,
    postLoginPath: config.allowedPostLoginPaths[0],
    expiresAt: "2026-09-10T10:10:00.000Z",
    consumedAt: null,
    version: 1,
  });
  await assert.rejects(
    first.createAuthorizationTransaction({
      ...record,
      encryptedSecrets: { ...record.encryptedSecrets, encryptionContext: "wrong" },
    }),
  );
  try {
    await first.createAuthorizationTransaction(record);
  } catch (error) {
    throw new Error("synthetic OIDC create failed: " + (databaseFailure ?? "validation"), {
      cause: error,
    });
  }
  const command = {
    stateSelectorHash: state,
    authCookieSelectorHash: cookie,
    consumedAt: "2026-09-10T10:05:00.000Z",
  };
  assert.equal(
    await first.consumeAuthorizationTransaction({
      ...command,
      authCookieSelectorHash: "c".repeat(64),
    }),
    null,
  );
  assert.equal(
    await first.consumeAuthorizationTransaction({
      ...command,
      consumedAt: "2026-09-10T09:59:59.999Z",
    }),
    null,
  );
  assert.equal(
    await first.consumeAuthorizationTransaction({ ...command, consumedAt: record.expiresAt }),
    null,
  );
  const outcomes = await Promise.all([
    first.consumeAuthorizationTransaction(command),
    second.consumeAuthorizationTransaction(command),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const consumed = outcomes.find(Boolean);
  assert.equal(consumed.version, 2);
  assert.deepEqual(consumed.encryptedSecrets, record.encryptedSecrets);
  assert.equal(consumed.consumedAt, command.consumedAt);
  assert.equal(await first.consumeAuthorizationTransaction(command), null);
  const result = await admin.query(
    "SELECT version,consumed_at FROM bop_identity.oidc_authorization_transaction WHERE transaction_id=$1",
    [reference],
  );
  assert.equal(result.rows[0].version, 2);
  assert.equal(result.rows[0].consumed_at.toISOString(), command.consumedAt);
}
