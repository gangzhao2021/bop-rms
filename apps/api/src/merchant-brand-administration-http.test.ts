import { request as httpRequest, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  workforceAuthorizationCookie as authorizationCookie,
  workforceSessionCookie as merchantSessionCookie,
  createAuthenticationSession,
  createIdentityActor,
  parseRawBrowserCredential,
  sessionPolicies,
  parseCanonicalInstant,
  parseAuthorizationTransactionReference,
} from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseOrganizationVersion,
  createBrandConfigurationRevision,
  type Brand,
} from "@bop/tenant";
import { brandCatalogSourceIntentDigest } from "@rms/catalog";
import { createApp } from "./app.js";
import { MerchantBrandDiscoveryError } from "./merchant-brand-discovery.js";
import { MerchantBrandLifecycleError } from "./merchant-brand-lifecycle-ordinary.js";
import { parseMerchantBrandLifecycleReceipt } from "./merchant-brand-lifecycle-transport.js";
import type { MerchantBrandAdministrationHttpOptions } from "./merchant-brand-administration-http.js";

// Actual App/router/headers with controlled service outputs. Real noStore
// Session/IAM/database acceptance is separately exercised in brand-admin.
const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  brand = id(1),
  actor = id(2);
const path = `/app/organization/brands/${brand}`,
  rootPath = "/merchant/organization/brands";
