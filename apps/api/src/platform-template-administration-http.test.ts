import { Buffer } from "node:buffer";
import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSessionError, platformSessionCookie } from "@bop/identity";
import { PlatformPermissionError } from "@bop/permission";
import { PublishingContractError } from "@bop/publishing";
import { PlatformBrandTemplateError } from "@bop/tenant";
import {
  createPlatformTemplateAdministrationRouter,
  platformTemplateAdministrationRoutes,
  type PlatformTemplateAdministrationHttpOptions,
} from "./platform-template-administration-http.js";

// Real HTTP and actual request parsers; controlled administration results are
// transport evidence only. The ordinary composition and PostgreSQL gate own
// actual Session, permission, content and publication evidence.
const id = (n: number) => `01902627-0011-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const credential = Buffer.alloc(32, 2).toString("base64url"),
  csrf = Buffer.alloc(32, 3).toString("base64url");
const content = {
  code: "SYNTHETIC_BASE",
  name: "Synthetic template",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  overrideAllowedFieldCodes: ["DISPLAY_NAME"],
  hardRequirementFieldCodes: ["TIME_ZONE"],
  effectiveFrom: "2026-10-06T12:00:00.000Z",
  effectiveUntil: null,
  reasonCode: "SYNTHETIC_SETUP",
};
const list = { action: "List", after: null, limit: 20 };
const queries = [
  { action: "Actions" },
  list,
  { action: "List", after: { code: "SYNTHETIC_BASE", templateReference: id(1) }, limit: 1 },
  { action: "Current", templateReference: id(1) },
  { action: "Exact", templateVersionReference: id(2) },
  { action: "History", templateReference: id(1), beforeRevision: null },
  { action: "History", templateReference: id(1), beforeRevision: 3 },
  { action: "PublicationCurrent", templateReference: id(1), lifecycleReference: null },
  { action: "PublicationCurrent", templateReference: id(1), lifecycleReference: id(3) },
  { action: "PublicationExact", templateReference: id(1), sequence: 2 },
  { action: "PublicationHistory", templateReference: id(1), beforeSequence: null },
  { action: "PublicationHistory", templateReference: id(1), beforeSequence: 3 },
];
const save = {
  action: "Save",
  operationReference: id(4),
  templateReference: null,
  expectedHead: null,
  content,
};
const publication = {
  action: "Publication",
  request: {
    profile: "PlatformPublishingRequestV1",
    operation: "CreateDraft",
    operationReference: id(5),
    templateReference: id(1),
    templateVersionReference: id(2),
    contentDigest: digest,
    templateSourceDigest: digest,
    expectedLifecycle: null,
    reviewValidUntil: null,
    reasonCode: "SYNTHETIC_REVIEW",
  },
};
const commands = [
  save,
  {
    ...save,
    templateReference: id(1),
    expectedHead: { revision: 2, templateVersionReference: id(2), sourceDigest: digest },
  },
  { action: "ResolveSave", operationReference: id(4), intentDigest: digest },
  publication,
  ...["SubmitReview", "Approve", "Publish", "Archive"].map((operation) => ({
    ...publication,
    request: {
      ...publication.request,
      operation,
      expectedLifecycle: { lifecycleReference: id(3), version: 2, sourceDigest: digest },
      reviewValidUntil: operation === "SubmitReview" ? "2026-10-07T12:00:00.000Z" : null,
    },
  })),
  { action: "ResolvePublication", operationReference: id(5), intentDigest: digest },
];
const output = Object.freeze({ controlledTransportResult: true });
function fixture() {
  const administration = {
    query: vi.fn(async (): Promise<unknown> => output),
    command: vi.fn(async (): Promise<unknown> => output),
  };
  const options: PlatformTemplateAdministrationHttpOptions = {
    exactOrigin: "https://platform.invalid",
    acceptedHost: "platform.invalid",
    administration,
  };
  return { administration, options };
}
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
async function serve(options: PlatformTemplateAdministrationHttpOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use("/platform/templates", createPlatformTemplateAdministrationRouter(options));
  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic listener absent");
  return `http://127.0.0.1:${address.port}`;
}
interface RequestOptions {
  prefix?: string;
  method?: string;
  body?: string;
  headers?: readonly (readonly [string, string])[];
  omit?: readonly string[];
}
async function send(root: string, path: string, options: RequestOptions = {}) {
  const overrides = options.headers ?? [],
    names = new Set(overrides.map(([name]) => name.toLowerCase()));
  const base: [string, string][] = [
    ["Host", "platform.invalid"],
    ["Origin", "https://platform.invalid"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Sec-Fetch-Mode", "cors"],
    ["Sec-Fetch-Dest", "empty"],
    ["Cookie", `${platformSessionCookie.name}=${credential}`],
    ["X-Bop-CSRF", csrf],
    ["Content-Type", "application/json"],
  ];
  if (options.body !== undefined)
    base.push(["Content-Length", String(Buffer.byteLength(options.body))]);
  const headers = [
    ...base.filter(
      ([name]) => !names.has(name.toLowerCase()) && !options.omit?.includes(name.toLowerCase()),
    ),
    ...overrides,
  ].flat();
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown; text: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        `${root}${options.prefix ?? "/platform/templates"}${path}`,
        { method: options.method ?? "POST", headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text });
          });
        },
      );
      request.on("error", reject);
      request.end(options.body);
    },
  );
}

