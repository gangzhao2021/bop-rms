import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { canonicalizeRfc8785 } from "../../../packages/bop/audit/src/index.js";
import {
  parsePlatformBrandTemplateSave,
  createPlatformBrandTemplateRevision,
  parsePlatformBrandTemplateReceipt,
  parsePlatformBrandTemplateCurrent,
  parsePlatformBrandTemplateExact,
  parsePlatformBrandTemplateHistory,
  parsePlatformBrandTemplateList,
  parsePlatformBrandTemplateListRequest,
  type PlatformBrandTemplateRevision,
} from "../../../packages/bop/tenant/src/contracts/platform-brand-template.js";
import {
  buildPlatformPublishingSource,
  parsePlatformPublishingSourceScope,
  parsePlatformPublishingRequest,
  parsePlatformPublishingOriginal,
  platformPublishingIntentDigest,
  parsePlatformPublishingReceipt,
  parsePlatformPublishingCurrent,
  parsePlatformPublishingExact,
  parsePlatformPublishingHistory,
  type PlatformPublishingSource,
} from "../../../packages/bop/publishing/src/contracts/platform-publishing-source.js";
import { createIdentityActor } from "../../../packages/bop/identity/src/contracts/identity-actor.js";
import { createAuthenticationSession } from "../../../packages/bop/identity/src/contracts/authentication-session.js";