const rawCookie = parseRawBrowserCredential(Buffer.alloc(32, 2).toString("base64url"));
const csrf = parseRawBrowserCredential(Buffer.alloc(32, 3).toString("base64url"));
const scope = { tenantReference: brand, brandReference: brand, actorReference: actor };
const session = createAuthenticationSession({
  sessionReference: id(3),
  actor: createIdentityActor({
    actorType: "User",
    actorReference: actor,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  }),
  status: "Active",
  policyCode: "Privileged",
  maxActiveSessions: sessionPolicies.Privileged.maxActiveSessions,
  idleTimeoutMinutes: sessionPolicies.Privileged.idleTimeoutMinutes,
  absoluteTimeoutMinutes: sessionPolicies.Privileged.absoluteTimeoutMinutes,
  version: 1,
  authenticatedAt: at,
  createdAt: at,
  lastSeenAt: at,
  idleExpiresAt: "2026-10-06T12:15:00.000Z",
  absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
const mutation = { descriptor: merchantSessionCookie, value: rawCookie, clear: false };
const logoutUrl =
  "https://identity.invalid/logout?client_id=synthetic&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands";
const mfa = {
  sessionReference: session.sessionReference,
  actorReference: actor,
  method: "Totp" as const,
  evidenceReference: id(301),
  authorizationTransactionReference: parseAuthorizationTransactionReference(id(302)),
  authenticatedAt: session.authenticatedAt,
  verifiedAt: session.authenticatedAt,
  validUntil: parseCanonicalInstant("2026-10-06T12:15:00.000Z"),
};
const bootstrap = {
  session,
  csrf,
  recentMfa: mfa,
  recentMfaRequired: false,
  observedAt: parseCanonicalInstant(at),
  validUntil: parseCanonicalInstant(until),
};
const view = {
  profile: "BrandAdministrationWorkspaceV1" as const,
  selectedScope: scope,
  brand: {
    brandReference: brand,
    label: "Synthetic Brand",
    lifecycle: "Active" as Brand["lifecycle"],
    version: parseOrganizationVersion(3),
  },
  navigation: [
    {
      screenId: "ORG-BRAND-DETAIL" as const,
      label: "Brand" as const,
      href: path,
      permission: "organization.manage" as const,
    },
  ],
};
const current = {
  profile: "TenantBrandConfigurationCurrentV1" as const,
  ...scope,
  current: null,
  recordedReview: null,
  observedAt: at,
  validUntil: until,
  currentPublication: "NotEvaluated" as const,
};
const original = {
  command: "SaveConfigurationDraft",
  operationReference: id(5),
  expectedBrandVersion: 1,
  expectedHead: null,
  intentDigest: `sha256:${"a".repeat(64)}`,
};
const receipt = {
  profile: "TenantBrandConfigurationOperationV1",
  ...scope,
  ...original,
  purposeCode: "BRAND_CONFIGURATION",
  originalCommand: null,
  outcome: "Abandoned",
  snapshot: null,
  auditReference: id(6),
  occurredAt: at,
  dataClassification: "ConfigurationMetadata",
};
function fixture() {
  const service = {
    start: vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    callback: vi.fn(async () => ({
      postLoginPath: path,
      session,
      cookies: [{ descriptor: authorizationCookie, value: "" as const, clear: true }, mutation],
    })),
    bootstrap: vi.fn(
      async (): Promise<
        Awaited<ReturnType<MerchantBrandAdministrationHttpOptions["service"]["bootstrap"]>>
      > => ({ ...bootstrap, workspace: view }),
    ),
    authorize: vi.fn(async () => session),
    rotate: vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    logout: vi.fn(
      async (): Promise<
        Awaited<ReturnType<MerchantBrandAdministrationHttpOptions["service"]["logout"]>>
      > => ({
        status: "BrowserLogoutRequired",
        cookies: [{ descriptor: merchantSessionCookie, value: "", clear: true }],
        browserLogoutUrl: logoutUrl,
      }),
    ),
  } satisfies MerchantBrandAdministrationHttpOptions["service"];
  const configuration = {
    templates: vi.fn(async (): Promise<unknown> => ({
      profile: "MerchantBrandTemplateCandidatesV1",
      ...scope,
      afterTemplateReference: null,
      items: [],
      hasMore: false,
      nextAfterTemplateReference: null,
      observedAt: at,
      validUntil: until,
    })),
    current: vi.fn(async (): Promise<unknown> => current),
    history: vi.fn(async () => ({
      profile: "TenantBrandConfigurationHistoryV1",
      ...scope,
      beforeRevision: null,
      entries: [],
      nextBeforeRevision: null,
      observedAt: at,
      validUntil: until,
      currentPublication: "NotEvaluated",
    })),
    execute: vi.fn(async (): Promise<unknown> => receipt),
    resolve: vi.fn(async (): Promise<unknown> => receipt),
  };
  const time = { now: at };
  const catalogSource = {
    current: vi.fn(async (): Promise<unknown> => ({
      profile: "BrandCatalogSourceCurrentV1",
      ...scope,
      source: null,
      observedAt: at,
      validUntil: until,
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    })),
    exact: vi.fn(async (): Promise<unknown> => ({
      profile: "BrandCatalogSourceExactV1",
      ...scope,
      requestedSourceReference: id(8),
      source: null,
      observedAt: at,
      validUntil: until,
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    })),
    register: vi.fn(async (): Promise<unknown> => null),
    resolve: vi.fn(async (): Promise<unknown> => null),
  };
  return {
    service,
    configuration,
    catalogSource,
    time,
    options: {
      brandReference: brand,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      authorizationOrigin: "https://identity.invalid",
      logoutUrl,
      service,
      configuration: configuration as unknown as NonNullable<
        MerchantBrandAdministrationHttpOptions["configuration"]
      >,
      catalogSource: catalogSource as unknown as NonNullable<
        MerchantBrandAdministrationHttpOptions["catalogSource"]
      >,
      clock: { now: () => time.now },
    },
  };
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
it("serves scoped Published Template candidates through the ordinary authenticated POST route", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const result = await send(root, "/configuration/templates", {
    brandReference: brand,
    afterTemplateReference: null,
  });
  expect(result.status).toBe(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.body).toMatchObject({
    profile: "MerchantBrandTemplateCandidatesV1",
    ...scope,
    items: [],
  });
  expect(f.configuration.templates).toHaveBeenCalledWith({
    sessionCookie: rawCookie,
    csrf,
    expectedBrandReference: brand,
    afterTemplateReference: null,
  });
  expect(f.configuration.execute).not.toHaveBeenCalled();
  expect(f.catalogSource.register).not.toHaveBeenCalled();
});
it.each([
  { brandReference: brand },
  { brandReference: brand, afterTemplateReference: "invalid" },
  { brandReference: brand, afterTemplateReference: null, actorReference: actor },
  { brandReference: brand, afterTemplateReference: null, limit: 100 },
])("refuses open or malformed Template candidate requests: %j", async (body) => {
  const f = fixture(),
    root = await serve(f.options);
  expect((await send(root, "/configuration/templates", body)).status).toBe(400);
  expect(f.configuration.templates).not.toHaveBeenCalled();
});
it("refuses foreign Brand, unauthorized, stale or misbound candidate service outputs", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const body = { brandReference: brand, afterTemplateReference: null };
  expect(
    (await send(root, "/configuration/templates", { ...body, brandReference: id(9) })).status,
  ).toBe(403);
  const valid = {
    profile: "MerchantBrandTemplateCandidatesV1",
    ...scope,
    afterTemplateReference: null,
    items: [],
    hasMore: false,
    nextAfterTemplateReference: null,
    observedAt: at,
    validUntil: until,
  };
  for (const change of [
    { actorReference: id(9) },
    { validUntil: at },
    { authoredByReference: id(9) },
    { afterTemplateReference: id(9) },
  ]) {
    f.configuration.templates.mockResolvedValueOnce({ ...valid, ...change });
    const response = await send(root, "/configuration/templates", body);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "brand_administration_unavailable" });
  }
  f.service.authorize.mockRejectedValueOnce(
    new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED"),
  );
  expect((await send(root, "/configuration/templates", body)).status).toBe(403);
});
it("exposes Catalog identity current/exact and bound original recovery without publication claims", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const currentResult = await send(root, "/catalog-source/current", { brandReference: brand });
  expect(currentResult.status).toBe(200);
  expect(currentResult.body).toMatchObject({
    source: null,
    publicationStatus: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
  });
  expect(
    (await send(root, "/catalog-source/exact", { brandReference: brand, sourceReference: id(8) }))
      .status,
  ).toBe(200);
  const command = { operationReference: id(9), code: "SYNTHETIC", label: "Synthetic catalogue" };
  const intentDigest = brandCatalogSourceIntentDigest({
    ...command,
    ...scope,
    profile: "BrandCatalogSourceRegisterV1",
  });
  const original = { operationReference: command.operationReference, intentDigest };
  const terminal = {
    profile: "BrandCatalogSourceReceiptV1",
    ...scope,
    ...original,
    outcome: "Abandoned",
    originalCommand: null,
    source: null,
    auditReference: id(10),
    occurredAt: at,
  };
  f.catalogSource.register.mockResolvedValueOnce(terminal);
  expect(
    (await send(root, "/catalog-source/register", { brandReference: brand, command })).body,
  ).toEqual(terminal);
  f.catalogSource.resolve.mockResolvedValueOnce(terminal);
  expect(
    (await send(root, "/catalog-source/resolve", { brandReference: brand, original })).body,
  ).toEqual(terminal);
  expect(f.catalogSource.resolve).toHaveBeenCalledWith({
    sessionCookie: rawCookie,
    csrf,
    expectedBrandReference: brand,
    original,
  });
});
it("refuses Catalog forged authority and wrong exact-source or original responses", async () => {
  const f = fixture(),
    root = await serve(f.options);
  expect((await send(root, "/catalog-source/current", { brandReference: id(99) })).status).toBe(
    403,
  );
  expect(
    (await send(root, "/catalog-source/current", { brandReference: brand, actorReference: actor }))
      .status,
  ).toBe(400);
  expect(f.catalogSource.current).not.toHaveBeenCalled();
  expect(
    (await send(root, "/catalog-source/exact", { brandReference: brand, sourceReference: id(7) }))
      .status,
  ).toBe(503);
  f.catalogSource.resolve.mockResolvedValueOnce({
    profile: "BrandCatalogSourceReceiptV1",
    ...scope,
    operationReference: id(55),
    intentDigest: original.intentDigest,
    outcome: "Abandoned",
    originalCommand: null,
    source: null,
    auditReference: id(10),
    occurredAt: at,
  });
  expect(
    (
      await send(root, "/catalog-source/resolve", {
        brandReference: brand,
        original: { operationReference: id(9), intentDigest: original.intentDigest },
      })
    ).status,
  ).toBe(503);
});
async function serve(options: MerchantBrandAdministrationHttpOptions) {
  const server = createApp({ brandAdministration: options }).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function send(
  root: string,
  suffix: string,
  body?: unknown,
  extra: Record<string, string | string[]> = {},
  method = body === undefined ? "GET" : "POST",
) {
  return new Promise<{
    status: number;
    raw: string;
    body: unknown;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = httpRequest(
      new URL(rootPath + suffix, root),
      {
        method,
        headers: {
          Host: "merchant.invalid",
          Origin: "https://merchant.invalid",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          Cookie: `__Host-bop-merchant=${rawCookie}; __Host-bop-auth=${rawCookie}`,
          "X-BOP-CSRF": csrf,
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, raw, body: parsed, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
it("serves noStore login/callback/session/rotation/logout through the actual App with secure cookies", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const login = await send(root, "/login");
  expect(login.status).toBe(303);
  expect(login.headers.location).toBe("https://identity.invalid/authorize");
  const callback = await send(root, "/callback?code=synthetic-code&state=synthetic-state");
  expect(callback.status).toBe(303);
  expect(callback.headers.location).toBe(path);
  expect(f.service.callback).toHaveBeenCalledWith({
    code: "synthetic-code",
    state: "synthetic-state",
    authCookie: rawCookie,
  });
  const boot = await send(root, "/session");
  expect(boot.status).toBe(200);
  expect(boot.body).toEqual({
    authenticated: true,
    csrf,
    recentMfaRequired: false,
    workspace: view,
  });
  expect(boot.headers["cache-control"]).toBe("no-store");
  const rotated = await send(root, "/session/rotate", {});
  expect(rotated.status).toBe(200);
  expect(rotated.body).toEqual({
    status: "step_up_required",
    authorizationUrl: "https://identity.invalid/authorize",
  });
  expect(rotated.headers["set-cookie"]?.[0]).toContain("Secure; HttpOnly; SameSite=Lax");
  const logout = await send(root, "/session/logout", {});
  expect(logout.status).toBe(200);
  expect(logout.body).toEqual({ status: "browser_logout_required", logoutUrl });
  expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  expect(f.service.logout).toHaveBeenCalledWith({ sessionCookie: rawCookie, csrf });
  expect(f.service.authorize).not.toHaveBeenCalled();
});
it("returns bound current/history and unchanged original Abandoned identity", async () => {
  const f = fixture(),
    root = await serve(f.options);
  expect((await send(root, "/configuration/current", { brandReference: brand })).body).toEqual(
    current,
  );
  expect(
    (await send(root, "/configuration/history", { brandReference: brand, beforeRevision: null }))
      .status,
  ).toBe(200);
  const resolved = await send(root, "/configuration/resolve", {
    brandReference: brand,
    command: original,
  });
  expect(resolved.status).toBe(200);
  expect(resolved.body).toEqual(receipt);
  expect(f.configuration.resolve).toHaveBeenCalledWith({
    sessionCookie: rawCookie,
    csrf,
    expectedBrandReference: brand,
    original,
  });
  expect(f.configuration.execute).not.toHaveBeenCalled();
});
it("returns closed recorded review and refuses missing or mismatched non-Draft evidence", async () => {
  const f = fixture(),
    root = await serve(f.options),
    submittedAt = "2026-10-06T11:00:00.000Z";
  const revision = createBrandConfigurationRevision(
    {
      profile: "TenantBrandConfigurationRevisionV1",
      ...scope,
      actorReference: id(20),
      revision: 2,
      brandVersion: 3,
      command: "SubmitConfiguration",
      operationReference: id(21),
      configuration: {
        configurationVersionReference: id(22),
        brandReference: brand,
        configurationVersion: 1,
        lifecycle: "PendingApproval",
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA"],
        mediaThemeReference: null,
        catalogSourceReference: id(23),
        platformTemplateReference: id(24),
        overrideAllowedFieldCodes: [],
        hardRequirementFieldCodes: [],
        effectiveFrom: submittedAt,
        effectiveUntil: null,
        supersedesVersionReference: null,
        reasonCode: "INITIAL_CONFIGURATION",
        authoredByReference: id(20),
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        createdAt: submittedAt,
        updatedAt: submittedAt,
        dataClassification: "ConfigurationMetadata",
      },
      submittedByReference: id(20),
      publishing: {
        familyReference: brand,
        lifecycleReference: id(25),
        lifecycleVersion: 2,
        mutationOperationReference: id(21),
        validationEvidenceReference: id(26),
        approvalEvidenceReference: null,
        publicationReference: null,
      },
      auditReference: id(27),
      createdAt: submittedAt,
      recordedAt: submittedAt,
      dataClassification: "ConfigurationMetadata",
    },
    { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
  );
  const review = {
    profile: "MerchantBrandConfigurationRecordedReviewV1",
    configurationVersionReference: id(22),
    configurationSourceDigest: revision.sourceDigest,
    lifecycleReference: id(25),
    lifecycleVersion: 2,
    recordedState: "PendingApproval",
    validationEvidenceReference: id(26),
    submittedByReference: id(20),
    submittedAt,
    reviewValidUntil: "2026-10-06T11:30:00.000Z",
  };
  const response = { ...current, current: revision, recordedReview: review };
  f.configuration.current.mockResolvedValueOnce(response);
  const accepted = await send(root, "/configuration/current", { brandReference: brand });
  expect(accepted.status).toBe(200);
  expect(accepted.body).toEqual(response);
  for (const invalid of [
    { ...response, recordedReview: null },
    Object.fromEntries(Object.entries(response).filter(([key]) => key !== "recordedReview")),
    { ...response, recordedReview: { ...review, callerApproved: true } },
    { ...response, recordedReview: { ...review, submittedByReference: actor } },
    { ...response, recordedReview: { ...review, reviewValidUntil: submittedAt } },
    { ...response, recordedReview: { ...review, lifecycleReference: id(90) } },
  ]) {
    f.configuration.current.mockResolvedValueOnce(invalid);
    expect((await send(root, "/configuration/current", { brandReference: brand })).status).toBe(
      503,
    );
  }
});
it("binds a command result to the exact submitted intent instead of accepting another receipt", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const command = {
    command: "SubmitConfiguration",
    operationReference: id(5),
    expectedBrandVersion: 1,
    expectedHead: {
      revision: 1,
      configurationVersionReference: id(10),
      sourceDigest: `sha256:${"b".repeat(64)}`,
    },
    configuration: null,
    reviewValidUntil: "2026-10-07T12:00:00.000Z",
  };
  const intentDigest = `sha256:${sha256Hex(canonicalizeRfc8785({ profile: "TenantBrandConfigurationCommandV1", ...scope, ...command, purposeCode: "BRAND_CONFIGURATION" }))}`;
  f.configuration.execute.mockResolvedValueOnce({
    ...receipt,
    command: command.command,
    expectedHead: command.expectedHead,
    intentDigest,
  });
  expect(
    (await send(root, "/configuration/execute", { brandReference: brand, command })).status,
  ).toBe(200);
  // A valid receipt for another intent cannot acknowledge this command.
  f.configuration.execute.mockResolvedValueOnce({
    ...receipt,
    command: command.command,
    expectedHead: command.expectedHead,
  });
  expect(
    (await send(root, "/configuration/execute", { brandReference: brand, command })).status,
  ).toBe(503);
});
it.each([
  ["Origin", "https://other.invalid"],
  ["Host", "other.invalid"],
  ["Sec-Fetch-Site", "cross-site"],
  ["X-BOP-CSRF", "bad"],
  ["Origin", ["https://merchant.invalid", "https://merchant.invalid"]],
  ["Cookie", `__Host-bop-merchant=${rawCookie}; __Host-bop-merchant=${rawCookie}`],
] as const)("denies unsafe %s before ordinary source access", async (name, value) => {
  const f = fixture(),
    root = await serve(f.options);
  const result = await send(
    root,
    "/configuration/current",
    { brandReference: brand },
    { [name]: typeof value === "string" ? value : [...value] },
  );
  expect(result.status).toBe(403);
  expect(f.configuration.current).not.toHaveBeenCalled();
});
it("rejects hidden scope/authority fields, wrong Brand, query overrides and oversized JSON", async () => {
  const f = fixture(),
    root = await serve(f.options);
  expect(
    (await send(root, "/configuration/current", { brandReference: brand, actorReference: id(8) }))
      .status,
  ).toBe(400);
  expect((await send(root, "/configuration/current", { brandReference: id(8) })).status).toBe(403);
  expect(
    (await send(root, "/configuration/current?allow=true", { brandReference: brand })).status,
  ).toBe(400);
  expect(
    (
      await send(root, "/configuration/resolve", {
        brandReference: brand,
        command: { ...original, permission: "Allow" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(root, "/configuration/current", {
        brandReference: brand,
        extra: "x".repeat(40_000),
      })
    ).status,
  ).toBe(413);
  expect(f.configuration.current).not.toHaveBeenCalled();
  expect(f.configuration.resolve).not.toHaveBeenCalled();
});
it("refuses wrong-reader and expired owner responses, while preserving exact bounded conflicts", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.configuration.current.mockResolvedValueOnce({ ...current, actorReference: id(9) });
  expect((await send(root, "/configuration/current", { brandReference: brand })).status).toBe(503);
  f.time.now = until;
  expect((await send(root, "/configuration/current", { brandReference: brand })).status).toBe(503);
  f.time.now = at;
  f.configuration.resolve.mockRejectedValueOnce(
    new BrandConfigurationOperationError("BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT"),
  );
  expect(
    (await send(root, "/configuration/resolve", { brandReference: brand, command: original }))
      .status,
  ).toBe(409);
});
it("hides malformed navigation and does not intercept the existing Store topology routes", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.bootstrap.mockResolvedValueOnce({
    ...bootstrap,
    workspace: { ...view, selectedScope: { ...scope, actorReference: id(9) } },
  });
  expect((await send(root, "/session")).status).toBe(503);
  expect(
    (await send(root, "/topology/draft/workspace", undefined, { Host: "irrelevant.invalid" }))
      .status,
  ).toBe(404);
});

it.each(["Draft", "Active", "Suspended", "Archived"] as const)(
  "serves actual administrative %s lifecycle through the session transport",
  async (lifecycle) => {
    const f = fixture(),
      root = await serve(f.options);
    const workspace = { ...view, brand: { ...view.brand, lifecycle } };
    f.service.bootstrap.mockResolvedValue({ ...bootstrap, workspace });
    const result = await send(root, "/session");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ authenticated: true, csrf, recentMfaRequired: false, workspace });
    expect(f.configuration.execute).not.toHaveBeenCalled();
    expect(f.catalogSource.register).not.toHaveBeenCalled();
  },
);
it("refuses an unknown administrative lifecycle from the service", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const workspace = { ...view, brand: { ...view.brand } };
  Object.defineProperty(workspace.brand, "lifecycle", { value: "Unknown", enumerable: true });
  f.service.bootstrap.mockResolvedValue({ ...bootstrap, workspace });
  expect((await send(root, "/session")).status).toBe(503);
});

it("exposes expired MFA without workspace or private proof, and starts a real challenge", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.bootstrap.mockResolvedValueOnce({
    ...bootstrap,
    recentMfaRequired: true,
    workspace: null,
  });
  const result = await send(root, "/session");
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    authenticated: true,
    csrf,
    recentMfaRequired: true,
    workspace: null,
  });
  const challenge = await send(root, "/session/rotate", {});
  expect(challenge.body).toEqual({
    status: "step_up_required",
    authorizationUrl: "https://identity.invalid/authorize",
  });
  expect(challenge.headers["set-cookie"]?.[0]).toContain("__Host-bop-auth=");
  expect(f.service.authorize).not.toHaveBeenCalled();
});
it("preserves cookies for unknown logout and retries owner logout without preauthorizing a revoked Session", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.authorize.mockRejectedValue(new Error("local Session already revoked"));
  f.service.logout.mockResolvedValueOnce({
    status: "Unknown",
    cookies: [],
    browserLogoutUrl: null,
  });
  const unknown = await send(root, "/session/logout", {});
  expect(unknown.status).toBe(200);
  expect(unknown.body).toEqual({ status: "logout_unknown" });
  expect(unknown.headers["set-cookie"]).toBeUndefined();
  const confirmed = await send(root, "/session/logout", {});
  expect(confirmed.body).toEqual({ status: "browser_logout_required", logoutUrl });
  expect(confirmed.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  expect(f.service.authorize).not.toHaveBeenCalled();
  expect(f.service.logout).toHaveBeenNthCalledWith(2, { sessionCookie: rawCookie, csrf });
});
it.each([
  "https://other.invalid/authorize",
  "http://identity.invalid/authorize",
  "https://user:password@identity.invalid/authorize",
])("rejects an unconfigured authentication redirect %s", async (authorizationUrl) => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.start.mockResolvedValueOnce({
    authorizationUrl,
    cookie: { ...mutation, descriptor: authorizationCookie },
  });
  f.service.rotate.mockResolvedValueOnce({
    authorizationUrl,
    cookie: { ...mutation, descriptor: authorizationCookie },
  });
  expect((await send(root, "/login")).status).toBe(503);
  const result = await send(root, "/session/rotate", {});
  expect(result.status).toBe(503);
  expect(result.headers["set-cookie"]).toBeUndefined();
});
it("refuses altered fixed logout destination and contradictory MFA workspace", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.logout.mockResolvedValueOnce({
    status: "BrowserLogoutRequired",
    cookies: [{ descriptor: merchantSessionCookie, value: "", clear: true }],
    browserLogoutUrl: "https://identity.invalid/logout?other=1",
  });
  const result = await send(root, "/session/logout", {});
  expect(result.status).toBe(503);
  expect(result.headers["set-cookie"]).toBeUndefined();
  f.service.bootstrap.mockResolvedValueOnce({
    ...bootstrap,
    recentMfaRequired: true,
    workspace: view,
  });
  expect((await send(root, "/session")).status).toBe(503);
});

