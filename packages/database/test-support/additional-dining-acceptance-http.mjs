import { createMerchantAcceptanceConfigurationResolver } from "../../../apps/api/src/merchant-acceptance-configuration-resolver.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, request } from "node:http";
import { createApp } from "../../../apps/api/src/app.ts";
import { createMerchantOrderAcceptanceCommand } from "../../../apps/api/src/merchant-order-acceptance-command.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";

// Synthetic OIDC/association authority; real encrypted session, scope, policy,
// CSRF, HTTP guards, paid sources and owner acceptance transaction.
export async function exerciseAdditionalAcceptanceHttp({
  client,
  runner,
  scope,
  actor,
  at,
  configuration,
  paymentEvent,
  paymentScope,
  command,
  auditReference,
  initialAccepted = false,
}) {
  const session = await seedMerchantAcceptanceSession({
    admin: client,
    runner: runner(),
    scope,
    actor,
    at,
    ...(initialAccepted
      ? {
          referencePrefix: "01909866",
          sessionReferencePrefix: "01909865",
        }
      : {}),
  });
  const queue = createPersistentMerchantOrderQueue({
    persistence: { ...session.persistence, now: () => new Date().toISOString() },
    quoteVersion: configuration.quoteVersion,
    acceptanceConfigured: true,
  });
  const resolveConfiguration = createMerchantAcceptanceConfigurationResolver({
    now: () => new Date().toISOString(),
    authorize: async (_transaction, selected) =>
      selected.brandReference === scope.brandReference &&
      selected.storeReference === scope.storeReference &&
      selected.actorReference === actor,
    resolvePolicy: async () => ({ paymentScope, additional: configuration }),
  });
  const accept = createMerchantOrderAcceptanceCommand({
    persistence: session.persistence,
    authentication: session.authentication,
    generateAuditReference: () => auditReference,
    audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
    resolveConfiguration: async (transaction, selected, candidate) => {
      assert.deepEqual(selected, { ...scope, actorReference: actor });
      assert.deepEqual(candidate, command);
      const resolved = await resolveConfiguration(transaction, selected, candidate);
      assert.equal(resolved.kind, "Additional");
      assert.deepEqual(resolved.paymentEvent, paymentEvent);
      return resolved;
    },
  });
  const unavailable = async () => {
    throw new Error("UNUSED_TEST_LOGIN");
  };
  let queueFailure = "none";
  const server = createServer(
    createApp({
      merchantBff: {
        exactOrigin: "https://merchant.example.test",
        acceptedHost: "merchant.example.test",
        service: {
          ...session.authentication,
          start: unavailable,
          callback: unavailable,
          bootstrap: unavailable,
          logout: unavailable,
          switchStore: unavailable,
        },
        orderAcceptance: accept,
        orderQueue: async (input) => {
          try {
            return await queue(input);
          } catch (error) {
            queueFailure = [error?.name, error?.code, error?.message]
              .filter((value) => typeof value === "string" && /^[A-Za-z_ ]{1,100}$/.test(value))
              .join(":");
            throw error;
          }
        },
      },
    }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const post = (csrf = session.csrf, origin = "https://merchant.example.test", method = "POST") =>
    new Promise((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: method === "GET" ? "/merchant/orders" : "/merchant/orders/accept",
          method,
          headers: {
            Host: "merchant.example.test",
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            Cookie: "__Host-bop-merchant=" + session.sessionCookie,
            "X-BOP-CSRF": csrf,
          },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode,
              cache: incoming.headers["cache-control"],
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      call.on("error", reject);
      call.setTimeout(10000, () => call.destroy(new Error("TEST_HTTP_TIMEOUT")));
      call.end(method === "GET" ? undefined : JSON.stringify(command));
    });
  try {
    assert.equal((await post("invalid")).status, 403);
    assert.equal((await post(session.csrf, "https://foreign.example.test")).status, 403);
    const before = await post(session.csrf, "https://merchant.example.test", "GET");
    assert.equal(before.status, 200, "queue: " + queueFailure);
    const beforeOrder = before.body.items.find(
      (item) => item.orderReference === command.orderReference,
    );
    assert.ok(beforeOrder);
    assert.deepEqual(
      beforeOrder.batches.map((batch) => [
        batch.sequence,
        batch.acceptanceStatus,
        batch.canRequestAcceptance,
      ]),
      [
        [1, initialAccepted ? "Accepted" : "NotAccepted", false],
        [2, "NotAccepted", true],
      ],
    );
    const created = await post();
    assert.deepEqual(created, {
      status: 200,
      cache: "no-store",
      body: {
        status: "Created",
        acceptedOrderVersion: command.expectedOrderVersion + 1,
      },
    });
    assert.deepEqual(await post(), {
      status: 200,
      cache: "no-store",
      body: {
        status: "AlreadyCommitted",
        acceptedOrderVersion: command.expectedOrderVersion + 1,
      },
    });
    const after = await post(session.csrf, "https://merchant.example.test", "GET");
    assert.equal(after.status, 200);
    const afterOrder = after.body.items.find(
      (item) => item.orderReference === command.orderReference,
    );
    assert.equal(afterOrder.currentVersion, command.expectedOrderVersion + 1);
    assert.deepEqual(
      afterOrder.batches.map((batch) => [
        batch.sequence,
        batch.acceptanceStatus,
        batch.canRequestAcceptance,
      ]),
      [
        [1, initialAccepted ? "Accepted" : "NotAccepted", false],
        [2, "Accepted", false],
      ],
    );
    await session.revoke();
    assert.equal((await post()).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
