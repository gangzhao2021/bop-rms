import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  createReconnectPolicy,
  InMemoryRealtimeConnectionRegistry,
  type RealtimeAuthorization,
  type RealtimeAuthorizer,
  type RealtimeHint,
  type RealtimeMetric,
  type RealtimeSession,
  RealtimeTransport,
  recoveryActionFor,
} from "./realtime.js";

const ORIGIN = "https://merchant.example.test";
const BRAND_ID = "018f0000-0000-7000-8000-000000000001";
const STORE_ID = "018f0000-0000-7000-8000-000000000002";
const OTHER_STORE_ID = "018f0000-0000-7000-8000-000000000003";
const MESSAGE_ID = "018f0000-0000-7000-8000-000000000004";
const RESOURCE_ID = "018f0000-0000-7000-8000-000000000005";

const servers: Server[] = [];
const openRequests: ReturnType<typeof import("node:http").request>[] = [];

afterEach(async () => {
  for (const request of openRequests.splice(0)) request.destroy();
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

function session(overrides: Partial<RealtimeSession> = {}): RealtimeSession {
  return {
    active: true,
    brandId: BRAND_ID,
    kind: "merchant",
    permissions: ["realtime:subscribe"],
    revision: "revision-1",
    sessionKey: "merchant-session-1",
    storeId: STORE_ID,
    ...overrides,
  };
}

class MutableAuthorizer implements RealtimeAuthorizer {
  current: RealtimeAuthorization = { outcome: "authorized", session: session() };
  changeListener: (() => void) | undefined;

  async authorize(): Promise<RealtimeAuthorization> {
    return this.current;
  }

  async revalidate(): Promise<RealtimeAuthorization> {
    return this.current;
  }

  subscribeToScopeChanges(_session: Readonly<RealtimeSession>, onChange: () => void) {
    this.changeListener = onChange;
    return () => {
      this.changeListener = undefined;
    };
  }
}

function transportFor(
  authorizer: RealtimeAuthorizer,
  options: Partial<ConstructorParameters<typeof RealtimeTransport>[0]> = {},
): RealtimeTransport {
  return new RealtimeTransport({
    authorizer,
    connectionRegistry: new InMemoryRealtimeConnectionRegistry(),
    expectedOrigin: ORIGIN,
    ...options,
  });
}

async function listen(transport: RealtimeTransport): Promise<number> {
  const server = createServer(createApp({ realtime: transport }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    origin: ORIGIN,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...overrides,
  };
}

async function requestJson(
  port: number,
  path = "/bff/realtime",
  requestHeaders = headers(),
): Promise<{ body: unknown; headers: import("node:http").IncomingHttpHeaders; status: number }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: requestHeaders,
  });
  return {
    body: await response.json(),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
}

async function openStream(
  port: number,
  path = "/bff/realtime",
): Promise<{
  chunks: string[];
  request: ReturnType<typeof import("node:http").request>;
  response: import("node:http").IncomingMessage;
}> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers: headers(),
        host: "127.0.0.1",
        method: "GET",
        path,
        port,
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => chunks.push(chunk));
        resolve({ chunks, request, response });
      },
    );
    request.once("error", reject);
    request.end();
    openRequests.push(request);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for realtime evidence");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function validHint(overrides: Partial<RealtimeHint> = {}): RealtimeHint {
  return {
    messageId: MESSAGE_ID,
    occurredAt: "2026-07-24T20:00:00.000Z",
    projectionVersion: 2,
    resource: { id: RESOURCE_ID, type: "kitchenWorkItem" },
    scope: { brandId: BRAND_ID, storeId: STORE_ID },
    type: "kitchen.work-item-updated",
    version: 1,
    ...overrides,
  };
}