// Discovery HTTP tests use controlled genuine public Session fixtures. They do
// not replace native encrypted-session/selection/IAM owner integration.
function directoryFixture() {
  const f = fixture();
  const discovery = {
    discoveryBootstrap: vi.fn(async () => ({
      authenticated: true as const,
      csrf,
      recentMfaRequired: false,
      actorReference: actor,
      selectedBrandReference: null as string | null,
    })),
    list: vi.fn(async () => ({
      profile: "MerchantBrandDiscoveryV1" as const,
      actorReference: actor,
      afterBrandReference: null as string | null,
      items: [
        {
          brandReference: brand,
          code: "REAL-BRAND",
          displayName: "Synthetic Brand",
          lifecycle: "Draft" as const,
          defaultLocale: "en-CA",
          version: 1,
        },
      ],
      hasMore: false,
      nextAfterBrandReference: null as string | null,
      observedAt: at,
      validUntil: until,
    })),
    select: vi.fn(async () => ({ actorReference: actor, brandReference: brand, href: path })),
  } satisfies NonNullable<MerchantBrandAdministrationHttpOptions["discovery"]>;
  f.service.callback.mockResolvedValue({
    postLoginPath: "/app/organization/brands",
    session,
    cookies: [{ descriptor: authorizationCookie, value: "", clear: true }, mutation],
  });
  return {
    ...f,
    discovery,
    options: {
      ...f.options,
      brandReference: null,
      discovery,
    } satisfies MerchantBrandAdministrationHttpOptions,
  };
}
it("directory login is canonical and never accepts browser-requested Brand or return URL", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  expect((await send(root, "/login")).status).toBe(303);
  expect(f.service.start).toHaveBeenCalledWith("/app/organization/brands");
  expect((await send(root, `/login?brandReference=${brand}`)).status).toBe(400);
  expect((await send(root, "/callback?code=controlled&state=controlled")).headers.location).toBe(
    "/app/organization/brands",
  );
});
it("directory discovery exposes closed current Session and bound list/selection only after CSRF authorization", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  const first = await send(root, "/discovery/session");
  expect(first.status).toBe(200);
  expect(first.body).toEqual({
    authenticated: true,
    csrf,
    recentMfaRequired: false,
    actorReference: actor,
    selectedBrandReference: null,
  });
  expect(first.headers["cache-control"]).toBe("no-store");
  const list = await send(root, "/discovery/list", { afterBrandReference: null });
  expect(list.status).toBe(200);
  expect(f.service.authorize).toHaveBeenCalledWith({ sessionCookie: rawCookie, csrf });
  const selected = await send(root, "/discovery/select", {
    brandReference: brand,
    expectedSelectedBrandReference: null,
  });
  expect(selected.status).toBe(200);
  expect(selected.body).toEqual({ actorReference: actor, brandReference: brand, href: path });
  expect(f.discovery.select).toHaveBeenCalledWith({
    sessionCookie: rawCookie,
    csrf,
    brandReference: brand,
    expectedSelectedBrandReference: null,
  });
});
it("anonymous or malformed Session cookies require access without calling bootstrap owners", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  for (const cookie of [
    [],
    "unrelated=opaque",
    "__Host-bop-merchant=invalid",
    `__Host-bop-merchant=${rawCookie}; __Host-bop-merchant=${rawCookie}`,
  ]) {
    for (const route of ["/session", "/discovery/session"]) {
      const response = await send(root, route, undefined, { Cookie: cookie });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "request_denied" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  }
  expect(f.service.bootstrap).not.toHaveBeenCalled();
  expect(f.discovery.discoveryBootstrap).not.toHaveBeenCalled();
});
it("maps confirmed discovery denial to access required while unavailable and unknown remain failures", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  for (const [error, status, code] of [
    [new MerchantBrandDiscoveryError("Denied"), 403, "request_denied"],
    [new MerchantBrandDiscoveryError("Unavailable"), 503, "brand_administration_unavailable"],
    [new Error("controlled infrastructure failure"), 503, "brand_administration_unavailable"],
  ] as const) {
    f.service.bootstrap.mockRejectedValueOnce(error);
    f.discovery.discoveryBootstrap.mockRejectedValueOnce(error);
    for (const route of ["/session", "/discovery/session"]) {
      const response = await send(root, route);
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error: code });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  }
});
it("directory session distinguishes unselected from actual selected workspace and expired MFA", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  f.service.bootstrap.mockResolvedValue({ ...bootstrap, workspace: null });
  const empty = await send(root, "/session");
  expect(empty.status).toBe(409);
  expect(empty.body).toEqual({ error: "brand_selection_required" });
  f.service.bootstrap.mockResolvedValue({ ...bootstrap, workspace: view });
  expect((await send(root, "/session")).status).toBe(200);
  f.service.bootstrap.mockResolvedValue({ ...bootstrap, recentMfaRequired: true, workspace: null });
  expect((await send(root, "/session")).body).toMatchObject({
    recentMfaRequired: true,
    workspace: null,
  });
});
it("discovery malformed bodies/cookies/CSRF/cross-origin requests cannot reach owning selection", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  for (const body of [
    { brandReference: brand },
    { brandReference: brand, expectedSelectedBrandReference: null, actorReference: actor },
    { brandReference: "bad", expectedSelectedBrandReference: null },
  ])
    expect((await send(root, "/discovery/select", body)).status).toBe(400);
  expect(
    (
      await send(
        root,
        "/discovery/select",
        { brandReference: brand, expectedSelectedBrandReference: null },
        { Origin: "https://foreign.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(
        root,
        "/discovery/select",
        { brandReference: brand, expectedSelectedBrandReference: null },
        { Cookie: `__Host-bop-merchant=${rawCookie}; __Host-bop-merchant=${rawCookie}` },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(
        root,
        "/discovery/select",
        { brandReference: brand, expectedSelectedBrandReference: null },
        { "X-BOP-CSRF": "bad" },
      )
    ).status,
  ).toBe(403);
  expect(f.discovery.select).not.toHaveBeenCalled();
});
it("discovery refuses forged Actor/cursor/expired outputs and captured port drift after await", async () => {
  const f = directoryFixture(),
    root = await serve(f.options),
    original = await f.discovery.list();
  for (const value of [
    { ...original, actorReference: id(9) },
    { ...original, afterBrandReference: id(8) },
    { ...original, validUntil: at },
  ]) {
    f.discovery.list.mockResolvedValue(value);
    expect((await send(root, "/discovery/list", { afterBrandReference: null })).status).toBe(503);
  }
  f.discovery.list.mockImplementation(async () => {
    f.time.now = until;
    return original;
  });
  expect((await send(root, "/discovery/list", { afterBrandReference: null })).status).toBe(503);
  f.time.now = at;
  f.discovery.list.mockImplementation(async () => {
    f.options.clock.now = () => at;
    return original;
  });
  expect((await send(root, "/discovery/list", { afterBrandReference: null })).status).toBe(503);
});
it("directory filtered empty scanned pages advance and preserve finite selection conflict/unknown", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  f.discovery.list.mockResolvedValue({
    profile: "MerchantBrandDiscoveryV1",
    actorReference: actor,
    afterBrandReference: null,
    items: [],
    hasMore: true,
    nextAfterBrandReference: id(9),
    observedAt: at,
    validUntil: until,
  });
  expect((await send(root, "/discovery/list", { afterBrandReference: null })).body).toMatchObject({
    items: [],
    hasMore: true,
    nextAfterBrandReference: id(9),
  });
  f.discovery.select.mockRejectedValue(new MerchantBrandDiscoveryError("SelectionConflict"));
  expect(
    (
      await send(root, "/discovery/select", {
        brandReference: brand,
        expectedSelectedBrandReference: null,
      })
    ).body,
  ).toEqual({ error: "brand_selection_conflict" });
  f.discovery.select.mockRejectedValue(new Error("controlled unknown"));
  expect(
    (
      await send(root, "/discovery/select", {
        brandReference: brand,
        expectedSelectedBrandReference: null,
      })
    ).status,
  ).toBe(503);
});
it("directory configuration body supplies only requested Brand while actual selected service decides admission", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  expect((await send(root, "/configuration/current", { brandReference: brand })).status).toBe(200);
  f.configuration.current.mockRejectedValue(
    new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED"),
  );
  expect((await send(root, "/configuration/current", { brandReference: id(99) })).status).toBe(403);
  expect(f.configuration.current).toHaveBeenLastCalledWith({
    sessionCookie: rawCookie,
    csrf,
    expectedBrandReference: id(99),
  });
});

