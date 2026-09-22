import { createMerchantKitchenQuery } from "../../../apps/api/src/merchant-kitchen-query.ts";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import assert from "node:assert/strict";
import { createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { createMerchantKitchenCommand } from "../../../apps/api/src/merchant-kitchen-command.ts";

/** Real HTTP/Identity/selected-scope adapter over the original paid Kitchen ticket.
 * Staff, admission and Expo policies are explicit isolated-test inputs.
 */
export async function createKitchenMerchantHttp({
  session,
  createPorts,
  validateCurrentSource,
  sha256,
}) {
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
      "Sec-Fetch-Site": "same-origin",
      acceptedHost: "merchant.example.test",
      service: session.authentication,
      kitchenQuery: createMerchantKitchenQuery({
        persistence: { ...session.persistence, now: () => new Date().toISOString() },
        authentication: session.authentication,
        sha256,
      }),
      kitchenCommand: (input) => {
        const ports = createPorts(input.command, new Date().toISOString());
        return createMerchantKitchenCommand({
          persistence: { ...session.persistence, now: () => new Date().toISOString() },
          authentication: session.authentication,
          lifecycle: ports,
          validateCurrentSource,
        })(input);
      },
    },
  });
  try {
    await runtime.listen();
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const submit = async (command, overrides = {}, path = "/merchant/kitchen/work") => {
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
                reject(new Error("KITCHEN_HTTP_RESPONSE_INVALID"));
              }
            });
          },
        );
        outgoing.setTimeout(10000, () => outgoing.destroy(new Error("KITCHEN_HTTP_TIMEOUT")));
        outgoing.once("error", reject);
        outgoing.end(JSON.stringify(command));
      });
      if (response.headers["cache-control"] !== "no-store") {
        const error = new Error("Kitchen HTTP cache policy missing");
        error.code = "KITCHEN_HTTP_CACHE_" + response.status;
        throw error;
      }
      return { status: response.status, body: response.body };
    };
    return {
      submit,
      query: (query, overrides = {}) => submit(query, overrides, "/merchant/kitchen/query"),
      async execute(command) {
        const { actorReference, brandReference, ...intent } = command;
        assert.equal(typeof actorReference, "string");
        assert.equal(typeof brandReference, "string");
        const response = await submit({ ...intent, authority: "CurrentMerchantSession" });
        if (response.status !== 200) {
          const error = new Error("KITCHEN_MERCHANT_HTTP_REJECTED");
          error.code = response.body.error;
          error.status = response.status;
          throw error;
        }
        return response.body;
      },
      close: () => runtime.shutdown("SIGTERM"),
    };
  } catch (error) {
    await runtime.shutdown("SIGTERM");
    throw error;
  }
}
