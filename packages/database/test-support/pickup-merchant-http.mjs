import { createMerchantPickupQuery } from "../../../apps/api/src/merchant-pickup-query.ts";
import { createMerchantPickupProof } from "../../../apps/api/src/merchant-pickup-proof.ts";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import assert from "node:assert/strict";
import { createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { createMerchantPickupHandoff } from "../../../apps/api/src/merchant-pickup-handoff.ts";
/** Actual authenticated HTTP transport; device/location admission remains explicit fixture policy. */
export async function createPickupMerchantHttp({ session, handoff, proof }) {
  const runtime = createApiServerRuntime({
    port: 0,
    logger: {
      info() {
        /* Isolated fixture suppresses logs. */
      },
      warn() {
        /* Isolated fixture suppresses logs. */
      },
      error() {
        /* Isolated fixture suppresses logs. */
      },
    },
    merchantBff: {
      exactOrigin: "https://merchant.example.test",
      acceptedHost: "merchant.example.test",
      service: session.authentication,
      pickupQuery: createMerchantPickupQuery({
        persistence: { ...session.persistence, now: () => new Date().toISOString() },
        authentication: session.authentication,
        store: handoff.store,
        installContext: handoff.installContext,
      }),
      ...(proof
        ? {
            pickupProof: createMerchantPickupProof({
              persistence: { ...session.persistence, now: () => new Date().toISOString() },
              authentication: session.authentication,
              ...proof,
            }),
          }
        : {}),
      pickupHandoff: createMerchantPickupHandoff({
        persistence: { ...session.persistence, now: () => new Date().toISOString() },
        authentication: session.authentication,
        ...handoff,
      }),
    },
  });
  try {
    await runtime.listen();
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const submit = async (command, overrides = {}, path = "/merchant/pickup/handoff") => {
      const response = await new Promise((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method: "POST",
            headers: {
              Host: "merchant.example.test",
              Origin: "https://merchant.example.test",
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/json",
              "X-BOP-CSRF": session.csrf,
              Cookie: "__Host-bop-merchant=" + session.sessionCookie,
              ...overrides,
            },
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () => {
              try {
                resolve({
                  status: incoming.statusCode,
                  headers: incoming.headers,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
              } catch {
                reject(new Error("PICKUP_HTTP_RESPONSE_INVALID"));
              }
            });
          },
        );
        outgoing.setTimeout(10000, () => outgoing.destroy(new Error("PICKUP_HTTP_TIMEOUT")));
        outgoing.once("error", reject);
        outgoing.end(JSON.stringify(command));
      });
      if (response.headers["cache-control"] !== "no-store") {
        const error = new Error("Pickup HTTP cache policy missing");
        error.code = "PICKUP_HTTP_CACHE_" + response.status;
        throw error;
      }
      return { status: response.status, body: response.body };
    };
    return {
      submit,
      query: (query) => submit(query, {}, "/merchant/pickup/query"),
      verify: (command) => submit(command, {}, "/merchant/pickup/proof"),
      close: () => runtime.shutdown("SIGTERM"),
    };
  } catch (error) {
    await runtime.shutdown("SIGTERM");
    throw error;
  }
}