it("directory forged successful selection never invents a navigation scope", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  f.discovery.select.mockResolvedValue({
    actorReference: id(99),
    brandReference: brand,
    href: path,
  });
  const result = await send(root, "/discovery/select", {
    brandReference: brand,
    expectedSelectedBrandReference: null,
  });
  expect(result.status).toBe(503);
  expect(result.headers.location).toBeUndefined();
  expect(result.raw).not.toContain(id(99));
});

it("accepts legitimate same-site Cognito callback while unsafe discovery POST remains same-origin only", async () => {
  const f = directoryFixture(),
    root = await serve(f.options);
  const returned = await send(root, "/callback?code=controlled&state=controlled", undefined, {
    "Sec-Fetch-Site": "same-site",
  });
  expect(returned.status).toBe(303);
  expect(returned.headers.location).toBe("/app/organization/brands");
  const denied = await send(
    root,
    "/discovery/select",
    { brandReference: brand, expectedSelectedBrandReference: null },
    { "Sec-Fetch-Site": "same-site" },
  );
  expect(denied.status).toBe(403);
  expect(f.discovery.select).not.toHaveBeenCalled();
});

const lifecycleCommand = {
  brandReference: brand,
  action: "ActivateBrand" as const,
  expectedBrandVersion: 1,
  operationReference: id(401),
};
function lifecycleFixture(directory = false) {
  const f = directory ? directoryFixture() : fixture();
  const original = parseMerchantBrandLifecycleReceipt(
    {
      profile: "MerchantBrandLifecycleReceiptV1",
      actorReference: actor,
      ...lifecycleCommand,
      status: "Applied",
      lifecycle: "Active",
      version: 2,
      occurredAt: at,
    },
    lifecycleCommand,
    actor,
    at,
  );
  const lifecycle = { execute: vi.fn(async () => original) };
  return { ...f, original, lifecycle, options: { ...f.options, lifecycle } };
}
it.each([false, true])(
  "executes current authorized lifecycle via dedicated ordinary route; directory=%s",
  async (directory) => {
    const f = lifecycleFixture(directory),
      root = await serve(f.options);
    const result = await send(root, "/lifecycle", lifecycleCommand);
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual(f.original);
    expect(f.service.authorize).toHaveBeenCalledWith({ sessionCookie: rawCookie, csrf });
    expect(f.lifecycle.execute).toHaveBeenCalledWith({
      sessionCookie: rawCookie,
      csrf,
      command: lifecycleCommand,
    });
  },
);
it("lifecycle rejects malformed or fixed foreign scope before dispatch", async () => {
  const f = lifecycleFixture(),
    root = await serve(f.options);
  for (const body of [
    { ...lifecycleCommand, actorReference: actor },
    { ...lifecycleCommand, action: "CreateBrand" },
    { ...lifecycleCommand, expectedBrandVersion: 0 },
  ])
    expect((await send(root, "/lifecycle", body)).status).toBe(400);
  expect(
    (await send(root, "/lifecycle", { ...lifecycleCommand, brandReference: id(9) })).status,
  ).toBe(403);
  expect(f.lifecycle.execute).not.toHaveBeenCalled();
});
it("lifecycle preserves an original receipt after later current state without renewing its time", async () => {
  const f = lifecycleFixture(),
    root = await serve(f.options);
  f.lifecycle.execute.mockResolvedValue({ ...f.original, status: "AlreadyApplied" });
  f.time.now = "2026-10-07T12:00:00.000Z";
  const result = await send(root, "/lifecycle", lifecycleCommand);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ status: "AlreadyApplied", occurredAt: at, version: 2 });
});
it.each(["Actor", "Operation", "Version", "Port", "Expired"])(
  "lifecycle refuses a misbound or stale response %s",
  async (kind) => {
    const f = lifecycleFixture(),
      root = await serve(f.options);
    f.lifecycle.execute.mockImplementation(async () => {
      if (kind === "Port") f.options.lifecycle = { execute: vi.fn(async () => f.original) };
      if (kind === "Expired") f.time.now = until;
      return {
        ...f.original,
        ...(kind === "Actor" ? { actorReference: id(9) } : {}),
        ...(kind === "Operation" ? { operationReference: id(9) } : {}),
        ...(kind === "Version" ? { version: parseOrganizationVersion(3) } : {}),
      };
    });
    const result = await send(root, "/lifecycle", lifecycleCommand);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "brand_lifecycle_unavailable" });
  },
);
it("lifecycle exposes only the service's confirmed prewrite Conflict as clearable409", async () => {
  const f = lifecycleFixture(),
    root = await serve(f.options);
  f.lifecycle.execute.mockRejectedValue(new MerchantBrandLifecycleError("Conflict"));
  const confirmed = await send(root, "/lifecycle", lifecycleCommand);
  expect(confirmed.status).toBe(409);
  expect(confirmed.body).toEqual({ error: "brand_lifecycle_conflict" });
  f.lifecycle.execute.mockRejectedValue(new Error("synthetic unknown"));
  const unknown = await send(root, "/lifecycle", lifecycleCommand);
  expect(unknown.status).toBe(503);
  expect(unknown.body).toEqual({ error: "brand_lifecycle_unavailable" });
  f.lifecycle.execute.mockRejectedValue(new MerchantBrandLifecycleError("Denied"));
  expect((await send(root, "/lifecycle", lifecycleCommand)).status).toBe(403);
});
it("unconfigured lifecycle remains explicitly unavailable", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const result = await send(root, "/lifecycle", lifecycleCommand);
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: "brand_lifecycle_unavailable" });
});
it.each([
  { Origin: "https://foreign.invalid" },
  { "Sec-Fetch-Site": "same-site" },
  { "X-BOP-CSRF": "bad" },
  { Cookie: "" },
  { Host: "foreign.invalid" },
])("lifecycle cannot dispatch with unsafe request headers %j", async (headers) => {
  const f = lifecycleFixture(),
    root = await serve(f.options);
  expect((await send(root, "/lifecycle", lifecycleCommand, headers)).status).toBe(403);
  expect(f.lifecycle.execute).not.toHaveBeenCalled();
});

