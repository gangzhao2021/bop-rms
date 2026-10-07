import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { canonicalizeRfc8785 } from "../../../packages/bop/audit/src/index.js";
import {
  brandConfigurationEditableFields,
  createBrandConfigurationVersion,
} from "../../../packages/bop/tenant/src/contracts/brand-administration.js";
import {
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  createBrandConfigurationRevision,
  parseBrandConfigurationReceipt,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  type BrandConfigurationCommand,
  type BrandConfigurationRevision,
} from "../../../packages/bop/tenant/src/contracts/brand-configuration-operation.js";
import { createPlatformBrandTemplateRevision } from "../../../packages/bop/tenant/src/contracts/platform-brand-template.js";
import { createIdentityActor } from "../../../packages/bop/identity/src/contracts/identity-actor.js";
import { createAuthenticationSession } from "../../../packages/bop/identity/src/contracts/authentication-session.js";

const id = (n: number) => `018f9e91-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(1),
  author = id(2),
  reviewer = id(3),
  brandVersion = 7;
const href = `/app/organization/brands/${brand}`,
  prefix = "/merchant/organization/brands";
const hashIntent = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const digestRefs = { canonicalize: canonicalizeRfc8785, hashIntent };
const respond = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const recorded: string[] = [];
  errors.set(page, recorded);
  page.on("pageerror", (error) => recorded.push(error.message));
  await page.clock.install();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(
    page.locator(".vite-error-overlay, vite-error-overlay, [data-nextjs-dialog]"),
  ).toHaveCount(0);
});
const browserNow = async (page: Page) =>
  new Date(await page.evaluate(() => Date.now())).toISOString();
const panel = (page: Page) =>
  page.getByRole("region", { name: "Brand configuration", exact: true });
const button = (page: Page, name: string) => panel(page).getByRole("button", { name, exact: true });

/** Controlled HTTP/Session/material fixtures for the ordinary rendered App.
 * The saved Draft's Catalog/PlatformTemplate references are explicitly synthetic.
 * Actual public Tenant/Identity parsers and RFC hashes construct every wire record;
 * this does not prove actual IAM, PostgreSQL or production publication qualification. */
async function backend(page: Page, empty = false, paginated = false) {
  const initialAt = await browserNow(page),
    seedAt = new Date(Date.parse(initialAt) - 60000).toISOString();
  let sequence = 100;
  function sessionFor(
    actorReference: string,
    at: string,
    rotatedFromSessionReference: string | null = null,
  ) {
    return createAuthenticationSession({
      sessionReference: id(sequence++),
      actor: createIdentityActor({
        actorType: "User",
        actorReference,
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
      idleExpiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(at) + 43200000).toISOString(),
      rotatedFromSessionReference,
      revocationReason: null,
      revokedAt: null,
    });
  }
  const state = {
    session: sessionFor(author, seedAt),
    csrf: "c".repeat(43),
    denyRecovery: false,
    loseExecuteReply: false,
    deniedStoreBootstrapRequests: 0,
    rotations: 0,
    executions: [] as BrandConfigurationCommand[],
    resolves: 0,
    initialEmpty: empty,
    candidatesAvailable: true,
    templateCursors: [] as (string | null)[],
  };
  const scope = () => ({
    tenantReference: brand,
    brandReference: brand,
    actorReference: String(state.session.actor.actorReference),
  });
  const seedCommand = parseBrandConfigurationCommand({
    profile: "TenantBrandConfigurationCommandV1",
    ...scope(),
    command: "SaveConfigurationDraft",
    operationReference: id(10),
    expectedBrandVersion: brandVersion,
    expectedHead: null,
    purposeCode: "BRAND_CONFIGURATION",
    reviewValidUntil: null,
    configuration: {
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA", "fr-CA"],
      mediaThemeReference: null,
      catalogSourceReference: id(11),
      platformTemplateReference: id(12),
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: [],
      effectiveFrom: seedAt,
      effectiveUntil: null,
      reasonCode: "SYNTHETIC_SAVED_DRAFT",
    },
  });
  let current = createBrandConfigurationRevision(
    {
      profile: "TenantBrandConfigurationRevisionV1",
      ...scope(),
      revision: 1,
      brandVersion,
      command: seedCommand.command,
      operationReference: seedCommand.operationReference,
      configuration: {
        ...seedCommand.configuration,
        configurationVersionReference: id(13),
        brandReference: brand,
        configurationVersion: 1,
        lifecycle: "Draft",
        supersedesVersionReference: null,
        authoredByReference: author,
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        createdAt: seedAt,
        updatedAt: seedAt,
        dataClassification: "ConfigurationMetadata",
      },
      submittedByReference: null,
      publishing: null,
      auditReference: id(14),
      createdAt: seedAt,
      recordedAt: seedAt,
      dataClassification: "ConfigurationMetadata",
    },
    digestRefs,
  );
  const history: BrandConfigurationRevision[] = empty ? [] : [current];
  const operations = new Map<string, ReturnType<typeof parseBrandConfigurationReceipt>>();
  function receiptFor(command: BrandConfigurationCommand, snapshot: BrandConfigurationRevision) {
    const { profile, configuration, reviewValidUntil, ...identity } = command;
    void profile;
    void configuration;
    void reviewValidUntil;
    return parseBrandConfigurationReceipt({
      profile: "TenantBrandConfigurationOperationV1",
      ...identity,
      intentDigest: hashIntent(canonicalizeRfc8785(command)),
      originalCommand: command,
      outcome: "Committed",
      snapshot,
      auditReference: snapshot.auditReference,
      occurredAt: snapshot.recordedAt,
      dataClassification: "ConfigurationMetadata",
    });
  }
  if (!empty) operations.set(seedCommand.operationReference, receiptFor(seedCommand, current));
  let submitted: { revision: BrandConfigurationRevision; reviewValidUntil: string } | null = null;
  const lease = (at: string) => ({
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    currentPublication: "NotEvaluated",
  });
  function currentPacket(at: string) {
    const owner = parseBrandConfigurationCurrent({
      profile: "TenantBrandConfigurationCurrentV1",
      ...scope(),
      current: state.initialEmpty ? null : current,
      ...lease(at),
    });
    if (state.initialEmpty || current.configuration.lifecycle === "Draft")
      return { ...owner, recordedReview: null };
    if (!submitted || !current.publishing) throw new Error("Controlled missing original Submit");
    return {
      ...owner,
      recordedReview: {
        profile: "MerchantBrandConfigurationRecordedReviewV1",
        configurationVersionReference: current.configuration.configurationVersionReference,
        configurationSourceDigest: current.sourceDigest,
        lifecycleReference: current.publishing.lifecycleReference,
        lifecycleVersion: current.publishing.lifecycleVersion,
        recordedState: current.configuration.lifecycle,
        validationEvidenceReference: current.publishing.validationEvidenceReference,
        submittedByReference: submitted.revision.submittedByReference,
        submittedAt: submitted.revision.recordedAt,
        reviewValidUntil: submitted.reviewValidUntil,
      },
    };
  }
  function historyPacket(beforeRevision: unknown, at: string) {
    if (
      beforeRevision !== null &&
      (typeof beforeRevision !== "number" || !Number.isInteger(beforeRevision))
    )
      throw new Error("Controlled invalid history request");
    const matching = history
        .filter((row) => beforeRevision === null || row.revision < beforeRevision)
        .reverse(),
      entries = matching.slice(0, 2);
    return parseBrandConfigurationHistory({
      profile: "TenantBrandConfigurationHistoryV1",
      ...scope(),
      beforeRevision,
      entries,
      nextBeforeRevision: matching.length > 2 ? entries[1]?.revision : null,
      ...lease(at),
    });
  }
  function apply(command: BrandConfigurationCommand, at: string) {
    const previous = current;
    let configuration = previous.configuration,
      publishing = previous.publishing,
      submittedByReference = previous.submittedByReference;
    if (command.command === "SaveConfigurationDraft") {
      if (!command.configuration) throw new Error("Controlled missing editable fields");
      configuration = createBrandConfigurationVersion({
        ...configuration,
        ...command.configuration,
        configurationVersionReference: id(sequence++),
        configurationVersion: state.initialEmpty ? 1 : configuration.configurationVersion + 1,
        lifecycle: "Draft",
        supersedesVersionReference: state.initialEmpty
          ? null
          : configuration.configurationVersionReference,
        authoredByReference: state.session.actor.actorReference,
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        createdAt: at,
        updatedAt: at,
      });
      publishing = null;
      submittedByReference = null;
      submitted = null;
    } else if (command.command === "SubmitConfiguration") {
      if (
        !command.reviewValidUntil ||
        command.reviewValidUntil <= at ||
        previous.configuration.lifecycle !== "Draft"
      )
        throw new Error("Controlled invalid Submit");
      configuration = createBrandConfigurationVersion({
        ...configuration,
        lifecycle: "PendingApproval",
        updatedAt: at,
      });
      submittedByReference = scope().actorReference;
      publishing = {
        familyReference: brand,
        lifecycleReference: id(sequence++),
        lifecycleVersion: 2,
        mutationOperationReference: command.operationReference,
        validationEvidenceReference: id(sequence++),
        approvalEvidenceReference: null,
        publicationReference: null,
      };
    } else {
      if (!publishing || !submitted || submitted.reviewValidUntil <= at)
        throw new Error("Controlled expired review");
      if (command.command === "ApproveConfiguration") {
        if (
          configuration.lifecycle !== "PendingApproval" ||
          scope().actorReference === submittedByReference ||
          scope().actorReference === configuration.authoredByReference
        )
          throw new Error("Controlled self approval");
        const approval = id(sequence++);
        configuration = createBrandConfigurationVersion({
          ...configuration,
          lifecycle: "Approved",
          approvedByReference: scope().actorReference,
          approvalEvidenceReference: approval,
          updatedAt: at,
        });
        publishing = {
          ...publishing,
          lifecycleVersion: 3,
          mutationOperationReference: command.operationReference,
          approvalEvidenceReference: approval,
        };
      } else {
        if (configuration.lifecycle !== "Approved") throw new Error("Controlled invalid Publish");
        const publication = id(sequence++);
        configuration = createBrandConfigurationVersion({
          ...configuration,
          lifecycle: "Published",
          publicationReference: publication,
          updatedAt: at,
        });
        publishing = {
          ...publishing,
          lifecycleVersion: 4,
          mutationOperationReference: command.operationReference,
          publicationReference: publication,
        };
      }
    }
    current = createBrandConfigurationRevision(
      {
        profile: "TenantBrandConfigurationRevisionV1",
        ...scope(),
        revision: state.initialEmpty ? 1 : previous.revision + 1,
        brandVersion: command.expectedBrandVersion,
        command: command.command,
        operationReference: command.operationReference,
        configuration,
        submittedByReference,
        publishing,
        auditReference: id(sequence++),
        createdAt: state.initialEmpty ? at : previous.createdAt,
        recordedAt: at,
        dataClassification: "ConfigurationMetadata",
      },
      digestRefs,
    );
    state.initialEmpty = false;
    history.push(current);
    if (command.command === "SubmitConfiguration") {
      if (command.reviewValidUntil === null) throw new Error("Controlled missing deadline");
      submitted = { revision: current, reviewValidUntil: command.reviewValidUntil };
    }
    const receipt = receiptFor(command, current);
    operations.set(command.operationReference, receipt);
    return receipt;
  }
  let providerReturnOrigin = "",
    pendingRenewalAt: string | null = null;
  // Controlled Provider redirect and return; cryptographic native evidence is separate.
  await page.route("https://identity.invalid/authorize*", async (route) => {
    if (!pendingRenewalAt) throw Error("missing controlled challenge");
    state.session = sessionFor(
      scope().actorReference,
      pendingRenewalAt,
      state.session.sessionReference,
    );
    state.csrf = "r".repeat(43);
    pendingRenewalAt = null;
    return route.fulfill({ status: 302, headers: { location: providerReturnOrigin + href } });
  });
  const template = createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(15),
      templateVersionReference: id(12),
      revision: 1,
      recordKind: "AuthoredContent",
      content: {
        code: "STANDARD",
        name: "Standard Brand",
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA", "fr-CA"],
        overrideAllowedFieldCodes: ["CONTACT"],
        hardRequirementFieldCodes: empty ? ["CURRENCY"] : [],
        effectiveFrom: seedAt,
        effectiveUntil: null,
        reasonCode: "TEMPLATE_AUTHORING",
      },
      supersedesVersionReference: null,
      authoredByReference: id(16),
      operationReference: id(17),
      auditReference: id(18),
      createdAt: seedAt,
      recordedAt: seedAt,
      dataClassification: "ConfigurationMetadata",
    },
    digestRefs,
  );
  const {
    contentDigest: templateContentDigest,
    sourceDigest: templateSourceDigest,
    ...templateBody
  } = template;
  void templateContentDigest;
  void templateSourceDigest;
  const secondTemplate = createPlatformBrandTemplateRevision(
    {
      ...templateBody,
      templateReference: id(30),
      templateVersionReference: id(31),
      content: { ...template.content, code: "SECOND_PAGE", name: "Second page Brand" },
      operationReference: id(32),
      auditReference: id(33),
    },
    digestRefs,
  );
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      at = await browserNow(page);
    providerReturnOrigin = new URL(request.url()).origin;
    if (path === "/merchant/session") {
      state.deniedStoreBootstrapRequests++;
      return respond(route, { error: "request_denied" }, 403);
    }
    if (path === prefix + "/session")
      return respond(route, {
        authenticated: true,
        recentMfaRequired: false,
        csrf: state.csrf,
        workspace: {
          profile: "BrandAdministrationWorkspaceV1",
          selectedScope: scope(),
          brand: {
            brandReference: brand,
            label: "Synthetic noStore Brand",
            lifecycle: empty ? "Draft" : "Active",
            version: brandVersion,
          },
          navigation: [
            {
              screenId: "ORG-BRAND-DETAIL",
              label: "Brand",
              href,
              permission: "organization.manage",
            },
          ],
        },
      });
    if (!path.startsWith(prefix + "/") || request.method() !== "POST") return route.abort();
    if (request.headers()["x-bop-csrf"] !== state.csrf)
      return respond(route, { error: "request_denied" }, 403);
    const body = request.postDataJSON() as Record<string, unknown>;
    if (path === prefix + "/session/rotate") {
      expect(body).toEqual({});
      state.rotations++;
      pendingRenewalAt = at;
      return respond(route, {
        status: "step_up_required",
        authorizationUrl: "https://identity.invalid/authorize?controlled=configuration",
      });
    }
    if (body.brandReference !== brand) return respond(route, { error: "request_denied" }, 403);
    if (path === prefix + "/catalog-source/current")
      return respond(route, {
        profile: "BrandCatalogSourceCurrentV1",
        ...scope(),
        source: {
          profile: "BrandCatalogSourceRegisteredIdentityV1",
          tenantReference: brand,
          brandReference: brand,
          sourceReference: id(11),
          code: "MAIN",
          label: "Brand catalogue",
          registeredByReference: author,
          operationReference: id(19),
          auditReference: id(20),
          registeredAt: seedAt,
          dataClassification: "ConfigurationMetadata",
        },
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
        publicationStatus: "NotEvaluated",
        referenceEligibility: "NotEvaluated",
      });
    if (path === prefix + "/configuration/templates") {
      expect(body.brandReference).toBe(brand);
      expect(
        body.afterTemplateReference === null ||
          (paginated && body.afterTemplateReference === template.templateReference),
      ).toBe(true);
      const cursor = body.afterTemplateReference;
      if (cursor !== null && typeof cursor !== "string")
        throw new Error("Controlled template cursor required");
      state.templateCursors.push(cursor);
      const selected = cursor === null ? template : secondTemplate,
        more = paginated && cursor === null && state.candidatesAvailable;
      return respond(route, {
        profile: "MerchantBrandTemplateCandidatesV1",
        ...scope(),
        afterTemplateReference: cursor,
        items: state.candidatesAvailable
          ? [
              {
                templateReference: selected.templateReference,
                templateVersionReference: selected.templateVersionReference,
                revision: selected.revision,
                contentDigest: selected.contentDigest,
                ...selected.content,
              },
            ]
          : [],
        hasMore: more,
        nextAfterTemplateReference: more ? template.templateReference : null,
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      });
    }
    if (path === prefix + "/configuration/current") {
      expect(body).toEqual({ brandReference: brand });
      return respond(route, currentPacket(at));
    }
    if (path === prefix + "/configuration/history") {
      expect(Object.keys(body).sort()).toEqual(["beforeRevision", "brandReference"]);
      return respond(route, historyPacket(body.beforeRevision, at));
    }
    if (path === prefix + "/configuration/execute") {
      expect(Object.keys(body).sort()).toEqual(["brandReference", "command"]);
      const wire = body.command as Record<string, unknown>;
      expect(Object.keys(wire).sort()).toEqual([
        "command",
        "configuration",
        "expectedBrandVersion",
        "expectedHead",
        "operationReference",
        "reviewValidUntil",
      ]);
      const command = parseBrandConfigurationCommand({
        profile: "TenantBrandConfigurationCommandV1",
        ...scope(),
        purposeCode: "BRAND_CONFIGURATION",
        ...wire,
      });
      const previous = operations.get(command.operationReference);
      if (previous) {
        expect(previous.intentDigest).toBe(hashIntent(canonicalizeRfc8785(command)));
        return respond(route, previous);
      }
      expect(command.expectedBrandVersion).toBe(brandVersion);
      expect(command.expectedHead).toEqual(
        state.initialEmpty
          ? null
          : {
              revision: current.revision,
              configurationVersionReference: current.configuration.configurationVersionReference,
              sourceDigest: current.sourceDigest,
            },
      );
      state.executions.push(command);
      const receipt = apply(command, at);
      if (state.loseExecuteReply) {
        state.loseExecuteReply = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    if (path === prefix + "/configuration/resolve") {
      state.resolves++;
      if (state.denyRecovery) return respond(route, { error: "request_denied" }, 403);
      expect(Object.keys(body).sort()).toEqual(["brandReference", "command"]);
      const original = parseBrandConfigurationResolve({
        profile: "TenantBrandConfigurationResolveV1",
        ...scope(),
        purposeCode: "BRAND_CONFIGURATION",
        ...(body.command as Record<string, unknown>),
      });
      const receipt = operations.get(original.operationReference);
      if (!receipt) throw new Error("Controlled missing original receipt");
      for (const key of [
        "actorReference",
        "command",
        "operationReference",
        "expectedBrandVersion",
        "expectedHead",
        "intentDigest",
      ] as const)
        expect(receipt[key]).toEqual(original[key]);
      return respond(route, receipt);
    }
    return respond(route, { error: "brand_administration_unavailable" }, 503);
  });
  return {
    state,
    current: () => current,
    submitted: () => submitted,
    async signInIndependent() {
      state.session = sessionFor(reviewer, await browserNow(page));
      state.csrf = "i".repeat(43);
    },
  };
}
async function originals(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-brand-configuration-pending-v1", 1);
        open.onerror = () => reject(new Error("Controlled journal unavailable"));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("originals")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(request.result as unknown[]);
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
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Synthetic noStore Brand", exact: true }),
  ).toBeVisible();
  await expect(panel(page).getByLabel("Reason code", { exact: true })).toHaveValue(
    "SYNTHETIC_SAVED_DRAFT",
  );
}
async function refresh(page: Page) {
  await button(page, "Refresh configuration").click();
  await expect(button(page, "Refresh configuration")).toBeEnabled();
  await expect(button(page, "Save configuration draft")).toBeEnabled();
}
async function committed(page: Page, lifecycle: string, revision: number) {
  await expect(panel(page)).toContainText(`Recorded state: ${lifecycle}.`);
  await expect(panel(page)).toContainText(`Revision ${revision}.`);
  await expect(button(page, "Recover original request")).toHaveCount(0);
  expect(await originals(page)).toEqual([]);
}
async function submit(page: Page, milliseconds = 3600000) {
  const chosen = new Date(Date.parse(await browserNow(page)) + milliseconds)
      .toISOString()
      .slice(0, 16),
    exact = new Date(chosen + ":00.000Z").toISOString();
  await panel(page).getByLabel("Review valid until (UTC)", { exact: true }).fill(chosen);
  await refresh(page);
  await button(page, "Submit for review").click();
  await expect(panel(page).locator(`time[datetime="${exact}"]`)).toBeVisible();
  await expect(button(page, "Recover original request")).toHaveCount(0);
  return exact;
}
test("@production saved Brand configuration edits and completes independent review/publication through noStore App", async ({
  page,
}) => {
  const f = await backend(page);
  await enter(page);
  await panel(page)
    .getByRole("combobox", { name: "Default locale", exact: true })
    .selectOption("fr-CA");
  await panel(page).getByLabel("Reason code", { exact: true }).fill("LOCALE_REVIEW");
  const effectiveUntil = new Date(Date.parse(await browserNow(page)) + 172800000)
    .toISOString()
    .slice(0, 16);
  await panel(page)
    .getByLabel("Effective until (UTC, blank means open)", { exact: true })
    .fill(effectiveUntil);
  await refresh(page);
  await button(page, "Save configuration draft").click();
  await committed(page, "Draft", 2);
  expect(f.current().configuration.defaultLocale).toBe("fr-CA");
  expect(f.current().configuration.reasonCode).toBe("LOCALE_REVIEW");
  expect(Object.keys(f.state.executions[0]?.configuration ?? {}).sort()).toEqual(
    [...brandConfigurationEditableFields].sort(),
  );
  await page.clock.fastForward(6000);
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  await refresh(page);
  const deadline = await submit(page);
  await committed(page, "PendingApproval", 3);
  await expect(button(page, "Approve independently")).toBeDisabled();
  expect(f.submitted()?.reviewValidUntil).toBe(deadline);
  const authorSession = f.state.session.sessionReference;
  await page.reload();
  await expect(panel(page).locator(`time[datetime="${deadline}"]`)).toBeVisible();
  await expect(button(page, "Approve independently")).toBeDisabled();
  await f.signInIndependent();
  expect(f.state.session.actor.actorReference).toBe(reviewer);
  expect(f.state.session.sessionReference).not.toBe(authorSession);
  await page.reload();
  await expect(button(page, "Approve independently")).toBeEnabled();
  await button(page, "Approve independently").click();
  await committed(page, "Approved", 4);
  await button(page, "Publish configuration").click();
  await committed(page, "Published", 5);
  expect(f.state.executions.map((command) => command.command)).toEqual([
    "SaveConfigurationDraft",
    "SubmitConfiguration",
    "ApproveConfiguration",
    "PublishConfiguration",
  ]);
  expect(f.state.executions[2]?.actorReference).toBe(reviewer);
  await button(page, "Older configuration history").click();
  await expect(panel(page).getByRole("list")).toContainText("Revision 3 · PendingApproval");
  await expect(panel(page).getByRole("list")).toContainText("Revision 2 · Draft");
  await expect(panel(page).locator(`time[datetime="${deadline}"]`)).toBeVisible();
  expect(f.state.deniedStoreBootstrapRequests).toBeGreaterThan(0);
  await expect(
    page.getByText("Store assignment management requires an authorized Store workspace.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("brand-configuration-published.png"),
    fullPage: true,
  });
});
test("@production lost configuration reply retains scalar original across reload, denied recovery and Session renewal", async ({
  page,
}) => {
  const f = await backend(page);
  f.state.loseExecuteReply = true;
  await enter(page);
  await panel(page).getByLabel("Reason code", { exact: true }).fill("LOST_REPLY_EDIT");
  await refresh(page);
  await button(page, "Save configuration draft").click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  const retained = await originals(page);
  expect(retained).toHaveLength(1);
  expect(JSON.stringify(retained)).not.toMatch(
    /LOST_REPLY_EDIT|originalCommand|reviewValidUntil|csrf|qualification/u,
  );
  await page.reload();
  await expect(button(page, "Recover original request")).toBeEnabled();
  f.state.denyRecovery = true;
  await button(page, "Recover original request").click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Current session or permission refused",
  );
  expect(await originals(page)).toEqual(retained);
  f.state.denyRecovery = false;
  const originalSession = f.state.session.sessionReference;
  await page.getByRole("button", { name: "Renew session", exact: true }).click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  expect(f.state.session.rotatedFromSessionReference).toBe(originalSession);
  expect(f.state.session.actor.actorReference).toBe(author);
  await button(page, "Recover original request").click();
  await committed(page, "Draft", 2);
  await expect(panel(page).getByLabel("Reason code", { exact: true })).toHaveValue(
    "LOST_REPLY_EDIT",
  );
  expect(f.state.executions).toHaveLength(1);
  expect(f.state.resolves).toBe(3);
  expect(f.state.rotations).toBe(1);
  expect(f.state.deniedStoreBootstrapRequests).toBeGreaterThan(0);
  await expect(
    page.getByText("Store assignment management requires an authorized Store workspace.", {
      exact: true,
    }),
  ).toBeVisible();
});
test("@production actual configuration fields reflow at 320px and 200 percent text while expired review stays readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const f = await backend(page);
  await enter(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await panel(page).getByLabel("Reason code", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("MOBILE_REVIEW");
  await expect(panel(page).getByLabel("Reason code", { exact: true })).toHaveValue("MOBILE_REVIEW");
  for (const label of [
    "Default locale",
    "Effective from (UTC)",
    "Effective until (UTC, blank means open)",
    "Reason code",
    "Review valid until (UTC)",
  ]) {
    const control =
      label === "Default locale"
        ? panel(page).getByRole("combobox", { name: label, exact: true })
        : panel(page).getByLabel(label, { exact: true });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Controlled field has no rendered box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await refresh(page);
  await button(page, "Save configuration draft").click();
  await committed(page, "Draft", 2);
  const deadline = await submit(page, 120000);
  await f.signInIndependent();
  await page.reload();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(button(page, "Approve independently")).toBeEnabled();
  await page.clock.fastForward(Date.parse(deadline) - Date.parse(await browserNow(page)) + 1000);
  await refresh(page);
  await expect(panel(page).locator(`time[datetime="${deadline}"]`)).toBeVisible();
  await expect(panel(page)).toContainText("Review expired.");
  await expect(button(page, "Approve independently")).toBeDisabled();
  await expect(button(page, "Publish configuration")).toBeDisabled();
  await expect(button(page, "Save configuration draft")).toBeEnabled();
  expect(f.state.executions.map((command) => command.command)).toEqual([
    "SaveConfigurationDraft",
    "SubmitConfiguration",
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel(page).screenshot({
    path: test.info().outputPath("brand-configuration-mobile-expired-review.png"),
  });
});

async function chooseFirstTemplate(page: Page) {
  await page.goto(href);
  await expect(panel(page).getByRole("status")).toContainText("No configuration has been saved");
  await panel(page)
    .getByRole("combobox", { name: "Platform template", exact: true })
    .selectOption({ label: "STANDARD — Standard Brand" });
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  const from = new Date(Date.parse(await browserNow(page)) + 60000).toISOString().slice(0, 16);
  await panel(page).getByLabel("Effective from (UTC)", { exact: true }).fill(from);
  await panel(page).getByLabel("Reason code", { exact: true }).fill("INITIAL_SETUP");
  await expect(button(page, "Save configuration draft")).toBeEnabled();
}
test("@production empty Draft Brand chooses a published template and saves its first configuration with genuine null CAS", async ({
  page,
}) => {
  const f = await backend(page, true);
  await chooseFirstTemplate(page);
  await expect(panel(page)).toContainText("Hard requirements: CURRENCY");
  await expect(panel(page)).toContainText("MAIN — Brand catalogue");
  await expect(panel(page)).not.toContainText(id(12));
  await page.clock.fastForward(6000);
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const localeCheckbox = panel(page).getByRole("checkbox", { name: "fr-CA", exact: true }),
    overrideCheckbox = panel(page).getByRole("checkbox", {
      name: "Allow override CONTACT",
      exact: true,
    });
  await localeCheckbox.locator("..").click();
  await expect(localeCheckbox).toBeChecked();
  await overrideCheckbox.locator("..").click();
  await expect(overrideCheckbox).toBeChecked();
  await overrideCheckbox.locator("..").click();
  await expect(overrideCheckbox).not.toBeChecked();
  await localeCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(localeCheckbox).not.toBeChecked();
  for (const checkbox of [localeCheckbox, overrideCheckbox]) {
    const dimensions = await checkbox.evaluate((input) => ({
      width: input.getBoundingClientRect().width,
      height: input.getBoundingClientRect().height,
      labelHeight: input.parentElement?.getBoundingClientRect().height ?? 0,
    }));
    expect(dimensions.width).toBe(20);
    expect(dimensions.height).toBe(20);
    expect(dimensions.labelHeight).toBeGreaterThanOrEqual(44);
  }
  await panel(page).getByLabel("Reason code", { exact: true }).focus();
  await expect(
    page.getByRole("link", { name: "Skip to main content", exact: true }),
  ).not.toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("first-configuration-1440", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const checkbox of [localeCheckbox, overrideCheckbox]) {
    const dimensions = await checkbox.evaluate((input) => ({
      width: input.getBoundingClientRect().width,
      height: input.getBoundingClientRect().height,
      labelHeight: input.parentElement?.getBoundingClientRect().height ?? 0,
    }));
    expect(dimensions.width).toBe(20);
    expect(dimensions.height).toBe(20);
    expect(dimensions.labelHeight).toBeGreaterThanOrEqual(44);
  }
  await panel(page).getByLabel("Reason code", { exact: true }).focus();
  await expect(
    page.getByRole("link", { name: "Skip to main content", exact: true }),
  ).not.toBeFocused();
  expect(
    await page.locator(".bop-skip-link").evaluate((link) => link.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("first-configuration-320-200-percent", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await button(page, "Refresh configuration").click();
  await expect(button(page, "Save configuration draft")).toBeEnabled();
  await expect(panel(page).getByLabel("Reason code", { exact: true })).toHaveValue("INITIAL_SETUP");
  await button(page, "Save configuration draft").click();
  await committed(page, "Draft", 1);
  expect(f.state.executions[0]?.expectedHead).toBeNull();
  expect(f.current().configuration).toMatchObject({
    configurationVersion: 1,
    mediaThemeReference: null,
    platformTemplateReference: id(12),
    hardRequirementFieldCodes: ["CURRENCY"],
    reasonCode: "INITIAL_SETUP",
  });
});
test("@production first-Save lost reply recovers after its template leaves current candidates without replacement allocation", async ({
  page,
}) => {
  const f = await backend(page, true);
  await chooseFirstTemplate(page);
  f.state.loseExecuteReply = true;
  await button(page, "Save configuration draft").click();
  await expect(button(page, "Recover original request")).toBeEnabled();
  const retained = await originals(page);
  expect(retained).toHaveLength(1);
  expect(JSON.stringify(retained)).not.toMatch(
    /INITIAL_SETUP|originalCommand|csrf|supportedLocales/u,
  );
  f.state.candidatesAvailable = false;
  await page.reload();
  await expect(button(page, "Recover original request")).toBeEnabled();
  await expect(
    panel(page).getByRole("combobox", { name: "Platform template", exact: true }),
  ).toBeDisabled();
  await button(page, "Recover original request").click();
  await committed(page, "Draft", 1);
  await expect(panel(page)).toContainText("Recorded template — unavailable for new selection");
  expect(f.state.executions).toHaveLength(1);
});
test("@production candidate expiry and missing publication prevent first Save without reserving an original", async ({
  page,
}) => {
  const f = await backend(page, true);
  await chooseFirstTemplate(page);
  await page.clock.fastForward(5000);
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  expect(await originals(page)).toEqual([]);
  f.state.candidatesAvailable = false;
  await button(page, "Refresh configuration").click();
  await expect(
    panel(page)
      .getByRole("combobox", { name: "Platform template", exact: true })
      .getByRole("option", { name: "STANDARD — Standard Brand", exact: true }),
  ).toHaveCount(0);
  expect(f.state.executions).toHaveLength(0);
  expect(await originals(page)).toEqual([]);
});

test("@production second-page template selection and explicit fields survive slow entry and real-page refresh before first Save", async ({
  page,
}) => {
  const f = await backend(page, true, true);
  await page.goto(href);
  await expect(panel(page).getByRole("status")).toContainText("No configuration has been saved");
  await panel(page).getByRole("button", { name: "More published templates", exact: true }).click();
  await panel(page)
    .getByRole("combobox", { name: "Platform template", exact: true })
    .selectOption({ label: "SECOND_PAGE — Second page Brand" });
  const from = new Date(Date.parse(await browserNow(page)) + 60000).toISOString().slice(0, 16);
  await panel(page).getByLabel("Effective from (UTC)", { exact: true }).fill(from);
  await page.clock.fastForward(6000);
  await panel(page).getByLabel("Reason code", { exact: true }).fill("SLOW_SECOND_PAGE_SETUP");
  await expect(button(page, "Save configuration draft")).toBeDisabled();
  await button(page, "Refresh configuration").click();
  await expect(button(page, "Save configuration draft")).toBeEnabled();
  await expect(
    panel(page).getByRole("combobox", { name: "Platform template", exact: true }),
  ).toHaveValue(id(31));
  await expect(panel(page).getByLabel("Effective from (UTC)", { exact: true })).toHaveValue(from);
  await expect(panel(page).getByLabel("Reason code", { exact: true })).toHaveValue(
    "SLOW_SECOND_PAGE_SETUP",
  );
  expect(f.state.templateCursors.slice(-2)).toEqual([null, id(15)]);
  await button(page, "Save configuration draft").click();
  await committed(page, "Draft", 1);
  expect(f.current().configuration.platformTemplateReference).toBe(id(31));
  expect(f.state.executions).toHaveLength(1);
});
