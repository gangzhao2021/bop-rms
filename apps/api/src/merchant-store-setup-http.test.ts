import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import { createStore } from "@bop/tenant";
import {
  createUnconfiguredStoreSetupDraftContent,
  parseStoreSetupDraft,
  parseStoreSetupDraftContent,
  parseStoreSetupCurrent,
  parseStoreSetupOperationReceipt,
  StoreSetupOperationError,
} from "@rms/store";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantStoreSetup } from "./merchant-store-setup.js";

// Real App middleware, localhost HTTP and BFF dispatch. Controlled public host
// responses prove transport behavior, not native IAM, persistence or eligibility.
const id = (n: number) => "01902421-1009-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  cookie = Buffer.alloc(32, 2).toString("base64url"),
  csrf = Buffer.alloc(32, 1).toString("base64url"),
  headerScope = Buffer.from(JSON.stringify(scope)).toString("base64url"),
  headers = {
    Host: "merchant.invalid",
    Origin: "https://merchant.invalid",
    "Sec-Fetch-Site": "same-origin",
    Cookie: "__Host-bop-merchant=" + cookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
    "X-BOP-Store-Setup-Scope": headerScope,
  },
  content = createUnconfiguredStoreSetupDraftContent(),
  command = {
    command: "SaveDraft",
    operationReference: id(7),
    expectedSetupReference: null,
    expectedRevision: 0,
    content,
  },
  digest = "sha256:" + "a".repeat(64),
  resolveCommand = {
    command: "ResolveOriginal",
    operationReference: id(7),
    expectedSetupReference: null,
    expectedRevision: 0,
    intentDigest: digest,
  };