it("starts configured invitation anonymously at the fixed POST entry and returns only authorization URL/auth cookie", async () => {
  const f = fixture(),
    startInvitation = vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    root = await serve({ ...f.options, service: { ...f.service, startInvitation } });
  const result = await send(
    root,
    "/invitation",
    { secret: rawCookie },
    { Cookie: "", "X-BOP-CSRF": "" },
  );
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ authorizationUrl: "https://identity.invalid/authorize" });
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.headers["set-cookie"]).toHaveLength(1);
  expect(result.headers["set-cookie"]?.[0]).toContain("__Host-bop-auth=");
  expect(result.headers["set-cookie"]?.[0]).toContain("Secure; HttpOnly; SameSite=Lax");
  expect(result.headers["set-cookie"]?.[0]).not.toContain("__Host-bop-merchant");
  expect(result.raw).not.toContain(rawCookie);
  expect(startInvitation).toHaveBeenCalledExactlyOnceWith(rawCookie);
  expect(f.service.authorize).not.toHaveBeenCalled();
  expect(f.service.start).not.toHaveBeenCalled();
  expect(f.service.bootstrap).not.toHaveBeenCalled();
  expect(f.configuration.execute).not.toHaveBeenCalled();
});
it("returns generic unavailable for disabled invitation mode without attempting ordinary login", async () => {
  const f = fixture(),
    root = await serve(f.options),
    result = await send(
      root,
      "/invitation",
      { secret: rawCookie },
      { Cookie: "", "X-BOP-CSRF": "" },
    );
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: "brand_administration_unavailable" });
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(f.service.start).not.toHaveBeenCalled();
});
it.each([
  {},
  { secret: "bad" },
  { secret: rawCookie, postLoginPath: path },
  { secret: rawCookie, actorReference: actor },
])("denies malformed invitation body before source calls", async (body) => {
  const f = fixture(),
    startInvitation = vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    root = await serve({ ...f.options, service: { ...f.service, startInvitation } });
  const result = await send(root, "/invitation", body);
  expect(result.status).toBe(400);
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(startInvitation).not.toHaveBeenCalled();
});
it.each([
  { Origin: "https://foreign.invalid" },
  { Host: "foreign.invalid" },
  { "Sec-Fetch-Site": "cross-site" },
])("denies foreign invitation transport before source calls: %j", async (headers) => {
  const f = fixture(),
    startInvitation = vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    root = await serve({ ...f.options, service: { ...f.service, startInvitation } });
  const result = await send(root, "/invitation", { secret: rawCookie }, headers);
  expect(result.status).toBe(403);
  expect(startInvitation).not.toHaveBeenCalled();
  expect(result.headers["set-cookie"]).toBeUndefined();
});
it("rejects invitation POST query and public GET without invoking the source", async () => {
  const f = fixture(),
    startInvitation = vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    root = await serve({ ...f.options, service: { ...f.service, startInvitation } });
  expect((await send(root, "/invitation?unexpected=1", { secret: rawCookie })).status).toBe(400);
  expect((await send(root, "/invitation")).status).toBe(404);
  expect(startInvitation).not.toHaveBeenCalled();
});
it("sanitizes invitation refusal and malformed authorization responses without setting any cookies", async () => {
  const f = fixture(),
    startInvitation = vi.fn(async () => ({
      authorizationUrl: "https://identity.invalid/authorize",
      cookie: { ...mutation, descriptor: authorizationCookie },
    })),
    root = await serve({ ...f.options, service: { ...f.service, startInvitation } });
  startInvitation.mockRejectedValueOnce(new Error(`Controlled private failure ${rawCookie}`));
  const failed = await send(root, "/invitation", { secret: rawCookie });
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ error: "brand_administration_unavailable" });
  expect(failed.headers["set-cookie"]).toBeUndefined();
  expect(failed.raw).not.toContain(rawCookie);
  startInvitation.mockResolvedValueOnce({
    authorizationUrl: "https://foreign.invalid/authorize",
    cookie: { ...mutation, descriptor: authorizationCookie },
  });
  const bad = await send(root, "/invitation", { secret: rawCookie });
  expect(bad.status).toBe(503);
  expect(bad.headers["set-cookie"]).toBeUndefined();
});
