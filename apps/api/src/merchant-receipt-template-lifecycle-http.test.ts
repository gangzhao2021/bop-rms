import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  parseDigitalReceiptTemplateLifecycleReceipt,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantReceiptTemplateLifecycle } from "./merchant-receipt-template-lifecycle.js";
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
const command = () => ({
  command: "Approve",
  operationReference: id(7),
  templateReference: id(13),
  expectedVersionReference: id(14),
  expectedRevision: 1,
  reviewLifecycleReference: id(21),
  expectedReviewVersion: 2,
  expectedReviewOperationReference: id(25),
});
const resolveCommand = {
  ...command(),
  command: "ResolveOriginal",
  action: "Approve",
  intentDigest: digest,
};
const receipt = () =>
  parseDigitalReceiptTemplateLifecycleReceipt({
    profile: "DigitalReceiptTemplateLifecycleReceiptV1",
    ...scope,
    action: "Approve",
    operationReference: id(7),
    templateReference: id(13),
    expectedVersionReference: id(14),
    expectedRevision: 1,
    reviewLifecycleReference: id(21),
    expectedReviewVersion: 2,
    expectedReviewOperationReference: id(25),
    intentDigest: digest,
    outcome: "Committed",
    result: {
      lifecycleReference: id(21),
      lifecycleVersion: 3,
      state: "Approved",
      mutationOperationReference: id(7),
      changedAt: at,
      approvalEvidenceReference: id(22),
      approvedByReference: id(4),
      approvedAt: at,
      approvalValidUntil: "2026-10-05T13:00:00.000Z",
      publishedVersion: null,
    },
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
type Port = ReturnType<typeof createMerchantReceiptTemplateLifecycle>;
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
  return { write: vi.fn<Port["write"]>(async () => receipt()) };
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
        ...(port ? { receiptTemplateLifecycle: port } : {}),
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
        new URL("/merchant/store-setup/receipt-template-lifecycle" + query, root),
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
it("forwards the eight-field Approve with exact actual scope and no Store-ready ID substitution", async () => {
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
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  expect(receipt().result?.approvedByReference).toBe(scope.actorReference);
});
it("forwards the exact ten-field original Resolve without qualifications and preserves Abandoned", async () => {
  const port = endpoints(),
    abandoned = parseDigitalReceiptTemplateLifecycleReceipt({
      ...receipt(),
      outcome: "Abandoned",
      result: null,
    });
  port.write.mockResolvedValueOnce(abandoned);
  const reply = await send(await serve(port), { body: resolveCommand });
  expect(reply).toMatchObject({ status: 200, body: abandoned });
  expect(port.write).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command: resolveCommand,
    expectedScope: scope,
  });
});
it("refuses an unconfigured genuine port", async () => {
  expect(await send(await serve())).toMatchObject({
    status: 503,
    body: { error: "receipt_template_lifecycle_unavailable" },
  });
});
it.each([
  ["RECEIPT_TEMPLATE_INPUT_INVALID", 400, "receipt_template_lifecycle_invalid"],
  ["RECEIPT_TEMPLATE_PERMISSION_DENIED", 403, "request_denied"],
  ["RECEIPT_TEMPLATE_CONFLICT", 409, "receipt_template_lifecycle_conflict"],
  ["RECEIPT_TEMPLATE_UNAVAILABLE", 503, "receipt_template_lifecycle_unavailable"],
] as const)("preserves finite owner code %s without payload echo", async (code, status, error) => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new DigitalReceiptTemplateError(code));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({ status, body: { error } });
  expect(reply.raw).not.toContain(id(7));
  expect(reply.raw).not.toContain(code);
});
it("sanitizes arbitrary private errors", async () => {
  const port = endpoints();
  port.write.mockRejectedValueOnce(new Error("private-token-material"));
  const reply = await send(await serve(port));
  expect(reply).toMatchObject({
    status: 503,
    body: { error: "receipt_template_lifecycle_unavailable" },
  });
  expect(reply.raw).not.toContain("private-token");
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
    body: { error: invalidScope ? "receipt_template_lifecycle_invalid" : "request_denied" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  {},
  { ...command(), actorReference: id(20) },
  { ...command(), templateReference: null },
  { ...command(), expectedVersionReference: null },
  { ...command(), expectedRevision: 0 },
  { ...command(), expectedRevision: 1.5 },
  { ...command(), operationReference: "invalid" },
  { ...command(), validationValidUntil: until },
  { ...command(), approvalValidUntil: until },
  { ...command(), validationEvidenceReference: id(22) },
  { ...command(), reviewLifecycleReference: "invalid" },
  { ...command(), reviewVersion: 2 },
  { ...command(), approvalEvidence: receipt().result },
  { ...command(), purposeCode: "RECEIPT_TEMPLATE_REVIEW" },
  { ...command(), command: "SubmitReview" },
  { ...resolveCommand, intentDigest: "invalid" },
  { ...resolveCommand, content: { ready: true } },
])("rejects injected qualification or malformed closed lifecycle/Resolve body %j", async (body) => {
  const port = endpoints();
  expect(await send(await serve(port), { body })).toMatchObject({
    status: 400,
    body: { error: "receipt_template_lifecycle_invalid" },
  });
  expect(port.write).not.toHaveBeenCalled();
});
it("uses the dedicated 32KiB parser, rejects malformed JSON and oversized requests", async () => {
  const port = endpoints(),
    root = await serve(port);
  expect(await send(root, { text: "{broken" })).toMatchObject({
    status: 400,
    body: { error: "receipt_template_lifecycle_invalid" },
  });
  expect(
    await send(root, { text: JSON.stringify({ ...command(), private: "x".repeat(32768) }) }),
  ).toMatchObject({ status: 413, body: { error: "receipt_template_lifecycle_invalid" } });
  expect(port.write).not.toHaveBeenCalled();
});
