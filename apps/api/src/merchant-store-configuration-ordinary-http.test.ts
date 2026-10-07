import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createAuthenticationSession, createIdentityActor } from "@bop/identity";
import {
  createStoreConfigurationVersion,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
  StoreConfigurationOriginalError,
  StoreConfigurationAdministrationError,
  StoreSetupOperationError,
} from "@rms/store";
import { createApp } from "./app.js";
import { parseMerchantStoreConfigurationOrdinaryWorkspace } from "./merchant-store-configuration-ordinary-values.js";
import type { MerchantBffService, MerchantStoreConfigurationOrdinaryPort } from "./merchant-bff.js";
// Actual App/listener/middleware; controlled public host outputs are transport
// evidence only, not native Session/IAM/Store/Core/Publishing qualification.
const id = (n: number) => "01902421-1013-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const cookie = Buffer.alloc(32, 2).toString("base64url"),
  csrf = Buffer.alloc(32, 1).toString("base64url");
const headers = {
  Host: "merchant.invalid",
  Origin: "https://merchant.invalid",
  "Sec-Fetch-Site": "same-origin",
  Cookie: "__Host-bop-merchant=" + cookie,
  "X-BOP-CSRF": csrf,
  "Content-Type": "application/json",
  "X-BOP-Store-Setup-Scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
};
const command = parseStoreConfigurationOrdinaryCommand({
  profile: "StoreConfigurationOrdinaryCommandV1",
  ...scope,
  operationReference: id(5),
  action: "Materialize",
  expectedHead: { configurationReference: null, configurationVersion: 0, contentDigest: null },
  setupSelector: {
    setupDraftReference: id(6),
    sourceRevision: 1,
    sourceSnapshotDigest: digest("controlled actual source"),
  },
  reasonCode: "INITIAL_CONFIGURATION",
});
const original = parseStoreConfigurationOrdinaryResolve({
  ...command,
  profile: "StoreConfigurationOrdinaryResolveV1",
  intentDigest: digest(command),
});
const configuration = createStoreConfigurationVersion({
  configurationReference: id(8),
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  configurationVersion: 1,
  lifecycle: "Draft",
  source: "StoreOverride",
  brandBaseVersionReference: id(9),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(10),
  contactReference: id(11),
  receiptReference: id(12),
  taxConfigurationReference: id(13),
  paymentConfigurationReference: id(14),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "INITIAL_CONFIGURATION",
  authoredByReference: scope.actorReference,
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  liveGateEvidenceReference: null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
  setupBasis: {
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: scope.tenantReference,
    setupDraftReference: id(6),
    sourceRevision: 1,
    sourceSnapshotDigest: digest("controlled actual source"),
    feeContexts: [
      { chargeType: "ServiceCharge", state: "Disabled" },
      { chargeType: "DeliveryFee", state: "Disabled" },
      { chargeType: "Tip", state: "Disabled" },
    ],
  },
});
const receipt = parseStoreConfigurationOrdinaryReceipt({
  ...command,
  profile: "StoreConfigurationOrdinaryReceiptV1",
  intentDigest: digest(command),
  outcome: "Committed",
  operation: {
    command: "SaveDraft",
    operationReference: command.operationReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    intentDigest: digest("controlled genuine legacy input"),
    resultingVersion: 1,
    configuration,
  },
  auditReference: id(15),
  occurredAt: at,
  dataClassification: "ConfigurationMetadata",
});
const workspace = parseMerchantStoreConfigurationOrdinaryWorkspace(
  {
    profile: "StoreConfigurationOrdinaryWorkspaceV1",
    scope,
    latest: configuration,
    current: null,
    expectedHead: {
      configurationReference: configuration.configurationReference,
      configurationVersion: 1,
      contentDigest: digest(configuration),
    },
    original: null,
    observedAt: at,
    validUntil: until,
    businessReferenceValidation: "NotEvaluated",
  },
  scope,
);
const session = createAuthenticationSession({
  sessionReference: id(20),
  actor: createIdentityActor({
    actorType: "User",
    actorReference: scope.actorReference,
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
function port() {
  return {
    read: vi.fn<MerchantStoreConfigurationOrdinaryPort["read"]>(async () => workspace),
    write: vi.fn<MerchantStoreConfigurationOrdinaryPort["write"]>(async () => receipt),
  };
}
async function serve(
  endpoint?: MerchantStoreConfigurationOrdinaryPort,
  {
    clock = () => at,
    missingClock = false,
    denyCsrf = false,
  }: { clock?: () => string; missingClock?: boolean; denyCsrf?: boolean } = {},
) {
  const unused = async (): Promise<never> => {
    throw new Error("Unconfigured unrelated transport");
  };
  const authorize = vi.fn<MerchantBffService["authorize"]>(async (input) => {
    if (denyCsrf || input.csrf !== csrf) throw new Error("Controlled CSRF denial");
    return session;
  });
  const service: MerchantBffService = {
    start: unused,
    callback: unused,
    bootstrap: unused,
    authorize,
    logout: unused,
    switchStore: unused,
  };
  const app = createApp({
      merchantBff: {
        service,
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(endpoint ? { storeConfigurationOrdinary: endpoint } : {}),
        ...(!missingClock ? { storeConfigurationOrdinaryClock: { now: clock } } : {}),
      },
    }),
    server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local listener unavailable");
  return { root: "http://127.0.0.1:" + address.port, authorize };
}
async function send(
  root: string,
  {
    method = "POST",
    path = "/merchant/store-configuration/ordinary-command",
    body = { command },
    customHeaders = headers,
    text,
  }: {
    method?: "GET" | "POST";
    path?: string;
    body?: unknown;
    customHeaders?: Readonly<Record<string, string | string[]>>;
    text?: string;
  } = {},
) {
  return new Promise<{ status: number; body: unknown; raw: string; headers: Headers }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        new URL(path, root),
        { method, headers: customHeaders },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.once("error", reject);
          incoming.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8"),
              replyHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              const key = incoming.rawHeaders[i],
                value = incoming.rawHeaders[i + 1];
              if (key !== undefined && value !== undefined) replyHeaders.append(key, value);
            }
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(raw),
              raw,
              headers: replyHeaders,
            });
          });
        },
      );
      outgoing.once("error", reject);
      if (method !== "GET") outgoing.write(text ?? JSON.stringify(body));
      outgoing.end();
    },
  );
}
const getPath =
  "/merchant/store-configuration/ordinary?expectedStoreReference=" + scope.storeReference;
