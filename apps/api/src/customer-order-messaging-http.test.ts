import { createServer } from "node:http";
import { OrderRecoveryError } from "@bop/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  createCustomerOrderMessagingOptionsHandler,
  createCustomerOrderRecoveryHandler,
  createNotificationFeedbackHandlers,
} from "./customer-order-messaging-http.js";

const origin = "https://127.0.0.1:4443";
const token = "B".repeat(43);
const order = "0190aa20-0000-7000-8000-000000000001";
const credential = "C".repeat(43);

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function call(
  application: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const server = createServer(application);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function app(
  options: {
    recovery?: Parameters<typeof createCustomerOrderRecoveryHandler>[0]["port"];
    feedback?: Parameters<typeof createNotificationFeedbackHandlers>[0]["port"];
    availability?: () => { sms: boolean; email: boolean };
  } = {},
) {
  return createApp({
    customerOrderMessagingOptions: createCustomerOrderMessagingOptionsHandler({
      availability: options.availability ?? (() => ({ sms: false, email: false })),
    }),
    customerOrderRecovery: createCustomerOrderRecoveryHandler({
      allowedOrigin: origin,
      ...(options.recovery === undefined ? {} : { port: options.recovery }),
    }),
    notificationFeedback: createNotificationFeedbackHandlers(
      options.feedback === undefined ? {} : { port: options.feedback },
    ),
  });
}
const post = (
  target: ReturnType<typeof app>,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  call(target, "/api/v1/customer/order-recovery", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("DEC-PILOT-NOTIFICATIONS HTTP surface", () => {
  it("offers no order messages by default and reports configured channels", async () => {
    const off = await call(createApp(), "/api/v1/customer/order-messages");
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ schemaVersion: 1, orderMessages: { sms: false, email: false } });
    const on = await call(
      app({ availability: () => ({ sms: true, email: true }) }),
      "/api/v1/customer/order-messages",
    );
    expect(on.body.orderMessages).toEqual({ sms: true, email: true });
    expect(on.headers.get("cache-control")).toBe("no-store");
  });

  it("re-keys the session and returns only the clean order path", async () => {
    const recovery = vi.fn(async () => ({
      orderReference: order,
      sessionCredential: credential as never,
    }));
    const response = await post(app({ recovery }), { token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ schemaVersion: 1, redirectPath: `/orders/${order}` });
    expect(String(response.headers.get("set-cookie"))).toContain(`__Host-bop-guest=${credential}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ token }));
  });

  it("gives one uniform answer for an expired, used or unknown link", async () => {
    const response = await post(
      app({
        recovery: async () => {
          throw new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE");
        },
      }),
      { token },
    );
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      schemaVersion: 1,
      error: { code: "order_link_unavailable" },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 429 with Retry-After when the budget is spent and 503 when it cannot be checked", async () => {
    const limited = await post(
      app({
        recovery: async () => {
          throw new OrderRecoveryError("ORDER_RECOVERY_RATE_LIMITED", 1200);
        },
      }),
      { token },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1200");
    const down = await post(
      app({
        recovery: async () => {
          throw new Error("database down");
        },
      }),
      { token },
    );
    expect(down.status).toBe(503);
  });

  it.each([
    { body: { token: "short" }, headers: {} },
    { body: { token, extra: 1 }, headers: {} },
    { body: { token }, headers: { origin: "https://evil.example" } },
    { body: { token }, headers: { "sec-fetch-site": "cross-site" } },
  ])(
    "refuses a malformed or cross-site request before any lookup %#",
    async ({ body, headers }) => {
      const recovery = vi.fn();
      const response = await post(app({ recovery }), body, headers as Record<string, string>);
      expect(response.status).toBe(400);
      expect(recovery).not.toHaveBeenCalled();
    },
  );

  it("accepts SNS text/plain bodies on the feedback endpoint and never echoes them", async () => {
    const handle = vi.fn(async () => ({ status: 200 as const, body: { outcome: "Accepted" } }));
    const response = await call(app({ feedback: { handle } }), "/api/v1/provider/ses-feedback", {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "x-amz-sns-message-type": "Notification",
      },
      body: '{"Type":"Notification","Message":"secret-address@example.test"}',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ outcome: "Accepted" });
    expect(handle).toHaveBeenCalledWith({
      body: '{"Type":"Notification","Message":"secret-address@example.test"}',
      messageTypeHeader: "Notification",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-address");
  });

  it("has no feedback endpoint while email is not configured", async () => {
    const response = await call(createApp(), "/api/v1/provider/ses-feedback", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});