describe("WP-0036 same-origin realtime acceptance", () => {
  it("fails closed on Origin, Fetch Metadata, credential query and diagnostic cursor violations", async () => {
    const authorizer = new MutableAuthorizer();
    const transport = transportFor(authorizer);
    const port = await listen(transport);

    expect(
      (await requestJson(port, "/bff/realtime", headers({ origin: "https://evil.test" }))).status,
    ).toBe(403);
    expect(
      (await requestJson(port, "/bff/realtime", headers({ "sec-fetch-site": "cross-site" })))
        .status,
    ).toBe(403);
    expect((await requestJson(port, "/bff/realtime?token=secret")).status).toBe(400);
    expect(
      (await requestJson(port, "/bff/realtime", headers({ "last-event-id": "x".repeat(129) })))
        .status,
    ).toBe(400);
    expect(transport.resourceSnapshot()).toEqual({
      activeStreams: 0,
      draining: false,
      ownedTimers: 0,
    });
  });

  it("denies unauthenticated, Guest, missing permission and cross-Store subscriptions safely", async () => {
    const authorizer = new MutableAuthorizer();
    const transport = transportFor(authorizer);
    const port = await listen(transport);

    authorizer.current = { outcome: "unauthenticated" };
    expect((await requestJson(port)).status).toBe(401);
    authorizer.current = { outcome: "authorized", session: session({ kind: "guest" }) };
    expect((await requestJson(port)).status).toBe(403);
    authorizer.current = { outcome: "authorized", session: session({ permissions: [] }) };
    expect((await requestJson(port)).status).toBe(403);
    authorizer.current = { outcome: "authorized", session: session() };
    const denied = await requestJson(port, `/bff/realtime?storeId=${OTHER_STORE_ID}`);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(OTHER_STORE_ID);
  });

  it("sets no-buffer headers, emits minimal scoped hints and rejects unsafe/cross-scope hints", async () => {
    const metrics: unknown[] = [];
    const authorizer = new MutableAuthorizer();
    const transport = transportFor(authorizer, {
      metrics: (metric) => metrics.push(metric),
    });
    const port = await listen(transport);
    const stream = await openStream(port, `/bff/realtime?storeId=${STORE_ID}`);

    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.response.headers["cache-control"]).toBe("no-store, no-transform");
    expect(stream.response.headers["content-encoding"]).toBeUndefined();
    expect(stream.response.headers["x-accel-buffering"]).toBe("no");
    await waitFor(() => stream.chunks.join("").includes("event: system.refresh"));

    expect(transport.publish(validHint())).toBe(1);
    await waitFor(() => stream.chunks.join("").includes(MESSAGE_ID));
    const payload = stream.chunks.join("");
    expect(payload).toContain('"projectionVersion":2');
    expect(payload).not.toContain("token");
    (authorizer.current as { outcome: "authorized"; session: RealtimeSession }).session.storeId =
      OTHER_STORE_ID;
    expect(
      transport.publish(
        validHint({
          scope: { brandId: BRAND_ID, storeId: OTHER_STORE_ID },
        }),
      ),
    ).toBe(0);
    expect(
      transport.publish(
        validHint({
          type: "system.secret",
        }),
      ),
    ).toBe(0);
    expect(JSON.stringify(metrics)).not.toContain(BRAND_ID);

    stream.request.destroy();
    await waitFor(() => transport.resourceSnapshot().activeStreams === 0);
  });

  it("revalidates on a scope-change signal and closes before another business hint", async () => {
    const authorizer = new MutableAuthorizer();
    const registry = new InMemoryRealtimeConnectionRegistry(() => "connection-revocation");
    const transport = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
    });
    const port = await listen(transport);
    const stream = await openStream(port);
    await waitFor(() => transport.resourceSnapshot().activeStreams === 1);

    authorizer.current = { outcome: "forbidden" };
    authorizer.changeListener?.();
    await waitFor(() => transport.resourceSnapshot().activeStreams === 0);
    expect(registry.activeCount()).toBe(0);
    expect(stream.chunks.join("")).not.toContain("system.reconnect");
    expect(transport.publish(validHint())).toBe(0);
  });

  it("releases every owned resource when scope-change listener registration fails", async () => {
    const registry = new InMemoryRealtimeConnectionRegistry(() => "connection-listener-failure");
    const authorizer: RealtimeAuthorizer = {
      authorize: async () => ({ outcome: "authorized", session: session() }),
      revalidate: async () => ({ outcome: "authorized", session: session() }),
      subscribeToScopeChanges: () => {
        throw new Error("synthetic secret listener failure");
      },
    };
    const transport = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
    });
    const port = await listen(transport);
    await openStream(port);
    await waitFor(() => transport.resourceSnapshot().activeStreams === 0);
    expect(registry.activeCount()).toBe(0);
    expect(transport.resourceSnapshot().ownedTimers).toBe(0);
  });

  it("enforces one shared Merchant limit across concurrent API instances and releases leases", async () => {
    let connectionSequence = 0;
    const registry = new InMemoryRealtimeConnectionRegistry(
      () => `shared-connection-${(connectionSequence += 1)}`,
    );
    const authorizer = new MutableAuthorizer();
    const first = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
    });
    const second = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
    });
    const firstPort = await listen(first);
    const secondPort = await listen(second);
    const streams = await Promise.all([
      openStream(firstPort),
      openStream(secondPort),
      openStream(firstPort),
    ]);
    await waitFor(() => registry.activeCount() === 3);

    const limited = await requestJson(secondPort);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("1");
    expect(JSON.stringify(limited.body)).not.toContain("merchant-session-1");

    streams[0]?.request.destroy();
    await waitFor(() => registry.activeCount() === 2);
    const replacement = await openStream(secondPort);
    expect(replacement.response.statusCode).toBe(200);
    expect(registry.activeCount()).toBe(3);

    for (const stream of [...streams.slice(1), replacement]) stream.request.destroy();
    await waitFor(() => registry.activeCount() === 0);
  });

  it("models the separate two-stream Guest limit without mounting an invented Guest route", async () => {
    let sequence = 0;
    const registry = new InMemoryRealtimeConnectionRegistry(
      () => `guest-connection-${(sequence += 1)}`,
    );
    const first = await registry.acquire({
      kind: "guest",
      limit: 2,
      sessionKey: "guest-session",
    });
    const second = await registry.acquire({
      kind: "guest",
      limit: 2,
      sessionKey: "guest-session",
    });
    const third = await registry.acquire({
      kind: "guest",
      limit: 2,
      sessionKey: "guest-session",
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeUndefined();
    await first?.release();
    await second?.release();
    expect(registry.activeCount()).toBe(0);
  });

  it("heartbeats, expires, drains and leaves no stream, timer or lease residue", async () => {
    let connectionSequence = 0;
    const registry = new InMemoryRealtimeConnectionRegistry(
      () => `lifecycle-connection-${(connectionSequence += 1)}`,
    );
    const authorizer = new MutableAuthorizer();
    const transport = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
      heartbeatMs: 10,
      lifetimeMs: 80,
      revalidateMs: 20,
    });
    const port = await listen(transport);
    const expiring = await openStream(port);
    await waitFor(() => expiring.chunks.join("").includes(": heartbeat"));
    await waitFor(() => transport.resourceSnapshot().activeStreams === 0);
    expect(registry.activeCount()).toBe(0);

    const drainingTransport = new RealtimeTransport({
      authorizer,
      connectionRegistry: registry,
      expectedOrigin: ORIGIN,
    });
    const drainingPort = await listen(drainingTransport);
    const draining = await openStream(drainingPort);
    await waitFor(() => drainingTransport.resourceSnapshot().activeStreams === 1);
    await drainingTransport.beginDrain();
    await waitFor(() => draining.chunks.join("").includes("event: system.reconnect"));
    expect(drainingTransport.isReady()).toBe(false);
    expect(drainingTransport.resourceSnapshot()).toEqual({
      activeStreams: 0,
      draining: true,
      ownedTimers: 0,
    });
    expect(registry.activeCount()).toBe(0);
    expect((await requestJson(drainingPort)).status).toBe(503);
  });

  it("WP-2227 bounds a hung release, ends the response promptly and shares one failed drain", async () => {
    const metrics: RealtimeMetric[] = [];
    let releaseCalls = 0;
    let rejectRelease: (error: Error) => void = () => undefined;
    const release = new Promise<void>((_resolve, reject) => {
      rejectRelease = reject;
    });
    const transport = transportFor(new MutableAuthorizer(), {
      drainMs: 50,
      metrics: (metric) => metrics.push(metric),
      connectionRegistry: {
        async acquire() {
          return {
            connectionId: "synthetic-hung-lease",
            release: () => {
              releaseCalls += 1;
              return release;
            },
          };
        },
      },
    });
    const port = await listen(transport);
    const stream = await openStream(port);
    const ended = new Promise<void>((resolve) => stream.response.once("end", resolve));
    const drain = transport.beginDrain();
    expect(transport.beginDrain()).toBe(drain);
    const failure = expect(drain).rejects.toThrow("realtime cleanup incomplete");
    expect(transport.isReady()).toBe(false);
    await ended;
    expect(releaseCalls).toBe(1);
    expect((await requestJson(port)).status).toBe(503);
    await failure;
    expect(transport.resourceSnapshot()).toEqual({
      activeStreams: 0,
      draining: true,
      ownedTimers: 0,
    });
    expect(metrics).toContainEqual({
      operation: "lifecycle",
      result: "unavailable",
      sessionKind: "merchant",
    });
    expect(metrics.some((metric) => metric.result === "drained")).toBe(false);
    // Rejection after the deadline is observed; no second release or unhandled rejection.
    rejectRelease(new Error("synthetic late release failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseCalls).toBe(1);
  });

  it.each(["release", "unsubscribe"] as const)(
    "WP-2227 closes on %s failure and reports incomplete cleanup",
    async (failure) => {
      const authorizer = new MutableAuthorizer();
      if (failure === "unsubscribe")
        authorizer.subscribeToScopeChanges = () => () => {
          throw new Error("synthetic unsubscribe failure");
        };
      let releaseCalls = 0;
      const transport = transportFor(authorizer, {
        drainMs: 50,
        connectionRegistry: {
          async acquire() {
            return {
              connectionId: "synthetic-failing-lease",
              release() {
                releaseCalls += 1;
                if (failure === "release") throw new Error("synthetic release failure");
              },
            };
          },
        },
      });
      const port = await listen(transport);
      const stream = await openStream(port);
      const ended = new Promise<void>((resolve) => stream.response.once("end", resolve));
      await expect(transport.beginDrain()).rejects.toThrow("realtime cleanup incomplete");
      await ended;
      expect(releaseCalls).toBe(1);
      expect(transport.resourceSnapshot()).toEqual({
        activeStreams: 0,
        draining: true,
        ownedTimers: 0,
      });
    },
  );

  it("WP-2227 rejects an invalid lease promptly even when its release hangs", async () => {
    let rejectRelease: (error: Error) => void = () => undefined;
    const release = new Promise<void>((_resolve, reject) => {
      rejectRelease = reject;
    });
    const transport = transportFor(new MutableAuthorizer(), {
      drainMs: 5_000,
      connectionRegistry: {
        async acquire() {
          return {
            connectionId: "invalid lease identifier",
            release: () => release,
          };
        },
      },
    });
    const port = await listen(transport);
    expect((await requestJson(port)).status).toBe(503);
    const drain = expect(transport.beginDrain()).rejects.toThrow("realtime cleanup incomplete");
    rejectRelease(new Error("synthetic invalid lease cleanup failure"));
    await drain;
    expect(transport.resourceSnapshot().ownedTimers).toBe(0);
  });

  it("WP-2227 ends the client stream before a delayed successful release completes", async () => {
    let completeRelease: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      completeRelease = resolve;
    });
    const transport = transportFor(new MutableAuthorizer(), {
      drainMs: 5_000,
      connectionRegistry: {
        async acquire() {
          return {
            connectionId: "synthetic-delayed-release",
            release: () => release,
          };
        },
      },
    });
    const stream = await openStream(await listen(transport));
    const ended = new Promise<void>((resolve) => stream.response.once("end", resolve));
    const drain = transport.beginDrain();
    await ended;
    expect(transport.resourceSnapshot()).toEqual({
      activeStreams: 0,
      draining: true,
      ownedTimers: 1,
    });
    completeRelease();
    await drain;
    expect(transport.resourceSnapshot().ownedTimers).toBe(0);
  });

  it("WP-2227 rejects drain bounds above the accepted 25 seconds", () => {
    expect(() => transportFor(new MutableAuthorizer(), { drainMs: 25_001 })).toThrow();
    expect(() => transportFor(new MutableAuthorizer(), { drainMs: 0 })).toThrow();
  });

  it("requires Query refresh for open, hint and reconnect and never replays a Command", () => {
    expect(recoveryActionFor("open")).toEqual({
      reason: "open",
      refreshCanonicalQuery: true,
      replayCommand: false,
    });
    expect(recoveryActionFor("hint")).toEqual({
      reason: "hint",
      refreshCanonicalQuery: true,
      replayCommand: false,
    });
    expect(recoveryActionFor("reconnect")).toEqual({
      reason: "reconnect",
      refreshCanonicalQuery: true,
      replayCommand: false,
    });

    const policy = createReconnectPolicy(() => 0.5);
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(1_500);
    for (let index = 0; index < 20; index += 1) {
      expect(policy.nextDelayMs()).toBeGreaterThanOrEqual(1_000);
      expect(policy.nextDelayMs()).toBeLessThanOrEqual(30_000);
    }
    policy.reset();
    expect(policy.nextDelayMs()).toBe(1_000);
  });
});
