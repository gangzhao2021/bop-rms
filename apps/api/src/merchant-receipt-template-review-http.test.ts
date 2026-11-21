import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  parseDigitalReceiptTemplateReviewCurrent,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantReceiptTemplateReview } from "./merchant-receipt-template-review.js";
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
const receipt = () =>
  parseDigitalReceiptTemplateReviewCurrent({
    profile: "DigitalReceiptTemplateReviewCurrentV1",
    ...scope,
    templateReference: id(13),
    currentDraft: { versionReference: id(14), revision: 1, contentDigest: digest },
    submission: null,
    lifecycle: null,
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated",
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
type Port = ReturnType<typeof createMerchantReceiptTemplateReview>;
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
  return { read: vi.fn<Port["read"]>(async () => receipt()) };
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
        ...(port ? { receiptTemplateReview: port } : {}),
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
    method = "GET",
    query = "?storeReference=" + scope.storeReference + "&templateReference=" + id(13),
    body = undefined,
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
        new URL("/merchant/store-setup/receipt-template-review" + query, root),
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

it("returns actual selected review state through scoped no-store GET", async () => {
  const port = endpoints();
  const reply = await send(await serve(port));
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(receipt());
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(port.read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
    templateReference: id(13),
  });
});
it("fails closed without configured query port", async () => {
  const reply = await send(await serve());
  expect(reply.status).toBe(503);
  expect(reply.body).toEqual({ error: "receipt_template_review_unavailable" });
});
it.each([
  "",
  "?storeReference=" + id(3),
  "?storeReference=" + id(3) + "&templateReference=" + id(13) + "&ttl=72",
  "?storeReference=" + id(3) + "&templateReference=" + id(13) + "&templateReference=" + id(14),
])("rejects incomplete or extraneous query %s", async (query) => {
  const port = endpoints();
  const reply = await send(await serve(port), { query });
  expect(reply.status).toBe(403);
  expect(port.read).not.toHaveBeenCalled();
});
it.each(["X-BOP-Store-Setup-Scope", "Cookie", "Sec-Fetch-Site"])(
  "rejects missing %s",
  async (field) => {
    const port = endpoints();
    const customHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => key !== field),
    );
    expect((await send(await serve(port), { customHeaders })).status).toBe(403);
    expect(port.read).not.toHaveBeenCalled();
  },
);
it.each([
  "RECEIPT_TEMPLATE_INPUT_INVALID",
  "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  "RECEIPT_TEMPLATE_CONFLICT",
  "RECEIPT_TEMPLATE_UNAVAILABLE",
] as const)("maps finite query error %s", async (code) => {
  const port = endpoints();
  port.read.mockRejectedValue(new DigitalReceiptTemplateError(code));
  const reply = await send(await serve(port));
  expect(reply.status).toBe(
    code.endsWith("INVALID")
      ? 400
      : code.endsWith("DENIED")
        ? 403
        : code.endsWith("CONFLICT")
          ? 409
          : 503,
  );
  expect(reply.headers.get("cache-control")).toBe("no-store");
});
it("rejects selected Store/header disagreement before calling source", async () => {
  const port = endpoints();
  expect(
    (
      await send(await serve(port), {
        query: "?storeReference=" + id(99) + "&templateReference=" + id(13),
      })
    ).status,
  ).toBe(400);
  expect(port.read).not.toHaveBeenCalled();
});