it("dispatches ordinary current read with mandatory scope and validates genuine full-head metadata", async () => {
  const endpoint = port(),
    h = await serve(endpoint),
    reply = await send(h.root, { method: "GET", path: getPath });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(workspace);
  expect(endpoint.read).toHaveBeenCalledWith({
    sessionCookie: cookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
  });
  expect(reply.headers.get("cache-control")).toContain("no-store");
});
it("dispatches Materialize closed scalar pins and validates immutable committed receipt", async () => {
  const endpoint = port(),
    h = await serve(endpoint),
    reply = await send(h.root);
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(receipt);
  expect(endpoint.write).toHaveBeenCalledWith({
    sessionCookie: cookie,
    csrf,
    command,
    expectedScope: scope,
  });
  expect(reply.raw).not.toContain(cookie);
});
it("forwards exact payload-free Resolve and refreshes original state through a distinct authorized read", async () => {
  const endpoint = port();
  endpoint.read.mockResolvedValue({ ...workspace, original: receipt });
  const h = await serve(endpoint);
  expect((await send(h.root, { body: { command: original } })).status).toBe(200);
  const reply = await send(h.root, {
    path: "/merchant/store-configuration/ordinary-state",
    body: { original, expectedStoreReference: scope.storeReference },
  });
  expect(reply.status).toBe(200);
  expect(h.authorize).toHaveBeenCalledWith({ sessionCookie: cookie, csrf });
  expect(endpoint.read).toHaveBeenCalledWith({
    sessionCookie: cookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
    original,
    csrf,
  });
  expect(endpoint.write).toHaveBeenCalledTimes(1);
});
it("does not read state after real CSRF authorization rejects", async () => {
  const endpoint = port(),
    h = await serve(endpoint, { denyCsrf: true });
  expect(
    (
      await send(h.root, {
        path: "/merchant/store-configuration/ordinary-state",
        body: { original, expectedStoreReference: scope.storeReference },
      })
    ).status,
  ).toBe(403);
  expect(endpoint.read).not.toHaveBeenCalled();
});
it.each(["missingPort", "missingClock"])(
  "closes ordinary reads when %s is unavailable",
  async (kind) => {
    const h = await serve(kind === "missingPort" ? undefined : port(), {
      missingClock: kind === "missingClock",
    });
    expect((await send(h.root, { method: "GET", path: getPath })).status).toBe(503);
  },
);
it.each(["Origin", "Host", "Cookie", "X-BOP-CSRF"])(
  "refuses insecure/missing %s before writing",
  async (key) => {
    const endpoint = port(),
      h = await serve(endpoint);
    const changed: Record<string, string> = Object.fromEntries(
      Object.entries(headers).filter(([name]) =>
        key === "Origin" || key === "Host" ? true : name !== key,
      ),
    );
    if (key === "Origin") changed.Origin = "https://outside.invalid";
    else if (key === "Host") changed.Host = "outside.invalid";
    expect((await send(h.root, { customHeaders: changed })).status).toBe(403);
    expect(endpoint.write).not.toHaveBeenCalled();
  },
);
it.each(["GET", "POST"] as const)("refuses duplicate scope headers for %s", async (method) => {
  const endpoint = port(),
    h = await serve(endpoint);
  expect(
    (
      await send(h.root, {
        method,
        ...(method === "GET" ? { path: getPath } : {}),
        customHeaders: {
          ...headers,
          "X-BOP-Store-Setup-Scope": [
            headers["X-BOP-Store-Setup-Scope"],
            headers["X-BOP-Store-Setup-Scope"],
          ],
        },
      })
    ).status,
  ).toBe(403);
  expect(endpoint.read).not.toHaveBeenCalled();
  expect(endpoint.write).not.toHaveBeenCalled();
});
it("rejects malformed and noncanonical scope without dispatch", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  for (const value of ["malformed", headers["X-BOP-Store-Setup-Scope"] + "="])
    expect(
      (await send(h.root, { customHeaders: { ...headers, "X-BOP-Store-Setup-Scope": value } }))
        .status,
    ).toBe(400);
  expect(endpoint.write).not.toHaveBeenCalled();
});
it("refuses foreign Actor/Store body pins and original hash drift", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  expect(
    (await send(h.root, { body: { command: { ...command, actorReference: id(99) } } })).status,
  ).toBe(403);
  expect(
    (
      await send(h.root, {
        method: "GET",
        path: "/merchant/store-configuration/ordinary?expectedStoreReference=" + id(99),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(h.root, {
        body: { command: { ...original, intentDigest: digest("wrong original") } },
      })
    ).status,
  ).toBe(409);
  expect(endpoint.write).not.toHaveBeenCalled();
});
it.each([
  { command, approval: true },
  { command: { ...command, configuration } },
  { command: { ...command, permission: "organization.manage" } },
])("rejects authority/full-content injection", async (body) => {
  const endpoint = port(),
    h = await serve(endpoint);
  expect((await send(h.root, { body })).status).toBe(400);
  expect(endpoint.write).not.toHaveBeenCalled();
});
it("enforces the dedicated 8KiB parser and strict JSON", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  expect((await send(h.root, { text: "{" })).status).toBe(400);
  expect((await send(h.root, { body: { command, padding: "x".repeat(9000) } })).status).toBe(413);
  expect(endpoint.write).not.toHaveBeenCalled();
});
it("rejects query injection and duplicate selected Store", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  expect(
    (await send(h.root, { path: "/merchant/store-configuration/ordinary-command?actor=" + id(99) }))
      .status,
  ).toBe(403);
  expect(
    (
      await send(h.root, {
        method: "GET",
        path: getPath + "&expectedStoreReference=" + scope.storeReference,
      })
    ).status,
  ).toBe(400);
  expect(endpoint.read).not.toHaveBeenCalled();
});
it.each([
  ["STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID", 400],
  ["STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED", 403],
  ["STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT", 409],
  ["STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT", 409],
  ["STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE", 503],
] as const)("maps the bounded owning error %s", async (code, status) => {
  const endpoint = port();
  endpoint.write.mockRejectedValue(new StoreConfigurationOriginalError(code));
  const h = await serve(endpoint),
    reply = await send(h.root);
  expect(reply.status).toBe(status);
  expect(reply.raw).not.toContain(code);
  expect(reply.headers.get("cache-control")).toContain("no-store");
});
it("maps actual Administration gates without exposing internal errors", async () => {
  const endpoint = port();
  endpoint.write.mockRejectedValue(
    new StoreConfigurationAdministrationError("STORE_CONFIGURATION_GATE_REQUIRED"),
  );
  const h = await serve(endpoint);
  expect((await send(h.root)).status).toBe(409);
  endpoint.write.mockRejectedValue(new Error("Synthetic internal detail"));
  const reply = await send(h.root);
  expect(reply.status).toBe(503);
  expect(reply.raw).not.toContain("Synthetic internal detail");
});
it("rejects wrong returned Actor, malformed clock and expired/unknown workspace", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  for (const view of [
    { ...workspace, scope: { ...scope, actorReference: id(99) } },
    { ...workspace, validUntil: at },
    { ...workspace, privatePermission: true },
  ]) {
    endpoint.read.mockResolvedValue(view);
    expect((await send(h.root, { method: "GET", path: getPath })).status).toBe(503);
  }
  const invalidClock = await serve(port(), { clock: () => "invalid" });
  expect((await send(invalidClock.root, { method: "GET", path: getPath })).status).toBe(503);
});
it("rejects mismatched returned operation and unrelated original state", async () => {
  const endpoint = port(),
    h = await serve(endpoint);
  endpoint.write.mockResolvedValue({ ...receipt, operationReference: id(99) });
  expect((await send(h.root)).status).toBe(503);
  if (!receipt.operation) throw new Error("Missing controlled committed operation");
  endpoint.read.mockResolvedValue({
    ...workspace,
    original: parseStoreConfigurationOrdinaryReceipt({
      ...receipt,
      operationReference: id(99),
      operation: { ...receipt.operation, operationReference: id(99) },
    }),
  });
  expect(
    (
      await send(h.root, {
        path: "/merchant/store-configuration/ordinary-state",
        body: { original, expectedStoreReference: scope.storeReference },
      })
    ).status,
  ).toBe(503);
});
it("rejects a lease that expires during the actual read await", async () => {
  let now = at;
  const endpoint = port();
  endpoint.read.mockImplementation(async () => {
    now = until;
    return workspace;
  });
  const h = await serve(endpoint, { clock: () => now });
  expect((await send(h.root, { method: "GET", path: getPath })).status).toBe(503);
});
it("rejects a future observation and a backward trusted clock", async () => {
  const endpoint = port();
  endpoint.read.mockResolvedValue({ ...workspace, observedAt: "2026-10-05T12:00:00.001Z" });
  const h = await serve(endpoint);
  expect((await send(h.root, { method: "GET", path: getPath })).status).toBe(503);
  let now = "2026-10-05T12:00:00.001Z";
  endpoint.read.mockImplementation(async () => {
    now = at;
    return workspace;
  });
  const backward = await serve(endpoint, { clock: () => now });
  expect((await send(backward.root, { method: "GET", path: getPath })).status).toBe(503);
});
it("rejects future immutable receipt time without echoing it", async () => {
  const endpoint = port();
  endpoint.write.mockResolvedValue({ ...receipt, occurredAt: "2026-10-06T12:00:00.000Z" });
  const h = await serve(endpoint),
    reply = await send(h.root);
  expect(reply.status).toBe(503);
  expect(reply.raw).not.toContain("2026-10-06");
});
it("refuses a structurally valid Materialize receipt bound to another Setup revision", async () => {
  if (command.action !== "Materialize" || !receipt.operation || !configuration.setupBasis)
    throw new Error("Missing controlled Materialize pins");
  const changedCommand = parseStoreConfigurationOrdinaryCommand({
      ...command,
      setupSelector: { ...command.setupSelector, sourceRevision: 2 },
    }),
    changedConfiguration = createStoreConfigurationVersion({
      ...configuration,
      setupBasis: { ...configuration.setupBasis, sourceRevision: 2 },
    }),
    changedReceipt = parseStoreConfigurationOrdinaryReceipt({
      ...receipt,
      setupSelector: { ...command.setupSelector, sourceRevision: 2 },
      intentDigest: digest(changedCommand),
      operation: { ...receipt.operation, configuration: changedConfiguration },
    });
  const endpoint = port();
  endpoint.write.mockResolvedValue(changedReceipt);
  const h = await serve(endpoint);
  expect((await send(h.root)).status).toBe(503);
  expect(endpoint.write).toHaveBeenCalledWith({
    sessionCookie: cookie,
    csrf,
    command,
    expectedScope: scope,
  });
});

