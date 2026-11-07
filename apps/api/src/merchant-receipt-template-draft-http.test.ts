import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftRoster,
  parseDigitalReceiptTemplateDraftReceipt,
  createDigitalReceiptTemplateDraftContent,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantReceiptTemplateDraft } from "./merchant-receipt-template-draft.js";
// Actual Express App/localhost HTTP; controlled typed service output, not native IAM or persistence.
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
  digest = "sha256:" + "a".repeat(64);
const fields = () => ({
  locale: "en-CA",
  layoutDefinitionReference: id(15),
  complianceRuleReference: id(16),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
const command = () => ({
  command: "SaveDraft",
  operationReference: id(7),
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  fields: fields(),
});
const resolveCommand = {
  command: "ResolveOriginal",
  operationReference: id(7),
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  intentDigest: digest,
};
const canonicalDraft = () =>
  parseDigitalReceiptTemplateDraft({
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(12),
    revision: 1,
    authoredByReference: id(4),
    previousVersionReference: null,
    content: createDigitalReceiptTemplateDraftContent({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(13),
      versionReference: id(14),
      versionNumber: 1,
      fields: fields(),
    }),
    contentDigest: digest,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  });
const workspace = parseDigitalReceiptTemplateDraftCurrent({
  profile: "DigitalReceiptTemplateDraftCurrentV1",
  ...scope,
  templateReference: null,
  snapshot: null,
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const receipt = () =>
  parseDigitalReceiptTemplateDraftReceipt({
    profile: "DigitalReceiptTemplateDraftReceiptV1",
    ...scope,
    operationReference: id(7),
    templateReference: null,
    expectedVersionReference: null,
    expectedRevision: 0,
    intentDigest: digest,
    outcome: "Committed",
    snapshot: canonicalDraft(),
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
type Port = ReturnType<typeof createMerchantReceiptTemplateDraft>;
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
    list: vi.fn<Port["list"]>(async () =>
      parseDigitalReceiptTemplateDraftRoster({
        profile: "DigitalReceiptTemplateDraftRosterV1",
        ...scope,
        afterTemplate: null,
        entries: [canonicalDraft()],
        nextAfter: null,
        observedAt: at,
        validUntil: until,
        sourceQualification: "NotEvaluated",
      }),
    ),
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
        ...(port ? { receiptTemplateDraft: port } : {}),
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
    roster = false,
    query = "",
    body = command(),
    customHeaders = headers,
    text,
  }: {
    method?: "GET" | "POST";
    roster?: boolean;
    query?: string;
    body?: unknown;
    customHeaders?: Readonly<Record<string, string | string[]>>;
    text?: string;
  } = {},
) {
  return new Promise<{ status: number; headers: Headers; body: unknown; raw: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL("/merchant/store-setup/receipt-template-draft" + (roster ? "s" : "") + query, root),
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
it("reads an explicitly unselected template as null without guessing a template", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(workspace);
  expect(port.read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
    templateReference: null,
  });
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  expect(port.write).not.toHaveBeenCalled();
});
it("reads only the exact selected template and preserves historical author", async () => {
  const port = endpoints(),
    view = parseDigitalReceiptTemplateDraftCurrent({
      ...workspace,
      actorReference: id(4),
      templateReference: id(13),
      snapshot: { ...canonicalDraft(), authoredByReference: id(20) },
    });
  port.read.mockResolvedValueOnce(view);
  const reply = await send(await serve(port), {
    method: "GET",
    query: "?storeReference=" + id(3) + "&templateReference=" + id(13),
  });
  expect(reply.body).toEqual(view);
  expect(port.read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
    templateReference: id(13),
  });
});
it("dispatches a closed six-field SaveDraft with real scope header and CSRF", async () => {
  const port = endpoints(),
    body = command(),
    reply = await send(await serve(port), { body });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(receipt());
  expect(port.write).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command: body,
    expectedScope: scope,
  });
});
it("dispatches payload-free original Resolve and returns genuine Abandoned", async () => {
  const port = endpoints(),
    abandoned = parseDigitalReceiptTemplateDraftReceipt({
      ...receipt(),
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
it.each(["GET", "POST"] as const)("unconfigured %s remains unavailable", async (method) => {
  expect(
    await send(await serve(), {
      method,
      query: method === "GET" ? "?storeReference=" + id(3) : "",
    }),
  ).toMatchObject({ status: 503, body: { error: "receipt_template_draft_unavailable" } });
});
it.each([
  ["RECEIPT_TEMPLATE_INPUT_INVALID", 400, "receipt_template_draft_invalid"],
  ["RECEIPT_TEMPLATE_PERMISSION_DENIED", 403, "request_denied"],
  ["RECEIPT_TEMPLATE_CONFLICT", 409, "receipt_template_draft_conflict"],
  ["RECEIPT_TEMPLATE_UNAVAILABLE", 503, "receipt_template_draft_unavailable"],
] as const)("maps exact Device code %s without echo", async (code, status, error) => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new DigitalReceiptTemplateError(code));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({ status, body: { error } });
  expect(reply.raw).not.toContain(code);
  expect(reply.raw).not.toContain(id(7));
});
it("normalizes unknown service errors without private cause", async () => {
  const port = endpoints();
  port.read.mockRejectedValueOnce(new Error("private credential"));
  const reply = await send(await serve(port), { method: "GET", query: "?storeReference=" + id(3) });
  expect(reply).toMatchObject({
    status: 503,
    body: { error: "receipt_template_draft_unavailable" },
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
    body: { error: invalidScope ? "receipt_template_draft_invalid" : "request_denied" },
  });
  expect(port.write).not.toHaveBeenCalled();
});

it.each([
  "",
  "?storeReference=" + id(3) + "&extra=1",
  "?storeReference=" + id(3) + "&storeReference=" + id(3),
  "?storeReference=" + id(3) + "&templateReference=" + id(13) + "&templateReference=" + id(13),
  "?storeReference=" + id(3) + "&templateReference[extra]=1",
])("rejects nonclosed or repeated GET %s", async (query) => {
  const port = endpoints();
  expect(await send(await serve(port), { method: "GET", query })).toMatchObject({
    status: 403,
    body: { error: "request_denied" },
  });
  expect(port.read).not.toHaveBeenCalled();
});
it.each([
  "?storeReference=invalid",
  "?storeReference=" + id(3) + "&templateReference=invalid",
  "?storeReference=" + id(3) + "&templateReference=",
])("rejects malformed reference GET %s", async (query) => {
  const port = endpoints();
  expect(await send(await serve(port), { method: "GET", query })).toMatchObject({
    status: 400,
    body: { error: "receipt_template_draft_invalid" },
  });
  expect(port.read).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  {},
  { ...command(), actorReference: id(20) },
  { ...command(), templateReference: id(13) },
  { ...command(), expectedRevision: 1 },
  { ...command(), fields: { ...fields(), versionReference: id(14) } },
  { ...command(), fields: { ...fields(), activation: { mode: "Immediate", effectiveFrom: at } } },
  { ...command(), command: "Publish" },
  { ...resolveCommand, fields: fields() },
  { ...resolveCommand, intentDigest: "invalid" },
])("refuses malformed six-field body %j before dispatch", async (body) => {
  const port = endpoints();
  expect(await send(await serve(port), { body })).toMatchObject({
    status: 400,
    body: { error: "receipt_template_draft_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it("rejects malformed JSON and over-32KiB bodies with dedicated wire code", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(await send(root, { text: "{broken" })).toMatchObject({
    status: 400,
    body: { error: "receipt_template_draft_invalid" },
  });
  expect(
    await send(root, { text: JSON.stringify({ ...command(), extra: "x".repeat(33000) }) }),
  ).toMatchObject({ status: 413, body: { error: "receipt_template_draft_invalid" } });
  expect(port.write).not.toHaveBeenCalled();
});
it.each(["origin", "host", "cookie", "site"])("protects GET %s", async (reason) => {
  const port = endpoints(),
    changed: Record<string, string | string[]> = { ...headers };
  if (reason === "origin") changed.Origin = "https://foreign.invalid";
  if (reason === "host") changed.Host = "foreign.invalid";
  if (reason === "cookie") delete changed.Cookie;
  if (reason === "site") changed["Sec-Fetch-Site"] = "cross-site";
  expect(
    await send(await serve(port), {
      method: "GET",
      query: "?storeReference=" + id(3),
      customHeaders: changed,
    }),
  ).toMatchObject({ status: 403, body: { error: "request_denied" } });
  expect(port.read).not.toHaveBeenCalled();
});

it("lists real current Draft heads through the plural roster route, omitting cursor means null", async () => {
  const port = endpoints(),
    reply = await send(await serve(port), {
      method: "GET",
      roster: true,
      query: "?storeReference=" + id(3),
    });
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    profile: "DigitalReceiptTemplateDraftRosterV1",
    afterTemplate: null,
    entries: [canonicalDraft()],
  });
  expect(port.list).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
    afterTemplate: null,
  });
  expect(port.read).not.toHaveBeenCalled();
  expect(port.write).not.toHaveBeenCalled();
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("roster passes exact afterTemplate and original scope Store", async () => {
  const port = endpoints();
  port.list.mockResolvedValueOnce(
    parseDigitalReceiptTemplateDraftRoster({
      profile: "DigitalReceiptTemplateDraftRosterV1",
      ...scope,
      afterTemplate: id(13),
      entries: [],
      nextAfter: null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    }),
  );
  expect(
    (
      await send(await serve(port), {
        method: "GET",
        roster: true,
        query: "?storeReference=" + id(3) + "&afterTemplate=" + id(13),
      })
    ).status,
  ).toBe(200);
  expect(port.list).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
    afterTemplate: id(13),
  });
});
it.each([
  "",
  "?storeReference=" + id(3) + "&templateReference=" + id(13),
  "?storeReference=" + id(3) + "&afterTemplate=" + id(13) + "&afterTemplate=" + id(13),
  "?storeReference=" + id(3) + "&limit=20",
])("roster rejects nonclosed query %s", async (query) => {
  const port = endpoints();
  expect(await send(await serve(port), { method: "GET", roster: true, query })).toMatchObject({
    status: 403,
    body: { error: "request_denied" },
  });
  expect(port.list).not.toHaveBeenCalled();
});
it("roster rejects malformed cursor before source and unconfigured source remains503", async () => {
  const port = endpoints();
  expect(
    await send(await serve(port), {
      method: "GET",
      roster: true,
      query: "?storeReference=" + id(3) + "&afterTemplate=invalid",
    }),
  ).toMatchObject({ status: 400, body: { error: "receipt_template_draft_invalid" } });
  expect(port.list).not.toHaveBeenCalled();
  expect(
    await send(await serve(), { method: "GET", roster: true, query: "?storeReference=" + id(3) }),
  ).toMatchObject({ status: 503, body: { error: "receipt_template_draft_unavailable" } });
});
