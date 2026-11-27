import { request as httpRequest, type Server } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerMemberHandler, customerMemberRoute } from "./customer-member-http.js";
import { CustomerMemberError, type CustomerMemberPort } from "./customer-member.js";

/** WP-2423 取舍 18: the member route's transport; the port itself runs under the restricted role. */
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
const csrf = "c".repeat(43);
const guest = "g".repeat(43);
const token = "m".repeat(43);
const origin = "https://guest.invalid";
async function serve(port: Partial<CustomerMemberPort>, load?: () => Promise<CustomerMemberPort>) {
  const app = express();
  app.post(
    customerMemberRoute,
    ...new CustomerMemberHandler({
      allowedOrigin: origin,
      port: load ?? (async () => port as CustomerMemberPort),
    }).handler(),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener");
  return address.port;
}
const post = (
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  path = customerMemberRoute,
) =>
  new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            cookie: `__Host-bop-guest=${guest}; __Host-bop-member=${token}`,
            "x-csrf-token": csrf,
            ...headers,
          },
        },
        (incoming) => {
          let text = "";
          incoming.on("data", (chunk) => (text += String(chunk)));
          incoming.on("end", () =>
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(body));
    },
  );

it("signing in sets a host-only, HttpOnly cookie and never answers with the token", async () => {
  const verify = vi.fn(async () => ({
    joined: true,
    earnedPoints: 45,
    token,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  const port = await serve({ verify } as never);
  const answer = await post(port, {
    action: "Verify",
    phone: "6135550171",
    code: "123456",
    marketingConsent: false,
    claim: true,
  });
  expect(answer.status).toBe(200);
  expect(answer.text).not.toContain(token);
  expect(JSON.parse(answer.text)).toEqual({ schemaVersion: 1, joined: true, earnedPoints: 45 });
  const cookie = String((answer.headers["set-cookie"] as string[])[0]);
  expect(cookie).toMatch(
    /^__Host-bop-member=m+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
  );
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect((verify.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ memberToken: token });
});

it("leaving clears the cookie", async () => {
  const port = await serve({ leave: async () => ({ left: true }) } as never);
  const answer = await post(port, { action: "Leave" });
  expect(String((answer.headers["set-cookie"] as string[])[0])).toContain("Max-Age=0");
});

it("a limit says how long to wait; a failure never echoes the number", async () => {
  const port = await serve({
    sendCode: async () => {
      throw new CustomerMemberError("MEMBER_RATE_LIMITED", 600);
    },
  } as never);
  const answer = await post(port, { action: "SendCode", phone: "6135550172" });
  expect(answer.status).toBe(429);
  expect(answer.headers["retry-after"]).toBe("600");
  expect(answer.text).not.toContain("6135550172");
  expect(JSON.parse(answer.text).error).toEqual({
    code: "member_rate_limited",
    retryAfterSeconds: 600,
  });
});

it("refuses cross-site requests, query strings, missing values and unknown actions", async () => {
  const state = vi.fn(async () => ({ offered: false, signedIn: false }));
  const port = await serve({ state } as never);
  for (const [body, headers, path] of [
    [{ action: "State" }, { "sec-fetch-site": "cross-site" }, undefined],
    [{ action: "State" }, { origin: "https://elsewhere.invalid" }, undefined],
    [{ action: "State" }, { "x-csrf-token": "short" }, undefined],
    [{ action: "State" }, {}, customerMemberRoute + "?phone=6135550173"],
    [{ action: "Nope" }, {}, undefined],
    [{ action: "State", extra: 1 }, {}, undefined],
    [{ action: "Redeem", operationReference: "x", points: 300 }, {}, undefined],
  ] as const)
    expect((await post(port, body, headers as never, path)).status).toBe(400);
  expect(state).not.toHaveBeenCalled();
});

it("without its key, points are unavailable and nothing else is affected", async () => {
  const port = await serve({}, async () => {
    throw new Error("MANAGED_SECRET_MISSING");
  });
  const answer = await post(port, { action: "State" });
  expect(answer.status).toBe(503);
  expect(answer.text).not.toContain("MANAGED_SECRET");
});
