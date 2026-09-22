import { request as httpRequest } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { parseTaskInstant } from "@bop/task";
import { createMerchantBffRouter, type MerchantBffRouterOptions } from "./merchant-bff.js";
const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const at = parseTaskInstant("2026-09-20T00:00:00.000Z"),
  cookie = "A".repeat(43),
  id = "0190fad5-0000-7000-8000-000000000001";
const headers = {
  host: "merchant.invalid",
  cookie: "__Host-bop-merchant=" + cookie,
  "sec-fetch-site": "same-origin",
};
const view = () => ({
  screenId: "TASK-INBOX" as const,
  storeLabel: "Synthetic Store",
  observedAt: at,
  items: [],
  nextAfterTaskReference: null,
});
async function serve(taskInbox?: MerchantBffRouterOptions["taskInbox"]) {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected service call");
  };
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {
        start: unavailable,
        callback: unavailable,
        bootstrap: unavailable,
        authorize: unavailable,
        logout: unavailable,
        switchStore: unavailable,
      },
      ...(taskInbox ? { taskInbox } : {}),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return `http://127.0.0.1:${address.port}`;
}
it("passes only credentials and header cursor, whitelists output and disables caching", async () => {
  const read = vi.fn(async () => ({ ...view(), privateData: "synthetic" })),
    root = await serve(read);
  const response = await request(root, "/merchant/tasks", {
    headers: { ...headers, "x-bop-task-after": id },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(view());
  expect(read).toHaveBeenCalledExactlyOnceWith(cookie, { afterTaskReference: id });
});
it.each([
  { path: "/merchant/tasks?store=foreign", headers },
  { path: "/merchant/tasks?after=" + id, headers },
  { path: "/merchant/tasks", headers: { ...headers, "sec-fetch-site": "cross-site" } },
  {
    path: "/merchant/tasks",
    headers: { ...headers, cookie: "__Host-bop-merchant=a; __Host-bop-merchant=b" },
  },
  { path: "/merchant/tasks", headers: { ...headers, "x-bop-task-after": "invalid" } },
])("denies unsafe transport before invoking the reader %#", async (input) => {
  const read = vi.fn(async () => view()),
    root = await serve(read);
  const response = await request(root, input.path, { headers: input.headers });
  expect(response.status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});
it("fails safely when unconfigured or when reader fails", async () => {
  let root = await serve();
  expect((await request(root, "/merchant/tasks", { headers })).status).toBe(503);
  root = await serve(async () => {
    throw new Error("private failure");
  });
  const response = await request(root, "/merchant/tasks", { headers });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "request_denied" });
});

async function request(
  root: string,
  pathname: string,
  options: {
    readonly body?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  return await new Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(pathname, root),
      { method: options.method ?? "GET", headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) headers.append(name, value);
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers,
            json: async () => JSON.parse(body) as unknown,
            text: async () => body,
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}
