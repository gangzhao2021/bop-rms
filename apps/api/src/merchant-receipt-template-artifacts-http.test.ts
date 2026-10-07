import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactCurrent,
  parseDigitalReceiptTemplateArtifactReceipt,
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
  type DigitalReceiptTemplateArtifactKind,
} from "@rms/printing-device";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantReceiptTemplateArtifacts } from "./merchant-receipt-template-artifacts.js";

// Real App middleware, localhost HTTP and BFF dispatch. Controlled public host
// responses prove transport behavior, not native IAM, persistence or professional review.
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
  layout = {
    profile: "AccessibleDigitalReceiptLayoutV1",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    requiredFields: [...digitalReceiptRequiredFields],
  },
  compliance = {
    profile: "DigitalReceiptRequiredFieldRuleV1",
    dataContractVersion: 1,
    requiredFields: [...digitalReceiptRequiredFields],
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  },
  digest = "sha256:" + "a".repeat(64);
const command = (kind: DigitalReceiptTemplateArtifactKind = "Layout") => ({
  command: "SaveArtifact",
  operationReference: id(7),
  expectedArtifactReference: null,
  expectedRevision: 0,
  content: kind === "Layout" ? layout : compliance,
});
const resolveCommand = {
  command: "ResolveOriginal",
  operationReference: id(7),
  expectedArtifactReference: null,
  expectedRevision: 0,
  intentDigest: digest,
};
const canonicalDraft = (kind: DigitalReceiptTemplateArtifactKind = "Layout") =>
  parseDigitalReceiptTemplateArtifactVersion({
    profile: "DigitalReceiptTemplateArtifactV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    artifactKind: kind,
    artifactReference: kind === "Layout" ? id(8) : id(18),
    revision: 1,
    authoredByReference: scope.actorReference,
    previousArtifactReference: null,
    content: kind === "Layout" ? layout : compliance,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  });
