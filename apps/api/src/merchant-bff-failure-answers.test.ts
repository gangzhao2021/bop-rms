import { Buffer } from "node:buffer";
import { request as httpRequest, type Server } from "node:http";
import { BrowserSessionError } from "@bop/identity";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMerchantBffRouter, type MerchantBffRouterOptions } from "./merchant-bff.js";
import { withCause } from "./merchant-failure.js";
import { MerchantMenuError } from "./merchant-menus.js";
import { DiningTableCheckoutError } from "./merchant-dining-table-checkout.js";

/**
 * WP-2423 item 10: a failure is a permission refusal only when the error says so. These run through
 * the real router: what a staff member's browser gets, and what the operator's log hears.
 */
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const origin = "https://merchant.invalid";
const headers = {
  host: "merchant.invalid",
  origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-bop-csrf": "csrf",
  cookie: "__Host-bop-merchant=session",
};

const readHeaders = Object.fromEntries(
  Object.entries(headers).filter(([name]) => name !== "content-type"),
);

async function serve(options: Partial<MerchantBffRouterOptions>) {
  const reported: [string, unknown][] = [];
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      exactOrigin: origin,
      acceptedHost: "merchant.invalid",
      service: {},
      onUnexpectedFailure: (route: string, error: unknown) => {
        reported.push([route, error]);
      },
      ...options,
    } as unknown as MerchantBffRouterOptions),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}/merchant`;
  const send = (method: string, path: string, body?: string) =>
    new Promise<{
      readonly status: number;
      readonly headers: { get(name: string): string | null };
      json(): Promise<unknown>;
      text(): Promise<string>;
    }>((resolve, reject) => {
      const outgoing = httpRequest(
        root + path,
        {
          method,
          headers: body === undefined ? readHeaders : headers,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: incoming.statusCode ?? 0,
              headers: {
                get: (name) => {
                  const value = incoming.headers[name.toLowerCase()];
                  return typeof value === "string" ? value : null;
                },
              },
              json: () => Promise.resolve(JSON.parse(text)),
              text: () => Promise.resolve(text),
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  return {
    reported,
    post: (path: string, body: unknown = {}) => send("POST", path, JSON.stringify(body)),
    get: (path: string) => send("GET", path),
    /** A top-level page load (the sign-in callback, as the identity provider redirects to it). */
    navigate: (path: string) =>
      new Promise<{ readonly status: number; readonly location: string | undefined }>(
        (resolve, reject) => {
          const outgoing = httpRequest(
            root + path,
            { method: "GET", headers: { ...readHeaders, "sec-fetch-dest": "document" } },
            (incoming) => {
              incoming.resume();
              incoming.once("end", () =>
                resolve({ status: incoming.statusCode ?? 0, location: incoming.headers.location }),
              );
            },
          );
          outgoing.once("error", reject);
          outgoing.end();
        },
      ),
  };
}

const rejecting = (error: unknown) => () => Promise.reject(error);
const database = (code: string, sqlState: string | null) =>
  Object.assign(new Error("safe"), {
    code,
    diagnostic: { sqlState, table: "x", constraint: null },
  });
const missingGrant = () => database("TENANT_DATABASE_TRANSACTION_FAILED", "42501");

describe("a database refusal is not a permission refusal", () => {
  it("answers 503 retry_later with what to do, and reports the route once", async () => {
    const failure = missingGrant();
    const app = await serve({ oneStoreDishes: { command: rejecting(failure) } } as never);
    const response = await app.post("/commerce/one-store-dishes/command");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "retry_later" });
    expect(app.reported).toEqual([["/commerce/one-store-dishes/command", failure]]);
  });

  it("keeps a real refusal a refusal, and logs nothing", async () => {
    const app = await serve({
      oneStoreDishes: { command: rejecting(new MerchantMenuError("PermissionDenied")) },
    } as never);
    const response = await app.post("/commerce/one-store-dishes/command");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "PermissionDenied", part: "Menu" });
    expect(app.reported).toEqual([]);
  });

  it("a passing condition says so with a shorter wait", async () => {
    const app = await serve({
      oneStoreDishes: {
        command: rejecting(database("TENANT_DATABASE_TRANSACTION_FAILED", "57014")),
      },
    } as never);
    const response = await app.post("/commerce/one-store-dishes/command");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(app.reported).toHaveLength(1);
  });

  it("never lets the reporter change the answer", async () => {
    const app = await serve({
      diningTables: rejecting(missingGrant()),
      onUnexpectedFailure: () => {
        throw new Error("the log is gone");
      },
    } as never);
    const response = await app.post("/dining/tables");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "retry_later" });
  });

  it("works with no reporter composed", async () => {
    const app = await serve({
      diningTables: rejecting(missingGrant()),
      onUnexpectedFailure: undefined,
    } as never);
    expect((await app.post("/dining/tables")).status).toBe(503);
  });
});

describe("a race is not told to try again for ever", () => {
  it("two servers open one table: the second reads the table again, and nothing is logged", async () => {
    const app = await serve({
      diningSessionStart: rejecting(
        Object.assign(new Error("safe"), { code: "DINING_SESSION_VERSION_CONFLICT" }),
      ),
    } as never);
    const response = await app.post("/dining/sessions/start");
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "changed_while_loading" });
    expect(app.reported).toEqual([]);
  });
});

describe("no 5xx is ever silent", () => {
  it("a route's own 503 reports what the service threw, not just that it failed", async () => {
    const failure = missingGrant();
    const app = await serve({ diningTableBill: rejecting(failure) } as never);
    const answered = await app.post("/dining/table-bill");
    expect(answered.status).toBe(503);
    expect(app.reported).toEqual([["/dining/table-bill", failure]]);
    // A typed failure with its own 503 body.
    const typed = await serve({
      reconciliationAssigneeQuery: rejecting(missingGrant()),
    } as never);
    const own = await typed.post("/operations/order-exceptions/follow-up-assignees");
    expect(own.status).toBe(503);
    expect(await own.json()).toEqual({ error: "reconciliation_assignees_unavailable" });
    expect(typed.reported).toHaveLength(1);
  });

  it("a route that answers 5xx with nothing noted is reported anyway, with its route", async () => {
    const app = await serve({});
    const response = await app.post("/dining/tables");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "dining_tables_unavailable" });
    expect(app.reported).toHaveLength(1);
    const [route, error] = app.reported[0] as [string, Error];
    expect(route).toBe("/dining/tables");
    expect(error.message).toBe("MERCHANT_BFF_UNREPORTED_FAILURE");
  });

  it("contention that outlasted its reruns is answered and not logged", async () => {
    const conflict = database("TENANT_DATABASE_TRANSACTION_CONFLICT", "55P03");
    const app = await serve({
      diningTables: rejecting(conflict),
      diningTableBill: rejecting(conflict),
    } as never);
    expect((await app.post("/dining/tables")).status).toBe(503);
    expect((await app.post("/dining/table-bill")).status).toBe(503);
    expect(app.reported).toEqual([]);
  });

  it("a refusal or a race answered by a route is not a failure of the system", async () => {
    const app = await serve({
      diningTables: rejecting(new Error("DINING_TABLES_PERMISSION_DENIED")),
    } as never);
    expect((await app.post("/dining/tables")).status).toBe(403);
    expect(app.reported).toEqual([]);
  });

  it("a read that succeeds reports nothing", async () => {
    const app = await serve({
      diningStaffCallCount: () => Promise.resolve({ count: 1 }),
    } as never);
    expect((await app.post("/dining/staff-calls/count")).status).toBe(200);
    expect(app.reported).toEqual([]);
  });
});

describe("the session read", () => {
  const session = (error: unknown) =>
    serve({
      service: {
        bootstrap: rejecting(error),
      },
    } as never);

  it("a fault answers at once: no wait loop, one line", async () => {
    const failure = missingGrant();
    const app = await session(failure);
    const response = await app.get("/session");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "merchant_workspace_unavailable" });
    expect(app.reported).toEqual([["/session", failure]]);
  });

  it("a lock or a busy pool tells the browser to wait, and a lock is not logged", async () => {
    const lock = await session(database("TENANT_DATABASE_TRANSACTION_CONFLICT", "55P03"));
    const waited = await lock.get("/session");
    expect(waited.status).toBe(503);
    expect(waited.headers.get("retry-after")).toBe("2");
    expect(await waited.json()).toEqual({ error: "retry_later" });
    expect(lock.reported).toEqual([]);
    const pool = await session(database("TENANT_DATABASE_ACQUIRE_FAILED", null));
    expect(await (await pool.get("/session")).json()).toEqual({ error: "retry_later" });
    expect(pool.reported).toHaveLength(1);
  });

  it("a lock behind a rewrite waits too; a missing grant behind one does not", async () => {
    const waited = await session(
      Object.assign(new Error("MERCHANT_ORGANIZATION_UNAVAILABLE"), {
        cause: database("TENANT_DATABASE_TRANSACTION_CONFLICT", "55P03"),
      }),
    );
    expect(await (await waited.get("/session")).json()).toEqual({ error: "retry_later" });
    const fault = await session(
      Object.assign(new Error("MERCHANT_ORGANIZATION_UNAVAILABLE"), { cause: missingGrant() }),
    );
    expect(await (await fault.get("/session")).json()).toEqual({
      error: "merchant_workspace_unavailable",
    });
  });

  it("a real refusal still reads as signed out, and logs nothing", async () => {
    const app = await session(new Error("BROWSER_SESSION_DENIED"));
    const response = await app.get("/session");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "request_denied" });
    expect(app.reported).toEqual([]);
  });

  it("an archived Store answers 403 that says so, and logs nothing", async () => {
    for (const error of [
      new Error("MERCHANT_ORGANIZATION_NOT_ACTIVE_DENIED"),
      withCause(
        new Error("BROWSER_SESSION_DENIED"),
        new Error("MERCHANT_ORGANIZATION_NOT_ACTIVE_DENIED"),
      ),
    ]) {
      const app = await session(error);
      const response = await app.get("/session");
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "organization_not_active" });
      expect(app.reported).toEqual([]);
    }
  });
});

describe("replies that say nothing about why still tell the log", () => {
  it("a failed sign-in callback redirects as before and reports only a fault", async () => {
    const fault = missingGrant();
    const app = await serve({ service: { callback: rejecting(fault) } } as never);
    const failed = await app.get("/callback?code=x&state=y");
    expect(failed.status).toBe(403);
    expect(await failed.json()).toEqual({ error: "request_denied" });
    expect(app.reported).toEqual([["/callback", fault]]);
    const refused = await serve({
      service: { callback: rejecting(new Error("BROWSER_SESSION_DENIED")) },
    } as never);
    await refused.get("/callback?code=x&state=y");
    expect(refused.reported).toEqual([]);
  });

  it("a sign-in to a Store BOP closed lands on the page that says so, and logs nothing", async () => {
    const signInEntry = { path: "/operations/sign-in", testOnly: false };
    // As the sign-in writes it over: the session store's denial, then the sign-in's own.
    const closed = new BrowserSessionError("BROWSER_SESSION_DENIED", {
      cause: new BrowserSessionError("BROWSER_SESSION_DENIED", {
        cause: new Error("MERCHANT_SESSION_SELECTION_DENIED", {
          cause: new Error("MERCHANT_ORGANIZATION_NOT_ACTIVE_DENIED"),
        }),
      }),
    });
    const app = await serve({ signInEntry, service: { callback: rejecting(closed) } } as never);
    const page = await app.navigate("/callback?code=x&state=y");
    expect(page.status).toBe(303);
    expect(page.location).toBe("/operations/sign-in?signIn=not_active");
    expect(app.reported).toEqual([]);
    // Any other refused sign-in keeps its own page.
    const refused = await serve({
      signInEntry,
      service: {
        callback: rejecting(
          new BrowserSessionError("BROWSER_SESSION_DENIED", {
            cause: new Error("MERCHANT_SESSION_SELECTION_DENIED"),
          }),
        ),
      },
    } as never);
    expect((await refused.navigate("/callback?code=x&state=y")).location).toBe(
      "/operations/sign-in?signIn=failed",
    );
  });

  it("may-open answers no, and a fault behind it is seen", async () => {
    const fault = missingGrant();
    const app = await serve({ storeOpening: { mayOpen: rejecting(fault) } } as never);
    const response = await app.post("/organization/stores/may-open");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mayOpen: false });
    expect(app.reported).toEqual([["/organization/stores/may-open", fault]]);
    const refused = await serve({
      storeOpening: {
        mayOpen: rejecting(Object.assign(new Error("safe"), { code: "PermissionDenied" })),
      },
    } as never);
    await refused.post("/organization/stores/may-open");
    expect(refused.reported).toEqual([]);
  });
});

/**
 * The routes whose failure handler has no typed answer of its own, with a refusal their service
 * really throws. A refusal stays a refusal, a fault is a fault. If a service starts refusing with
 * a code the classifier does not know, the table is where that is decided.
 */
const unexpected = () => new Error("synthetic private failure");
const postRoutes: readonly (readonly [string, string, string])[] = [
  ["/dining/sessions/join-state", "diningJoinState", "DINING_JOIN_STATE_DENIED"],
  ["/dining/sessions/qr-join", "diningQrJoin", "DINING_QR_JOIN_DENIED"],
  ["/dining/sessions/regenerate", "diningJoinRegenerate", "DINING_JOIN_REGENERATE_DENIED"],
  ["/dining/sessions/host-transfer", "diningHostTransfer", "DINING_HOST_TRANSFER_DENIED"],
  ["/dining/sessions/host-selection", "diningHostSelection", "DINING_HOST_SELECTION_DENIED"],
  ["/dining/sessions/start", "diningSessionStart", "DINING_SESSION_START_DENIED"],
  ["/dining/tables", "diningTables", "DINING_TABLES_PERMISSION_DENIED"],
  ["/dining/staff-calls/count", "diningStaffCallCount", "DINING_STAFF_CALL_DENIED"],
  ["/dining/staff-calls/answer", "diningStaffCallAnswer", "DINING_STAFF_CALL_DENIED"],
  ["/dining/payment-timing", "diningPaymentTimingRead", "DINING_PAYMENT_TIMING_DENIED"],
  ["/dining/payment-timing/change", "diningPaymentTimingChange", "DINING_PAYMENT_TIMING_DENIED"],
  ["/dining/tables/availability", "diningTableCommand", "DINING_TABLE_COMMAND_DENIED"],
  ["/dining/order-progress", "diningOrderProgress", "DINING_ORDER_PROGRESS_PERMISSION_DENIED"],
  ["/dining/serve", "diningServe", "DINING_SERVE_COMMAND_DENIED"],
  ["/dining/item-service", "diningItemService", "DINING_ITEM_SERVICE_PERMISSION_DENIED"],
  ["/dining/table-bill", "diningTableBill", "TABLE_CHECKOUT_PERMISSION_DENIED"],
  ["/dining/table-settle", "diningTableSettle", "TABLE_CHECKOUT_PERMISSION_DENIED"],
  ["/dining/table-split", "diningTableSplit", "TABLE_CHECKOUT_PERMISSION_DENIED"],
  ["/kitchen/release", "kitchenRelease", "BROWSER_SESSION_DENIED"],
  ["/payments/refunds/preview", "ordinaryRefundPreview", "ORDINARY_REFUND_REQUEST_DENIED"],
  ["/payments/refunds/request", "ordinaryRefundRequest", "ORDINARY_REFUND_REQUEST_DENIED"],
  ["/payments/refunds/prepare", "ordinaryRefund", "ORDINARY_REFUND_COMMAND_DENIED"],
];
const getRoutes: readonly (readonly [string, string, string])[] = [
  ["/order-exceptions", "orderExceptions", "MERCHANT_ORDER_EXCEPTION_DENIED"],
  ["/tasks", "taskInbox", "MERCHANT_TASK_INBOX_DENIED"],
  ["/operations-alerts", "operationsAlerts", "BROWSER_SESSION_DENIED"],
  ["/business-day", "businessDay", "STORE_SERVICE_PERMISSION_DENIED"],
  ["/service-control", "serviceControlState", "STORE_SERVICE_PERMISSION_DENIED"],
  ["/store-configuration", "storeConfigurationState", "STORE_CONFIGURATION_PERMISSION_DENIED"],
  ["/settlement", "settlement", "MERCHANT_SETTLEMENT_DENIED"],
  ["/reports", "storeReports.read", "MERCHANT_STORE_REPORTS_DENIED"],
  ["/orders", "orderQueue", "MERCHANT_ORDER_QUEUE_DENIED"],
  ["/store/opening-list", "openingChecklist.read", "MERCHANT_OPENING_LIST_DENIED"],
];
const option = (key: string, value: unknown) => {
  const [first, second] = key.split(".") as [string, string?];
  return second === undefined ? { [first]: value } : { [first]: { [second]: value } };
};

describe("each route tells a refusal from a failure", () => {
  it.each(postRoutes)("POST %s", async (path, key, refusal) => {
    const refused = await serve(option(key, rejecting(new Error(refusal))) as never);
    const refusedResponse = await refused.post(path);
    expect(refusedResponse.status).toBe(403);
    expect(refused.reported).toEqual([]);
    const failing = await serve(option(key, rejecting(unexpected())) as never);
    const failed = await failing.post(path);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");
    expect(failing.reported).toHaveLength(1);
    expect(failing.reported[0]?.[0]).toBe(path);
  });

  it.each(getRoutes)("GET %s", async (path, key, refusal) => {
    const refused = await serve(option(key, rejecting(new Error(refusal))) as never);
    expect((await refused.get(path)).status).toBe(403);
    expect(refused.reported).toEqual([]);
    const failing = await serve(option(key, rejecting(unexpected())) as never);
    const failed = await failing.get(path);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");
    expect(failing.reported).toHaveLength(1);
  });

  it("a service's own rewrite around an ended sign-in still sends them to sign in", async () => {
    const ended = withCause(
      new Error("MERCHANT_TASK_INBOX_UNAVAILABLE"),
      new Error("BROWSER_SESSION_DENIED"),
    );
    const refused = await serve({ taskInbox: rejecting(ended) } as never);
    expect((await refused.get("/tasks")).status).toBe(403);
    expect(refused.reported).toEqual([]);
    const fault = withCause(new Error("MERCHANT_TASK_INBOX_UNAVAILABLE"), missingGrant());
    const failing = await serve({ taskInbox: rejecting(fault) } as never);
    expect((await failing.get("/tasks")).status).toBe(503);
    expect(failing.reported).toEqual([["/tasks", fault]]);
  });

  it("the session routes that only ask the session", async () => {
    const authorize = vi.fn(rejecting(new Error("BROWSER_SESSION_DENIED")));
    const refused = await serve({ service: { authorize, logout: authorize } } as never);
    expect((await refused.post("/protected")).status).toBe(403);
    expect((await refused.post("/logout")).status).toBe(403);
    expect(refused.reported).toEqual([]);
    const fault = vi.fn(rejecting(missingGrant()));
    const failing = await serve({ service: { authorize: fault, logout: fault } } as never);
    expect((await failing.post("/protected")).status).toBe(503);
    expect((await failing.post("/logout")).status).toBe(503);
    expect(failing.reported.map(([route]) => route)).toEqual(["/protected", "/logout"]);
  });
});

// WP-2423 (v15 fabf0261): a paper paid-at well before the table's last live round is a refusal
// the page explains, never a fault in the operator's log.
it("a table paid-at well before its last round was ordered is a 409 the page reads", async () => {
  const refused = await serve({
    diningTableSettle: rejecting(
      new DiningTableCheckoutError("TABLE_CHECKOUT_TAKEN_BEFORE_ORDERED"),
    ),
  } as never);
  const response = await refused.post("/dining/table-settle");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "taken_before_ordered" });
  expect(refused.reported).toEqual([]);
});