const id = (n: number) => `01902630-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const author = id(1),
  reviewer = id(2);
const scopeFor = (actorReference: string) =>
  parsePlatformPublishingSourceScope({
    kind: "Platform",
    actorReference,
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
  });
const pureScope = { kind: "Platform", brandReference: null, storeReference: null };
const codec = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (v: string) => `sha256:${createHash("sha256").update(v).digest("hex")}`,
};
const actions = [
  "platform.brand-template.manage",
  "platform.brand-template.submit",
  "platform.brand-template.approve",
  "platform.brand-template.publish",
  "platform.brand-template.archive",
];
const respond = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
const now = async (page: Page) => new Date(await page.evaluate(() => Date.now())).toISOString();
const panel = (page: Page) => page.getByRole("region", { name: "Templates", exact: true });
const button = (page: Page, name: string) => panel(page).getByRole("button", { name, exact: true });
const errors = new WeakMap<Page, string[]>();
test.setTimeout(90000);
test.beforeEach(async ({ page }) => {
  const found: string[] = [];
  errors.set(page, found);
  page.on("pageerror", (error) => found.push(error.message));
  await page.clock.install();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator(".vite-error-overlay, vite-error-overlay")).toHaveCount(0);
});

/** Controlled normal-App HTTP, permission and Provider responses. Every saved
 * content/review/receipt is made with actual public owner parsers and hashes.
 * This rendered proof does not establish real Cognito, IAM, PostgreSQL or an
 * installed environment; those have separate native/external acceptance. */
async function backend(page: Page) {
  let allocated = 100;
  let applicationOrigin = "";
  let seededCookie = false;
  let stepUpAt: string | null = null;
  // HTTP loopback transport fixture, not a production __Host cookie or encrypted
  // Session. The actual HTTPS cookie/profile has separate HTTP/native coverage.
  const cookieName = "bop-controlled-platform-session";
  const next = () => id(allocated++);
  function sessionFor(actorReference: string, at: string, previous: string | null = null) {
    return createAuthenticationSession({
      sessionReference: next(),
      actor: createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      }),
      status: "Active",
      policyCode: "Privileged",
      maxActiveSessions: 2,
      idleTimeoutMinutes: 15,
      absoluteTimeoutMinutes: 480,
      version: 1,
      authenticatedAt: at,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: new Date(Date.parse(at) + 900000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(at) + 28800000).toISOString(),
      rotatedFromSessionReference: previous,
      revocationReason: null,
      revokedAt: null,
    });
  }
  const state = {
    session: sessionFor(author, await now(page)),
    csrf: "s".repeat(43),
    authenticated: true,
    mfaRequired: false,
    allowed: [...actions],
    denyRecovery: false,
    loseSaveReply: false,
    dropSaveBeforeApply: false,
    deniedStoreBootstrapRequests: 0,
    rotations: 0,
    logouts: 0,
    saves: [] as ReturnType<typeof parsePlatformBrandTemplateSave>[],
    publications: [] as ReturnType<typeof parsePlatformPublishingRequest>[],
    resolves: 0,
  };
  const content = new Map<string, PlatformBrandTemplateRevision[]>(),
    publications = new Map<string, PlatformPublishingSource[]>();
  const activeRelease = new Map<string, PlatformPublishingSource>();
  const contentReceipts = new Map<string, ReturnType<typeof parsePlatformBrandTemplateReceipt>>();
  const publicationReceipts = new Map<string, ReturnType<typeof parsePlatformPublishingReceipt>>();
  const scope = () => scopeFor(String(state.session.actor.actorReference));
  async function installCookie() {
    await page.context().addCookies([
      {
        name: cookieName,
        value: String(state.session.sessionReference),
        url: applicationOrigin,
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
      },
    ]);
  }
  async function authenticatedRequest(route: Route, post: boolean) {
    const request = route.request(),
      headers = await request.allHeaders();
    const cookie =
      headers.cookie
        ?.split(";")
        .map((item) => item.trim())
        .filter((item) => item.startsWith(cookieName + "=")) ?? [];
    // CDP route interception omits fetch metadata and sometimes Origin. Require
    // actual frame/URL/Referer agreement here, and reject any conflicting header
    // that is exposed. Mandatory production headers remain HTTP/native coverage.
    if (!headers.referer) return false;
    return (
      state.authenticated &&
      new URL(request.url()).origin === applicationOrigin &&
      new URL(request.frame().url()).origin === applicationOrigin &&
      new URL(headers.referer).origin === applicationOrigin &&
      cookie.length === 1 &&
      cookie[0] === `${cookieName}=${state.session.sessionReference}` &&
      (headers["sec-fetch-site"] === undefined || headers["sec-fetch-site"] === "same-origin") &&
      (headers.origin === undefined || headers.origin === applicationOrigin) &&
      (!post ||
        (request.method() === "POST" &&
          headers["x-bop-csrf"] === state.csrf &&
          headers["content-type"] === "application/json"))
    );
  }
  const key = (operation: string) => `${scope().actorReference}:${operation}`;
  const lease = (at: string) => ({
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
  });
  const latest = (family: string) => content.get(family)?.at(-1) ?? null;
  const exact = (version: string) =>
    [...content.values()].flat().find((row) => row.templateVersionReference === version) ?? null;
  function list(after: unknown, limit: unknown, at: string) {
    const request = parsePlatformBrandTemplateListRequest({ after, limit });
    const matching = [...content.values()]
      .flatMap((rows) => {
        const row = rows.at(-1);
        return row ? [row] : [];
      })
      .sort((a, b) =>
        a.content.code < b.content.code
          ? -1
          : a.content.code > b.content.code
            ? 1
            : a.templateReference.localeCompare(b.templateReference),
      )
      .filter(
        (row) =>
          !request.after ||
          row.content.code > request.after.code ||
          (row.content.code === request.after.code &&
            row.templateReference > request.after.templateReference),
      );
    const rows = matching.slice(0, request.limit),
      last = rows.at(-1),
      more = matching.length > request.limit;
    return parsePlatformBrandTemplateList({
      profile: "PlatformBrandTemplateListV1",
      ...scope(),
      ...request,
      items: rows.map((r) => ({
        templateReference: r.templateReference,
        templateVersionReference: r.templateVersionReference,
        revision: r.revision,
        code: r.content.code,
        name: r.content.name,
        contentDigest: r.contentDigest,
        sourceDigest: r.sourceDigest,
        authoredByReference: r.authoredByReference,
        recordedAt: r.recordedAt,
      })),
      hasMore: more,
      nextCursor:
        more && last
          ? { code: last.content.code, templateReference: last.templateReference }
          : null,
      ...lease(at),
      publication: "NotEvaluated",
    });
  }
  function query(body: Record<string, unknown>, at: string): unknown {
    const family = String(body.templateReference);
    if (body.action === "Actions")
      return {
        profile: "PlatformTemplateActionsV1",
        scope: scope(),
        allowedActions: state.allowed,
        ...lease(at),
      };
    if (body.action === "List") return list(body.after, body.limit, at);
    if (body.action === "Current")
      return parsePlatformBrandTemplateCurrent(
        {
          profile: "PlatformBrandTemplateCurrentV1",
          ...scope(),
          templateReference: family,
          current: latest(family),
          ...lease(at),
          publication: "NotEvaluated",
        },
        codec,
      );
    if (body.action === "Exact")
      return parsePlatformBrandTemplateExact(
        {
          profile: "PlatformBrandTemplateExactV1",
          ...scope(),
          templateVersionReference: body.templateVersionReference,
          snapshot: exact(String(body.templateVersionReference)),
          ...lease(at),
          publication: "NotEvaluated",
        },
        codec,
      );
    if (body.action === "History") {
      const before = body.beforeRevision;
      if (before !== null && typeof before !== "number")
        throw new Error("Controlled invalid revision cursor");
      const matching = (content.get(family) ?? [])
          .filter((r) => before === null || r.revision < before)
          .toReversed(),
        rows = matching.slice(0, 2);
      return parsePlatformBrandTemplateHistory(
        {
          profile: "PlatformBrandTemplateHistoryV1",
          ...scope(),
          templateReference: family,
          beforeRevision: before,
          entries: rows,
          nextBeforeRevision: matching.length > 2 ? rows.at(-1)?.revision : null,
          ...lease(at),
          publication: "NotEvaluated",
        },
        codec,
      );
    }
    const sources = publications.get(family) ?? [];
    if (body.action === "PublicationCurrent")
      return parsePlatformPublishingCurrent(
        {
          profile: "PlatformPublishingCurrentV1",
          scope: scope(),
          templateReference: family,
          lifecycleReference: body.lifecycleReference,
          current:
            (body.lifecycleReference === null
              ? sources
              : sources.filter((s) => s.command.next.lifecycleId === body.lifecycleReference)
            ).at(-1) ?? null,
          currentRelease: activeRelease.get(family) ?? null,
          ...lease(at),
        },
        scope(),
        at,
      );
    if (body.action === "PublicationExact")
      return parsePlatformPublishingExact(
        {
          profile: "PlatformPublishingExactV1",
          scope: scope(),
          templateReference: family,
          sequence: body.sequence,
          source: sources.find((s) => s.sequence === body.sequence) ?? null,
          ...lease(at),
        },
        scope(),
        at,
      );
    if (body.action === "PublicationHistory") {
      const before = body.beforeSequence;
      if (before !== null && typeof before !== "number")
        throw new Error("Controlled invalid publication cursor");
      const matching = sources.filter((s) => before === null || s.sequence < before).toReversed(),
        items = matching.slice(0, 20);
      return parsePlatformPublishingHistory(
        {
          profile: "PlatformPublishingHistoryV1",
          scope: scope(),
          templateReference: family,
          beforeSequence: before,
          items,
          hasMore: matching.length > 20,
          nextBeforeSequence: matching.length > 20 ? items.at(-1)?.sequence : null,
          ...lease(at),
        },
        scope(),
        at,
      );
    }
    throw new Error("Controlled unknown query");
  }
  function save(body: Record<string, unknown>, at: string) {
    const { action, ...intent } = body;
    expect(action).toBe("Save");
    const command = parsePlatformBrandTemplateSave({
      profile: "PlatformBrandTemplateSaveV1",
      ...scope(),
      ...intent,
    });
    const original = contentReceipts.get(key(command.operationReference));
    if (original) {
      expect(original.intentDigest).toBe(codec.hashIntent(canonicalizeRfc8785(command)));
      return original;
    }
    const prior = command.templateReference ? latest(command.templateReference) : null;
    expect(command.expectedHead).toEqual(
      prior
        ? {
            revision: prior.revision,
            templateVersionReference: prior.templateVersionReference,
            sourceDigest: prior.sourceDigest,
          }
        : null,
    );
    const family = prior?.templateReference ?? next();
    const row = createPlatformBrandTemplateRevision(
      {
        profile: "PlatformBrandTemplateRevisionV1",
        templateReference: family,
        templateVersionReference: next(),
        revision: (prior?.revision ?? 0) + 1,
        recordKind: "AuthoredContent",
        content: command.content,
        supersedesVersionReference: prior?.templateVersionReference ?? null,
        authoredByReference: scope().actorReference,
        operationReference: command.operationReference,
        auditReference: next(),
        createdAt: prior?.createdAt ?? at,
        recordedAt: at,
        dataClassification: "ConfigurationMetadata",
      },
      codec,
    );
    const receipt = parsePlatformBrandTemplateReceipt(
      {
        profile: "PlatformBrandTemplateOperationV1",
        ...scope(),
        operationReference: command.operationReference,
        intentDigest: codec.hashIntent(canonicalizeRfc8785(command)),
        originalCommand: command,
        outcome: "Committed",
        snapshot: row,
        auditReference: row.auditReference,
        occurredAt: at,
        dataClassification: "ConfigurationMetadata",
      },
      codec,
    );
    content.set(family, [...(content.get(family) ?? []), row]);
    contentReceipts.set(key(command.operationReference), receipt);
    state.saves.push(command);
    return receipt;
  }
  function publish(value: unknown, at: string) {
    const request = parsePlatformPublishingRequest(value),
      original = parsePlatformPublishingOriginal({
        profile: "PlatformPublishingOriginalV1",
        scope: scope(),
        request,
      });
    const priorReceipt = publicationReceipts.get(key(request.operationReference));
    if (priorReceipt) {
      expect(priorReceipt.intentDigest).toBe(platformPublishingIntentDigest(original));
      return priorReceipt;
    }
    const saved = exact(String(request.templateVersionReference));
    if (!saved) throw new Error("Controlled missing saved template");
    expect(request.contentDigest).toBe(saved.contentDigest);
    expect(request.templateSourceDigest).toBe(saved.sourceDigest);
    const rows = publications.get(String(request.templateReference)) ?? [];
    const selected =
      request.operation === "CreateDraft"
        ? rows.at(-1)
        : rows
            .filter(
              (s) => s.command.next.lifecycleId === request.expectedLifecycle?.lifecycleReference,
            )
            .at(-1);
    expect(request.expectedLifecycle).toEqual(
      selected
        ? {
            lifecycleReference: selected.command.next.lifecycleId,
            version: selected.command.next.version,
            sourceDigest: selected.sourceDigest,
          }
        : null,
    );
    const current =
      request.operation === "CreateDraft" && selected?.command.next.state !== "Draft"
        ? null
        : (selected?.command.next ?? null);
    if (request.operation === "CreateDraft")
      expect(saved.authoredByReference).toBe(scope().actorReference);
    if (request.operation === "SubmitReview")
      expect(latest(String(request.templateReference))?.templateVersionReference).toBe(
        request.templateVersionReference,
      );
    const validation =
      request.operation === "SubmitReview"
        ? {
            evidenceReference: next(),
            snapshotReference: request.templateVersionReference,
            snapshotDigest: request.contentDigest,
            scope: pureScope,
            result: "Pass",
            checkedAt: at,
            validUntil: request.reviewValidUntil,
            checkCodes: ["PLATFORM_TEMPLATE_IMMUTABLE_CONTENT", "PLATFORM_TEMPLATE_CURRENT_SOURCE"],
          }
        : (selected?.command.validationEvidence ?? null);
    const approval =
      request.operation === "Approve"
        ? {
            evidenceReference: next(),
            reviewLifecycleId: current?.lifecycleId,
            reviewVersion: current?.version,
            snapshotReference: request.templateVersionReference,
            snapshotDigest: request.contentDigest,
            scope: pureScope,
            decision: "Accepted",
            approvedActorReference: scope().actorReference,
            authoredActorReference: current?.authoredActorReference,
            submittedActorReference: current?.submittedActorReference,
            approvedAt: at,
            validUntil: current?.reviewValidUntil,
          }
        : (selected?.command.approvalEvidence ?? null);
    const targetState = {
      CreateDraft: "Draft",
      SubmitReview: "InReview",
      Approve: "Approved",
      Publish: "Published",
      Archive: "Archived",
    }[request.operation];
    const nextRecord = {
      lifecycleId: current?.lifecycleId ?? next(),
      familyReference: request.templateReference,
      configurationType: "PLATFORM_BRAND_TEMPLATE",
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
      snapshotReference: request.templateVersionReference,
      snapshotDigest: request.contentDigest,
      scope: pureScope,
      version: (current?.version ?? 0) + 1,
      state: targetState,
      validationEvidenceReference:
        request.operation === "CreateDraft" ? null : (validation?.evidenceReference ?? null),
      approvalEvidenceReference:
        request.operation === "CreateDraft" || request.operation === "SubmitReview"
          ? null
          : (approval?.evidenceReference ?? null),
      createdAt: current?.createdAt ?? at,
      changedAt: at,
      authoredActorReference:
        request.operation === "CreateDraft"
          ? scope().actorReference
          : current?.authoredActorReference,
      submittedActorReference:
        request.operation === "CreateDraft"
          ? null
          : request.operation === "SubmitReview"
            ? scope().actorReference
            : current?.submittedActorReference,
      reviewValidUntil:
        request.operation === "CreateDraft"
          ? null
          : request.operation === "SubmitReview"
            ? request.reviewValidUntil
            : current?.reviewValidUntil,
    };
    const previousRelease =
      activeRelease.get(String(request.templateReference))?.command.release ?? null;
    const release =
      request.operation === "Publish"
        ? {
            releaseId: next(),
            familyReference: request.templateReference,
            configurationType: "PLATFORM_BRAND_TEMPLATE",
            purposeCode: "PLATFORM_BRAND_TEMPLATE",
            snapshotReference: request.templateVersionReference,
            snapshotDigest: request.contentDigest,
            scope: pureScope,
            sequence: (previousRelease?.sequence ?? 0) + 1,
            sourceLifecycleId: nextRecord.lifecycleId,
            kind: "Publish",
            previousReleaseId: previousRelease?.releaseId ?? null,
            createdAt: at,
          }
        : null;
    const source = buildPlatformPublishingSource({
      profile: "PlatformPublishingSourceV1",
      sequence: rows.length + 1,
      templateSourceDigest: request.templateSourceDigest,
      originalCommand: original,
      intentDigest: platformPublishingIntentDigest(original),
      command: {
        profile: "PlatformPublishingCommandV1",
        operation: request.operation,
        operationReference: request.operationReference,
        currentActorReference: scope().actorReference,
        expectedVersion: current?.version ?? 1,
        current,
        next: nextRecord,
        validationEvidence: request.operation === "CreateDraft" ? null : validation,
        approvalEvidence:
          request.operation === "CreateDraft" || request.operation === "SubmitReview"
            ? null
            : approval,
        release,
        previousRelease: request.operation === "Publish" ? previousRelease : null,
        rollbackTarget: null,
        occurredAt: at,
      },
      auditReference: next(),
    });
    const receipt = parsePlatformPublishingReceipt({
      profile: "PlatformPublishingReceiptV1",
      ...scope(),
      operationReference: request.operationReference,
      intentDigest: source.intentDigest,
      outcome: "Committed",
      originalCommand: original,
      source,
      auditReference: source.auditReference,
      occurredAt: at,
    });
    publications.set(String(request.templateReference), [...rows, source]);
    publicationReceipts.set(key(request.operationReference), receipt);
    state.publications.push(request);
    if (request.operation === "Publish")
      activeRelease.set(String(request.templateReference), source);
    if (
      request.operation === "Archive" &&
      activeRelease.get(String(request.templateReference))?.command.next.lifecycleId ===
        nextRecord.lifecycleId
    )
      activeRelease.delete(String(request.templateReference));
    return receipt;
  }
  await page.route("**/platform/tenants", async (route) => {
    applicationOrigin = new URL(route.request().url()).origin;
    if (!seededCookie) {
      seededCookie = true;
      if (state.authenticated) await installCookie();
    }
    await route.continue();
  });
  await page.route("**/merchant/session", async (route) => {
    state.deniedStoreBootstrapRequests++;
    await respond(route, { error: "request_denied" }, 403);
  });
  await page.route("https://controlled-platform-provider.invalid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/reauth") {
      if (stepUpAt === null) throw new Error("Controlled missing step-up clock");
      const authenticatedAt = stepUpAt;
      stepUpAt = null;
      const previous = state.session.sessionReference;
      state.session = sessionFor(scope().actorReference, authenticatedAt, String(previous));
      state.csrf = "r".repeat(43);
      state.rotations++;
      state.mfaRequired = false;
      await installCookie();
    } else if (path === "/logout") {
      state.authenticated = false;
      state.logouts++;
      await page.context().clearCookies({ name: cookieName });
    } else throw new Error("Controlled unexpected Provider destination");
    await route.fulfill({
      status: 303,
      headers: { location: new URL("/platform/tenants", applicationOrigin).href },
    });
  });
  await page.route("**/platform/auth/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    applicationOrigin = new URL(request.url()).origin;
    if (path === "/platform/auth/login") {
      state.authenticated = true;
      await installCookie();
      return route.fulfill({ status: 303, headers: { location: "/platform/tenants" } });
    }
    if (path === "/platform/auth/session")
      return (await authenticatedRequest(route, false))
        ? respond(route, {
            authenticated: true,
            session: {
              sessionReference: state.session.sessionReference,
              actorReference: state.session.actor.actorReference,
              expiresAt: state.session.idleExpiresAt,
            },
            recentMfaRequired: state.mfaRequired,
            csrf: state.csrf,
          })
        : respond(route, { error: "request_denied" }, 403);
    if (!(await authenticatedRequest(route, true)))
      return respond(route, { error: "request_denied" }, 403);
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual({});
    expect(request.headers()["x-bop-csrf"]).toBe(state.csrf);
    if (path === "/platform/auth/step-up") {
      // Read the controlled browser clock before navigation starts; evaluating
      // the page inside the intercepted Provider navigation would deadlock.
      stepUpAt = await now(page);
      return respond(route, {
        status: "step_up_required",
        authorizationUrl: "https://controlled-platform-provider.invalid/reauth",
      });
    }
    if (path === "/platform/auth/logout")
      return respond(route, {
        status: "browser_logout_required",
        logoutUrl: "https://controlled-platform-provider.invalid/logout",
      });
    throw new Error("Controlled unknown authentication route");
  });
  await page.route("**/platform/templates/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      at = await now(page);
    expect(request.method()).toBe("POST");
    expect(new URL(request.url()).search).toBe("");
    if (state.mfaRequired || !(await authenticatedRequest(route, true)))
      return respond(route, { error: "request_denied" }, 403);
    const body = request.postDataJSON() as Record<string, unknown>;
    for (const name of [
      "actorReference",
      "scope",
      "permission",
      "current",
      "next",
      "evidence",
      "observedAt",
    ])
      expect(body).not.toHaveProperty(name);
    if (path === "/platform/templates/query") return respond(route, query(body, at));
    if (path !== "/platform/templates/command")
      throw new Error("Controlled unknown template route");
    if (body.action === "ResolveSave" || body.action === "ResolvePublication") {
      state.resolves++;
      if (state.denyRecovery) return respond(route, { error: "request_denied" }, 403);
      expect(Object.keys(body).sort()).toEqual(["action", "intentDigest", "operationReference"]);
      const operation = String(body.operationReference);
      if (body.action === "ResolveSave") {
        let receipt = contentReceipts.get(key(operation));
        if (!receipt) {
          receipt = parsePlatformBrandTemplateReceipt(
            {
              profile: "PlatformBrandTemplateOperationV1",
              ...scope(),
              operationReference: operation,
              intentDigest: body.intentDigest,
              originalCommand: null,
              outcome: "Abandoned",
              snapshot: null,
              auditReference: next(),
              occurredAt: at,
              dataClassification: "ConfigurationMetadata",
            },
            codec,
          );
          contentReceipts.set(key(operation), receipt);
        }
        expect(receipt.intentDigest).toBe(body.intentDigest);
        return respond(route, receipt);
      }
      const receipt = publicationReceipts.get(key(operation));
      if (!receipt) throw new Error("Controlled missing publication original");
      expect(receipt.intentDigest).toBe(body.intentDigest);
      return respond(route, receipt);
    }
    if (body.action === "Save") {
      expect(Object.keys(body).sort()).toEqual([
        "action",
        "content",
        "expectedHead",
        "operationReference",
        "templateReference",
      ]);
      if (!state.allowed.includes("platform.brand-template.manage"))
        return respond(route, { error: "request_denied" }, 403);
      if (state.dropSaveBeforeApply) {
        state.dropSaveBeforeApply = false;
        return route.abort("failed");
      }
      const receipt = save(body, at);
      if (state.loseSaveReply) {
        state.loseSaveReply = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    expect(body.action).toBe("Publication");
    expect(Object.keys(body).sort()).toEqual(["action", "request"]);
    const candidate = parsePlatformPublishingRequest(body.request);
    const permission = {
      CreateDraft: "manage",
      SubmitReview: "submit",
      Approve: "approve",
      Publish: "publish",
      Archive: "archive",
    }[candidate.operation];
    if (!state.allowed.includes(`platform.brand-template.${permission}`))
      return respond(route, { error: "request_denied" }, 403);
    return respond(route, publish(candidate, at));
  });
  return {
    state,
    latest: () => [...content.values()].at(-1)?.at(-1),
    sources: () => [...publications.values()].flat(),
    async independent() {
      state.session = sessionFor(reviewer, await now(page));
      state.csrf = "i".repeat(43);
      await installCookie();
    },
  };
}
async function originals(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-platform-template-pending-v1", 1);
        open.onerror = () => reject(new Error("Controlled journal unavailable"));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("originals")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("originals", "readonly"),
            read = tx.objectStore("originals").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(read.result as unknown[]);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("Controlled journal read failed"));
          };
        };
      }),
  );
}
async function enter(page: Page) {
  await page.goto("/platform/tenants");
  await expect(
    page.getByRole("heading", { name: "Brand setup templates", exact: true }),
  ).toBeVisible();
  await expect(button(page, "Refresh templates")).toBeEnabled();
  await expect(button(page, "New template")).toBeVisible();
  expect(
    await page.evaluate(async () =>
      Promise.all([
        fetch("/platform/templates/query", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": "wrong-header" },
          body: JSON.stringify({ action: "Actions" }),
        }).then((response) => response.status),
        fetch("/platform/auth/step-up", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": "wrong-header" },
          body: "{}",
        }).then((response) => response.status),
        fetch("/platform/templates/query", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "Actions" }),
        }).then((response) => response.status),
      ]),
    ),
  ).toEqual([403, 403, 403]);
}
async function refresh(page: Page) {
  await button(page, "Refresh templates").click();
  await expect(button(page, "Refresh templates")).toBeEnabled();
}
async function fillNew(page: Page, code = "SYNTHETIC_BASE", name = "Synthetic setup template") {
  await refresh(page);
  await button(page, "New template").click();
  await panel(page).getByLabel("Template code", { exact: true }).fill(code);
  await panel(page).getByLabel("Template name", { exact: true }).fill(name);
  await panel(page)
    .getByRole("textbox", { name: "Supported locales", exact: true })
    .fill("en-CA, fr-CA");
  await panel(page)
    .getByRole("combobox", { name: "Default locale", exact: true })
    .selectOption("en-CA");
  await panel(page)
    .getByRole("textbox", { name: "Permitted override fields", exact: true })
    .fill("DISPLAY_NAME");
  await panel(page)
    .getByRole("textbox", { name: "Hard requirement fields", exact: true })
    .fill("TIME_ZONE");
  await panel(page)
    .getByLabel("Effective from (UTC)", { exact: true })
    .fill(new Date(Date.parse(await now(page)) - 60000).toISOString().slice(0, 16));
  await panel(page)
    .getByLabel("Effective until (UTC, blank means open)", { exact: true })
    .fill(new Date(Date.parse(await now(page)) + 86400000).toISOString().slice(0, 16));
  await panel(page).getByLabel("Content reason code", { exact: true }).fill("SYNTHETIC_SETUP");
  await refresh(page);
}
async function settled(page: Page) {
  await expect(button(page, "Recover original request")).toHaveCount(0);
  await expect(button(page, "Refresh templates")).toBeEnabled();
  expect(await originals(page)).toEqual([]);
}
async function saveNew(page: Page) {
  await fillNew(page);
  await button(page, "Save template content").click();
  await expect(panel(page)).toContainText("Saved content version 1.");
  await settled(page);
}
async function draft(page: Page) {
  await refresh(page);
  await button(page, "Create publication Draft").click();
  await expect(panel(page)).toContainText("Selected publication state: Draft");
  await settled(page);
}
async function submit(page: Page, milliseconds = 3600000) {
  const until = new Date(Date.parse(await now(page)) + milliseconds).toISOString().slice(0, 16);
  await panel(page).getByLabel("Review valid until (UTC)", { exact: true }).fill(until);
  await panel(page).getByLabel("Publication reason code", { exact: true }).fill("SYNTHETIC_REVIEW");
  await page.clock.fastForward(6000);
  await expect(button(page, "Submit for review")).toBeDisabled();
  await refresh(page);
  await expect(panel(page).getByLabel("Review valid until (UTC)", { exact: true })).toHaveValue(
    until,
  );
  await expect(panel(page).getByLabel("Publication reason code", { exact: true })).toHaveValue(
    "SYNTHETIC_REVIEW",
  );
  await button(page, "Submit for review").click();
  await expect(panel(page)).toContainText("Selected publication state: InReview");
  await settled(page);
  return new Date(until + ":00.000Z").toISOString();
}

test("@production Platform template discovery preserves an older review through independent approval, publication and archive", async ({
  page,
}) => {
  const f = await backend(page);
  f.state.authenticated = false;
  await page.goto("/platform/tenants");
  await page.getByRole("link", { name: "Sign in securely", exact: true }).click();
  await expect(button(page, "New template")).toBeVisible();
  await saveNew(page);
  await draft(page);
  const deadline = await submit(page);
  await expect(button(page, "Approve independently")).toBeDisabled();
  await expect(panel(page)).toContainText("author and submitter cannot approve");
  await panel(page).getByLabel("Template name", { exact: true }).fill("Synthetic revised content");
  await refresh(page);
  await button(page, "Save template content").click();
  await expect(panel(page)).toContainText("Saved content version 2.");
  await settled(page);
  await draft(page);
  await f.independent();
  await page.reload();
  await button(page, "Open Synthetic revised content (SYNTHETIC_BASE)").click();
  await expect(panel(page)).toContainText("Selected publication state: Draft");
  await button(page, "Open InReview lifecycle from sequence 2").click();
  await expect(panel(page)).toContainText(
    "Selected review content: Synthetic setup template · saved version 1.",
  );
  await expect(panel(page).locator(`time[datetime="${deadline}"]`)).toBeVisible();
  await expect(button(page, "Approve independently")).toBeEnabled();
  await button(page, "Approve independently").click();
  await expect(panel(page)).toContainText("Selected publication state: Approved");
  await settled(page);
  await refresh(page);
  await button(page, "Publish template").click();
  await expect(panel(page)).toContainText("Current release: Published · release 1");
  await settled(page);
  expect(f.state.publications.map((p) => p.operation)).toEqual([
    "CreateDraft",
    "SubmitReview",
    "CreateDraft",
    "Approve",
    "Publish",
  ]);
  expect(f.sources().at(-1)?.command.next.snapshotReference).not.toBe(
    f.latest()?.templateVersionReference,
  );
  const publishedScreenshot = await page.screenshot({
    path: test.info().outputPath("platform-template-published.png"),
    fullPage: true,
  });
  await test.info().attach("Platform template published desktop", {
    body: publishedScreenshot,
    contentType: "image/png",
  });
  await refresh(page);
  await panel(page).getByLabel("Confirm archive of this publication", { exact: true }).check();
  await button(page, "Archive publication").click();
  await expect(panel(page)).toContainText("Selected publication state: Archived");
  await expect(panel(page)).toContainText("Current release: None");
  await settled(page);
  expect(f.state.deniedStoreBootstrapRequests).toBeGreaterThan(0);
  await page.getByText("Tenant fleet operations", { exact: true }).click();
  await expect(
    page.getByText("Platform Tenant metadata is unavailable.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in securely", exact: true })).toBeVisible();
  expect(f.state.logouts).toBe(1);
});

test("@production first Save lost reply survives denied recovery and same-Actor MFA rotation without new IDs", async ({
  page,
}) => {
  const f = await backend(page);
  await enter(page);
  f.state.loseSaveReply = true;
  await fillNew(page);
  await button(page, "Save template content").click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  const retained = await originals(page);
  expect(retained).toHaveLength(1);
  expect(JSON.stringify(retained)).not.toMatch(
    /Synthetic setup template|supportedLocales|SYNTHETIC_SETUP|csrf|sessionReference|approvalEvidence/u,
  );
  expect(retained[0]).toMatchObject({ owner: "Save", templateReference: null });
  const originalOperation = f.state.saves[0]?.operationReference;
  await page.reload();
  f.state.denyRecovery = true;
  await button(page, "Recover original request").click();
  await expect(panel(page).getByRole("status")).toContainText("Current access refused");
  expect(await originals(page)).toEqual(retained);
  f.state.denyRecovery = false;
  f.state.mfaRequired = true;
  await page.getByRole("button", { name: "Refresh Platform session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MFA required", exact: true })).toBeVisible();
  const previous = f.state.session.sessionReference;
  await page.getByRole("button", { name: "Verify with MFA", exact: true }).click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  expect(f.state.session.rotatedFromSessionReference).toBe(previous);
  expect(f.state.rotations).toBe(1);
  await button(page, "Recover original request").click();
  await expect(panel(page)).toContainText("Saved content version 1.");
  await settled(page);
  expect(f.state.saves).toHaveLength(1);
  expect(f.state.saves[0]?.operationReference).toBe(originalOperation);
  f.state.allowed = ["platform.brand-template.approve"];
  await refresh(page);
  await expect(button(page, "Save template content")).toHaveCount(0);
  await expect(button(page, "New template")).toHaveCount(0);
  await expect(button(page, "Publish template")).toHaveCount(0);
  f.state.allowed = [...actions];
  await refresh(page);
  await fillNew(page, "SYNTHETIC_ABANDONED", "Synthetic abandoned attempt");
  f.state.dropSaveBeforeApply = true;
  await button(page, "Save template content").click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  await button(page, "Recover original request").click();
  await expect(panel(page).getByRole("status")).toContainText("original request was not applied");
  await settled(page);
  expect(f.state.saves).toHaveLength(1);
});

test("@production template fields reflow at 320px and 200 percent while expired review remains readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const f = await backend(page);
  await enter(page);
  await fillNew(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const label of [
    "Template code",
    "Template name",
    "Supported locales",
    "Default locale",
    "Permitted override fields",
    "Hard requirement fields",
    "Effective from (UTC)",
    "Effective until (UTC, blank means open)",
    "Content reason code",
  ]) {
    const field =
      label === "Default locale"
        ? panel(page).getByRole("combobox", { name: label, exact: true })
        : ["Supported locales", "Permitted override fields", "Hard requirement fields"].includes(
              label,
            )
          ? panel(page).getByRole("textbox", { name: label, exact: true })
          : panel(page).getByLabel(label, { exact: true });
    await expect(field).toBeVisible();
    const box = await field.boundingBox();
    if (!box) throw new Error("Controlled missing rendered field");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel(page).getByLabel("Template name", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Synthetic keyboard template");
  await refresh(page);
  await button(page, "Save template content").click();
  await expect(panel(page)).toContainText("Saved content version 1.");
  await settled(page);
  await draft(page);
  const deadline = await submit(page, 120000);
  await f.independent();
  await page.reload();
  await button(page, "Open Synthetic keyboard template (SYNTHETIC_BASE)").click();
  await expect(button(page, "Approve independently")).toBeEnabled();
  await page.clock.fastForward(Date.parse(deadline) - Date.parse(await now(page)) + 1000);
  await refresh(page);
  await expect(panel(page).locator(`time[datetime="${deadline}"]`)).toBeVisible();
  await expect(panel(page)).toContainText("Review expired.");
  await expect(button(page, "Approve independently")).toBeDisabled();
  await expect(button(page, "Publish template")).toBeDisabled();
  expect(f.state.publications.map((p) => p.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const expiredScreenshot = await page.screenshot({
    path: test.info().outputPath("platform-template-expired-review-mobile.png"),
    fullPage: true,
  });
  await test.info().attach("Platform template expired review mobile", {
    body: expiredScreenshot,
    contentType: "image/png",
  });
});