const workspace = parseDigitalReceiptTemplateArtifactCurrent({
  profile: "DigitalReceiptTemplateArtifactsCurrentV1",
  ...scope,
  layout: canonicalDraft(),
  compliance: canonicalDraft("Compliance"),
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const receipt = (kind: DigitalReceiptTemplateArtifactKind = "Layout") =>
  parseDigitalReceiptTemplateArtifactReceipt({
    profile: "DigitalReceiptTemplateArtifactReceiptV1",
    ...scope,
    artifactKind: kind,
    operationReference: id(7),
    expectedArtifactReference: null,
    expectedRevision: 0,
    intentDigest: digest,
    outcome: "Committed",
    snapshot: canonicalDraft(kind),
    auditReference: id(9),
    occurredAt: at,
  });
const session = createAuthenticationSession({
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
type Port = ReturnType<typeof createMerchantReceiptTemplateArtifacts>;
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
    write: vi.fn<Port["write"]>(async () => receipt()),
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
        ...(port ? { receiptTemplateArtifacts: port } : {}),
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
    body = command(),
    kind = "layout",
    customHeaders = headers,
    text,
  }: {
    method?: "GET" | "POST";
    query?: string;
    body?: unknown;
    customHeaders?: Readonly<Record<string, string | string[]>>;
    text?: string;
    kind?: string;
  } = {},
) {
  return new Promise<{ status: number; headers: Headers; body: unknown; raw: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL(
          "/merchant/store-setup/receipt-artifacts" + (method === "POST" ? "/" + kind : "") + query,
          root,
        ),
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
it("reads both actual software artifact versions through the one selected-Store current query", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
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
it.each(["Layout", "Compliance"] as const)(
  "dispatches closed %s Save with actual scope header, CSRF and exact kind",
  async (artifactKind) => {
    const port = endpoints();
    port.write.mockResolvedValueOnce(receipt(artifactKind));
    const body = command(artifactKind),
      reply = await send(await serve(port), { kind: artifactKind.toLowerCase(), body });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(receipt(artifactKind));
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(port.write).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: cookie,
      csrf,
      command: body,
      expectedScope: scope,
      artifactKind,
    });
    expect(port.read).not.toHaveBeenCalled();
  },
);
it.each(["Layout", "Compliance"] as const)(
  "dispatches payload-free %s Resolve and returns the actual Abandoned result",
  async (artifactKind) => {
    const port = endpoints(),
      abandoned = parseDigitalReceiptTemplateArtifactReceipt({
        ...receipt(artifactKind),
        outcome: "Abandoned",
        snapshot: null,
      });
    port.write.mockResolvedValueOnce(abandoned);
    const reply = await send(await serve(port), {
      kind: artifactKind.toLowerCase(),
      body: resolveCommand,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(abandoned);
    expect(port.write).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: cookie,
      csrf,
      command: resolveCommand,
      expectedScope: scope,
      artifactKind,
    });
  },
);
it.each(["GET", "POST"] as const)("unconfigured %s source stays unavailable", async (method) => {
  const reply = await send(await serve(), {
    method,
    query: method === "GET" ? "?storeReference=" + id(3) : "",
  });
  expect(reply).toMatchObject({
    status: 503,
    body: { error: "receipt_template_artifact_unavailable" },
  });
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it.each([
  ["RECEIPT_TEMPLATE_INPUT_INVALID", 400, "receipt_template_artifact_invalid"],
  ["RECEIPT_TEMPLATE_PERMISSION_DENIED", 403, "request_denied"],
  ["RECEIPT_TEMPLATE_CONFLICT", 409, "receipt_template_artifact_conflict"],
  ["RECEIPT_TEMPLATE_UNAVAILABLE", 503, "receipt_template_artifact_unavailable"],
] as const)(
  "maps canonical Device %s without raw error or request echo",
  async (code, status, error) => {
    const port = endpoints();
    port.write.mockRejectedValueOnce(new DigitalReceiptTemplateError(code));
    const reply = await send(await serve(port));
    expect(reply).toMatchObject({ status, body: { error } });
    expect(reply.raw).not.toContain(code);
    expect(reply.raw).not.toContain(id(7));
    expect(reply.headers.get("cache-control")).toBe("no-store");
  },
);
it("bounds unknown source cause without private information", async () => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new Error("Synthetic private credential"));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({
    status: 503,
    body: { error: "receipt_template_artifact_unavailable" },
  });
  expect(reply.raw).not.toContain("credential");
});
it.each(["printer", "Layout", "COMPLIANCE", "unknown"])(
  "rejects noncanonical URL kind %s without dispatch",
  async (kind) => {
    const port = endpoints(),
      reply = await send(await serve(port), { kind });
    expect(reply).toMatchObject({
      status: 400,
      body: { error: "receipt_template_artifact_invalid" },
    });
    expect(port.write).not.toHaveBeenCalled();
  },
);
it("rejects Layout content on a Compliance route", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), { kind: "compliance", body: command() });
  expect(reply).toMatchObject({
    status: 400,
    body: { error: "receipt_template_artifact_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
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
])("rejects unsafe %s before write dispatch", async (reason) => {
  const port = endpoints(),
    changed: Record<string, string | string[]> = { ...headers };
  let query = "";
  if (reason === "missingScope") delete changed["X-BOP-Store-Setup-Scope"];
  if (reason === "duplicateScope") changed["X-BOP-Store-Setup-Scope"] = [headerScope, headerScope];
  if (reason === "invalidScope") changed["X-BOP-Store-Setup-Scope"] = "invalid";
  if (reason === "paddedScope") changed["X-BOP-Store-Setup-Scope"] = headerScope + "=";
  if (reason === "foreignFields")
    changed["X-BOP-Store-Setup-Scope"] = Buffer.from(
      JSON.stringify({ ...scope, permission: "integration.manage" }),
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
  const reply = await send(await serve(port), { customHeaders: changed, query }),
    invalidScope = [
      "missingScope",
      "invalidScope",
      "paddedScope",
      "foreignFields",
      "nonUuid",
    ].includes(reason);
  expect(reply).toMatchObject({
    status: invalidScope ? 400 : 403,
    body: { error: invalidScope ? "receipt_template_artifact_invalid" : "request_denied" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it.each([
  "",
  "?storeReference=invalid",
  "?storeReference=" + id(3) + "&storeReference=" + id(3),
  "?storeReference=" + id(3) + "&actorReference=" + id(4),
])("rejects nonclosed GET query %s", async (query) => {
  const port = endpoints(),
    reply = await send(await serve(port), { method: "GET", query });
  const invalid = query === "?storeReference=invalid";
  expect(reply).toMatchObject({
    status: invalid ? 400 : 403,
    body: { error: invalid ? "receipt_template_artifact_invalid" : "request_denied" },
  });
  expect(port.read).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  { ...command(), actorReference: id(99) },
  { ...command(), tenantReference: id(99) },
  { ...command(), artifactKind: "Layout" },
  { ...command(), permission: "integration.manage" },
  { ...command(), content: { ...layout, html: "Synthetic forbidden" } },
  { ...command(), content: { ...layout, renderEngineVersion: 2 } },
  {
    ...command(),
    content: { ...layout, requiredFields: [...digitalReceiptRequiredFields].reverse() },
  },
  { ...resolveCommand, content: layout },
  { ...command(), expectedRevision: -1 },
  { ...command(), command: "Publish" },
])("rejects open or malformed POST body without echo or handler execution", async (body) => {
  const port = endpoints(),
    reply = await send(await serve(port), { body });
  expect(reply).toMatchObject({
    status: 400,
    body: { error: "receipt_template_artifact_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
  expect(reply.raw).not.toContain("Synthetic forbidden");
});
it("does not accept professional review approval as software artifact content", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), {
      kind: "compliance",
      body: {
        ...command("Compliance"),
        content: { ...compliance, professionalReviewStatus: "Approved" },
      },
    });
  expect(reply).toMatchObject({
    status: 400,
    body: { error: "receipt_template_artifact_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it("rejects malformed JSON before dispatch", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), { text: "{" });
  expect(reply.status).toBe(400);
  expect(port.write).not.toHaveBeenCalled();
});
it("enforces actual 32KiB body budget", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), {
      text: JSON.stringify({ padding: "x".repeat(32 * 1024) }),
    });
  expect(reply.status).toBe(413);
  expect(port.write).not.toHaveBeenCalled();
});
it.each(["origin", "host", "cookie"])("holds GET safety boundary for %s", async (reason) => {
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
});
it("preserves current PermissionDenied without pretending absence", async () => {
  const port = endpoints();
  port.read.mockRejectedValueOnce(
    new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED"),
  );
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply).toMatchObject({ status: 403, body: { error: "request_denied" } });
});
it("returns genuine absence with NotEvaluated qualification", async () => {
  const port = endpoints(),
    empty = parseDigitalReceiptTemplateArtifactCurrent({
      ...workspace,
      layout: null,
      compliance: null,
    });
  port.read.mockResolvedValueOnce(empty);
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(empty);
});
it("retains historical author independent of current reader", async () => {
  const port = endpoints(),
    historical = parseDigitalReceiptTemplateArtifactCurrent({
      ...workspace,
      layout: { ...canonicalDraft(), authoredByReference: id(11) },
    });
  port.read.mockResolvedValueOnce(historical);
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(historical);
});