it("dispatches every closed public query and command with only the dedicated Session cookie and CSRF", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const request of queries) {
    const response = await send(root, "/query", { body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(output);
    expect(f.administration.query).toHaveBeenLastCalledWith({
      sessionCookie: credential,
      csrf,
      request,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toContain(credential);
    expect(response.text).not.toContain(csrf);
  }
  for (const request of commands) {
    const response = await send(root, "/command", { body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(output);
    expect(f.administration.command).toHaveBeenLastCalledWith({
      sessionCookie: credential,
      csrf,
      request,
    });
  }
  expect(f.administration.query).toHaveBeenCalledTimes(queries.length);
  expect(f.administration.command).toHaveBeenCalledTimes(commands.length);
  expect(platformTemplateAdministrationRoutes).toEqual([
    "/platform/templates/query",
    "/platform/templates/command",
  ]);
});

it("refuses injected scope, Actor, current-state and proof fields before any administration call", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const request of queries)
    for (const extra of [
      { actorReference: id(90) },
      { permission: "Allow" },
      { observedAt: content.effectiveFrom },
      { scope: { kind: "Platform" } },
    ])
      expect(
        (await send(root, "/query", { body: JSON.stringify({ ...request, ...extra }) })).status,
      ).toBe(400);
  for (const request of commands)
    expect(
      (
        await send(root, "/command", {
          body: JSON.stringify({ ...request, actorReference: id(90) }),
        })
      ).status,
    ).toBe(400);
  for (const request of [
    { ...save, content: { ...content, current: {} } },
    { ...save, templateReference: id(1) },
    {
      ...save,
      expectedHead: {
        revision: 1,
        templateVersionReference: id(2),
        sourceDigest: digest,
        actorReference: id(90),
      },
    },
    { ...publication, request: { ...publication.request, current: {} } },
    {
      ...publication,
      request: { ...publication.request, approvalEvidence: { decision: "Accepted" } },
    },
    { ...publication, command: publication.request },
    {
      ...publication,
      request: { ...publication.request, reviewValidUntil: "2026-10-07T12:00:00.000Z" },
    },
    { ...publication, request: { ...publication.request, operation: "SubmitReview" } },
    { action: "ResolveSave", operationReference: id(4), intentDigest: digest, csrf },
  ])
    expect((await send(root, "/command", { body: JSON.stringify(request) })).status).toBe(400);
  expect(f.administration.query).not.toHaveBeenCalled();
  expect(f.administration.command).not.toHaveBeenCalled();
});

it("validates bounded scalar fields and cursors with the real owner parsers", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const request of [
    { ...list, limit: 0 },
    { ...list, limit: 21 },
    { ...list, limit: "1" },
    { ...list, after: { code: "SYNTHETIC_BASE", templateReference: id(1), extra: true } },
    { action: "Current", templateReference: "not-a-reference" },
    { action: "Exact", templateVersionReference: null },
    { action: "History", templateReference: id(1), beforeRevision: 0 },
    { action: "History", templateReference: id(1), beforeRevision: 2147483648 },
    { action: "PublicationCurrent", templateReference: id(1), lifecycleReference: "invalid" },
    { action: "PublicationExact", templateReference: id(1), sequence: "1" },
    { action: "PublicationHistory", templateReference: id(1), beforeSequence: -1 },
    { action: "PublicationHistory", templateReference: id(1), beforeSequence: 2147483648 },
    { action: "Unknown" },
    save,
  ])
    expect((await send(root, "/query", { body: JSON.stringify(request) })).status).toBe(400);
  for (const request of [
    { ...save, operationReference: "invalid" },
    {
      ...save,
      templateReference: id(1),
      expectedHead: { revision: 2147483647, templateVersionReference: id(2), sourceDigest: digest },
    },
    { ...save, content: { ...content, supportedLocales: ["en-CA", "en-CA"] } },
    { ...save, content: { ...content, hardRequirementFieldCodes: ["DISPLAY_NAME"] } },
    { ...save, content: { ...content, effectiveUntil: content.effectiveFrom } },
    { action: "ResolvePublication", operationReference: id(5), intentDigest: "invalid" },
    list,
  ])
    expect((await send(root, "/command", { body: JSON.stringify(request) })).status).toBe(400);
  expect(f.administration.query).not.toHaveBeenCalled();
  expect(f.administration.command).not.toHaveBeenCalled();
});