// Actor is a transport scope field, not a StoreSetupDraft field.
const canonicalDraft = parseStoreSetupDraft({
  profile: "StoreSetupDraftV1",
  setupDraftReference: id(8),
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  revision: 1,
  authoredByReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  baseConfigurationReference: null,
  content,
  createdAt: at,
  updatedAt: at,
  purposeCode: "STORE_SETUP_DRAFT",
  dataClassification: "ConfigurationMetadata",
});
const store = createStore({
    storeReference: id(3),
    brandReference: id(2),
    code: "SYNTHETIC_STORE",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  }),
  current = parseStoreSetupCurrent({
    profile: "StoreSetupCurrentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    readerActorReference: id(4),
    snapshot: canonicalDraft,
    observedAt: at,
    validUntil: until,
    businessReferenceValidation: "NotEvaluated",
  }),
  workspace = {
    profile: "StoreSetupWorkspaceV1" as const,
    scope: { ...scope, brandReference: store.brandReference, storeReference: store.storeReference },
    store: {
      storeReference: store.storeReference,
      code: store.code,
      displayName: store.displayName,
      locale: store.locale,
      currencyCode: store.currencyCode,
      timeZone: store.timeZone,
      version: store.version,
    },
    setup: current,
  },
  receipt = parseStoreSetupOperationReceipt({
    profile: "StoreSetupOperationReceiptV1",
    ...scope,
    operationReference: id(7),
    expectedSetupReference: null,
    expectedRevision: 0,
    purposeCode: "STORE_SETUP_DRAFT",
    intentDigest: digest,
    outcome: "Committed",
    snapshot: canonicalDraft,
    auditReference: id(9),
    occurredAt: at,
  }),
  session = createAuthenticationSession({
    sessionReference: id(10),
    actor: createIdentityActor({
      actorType: "User",
      actorReference: id(4),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: "2026-10-05T12:30:00.000Z",
    absoluteExpiresAt: "2026-10-06T00:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
type Port = Pick<ReturnType<typeof createMerchantStoreSetup>, "read" | "write">;
const servers: Server[] = [];
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
function endpoints() {
  return {
    read: vi.fn<Port["read"]>(async () => workspace),
    write: vi.fn<Port["write"]>(async () => receipt),
  };
}
async function serve(port?: Port) {
  const unused = async (): Promise<never> => {
    throw new Error("Unconfigured unrelated transport service");
  };
  const service: MerchantBffService = {
    start: unused,
    callback: unused,
    bootstrap: unused,
    authorize: vi.fn(async () => session),
    logout: unused,
    switchStore: unused,
  };
  const app = createApp({
      merchantBff: {
        service,
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(port ? { storeSetup: port } : {}),
      },
    }),
    server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test listener unavailable");
  return "http://127.0.0.1:" + address.port;
}
async function send(
  root: string,
  {
    method = "POST",
    query = "",
    body = command,
    customHeaders = headers,
    text,
  }: {
    method?: "GET" | "POST";
    query?: string;
    body?: unknown;
    customHeaders?: Readonly<Record<string, string | string[]>>;
    text?: string;
  } = {},
) {
  return new Promise<{ status: number; headers: Headers; body: unknown; raw: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL("/merchant/store-setup" + query, root),
        { method, headers: customHeaders },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.once("error", reject);
          incoming.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8"),
              replyHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              const name = incoming.rawHeaders[i],
                value = incoming.rawHeaders[i + 1];
              if (name !== undefined && value !== undefined) replyHeaders.append(name, value);
            }
            resolve({
              status: incoming.statusCode ?? 0,
              headers: replyHeaders,
              body: JSON.parse(raw),
              raw,
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(method === "GET" ? undefined : (text ?? JSON.stringify(body)));
    },
  );
}
it("reads a real declared Setup workspace using the single expected Store query", async () => {
  const port = endpoints(),
    root = await serve(port),
    reply = await send(root, { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(workspace);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  expect(port.read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
  });
  expect(port.write).not.toHaveBeenCalled();
});
it.each([command, resolveCommand])(
  "dispatches closed original body and exact four-field expected scope",
  async (body) => {
    const port = endpoints(),
      root = await serve(port),
      reply = await send(root, { body });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(receipt);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(port.write).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: cookie,
      csrf,
      command: body,
      expectedScope: scope,
    });
    expect(port.read).not.toHaveBeenCalled();
  },
);
it.each(["GET", "POST"] as const)(
  "returns unavailable when the %s source is unconfigured",
  async (method) => {
    const root = await serve(),
      reply = await send(root, {
        method,
        query: method === "GET" ? "?storeReference=" + id(3) : "",
      });
    expect(reply).toMatchObject({ status: 503, body: { error: "store_setup_unavailable" } });
    expect(reply.headers.get("cache-control")).toBe("no-store");
  },
);
it.each([
  ["STORE_SETUP_OPERATION_INPUT_INVALID", 400, "store_setup_invalid"],
  ["STORE_SETUP_OPERATION_PERMISSION_DENIED", 403, "request_denied"],
  ["STORE_SETUP_OPERATION_VERSION_CONFLICT", 409, "store_setup_conflict"],
  ["STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT", 409, "store_setup_conflict"],
  ["STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE", 503, "store_setup_unavailable"],
] as const)("maps %s without exposing the original error", async (code, status, error) => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new StoreSetupOperationError(code));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({ status, body: { error } });
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("bounds unknown source errors without private body echo", async () => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new Error("Synthetic private credential body"));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({ status: 503, body: { error: "store_setup_unavailable" } });
  expect(reply.raw).not.toContain("credential");
});
it.each([
  "missingScope",
  "duplicateScope",
  "invalidScope",
  "paddedScope",
  "foreignFields",
  "nonUuid",
  "origin",
  "host",
  "cookie",
  "csrf",
  "duplicateCsrf",
  "missingCsrf",
  "query",
])("rejects unsafe %s before the write handler", async (reason) => {
  const port = endpoints(),
    changed: Record<string, string | string[]> = { ...headers };
  let query = "";
  if (reason === "missingScope") delete changed["X-BOP-Store-Setup-Scope"];
  if (reason === "duplicateScope") changed["X-BOP-Store-Setup-Scope"] = [headerScope, headerScope];
  if (reason === "invalidScope") changed["X-BOP-Store-Setup-Scope"] = "invalid";
  if (reason === "paddedScope") changed["X-BOP-Store-Setup-Scope"] = headerScope + "=";
  if (reason === "foreignFields")
    changed["X-BOP-Store-Setup-Scope"] = Buffer.from(
      JSON.stringify({ ...scope, permission: "organization.manage" }),
    ).toString("base64url");
  if (reason === "nonUuid")
    changed["X-BOP-Store-Setup-Scope"] = Buffer.from(
      JSON.stringify({ ...scope, actorReference: "actor" }),
    ).toString("base64url");
  if (reason === "origin") changed.Origin = "https://foreign.invalid";
  if (reason === "host") changed.Host = "foreign.invalid";
  if (reason === "cookie") delete changed.Cookie;
  if (reason === "csrf") changed["X-BOP-CSRF"] = "invalid";
  if (reason === "duplicateCsrf") changed["X-BOP-CSRF"] = [csrf, csrf];
  if (reason === "missingCsrf") delete changed["X-BOP-CSRF"];
  if (reason === "query") query = "?storeReference=" + id(3);
  const reply = await send(await serve(port), { customHeaders: changed, query });
  const invalidScope = [
    "missingScope",
    "invalidScope",
    "paddedScope",
    "foreignFields",
    "nonUuid",
  ].includes(reason);
  expect(reply).toMatchObject({
    status: invalidScope ? 400 : 403,
    body: { error: invalidScope ? "store_setup_invalid" : "request_denied" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it.each([
  "",
  "?storeReference=invalid",
  "?storeReference=" + id(3) + "&storeReference=" + id(3),
  "?storeReference=" + id(3) + "&actorReference=" + id(4),
])("rejects nonclosed current query %s", async (query) => {
  const port = endpoints(),
    reply = await send(await serve(port), { method: "GET", query });
  const invalid = query === "?storeReference=invalid";
  expect(reply).toMatchObject({
    status: invalid ? 400 : 403,
    body: { error: invalid ? "store_setup_invalid" : "request_denied" },
  });
  expect(port.read).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  { ...command, actorReference: id(99) },
  {
    ...command,
    content: { ...content, privateContact: { state: "Configured", value: "Synthetic forbidden" } },
  },
  { ...resolveCommand, content },
  { ...command, expectedRevision: -1 },
  { ...command, command: "Publish" },
])("rejects nonclosed or malformed POST body", async (body) => {
  const port = endpoints(),
    reply = await send(await serve(port), { body });
  expect(reply).toMatchObject({ status: 400, body: { error: "store_setup_invalid" } });
  expect(port.write).not.toHaveBeenCalled();
});
it("rejects malformed JSON without dispatch", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), { text: "{" });
  expect(reply.status).toBe(400);
  expect(port.write).not.toHaveBeenCalled();
});
it.each(["origin", "host", "cookie"])(
  "holds the current read safety boundary for %s",
  async (reason) => {
    const port = endpoints(),
      changed: Record<string, string | string[]> = { ...headers };
    if (reason === "origin") changed.Origin = "https://foreign.invalid";
    if (reason === "host") changed.Host = "foreign.invalid";
    if (reason === "cookie") delete changed.Cookie;
    const reply = await send(await serve(port), {
      method: "GET",
      query: "?storeReference=" + id(3),
      customHeaders: changed,
    });
    expect(reply).toMatchObject({ status: 403, body: { error: "request_denied" } });
    expect(port.read).not.toHaveBeenCalled();
  },
);
it("preserves current source permission refusal as a bounded read error", async () => {
  const port = endpoints();
  port.read.mockRejectedValueOnce(
    new StoreSetupOperationError("STORE_SETUP_OPERATION_PERMISSION_DENIED"),
  );
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply).toMatchObject({ status: 403, body: { error: "request_denied" } });
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("admits a complete valid partial body beyond both 8KiB and the unrelated 64KiB parser", async () => {
  const exceptions = Array.from({ length: 366 }, (_, day) => ({
    localDate: new Date(Date.UTC(2028, 0, day + 1)).toISOString().slice(0, 10),
    kind: "Override",
    intervals: Array.from({ length: 16 }, (_, slot) => ({
      startLocalTime:
        String(Math.floor(slot / 2)).padStart(2, "0") + ":" + (slot % 2 ? "30" : "00") + ":00",
      endLocalTime:
        String(Math.floor((slot + 1) / 2)).padStart(2, "0") +
        ":" +
        ((slot + 1) % 2 ? "30" : "00") +
        ":00",
      endsNextDay: false,
      serviceModes: ["Pickup"],
      orderCutoffSeconds: 0,
      leadTimeSeconds: 0,
    })),
  }));
  const large = {
    ...command,
    content: parseStoreSetupDraftContent({
      ...content,
      exceptions: { state: "Configured", value: exceptions },
    }),
  };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(64 * 1024);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(2 * 1024 * 1024);
  const port = endpoints(),
    reply = await send(await serve(port), { body: large });
  expect(reply.status).toBe(200);
  expect(port.write).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command: large,
    expectedScope: scope,
  });
});
it("rejects a body over the actual two MiB transport budget", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), {
      text: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
    });
  expect(reply.status).toBe(413);
  expect(port.write).not.toHaveBeenCalled();
});
