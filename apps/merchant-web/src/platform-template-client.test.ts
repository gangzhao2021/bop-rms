import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicationValueDigest as hash } from "./product-publication-command-client-v2.js";
import {
  createPlatformTemplateClient,
  parsePlatformTemplateContent,
  parsePlatformTemplateReceipt,
  parsePlatformTemplatePublishingSource,
  parsePlatformTemplateQueryResult,
  type PreparedPlatformTemplate,
} from "./platform-template-client.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  scope = {
    kind: "Platform" as const,
    actorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE" as const,
  },
  csrf = Buffer.alloc(32, 51).toString("base64url");
const content = {
  code: "BRAND_STANDARD",
  name: "Brand standard",
  defaultLocale: "en-CA",
  supportedLocales: ["fr-CA", "en-CA"],
  overrideAllowedFieldCodes: ["CONTACT", "ADDRESS"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
};
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function client(fetcher: typeof fetch = vi.fn<typeof fetch>(async () => response({}))) {
  return createPlatformTemplateClient({ fetcher, now: () => new Date(Date.now()).toISOString() });
}
async function prepared(operationReference = id(2)) {
  return client().prepareSave(scope, {
    operationReference,
    templateReference: null,
    expectedHead: null,
    content,
  });
}
async function snapshot(p: PreparedPlatformTemplate) {
  if (p.request.action !== "Save") throw Error("expected Save");
  const body = {
    profile: "PlatformBrandTemplateRevisionV1",
    templateReference: id(3),
    templateVersionReference: id(4),
    revision: 1,
    recordKind: "AuthoredContent",
    content: p.request.content,
    supersedesVersionReference: null,
    authoredByReference: scope.actorReference,
    operationReference: p.original.operationReference,
    auditReference: id(5),
    createdAt: at,
    recordedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const semantic = {
    profile: "PlatformBrandTemplateContentV1",
    templateReference: body.templateReference,
    templateVersionReference: body.templateVersionReference,
    revision: body.revision,
    content: {
      ...body.content,
      supportedLocales: [...body.content.supportedLocales].sort(),
      overrideAllowedFieldCodes: [...body.content.overrideAllowedFieldCodes].sort(),
      hardRequirementFieldCodes: [...body.content.hardRequirementFieldCodes].sort(),
    },
    supersedesVersionReference: body.supersedesVersionReference,
    authoredByReference: body.authoredByReference,
    createdAt: body.createdAt,
    dataClassification: body.dataClassification,
  };
  const contentDigest = await hash(semantic),
    full = { ...body, contentDigest };
  return { ...full, sourceDigest: await hash(full) };
}
async function receipt(p: PreparedPlatformTemplate, abandoned = false) {
  if (p.request.action !== "Save") throw Error("expected Save");
  const { action, ...request } = p.request;
  void action;
  return {
    profile: "PlatformBrandTemplateOperationV1",
    ...scope,
    operationReference: p.original.operationReference,
    intentDigest: p.original.intentDigest,
    originalCommand: abandoned
      ? null
      : { profile: "PlatformBrandTemplateSaveV1", ...scope, ...request },
    outcome: abandoned ? "Abandoned" : "Committed",
    snapshot: abandoned ? null : await snapshot(p),
    auditReference: id(5),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
const current = (value: unknown = null, reader = scope) => ({
  profile: "PlatformBrandTemplateCurrentV1",
  ...reader,
  templateReference: id(3),
  current: value,
  observedAt: at,
  validUntil: until,
  publication: "NotEvaluated",
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("derives complete ordered owner intent from real Actor but never sends Actor or first-family IDs", async () => {
  const p = await prepared(),
    fetcher = vi.fn<typeof fetch>(async () => response(await receipt(p))),
    api = client(fetcher);
  expect(p.original).toMatchObject({
    owner: "Save",
    templateReference: null,
    actorReference: scope.actorReference,
  });
  if (p.request.action !== "Save") throw Error("expected Save");
  const { action, ...q } = p.request;
  void action;
  expect(p.original.intentDigest).toBe(
    await hash({ profile: "PlatformBrandTemplateSaveV1", ...scope, ...q }),
  );
  expect(await api.execute(scope, p, { csrf })).toMatchObject({ outcome: "Committed" });
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/platform/templates/command");
  expect(call?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-Bop-Csrf": csrf },
  });
  const text = String(call?.[1]?.body);
  expect(text).not.toContain("actorReference");
  expect(text).not.toContain("purposeCode");
  expect(JSON.parse(text)).toEqual(p.request);
  expect(Object.isFrozen(p.request.content.supportedLocales)).toBe(true);
});
it("preserves array order in intent while validating actual semantic content and source digest", async () => {
  const p = await prepared();
  const q = await client().prepareSave(scope, {
    operationReference: p.original.operationReference,
    templateReference: null,
    expectedHead: null,
    content: { ...content, supportedLocales: ["en-CA", "fr-CA"] },
  });
  expect(q.original.intentDigest).not.toBe(p.original.intentDigest);
  expect(await parsePlatformTemplateReceipt(await receipt(p), p.original)).toMatchObject({
    snapshot: { contentDigest: expect.stringMatching(/^sha256:/u) },
  });
  const r = await receipt(p);
  await expect(
    parsePlatformTemplateReceipt(
      { ...r, snapshot: { ...r.snapshot, sourceDigest: "sha256:" + "a".repeat(64) } },
      p.original,
    ),
  ).rejects.toThrow();
});
it("reads current authored history from another Actor but binds the actual reader and original immutable record", async () => {
  const p = await prepared(),
    s = await snapshot(p),
    reader = { ...scope, actorReference: id(9) },
    fetcher = vi.fn<typeof fetch>(async () => response(current(s, reader)));
  expect(await client(fetcher).current(reader, id(3), { csrf })).toMatchObject({
    current: { authoredByReference: scope.actorReference },
    actorReference: reader.actorReference,
  });
  await expect(client(fetcher).current(scope, id(3), { csrf })).rejects.toMatchObject({
    code: "ScopeChanged",
  });
});
it("reconstructs only immutable resolve scalars and refuses modified prepared intent before dispatch", async () => {
  const p = await prepared(),
    fetcher = vi.fn<typeof fetch>(async () => response(await receipt(p, true))),
    api = client(fetcher);
  expect(await api.resolve(scope, p.original, { csrf })).toMatchObject({ outcome: "Abandoned" });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    action: "ResolveSave",
    operationReference: p.original.operationReference,
    intentDigest: p.original.intentDigest,
  });
  fetcher.mockClear();
  await expect(
    api.execute(
      scope,
      { ...p, original: { ...p.original, intentDigest: "sha256:" + "b".repeat(64) } },
      { csrf },
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("keeps real bootstrap minimal and uses explicit top-level step-up/logout destinations", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input: RequestInfo | URL) =>
      response(
        String(input).endsWith("/session")
          ? {
              authenticated: true,
              session: {
                sessionReference: id(10),
                actorReference: scope.actorReference,
                expiresAt: "2026-10-06T12:15:00.000Z",
              },
              recentMfaRequired: true,
              csrf,
            }
          : String(input).endsWith("/step-up")
            ? {
                status: "step_up_required",
                authorizationUrl:
                  "https://synthetic.auth.ca-central-1.amazoncognito.com/oauth2/authorize?state=synthetic",
              }
            : {
                status: "browser_logout_required",
                logoutUrl:
                  "https://synthetic.auth.ca-central-1.amazoncognito.com/logout?client_id=synthetic",
              },
      ),
    ),
    api = client(fetcher);
  expect(await api.bootstrap()).toMatchObject({
    recentMfaRequired: true,
    session: { actorReference: scope.actorReference },
  });
  expect(await api.stepUp(csrf)).toMatchObject({ status: "step_up_required" });
  expect(await api.logout(csrf)).toMatchObject({ status: "browser_logout_required" });
  for (const [, options] of fetcher.mock.calls) expect(options?.credentials).toBe("same-origin");
});
it("validates fixed Actions and strict original five-second query leases", async () => {
  const packet = {
    profile: "PlatformTemplateActionsV1",
    scope,
    allowedActions: ["platform.brand-template.manage", "platform.brand-template.publish"],
    observedAt: at,
    validUntil: until,
  };
  expect(
    await client(vi.fn<typeof fetch>(async () => response(packet))).actions(scope, { csrf }),
  ).toEqual(packet);
  await expect(
    parsePlatformTemplateQueryResult(
      { ...packet, allowedActions: ["tenant.manage"] },
      scope,
      { action: "Actions" },
      at,
    ),
  ).rejects.toThrow();
  await expect(
    parsePlatformTemplateQueryResult(
      { ...packet, validUntil: "2026-10-06T12:00:05.001Z" },
      scope,
      { action: "Actions" },
      at,
    ),
  ).rejects.toThrow();
  await expect(
    parsePlatformTemplateQueryResult(packet, scope, { action: "Actions" }, until),
  ).rejects.toMatchObject({ code: "Stale" });
});
it.each([403, 409, 503])(
  "retains finite %s command failure and unknown outcome semantics",
  async (status) => {
    const p = await prepared();
    await expect(
      client(
        vi.fn<typeof fetch>(async () => response({ error: "request_denied" }, status)),
      ).execute(scope, p, { csrf }),
    ).rejects.toMatchObject({
      code: status === 403 ? "Denied" : status === 409 ? "Conflict" : "OutcomeUnknown",
    });
  },
);
it("rejects cached/non-JSON/oversized output and prevents invalidated asynchronous read or digest release", async () => {
  const bad = [
    new Response("{}", { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }),
    new Response("{}", {
      headers: { "Content-Type": "application/json", "Cache-Control": "public" },
    }),
    new Response(" ".repeat(131073), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  ];
  for (const r of bad)
    await expect(
      client(vi.fn<typeof fetch>(async () => r)).current(scope, id(3), { csrf }),
    ).rejects.toThrow();
  let release: (value: Response) => void = () => {
    throw Error("not started");
  };
  const api = client(
    vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  const waiting = api.current(scope, id(3), { csrf });
  api.invalidate();
  release(response(current()));
  await expect(waiting).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("rejects sparse/accessor content and byte-for-byte original receipt disagreement", async () => {
  const sparse = new Array(1);
  expect(() => parsePlatformTemplateContent({ ...content, supportedLocales: sparse })).toThrow();
  const p = await prepared(),
    r = await receipt(p);
  await expect(
    parsePlatformTemplateReceipt({ ...r, operationReference: id(8) }, p.original),
  ).rejects.toThrow();
  await expect(
    parsePlatformTemplateReceipt({ ...r, originalCommand: null }, p.original),
  ).rejects.toThrow();
});
it("hashes full immutable Publishing source and reads the genuine Draft pointer", async () => {
  const request = {
      profile: "PlatformPublishingRequestV1" as const,
      operation: "CreateDraft" as const,
      operationReference: id(20),
      templateReference: id(3),
      templateVersionReference: id(4),
      contentDigest: "sha256:" + "a".repeat(64),
      templateSourceDigest: "sha256:" + "b".repeat(64),
      expectedLifecycle: null,
      reviewValidUntil: null,
      reasonCode: "ADMIN_CONFIGURATION",
    },
    p = await client().preparePublication(scope, request),
    original = { profile: "PlatformPublishingOriginalV1", scope, request };
  expect(p.original.intentDigest).toBe(await hash(original));
  const next = {
    lifecycleId: id(21),
    familyReference: id(3),
    configurationType: "PLATFORM_BRAND_TEMPLATE",
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    snapshotReference: id(4),
    snapshotDigest: request.contentDigest,
    scope: { kind: "Platform", brandReference: null, storeReference: null },
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
    authoredActorReference: scope.actorReference,
    submittedActorReference: null,
    reviewValidUntil: null,
  };
  const body = {
    profile: "PlatformPublishingSourceV1",
    sequence: 1,
    templateSourceDigest: request.templateSourceDigest,
    originalCommand: original,
    intentDigest: p.original.intentDigest,
    command: {
      profile: "PlatformPublishingCommandV1",
      operation: "CreateDraft",
      operationReference: id(20),
      currentActorReference: scope.actorReference,
      expectedVersion: 1,
      current: null,
      next,
      validationEvidence: null,
      approvalEvidence: null,
      release: null,
      previousRelease: null,
      rollbackTarget: null,
      occurredAt: at,
    },
    auditReference: id(22),
  };
  const source = { ...body, sourceDigest: await hash(body) };
  expect(await parsePlatformTemplatePublishingSource(source)).toEqual(source);
  await expect(
    parsePlatformTemplatePublishingSource({ ...source, auditReference: id(23) }),
  ).rejects.toThrow();
  expect(
    await parsePlatformTemplateQueryResult(
      {
        profile: "PlatformPublishingCurrentV1",
        scope,
        templateReference: id(3),
        lifecycleReference: null,
        current: source,
        currentRelease: null,
        observedAt: at,
        validUntil: until,
      },
      scope,
      { action: "PublicationCurrent", templateReference: id(3), lifecycleReference: null },
      at,
    ),
  ).toMatchObject({ current: source });
});

it("binds only the exact Platform scope within a strictly parsed scalar pending original", async () => {
  const p = await prepared(),
    terminal = await receipt(p, true);
  expect(await parsePlatformTemplateReceipt(terminal, p.original)).toMatchObject({
    outcome: "Abandoned",
  });
  await expect(
    parsePlatformTemplateReceipt(terminal, { ...p.original, actorReference: id(9) }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