it("requires exact same origin, host, fetch metadata and single security headers for reads and writes", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const headers: [string, string][][] = [
    [["Host", "foreign.invalid"]],
    [["Origin", "https://foreign.invalid"]],
    [["Sec-Fetch-Site", "same-site"]],
    [["Sec-Fetch-Site", "cross-site"]],
    [["Sec-Fetch-Mode", "navigate"]],
    [["Sec-Fetch-Dest", "document"]],
    [["Cookie", `__Host-bop-merchant=${credential}`]],
    [["Cookie", `${platformSessionCookie.name}=invalid`]],
    [
      [
        "Cookie",
        `${platformSessionCookie.name}=${credential}; ${platformSessionCookie.name}=${credential}`,
      ],
    ],
    [["Cookie", `${platformSessionCookie.name}=${credential}; unrelated=${"x".repeat(4100)}`]],
    [["X-Bop-CSRF", "invalid"]],
  ];
  for (const [name, value] of [
    ["Host", "platform.invalid"],
    ["Origin", "https://platform.invalid"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Sec-Fetch-Mode", "cors"],
    ["Sec-Fetch-Dest", "empty"],
    ["Cookie", `${platformSessionCookie.name}=${credential}`],
    ["X-Bop-CSRF", csrf],
    ["Content-Type", "application/json"],
  ] as const)
    headers.push([
      [name, value],
      [name, value],
    ]);
  for (const [path, body] of [
    ["/query", list],
    ["/command", save],
  ] as const) {
    for (const values of headers) {
      const response = await send(root, path, { body: JSON.stringify(body), headers: values });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "request_denied" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const omitted of ["origin", "host", "sec-fetch-site", "cookie", "x-bop-csrf"]) {
      const response = await send(root, path, { body: JSON.stringify(body), omit: [omitted] });
      // Node's HTTP/1.1 parser rejects a missing Host before Express admission.
      expect(response.status, `${path} omitted ${omitted}`).toBe(omitted === "host" ? 400 : 403);
    }
  }
  expect(f.administration.query).not.toHaveBeenCalled();
  expect(f.administration.command).not.toHaveBeenCalled();
});

