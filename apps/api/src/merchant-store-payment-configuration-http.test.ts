import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  parseStorePaymentConfigurationVersion,
  parseStorePaymentConfigurationCurrent,
  parseStorePaymentConfigurationReceipt,
  StorePaymentConfigurationError,
} from "@rms/payment";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantStorePaymentConfiguration } from "./merchant-store-payment-configuration.js";

// Real App middleware, localhost HTTP and BFF dispatch. Controlled public host
// responses prove transport behavior, not native IAM, persistence or Provider readiness.
const id = (n: number) => "01902421-1424-7000-8000-" + n.toString(16).padStart(12, "0"),
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
  content = {
    customerOnlineCardEnabled: true,
    staffTerminalCardPresentEnabled: false,
    staffTerminalInteracEnabled: false,
  },
  command = {
    command: "SaveConfiguration",
    operationReference: id(7),
    expectedConfigurationReference: null,
    expectedRevision: 0,
    content,
  },
  digest = "sha256:" + "a".repeat(64),
  resolveCommand = {
    command: "ResolveOriginal",
    operationReference: id(7),
    expectedConfigurationReference: null,
    expectedRevision: 0,
    intentDigest: digest,
  };
const canonicalDraft = parseStorePaymentConfigurationVersion({
  profile: "StorePaymentConfigurationV1",
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  configurationReference: id(8),
  revision: 1,
  authoredByReference: id(4),
  previousConfigurationReference: null,
  content,
  currencyCode: "CAD",
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const workspace = parseStorePaymentConfigurationCurrent({
    profile: "StorePaymentConfigurationCurrentV1",
    ...scope,
    snapshot: canonicalDraft,
    observedAt: at,
    validUntil: until,
    providerReadiness: "NotEvaluated",
  }),
  receipt = parseStorePaymentConfigurationReceipt({
    profile: "StorePaymentConfigurationReceiptV1",
    ...scope,
    operationReference: id(7),
    expectedConfigurationReference: null,
    expectedRevision: 0,
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
type Port = ReturnType<typeof createMerchantStorePaymentConfiguration>;
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
        ...(port ? { storePaymentConfiguration: port } : {}),
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
        new URL("/merchant/store-setup/payment-configuration" + query, root),
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
it("reads a declared Payment configuration current view using the single expected Store query", async () => {
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
    expect(reply).toMatchObject({
      status: 503,
      body: { error: "store_payment_configuration_unavailable" },
    });
    expect(reply.headers.get("cache-control")).toBe("no-store");
  },
);
it.each([
  ["STORE_PAYMENT_CONFIGURATION_INPUT_INVALID", 400, "store_payment_configuration_invalid"],
  ["STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED", 403, "request_denied"],
  ["STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT", 409, "store_payment_configuration_conflict"],
  ["STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT", 409, "store_payment_configuration_conflict"],
  [
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    503,
    "store_payment_configuration_unavailable",
  ],
] as const)("maps %s without exposing the original error", async (code, status, error) => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new StorePaymentConfigurationError(code));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({ status, body: { error } });
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("bounds unknown source errors without private body echo", async () => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new Error("Synthetic private credential body"));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({
    status: 503,
    body: { error: "store_payment_configuration_unavailable" },
  });
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
    body: { error: invalidScope ? "store_payment_configuration_invalid" : "request_denied" },
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
    body: { error: invalid ? "store_payment_configuration_invalid" : "request_denied" },
  });
  expect(port.read).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  { ...command, actorReference: id(99) },
  { ...command, tenantReference: id(99) },
  { ...command, permission: "organization.manage" },
  { ...command, providerReady: true },
  { ...command, content: { ...content, customerOnlineCardEnabled: null } },
  { ...command, content: { ...content, staffTerminalCardPresentEnabled: "false" } },
  { ...command, content: { ...content, cashEnabled: true } },
  {
    ...command,
    content: { ...content, providerCredential: "Synthetic forbidden" },
  },
  { ...resolveCommand, content },
  { ...command, expectedRevision: -1 },
  { ...command, command: "Publish" },
])("rejects nonclosed or malformed POST body", async (body) => {
  const port = endpoints(),
    reply = await send(await serve(port), { body });
  expect(reply).toMatchObject({
    status: 400,
    body: { error: "store_payment_configuration_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
  expect(reply.raw).not.toContain("Synthetic forbidden");
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
    new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED"),
  );
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply).toMatchObject({ status: 403, body: { error: "request_denied" } });
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("rejects a body over the actual 32KiB transport budget", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), {
      text: JSON.stringify({ padding: "x".repeat(32 * 1024) }),
    });
  expect(reply.status).toBe(413);
  expect(port.write).not.toHaveBeenCalled();
});

it("keeps genuine absence explicit without Provider readiness inference", async () => {
  const port = endpoints(),
    empty = parseStorePaymentConfigurationCurrent({
      ...workspace,
      snapshot: null,
    });
  port.read.mockResolvedValueOnce(empty);
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(empty);
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("allows historical writer identity to differ from the current reader", async () => {
  const port = endpoints(),
    historical = parseStorePaymentConfigurationCurrent({
      ...workspace,
      snapshot: { ...canonicalDraft, authoredByReference: id(11) },
    });
  port.read.mockResolvedValueOnce(historical);
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(historical);
  expect(port.read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
  });
});
it("returns the actual original Abandoned result through ResolveOriginal", async () => {
  const port = endpoints(),
    abandoned = parseStorePaymentConfigurationReceipt({
      ...receipt,
      outcome: "Abandoned",
      snapshot: null,
    });
  port.write.mockResolvedValueOnce(abandoned);
  const reply = await send(await serve(port), { body: resolveCommand });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(abandoned);
  expect(port.write).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command: resolveCommand,
    expectedScope: scope,
  });
});
it("accepts explicit all-false disabled rules without manufacturing a ready state", async () => {
  const port = endpoints(),
    disabledContent = {
      customerOnlineCardEnabled: false,
      staffTerminalCardPresentEnabled: false,
      staffTerminalInteracEnabled: false,
    },
    disabledReceipt = parseStorePaymentConfigurationReceipt({
      ...receipt,
      snapshot: { ...canonicalDraft, content: disabledContent },
    }),
    body = { ...command, content: disabledContent };
  port.write.mockResolvedValueOnce(disabledReceipt);
  const reply = await send(await serve(port), { body });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(disabledReceipt);
  expect(port.write).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command: body,
    expectedScope: scope,
  });
});