it("reports a held Setup source version conflict as a retryable configuration conflict", async () => {
  const endpoint = port();
  endpoint.write.mockRejectedValue(
    new StoreSetupOperationError("STORE_SETUP_OPERATION_VERSION_CONFLICT"),
  );
  const h = await serve(endpoint);
  const result = await send(h.root, {
    path: "/merchant/store-configuration/ordinary-command",
    body: { command },
  });
  expect(result.status).toBe(409);
  expect(result.body).toEqual({ error: "store_configuration_ordinary_conflict" });
});
const historyPage = () => ({
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  readerActorReference: scope.actorReference,
  beforeSequence: null,
  entries: [],
  nextBeforeSequence: null,
  observedAt: at,
  validUntil: until,
});
it("refuses an invalid trusted history clock before source dispatch", async () => {
  const endpoint = {
    ...port(),
    history: vi.fn<NonNullable<MerchantStoreConfigurationOrdinaryPort["history"]>>(async () =>
      historyPage(),
    ),
  };
  const h = await serve(endpoint, { clock: () => "invalid" });
  expect(
    (
      await send(h.root, {
        path: "/merchant/store-configuration/ordinary-history",
        body: { expectedStoreReference: scope.storeReference, beforeSequence: null },
      })
    ).status,
  ).toBe(503);
  expect(endpoint.history).not.toHaveBeenCalled();
});
it("forwards scoped history cursor and actual CSRF without a cursor URL or current-write request", async () => {
  const endpoint = {
    ...port(),
    history: vi.fn<NonNullable<MerchantStoreConfigurationOrdinaryPort["history"]>>(async () =>
      historyPage(),
    ),
  };
  const h = await serve(endpoint);
  const reply = await send(h.root, {
    path: "/merchant/store-configuration/ordinary-history",
    body: { expectedStoreReference: scope.storeReference, beforeSequence: null },
  });
  expect(reply.status).toBe(200);
  expect(endpoint.history).toHaveBeenCalledWith({
    sessionCookie: cookie,
    csrf,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
    beforeSequence: null,
  });
  expect(endpoint.write).not.toHaveBeenCalled();
});
it("refuses malformed history cursor and scope before dispatch", async () => {
  const endpoint = {
    ...port(),
    history: vi.fn<NonNullable<MerchantStoreConfigurationOrdinaryPort["history"]>>(async () =>
      historyPage(),
    ),
  };
  const h = await serve(endpoint);
  for (const body of [
    { expectedStoreReference: scope.storeReference, beforeSequence: 1.5 },
    { expectedStoreReference: id(99), beforeSequence: null },
    { expectedStoreReference: scope.storeReference, beforeSequence: null, actorReference: id(99) },
  ]) {
    expect(
      (await send(h.root, { path: "/merchant/store-configuration/ordinary-history", body })).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(endpoint.history).not.toHaveBeenCalled();
});
it("refuses foreign-reader or expired history and a missing history source", async () => {
  const endpoint = {
    ...port(),
    history: vi.fn<NonNullable<MerchantStoreConfigurationOrdinaryPort["history"]>>(async () =>
      historyPage(),
    ),
  };
  const h = await serve(endpoint);
  for (const value of [
    { ...historyPage(), readerActorReference: id(99) },
    { ...historyPage(), validUntil: at },
  ]) {
    endpoint.history.mockResolvedValue(value);
    expect(
      (
        await send(h.root, {
          path: "/merchant/store-configuration/ordinary-history",
          body: { expectedStoreReference: scope.storeReference, beforeSequence: null },
        })
      ).status,
    ).toBe(503);
  }
  const missing = await serve(port());
  expect(
    (
      await send(missing.root, {
        path: "/merchant/store-configuration/ordinary-history",
        body: { expectedStoreReference: scope.storeReference, beforeSequence: null },
      })
    ).status,
  ).toBe(503);
});