it("keeps exact POST routes, forbids URL parameters and bounds JSON before dispatch", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const path of ["/query", "/command"]) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      const response = await send(root, path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
    }
    for (const body of ["{", "[]", "null", "true", "{}"])
      expect((await send(root, path, { body })).status).toBe(400);
    expect((await send(root, path)).status).toBe(400);
    expect((await send(root, `${path}?templateReference=${id(1)}`, { body: "{}" })).status).toBe(
      400,
    );
    expect(
      (await send(root, path, { body: JSON.stringify({ extra: "x".repeat(32768) }) })).status,
    ).toBe(413);
    expect(
      (await send(root, path, { body: "{}", headers: [["Content-Type", "text/plain"]] })).status,
    ).toBe(400);
    expect(
      (await send(root, path, { body: "{}", headers: [["Content-Encoding", "gzip"]] })).status,
    ).toBe(400);
  }
  for (const path of ["/Query", "/query/", "/command/", "/unrelated"])
    expect(
      (await send(root, path, { body: "{}", headers: [["Host", "foreign.invalid"]] })).status,
    ).toBe(404);
  expect(
    (await send(root, "/query", { prefix: "/PLATFORM/templates", body: JSON.stringify(list) }))
      .status,
  ).toBe(404);
  expect(f.administration.query).not.toHaveBeenCalled();
  expect(f.administration.command).not.toHaveBeenCalled();
});

it("returns finite generic errors without exposing owner messages, query inputs or credentials", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const [error, status, message] of [
    [new BrowserSessionError("BROWSER_SESSION_DENIED"), 403, "request_denied"],
    [new PlatformPermissionError("PLATFORM_PERMISSION_DENIED"), 403, "request_denied"],
    [new PlatformBrandTemplateError("PLATFORM_TEMPLATE_PERMISSION_DENIED"), 403, "request_denied"],
    [new PlatformBrandTemplateError("PLATFORM_TEMPLATE_VERSION_CONFLICT"), 409, "request_conflict"],
    [new PlatformBrandTemplateError("PLATFORM_TEMPLATE_INTENT_CONFLICT"), 409, "request_conflict"],
    [new PublishingContractError("PUBLISHING_INPUT_INVALID"), 400, "request_invalid"],
    [
      new Error(`synthetic-private-detail:${credential}`),
      503,
      "platform_template_administration_unavailable",
    ],
  ] as const) {
    f.administration.command.mockRejectedValueOnce(error);
    const response = await send(root, "/command", { body: JSON.stringify(save) });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: message });
    expect(response.text).not.toContain(credential);
    expect(response.text).not.toContain(id(4));
    expect(response.headers["set-cookie"]).toBeUndefined();
  }
  f.administration.query.mockRejectedValueOnce(
    new PlatformPermissionError("PLATFORM_PERMISSION_DENIED"),
  );
  expect((await send(root, "/query", { body: JSON.stringify(list) })).status).toBe(403);
});

it("captures the actual ports and refuses replacement during an awaited query", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.administration.query.mockImplementationOnce(async () => {
    Reflect.set(
      f.administration,
      "query",
      vi.fn(async () => output),
    );
    return output;
  });
  const response = await send(root, "/query", { body: JSON.stringify(list) });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: "platform_template_administration_unavailable" });
  expect(response.text).not.toContain("controlledTransportResult");
  expect((await send(root, "/command", { body: JSON.stringify(save) })).status).toBe(503);
  expect(f.administration.command).not.toHaveBeenCalled();
});

it("rejects noncanonical or mismatched trusted configuration before opening the router", () => {
  const f = fixture();
  for (const exactOrigin of [
    "http://platform.invalid",
    "https://platform.invalid/",
    "https://platform.invalid/path",
    "https://platform.invalid#fragment",
    "https://platform.invalid@foreign.invalid",
  ])
    expect(() =>
      createPlatformTemplateAdministrationRouter({ ...f.options, exactOrigin }),
    ).toThrow();
  expect(() =>
    createPlatformTemplateAdministrationRouter({ ...f.options, acceptedHost: "foreign.invalid" }),
  ).toThrow();
  expect(f.administration.query).not.toHaveBeenCalled();
  expect(f.administration.command).not.toHaveBeenCalled();
});
