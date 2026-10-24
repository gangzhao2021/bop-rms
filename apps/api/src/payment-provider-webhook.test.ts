import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { PaymentWebhookInboxError, ProviderWebhookVerificationError } from "@rms/payment";
import { createApp } from "./app.js";
import {
  PaymentProviderWebhookHandler,
  paymentProviderWebhookRoute,
} from "./payment-provider-webhook.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(receive?: (input: unknown) => Promise<unknown>) {
  const port = { receive: vi.fn(receive ?? (async () => ({ processed: "Completed" }))) };
  const server = createServer(
    createApp({
      paymentProviderWebhook: new PaymentProviderWebhookHandler({
        port,
        now: () => "2026-10-20T12:00:00.000Z",
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + paymentProviderWebhookRoute;
  return {
    port,
    send: (body: string, headers: Record<string, string> = {}, query = "") =>
      fetch(url + query, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "stripe-signature": "t=1,v1=" + "a".repeat(64),
          ...headers,
        },
        body,
      }),
  };
}
const body = JSON.stringify({ id: "evt_SYNTHETIC0001", object: "event", data: { object: {} } });

it("hands the exact raw bytes, signature header and receive time to the Payment receiver", async () => {
  const { port, send } = await setup();
  // Whitespace and key order must survive: Stripe signs these exact bytes.
  const raw = '{ "b":1,\n  "a" :2 }';
  const response = await send(raw);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ received: true });
  const input = port.receive.mock.calls[0]?.[0] as {
    signatureHeader: string;
    rawBody: Uint8Array;
    receivedAt: string;
  };
  expect(input.signatureHeader).toBe("t=1,v1=" + "a".repeat(64));
  expect(input.receivedAt).toBe("2026-10-20T12:00:00.000Z");
  expect(Buffer.from(input.rawBody).toString("utf8")).toBe(raw);
});
it("rejects a missing signature, other content types and query strings before the receiver", async () => {
  const { port, send } = await setup();
  expect((await send(body, { "stripe-signature": "" })).status).toBe(400);
  expect((await send(body, { "content-type": "text/plain" })).status).toBe(400);
  expect((await send(body, {}, "?replay=1")).status).toBe(400);
  expect((await send("")).status).toBe(400);
  expect(port.receive).not.toHaveBeenCalled();
});
it("answers 400 to a bad signature (no retry helps) and 503 to a dependency failure (retry)", async () => {
  for (const [error, status] of [
    [new ProviderWebhookVerificationError("PROVIDER_WEBHOOK_SIGNATURE_INVALID"), 400],
    [new ProviderWebhookVerificationError("PROVIDER_WEBHOOK_TIMESTAMP_INVALID"), 400],
    [new PaymentWebhookInboxError("PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT"), 400],
    [new ProviderWebhookVerificationError("PROVIDER_WEBHOOK_DEPENDENCY_UNAVAILABLE"), 503],
    [new PaymentWebhookInboxError("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE"), 503],
    [new Error("mapper failed"), 503],
  ] as const) {
    const { send } = await setup(async () => {
      throw error;
    });
    const response = await send(body);
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain("evt_");
    expect(text).not.toContain("mapper");
  }
});
it("is unavailable (503) when no Stripe receiver is configured", async () => {
  const server = createServer(createApp({}));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + paymentProviderWebhookRoute,
    { method: "POST", headers: { "content-type": "application/json" }, body },
  );
  expect(response.status).toBe(503);
});
