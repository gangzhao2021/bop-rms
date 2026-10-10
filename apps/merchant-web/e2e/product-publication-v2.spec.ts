import { expect, test, type Page, type Route } from "@playwright/test";
// WP-2423 pilot: /app/commerce/products and /app/commerce/option-sets are served by the Store
// back-office pages (ProductPages, StoreOptionSetPages). The WP-2421 pages this spec drives are not
// routed during the pilot; the spec returns with those pages on expansion (WP-2423 "可绕过").
test.skip(true, "WP-2423 pilot: the WP-2421 pages this spec drives are not routed");
import {
  at,
  csrf,
  digest,
  hash,
  id,
  none,
  oldPublication,
  scope,
  seal,
  validationReportView,
  warningAcknowledgementResult,
} from "../src/product-publication-v2-test-fixtures.js";
import { parseProductPublicationScopes } from "../src/product-publication-command-client.js";
import {
  canonicalPublicationValue,
  type ProductPublicationUserCommandV2 as Command,
} from "../src/product-publication-command-client-v2.js";
import { parseProductPublicationWarningAcknowledgementCommand } from "../src/product-publication-warning-acknowledgement-client.js";

// Actual production-built browser/UI and IndexedDB, with synthetic transport,
// identity, validation and receipts. This is not actual server/full-source proof.
type Publication = Omit<
  ReturnType<typeof oldPublication>,
  | "reviewReference"
  | "reviewVersion"
  | "submittedByActorReference"
  | "approvalEvidenceReference"
  | "scheduleReference"
  | "scopeSet"
  | "effectivePeriod"
  | "publishedAt"
  | "successorDraftVersionReference"
> & {
  reviewReference: string | null;
  reviewVersion: number | null;
  submittedByActorReference: string | null;
  approvalEvidenceReference: string | null;
  scheduleReference: string | null;
  scopeSet: Command["scopeSet"];
  effectivePeriod: Command["effectivePeriod"];
  publishedAt: string | null;
  successorDraftVersionReference: string | null;
  profile?: "CatalogProductPublicationVersionV2";
  replacementIntent?: Command["replacementIntent"];
  replacementIntentDigest?: string;
};
interface History {
  publicationAction: string;
  publication: Publication;
}
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
const selected = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(3),
};
const now = () => new Date().toISOString();
function editor(root: number, draftReference: string, observation: string) {
  const editorContent = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: {},
    localizedDescriptions: { "en-CA": "Synthetic browser publication content" },
    preparationNotes: {},
    tagReferences: [],
    attributeValues: [],
    media: [],
    variantDimensions: [],
    variantCombinations: [],
    optionRules: [],
    allergenReferences: [],
    nutritionProfile: null,
  };
  return seal({
    profile: "CatalogProductEditorSnapshotV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: root,
    aggregate: {
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTH_TEA",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: root,
      createdAt: at,
      createdByActorReference: id(70),
      updatedAt: observation,
      draft: {
        versionReference: draftReference,
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic tea" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: observation,
        editorContent,
      },
    },
    contentDigest: hash,
    configurationDigest: hash,
    contentStatus: "Present",
    observedAt: observation,
    validUntil: new Date(Date.parse(observation) + 5000).toISOString(),
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
}
async function installSources(page: Page, withPrevious = false) {
  const control = {
    root: 7,
    draft: id(6),
    reads: 0,
    editorRoots: [] as number[],
    rejectedEditorRoots: [] as number[],
    bodies: [] as string[],
    scopes: [] as string[],
    pageErrors: [] as string[],
    mode: "Current",
    loseNext: false,
    commandDenied: false,
    denyManagementAfterNextCommand: false,
    legacyWrites: 0,
    reportReads: 0,
    reportMode: "Current",
    completeReport: false,
    warningReport: false,
    missingConfigurationWarnings: false,
    hardErrorReport: false,
    ackBodies: [] as string[],
    ackScopes: [] as string[],
    ackApplied: 0,
    loseNextAck: false,
    ackDenied: false,
    denyManagementAfterNextAck: false,
    savedContentDigest: hash,
    resolutionBodies: [] as string[],
    resolutionDenied: false,
    loseNextResolution: false,
  };
  page.on("pageerror", (error) => control.pageErrors.push(error.message));
  const history: History[] = [],
    headers: Record<string, unknown>[] = [],
    heads = new Map<string, Publication>(),
    ledger = new Map<string, Record<string, unknown>>(),
    acknowledgementLedger = new Map<string, ReturnType<typeof warningAcknowledgementResult>>();
  function recordedReport(
    publication: Parameters<typeof validationReportView>[0],
    options: Parameters<typeof validationReportView>[1],
  ): ReturnType<typeof validationReportView> {
    const view = validationReportView(publication, options);
    if (
      !control.missingConfigurationWarnings ||
      !view.report ||
      publication?.validationDecision !== "WarningAcknowledgementRequired"
    )
      return view;
    // This one scenario models four recorded SKU warnings, not owning source facts.
    const findings = ["PRICING", "RECIPE", "INVENTORY", "MENU"]
        .map((domain) => ({
          checkCode: "ChangeImpact",
          ruleCode: "SKU_008",
          outcome: "Warning",
          subjectReference: id(81),
          reasonCode: `REQUIRED_${domain}_REFERENCE_MISSING`,
          references: [],
        }))
        .sort((a, b) =>
          canonicalPublicationValue(a).localeCompare(canonicalPublicationValue(b), "en"),
        ),
      sources = [
        {
          sourceCode: "SYNTHETIC_VALIDATION",
          sourceDigest: digest("synthetic report source"),
          generation: "1",
          relevantReferenceDigest: digest("synthetic relevant references"),
          observedAt: publication.occurredAt,
          validUntil: new Date(Date.parse(publication.occurredAt) + 5000).toISOString(),
        },
      ];
    return seal({
      ...view,
      report: seal({
        ...view.report,
        details: { coverage: "Complete", impact: "Recorded", findings, sources },
        warningBindingDigest: digest({
          binding: view.report.binding,
          warningCodes: ["ChangeImpact"],
          findings,
          references: sources.map(({ sourceCode, relevantReferenceDigest }) => ({
            sourceCode,
            relevantReferenceDigest,
          })),
        }),
      }),
    });
  }
  if (withPrevious) {
    for (const [index, action] of ["Validate", "SubmitReview", "Publish"].entries()) {
      const published = action === "Publish",
        draft = action === "Validate";
      const publication: Publication = {
        ...oldPublication(),
        scopeSet: parseProductPublicationScopes(oldPublication().scopeSet),
        publicationVersion: index + 1,
        productAggregateVersion: index + 1,
        state: draft ? "Draft" : published ? "Published" : "InReview",
        operationReference: id(40 + index),
        intentDigest: digest({ syntheticLegacyAction: action }),
        reviewReference: draft ? null : id(43),
        reviewVersion: draft ? null : 2,
        submittedByActorReference: draft ? null : id(70),
        publishedAt: published ? at : null,
        successorDraftVersionReference: published ? id(6) : null,
      };
      history.push({ publicationAction: action, publication });
      heads.set(publication.versionReference, publication);
    }
  }
  const previous = withPrevious ? heads.get(id(5)) : undefined;
  function targets(observation: string) {
    return [...heads.values()].flatMap((p) =>
      p.state === "Published" &&
      p.publishedAt !== null &&
      p.publishedAt <= observation &&
      p.effectivePeriod.effectiveFrom.instant <= observation &&
      (p.effectivePeriod.effectiveUntil === null ||
        p.effectivePeriod.effectiveUntil.instant > observation)
        ? p.scopeSet.flatMap((selector, index) =>
            selector.level === "Store" &&
            selector.reference === id(3) &&
            !headers.some((h) =>
              (
                h.retirements as {
                  replacementIntent: {
                    previousPublicationOperationReference: string;
                    previousSelectorIndex: number;
                  };
                }[]
              ).some(
                (r) =>
                  r.replacementIntent.previousPublicationOperationReference ===
                    p.operationReference && r.replacementIntent.previousSelectorIndex === index,
              ),
            )
              ? [
                  {
                    selector,
                    replacementIntent: seal({
                      profile: "CatalogProductExactStoreSelectorReplacementV1",
                      mode: "PermanentSelectorRetirement",
                      previousVersionReference: p.versionReference,
                      previousPublicationOperationReference: p.operationReference,
                      expectedPreviousPublicationVersion: p.publicationVersion,
                      previousIntentDigest: p.intentDigest,
                      previousScopeDigest: p.scopeDigest,
                      previousPeriodDigest: p.periodDigest,
                      previousSelectorIndex: index,
                      previousSelectorDigest: digest(selector),
                    }),
                  },
                ]
              : [],
          )
        : [],
    );
  }
  function management() {
    const observation = now(),
      versions = [...heads.values()].sort((a, b) =>
        a.versionReference.localeCompare(b.versionReference),
      ),
      sourceRevision = String(control.root);
    const coverage = {
      profile: "CatalogProductRetirementCoverageV1",
      coverage: "CompleteRecordedPublicationRetirements",
      sourceAuthority: "NotEvaluated",
      eligibility: "NotEvaluated",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(4),
      aggregateVersion: control.root,
      sourceRevision,
      observedAt: observation,
      history,
      headers,
      latest: versions,
    };
    return seal({
      profile: "CatalogProductPublicationManagementV2",
      ...scope,
      aggregateVersion: control.root,
      observedAt: observation,
      validUntil: new Date(Date.parse(observation) + 5000).toISOString(),
      editorObservedAt: observation,
      sourceObservedAt: observation,
      sourceRevision,
      sourceDigest: digest(coverage),
      coverage: "CompleteRecordedPublicationManagement",
      eligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      draft: {
        versionReference: control.draft,
        contentDigest: control.savedContentDigest,
        configurationDigest: hash,
        contentStatus: "Present",
      },
      versions,
      history,
      scopeRetirementHeaders: headers,
      noReplacementIntent: none(),
      replacementTargets: targets(observation),
    });
  }
  await page.route("**/merchant/session", (route) =>
    respond(route, {
      authenticated: true,
      csrf,
      workspace: {
        screenId: "HOME-OVERVIEW",
        selectedScope: selected,
        authorizedStores: [selected],
        navigation: [
          {
            screenId: "CAT-PRODUCT-LIST",
            href: "/app/commerce/products",
            label: "Products",
            permission: "catalog.manage",
          },
        ],
        businessDate: "2026-10-02",
        storeStatus: "Unavailable",
        freshness: "Current",
        dashboardAvailability: "UnavailableUntilWP1905",
      },
    }),
  );
  await page.route("**/merchant/catalog/products", (route) => {
    const observation = now(),
      unavailable = { status: "Unavailable" };
    return respond(route, {
      projection: {
        name: "catalog_product_search_v1",
        version: 1,
        asOfUtc: observation,
        stale: false,
        partial: true,
      },
      scope: { brandReference: id(2), storeReference: id(3) },
      locale: "en-CA",
      hasMore: false,
      nextCursor: null,
      items: [
        {
          productReference: id(4),
          internalCode: "SYNTH_TEA",
          name: "Synthetic tea",
          nameLocale: "en-CA",
          localeFallback: false,
          productType: "PreparedFood",
          lifecycle: "Draft",
          aggregateVersion: control.root,
          updatedAt: observation,
          createdAt: at,
          source: { productVersionReference: control.draft, configuration: "Draft" },
          skuCount: 0,
          activeSkuCount: 0,
          category: unavailable,
          menuCount: unavailable,
          availability: unavailable,
          storeCoverage: unavailable,
          tax: unavailable,
          updatedBy: unavailable,
        },
      ],
    });
  });
  await page.route("**/merchant/store-capability", (route) => {
    const key = (route.request().postDataJSON() as { capabilityKey: string }).capabilityKey;
    return respond(route, {
      brandReference: id(2),
      storeReference: id(3),
      capabilityKey: key,
      controlKey:
        key === "catalog.cat_product_create" ? "catalog.product.create" : "catalog.product.edit",
      backendExecution: "Allow",
      frontendVisibility: "Show",
      reason: "Enabled",
      source: "StoreOverride",
      controlReference: id(60),
      controlVersion: 1,
      observedAt: now(),
    });
  });
  await page.route("**/merchant/catalog/products/editor", (route) => {
    const body = route.request().postDataJSON() as { expectedAggregateVersion: number };
    control.editorRoots.push(body.expectedAggregateVersion);
    if (body.expectedAggregateVersion !== control.root) {
      control.rejectedEditorRoots.push(body.expectedAggregateVersion);
      return respond(route, { error: "product_editor_unavailable" }, 503);
    }
    return respond(
      route,
      seal({
        ...editor(control.root, control.draft, now()),
        contentDigest: control.savedContentDigest,
      }),
    );
  });
  // The old journal may be requested before the automatic V2 management read.
  // It deliberately remains unavailable and is replaced by complete V2 history.
  await page.route("**/merchant/catalog/products/publication/scope-journals", (route) =>
    respond(route, { error: "product_scope_journal_unavailable" }, 503),
  );
  await page.route("**/merchant/catalog/products/publication/management/v2", (route) => {
    control.reads++;
    expect(route.request().postDataJSON()).toEqual({
      productReference: id(4),
      expectedAggregateVersion: control.root,
    });
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    if (control.mode === "Denied") return respond(route, { error: "request_denied" }, 403);
    return respond(route, management());
  });
  await page.route("**/merchant/catalog/products/publication/validation-report/v2", (route) => {
    control.reportReads++;
    const body = route.request().postDataJSON() as {
        productReference: string;
        versionReference: string;
        expectedAggregateVersion: number;
        expectedPublicationVersion: number;
      },
      p = heads.get(body.versionReference) ?? null;
    expect(body).toEqual({
      productReference: id(4),
      versionReference: body.versionReference,
      expectedAggregateVersion: control.root,
      expectedPublicationVersion: p?.publicationVersion ?? 0,
    });
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    const encoded = route.request().headers()["x-bop-catalog-scope"] ?? "";
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      brandReference: id(2),
      storeReference: id(3),
    });
    if (control.reportMode === "Denied") return respond(route, { error: "request_denied" }, 403);
    const view = recordedReport(p, {
      observedAt: now(),
      aggregateVersion: control.root,
      draftReference: control.draft,
      versionReference: body.versionReference,
      complete: control.completeReport,
      draftContentDigest: control.savedContentDigest,
      publicationAction:
        history.findLast((h) => h.publication.versionReference === body.versionReference)
          ?.publicationAction ?? "Validate",
    });
    if (control.reportMode === "Malformed")
      return respond(route, seal({ ...view, selectedPublicationDigest: hash }));
    return respond(route, view);
  });
  // Synthetic transport receipt only. This route never advances Product root,
  // rewrites a report, changes checks or supplies owning source authority.
  await page.route(
    "**/merchant/catalog/products/publication/warning-acknowledgements/v1",
    (route) => {
      const text = route.request().postData() ?? "",
        command = parseProductPublicationWarningAcknowledgementCommand(JSON.parse(text));
      control.ackBodies.push(text);
      const encoded = route.request().headers()["x-bop-catalog-scope"] ?? "";
      control.ackScopes.push(encoded);
      expect(Object.keys(command)).toHaveLength(12);
      expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
      expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
        brandReference: id(2),
        storeReference: id(3),
      });
      if (control.ackDenied) return respond(route, { error: "request_denied" }, 403);
      const replay = acknowledgementLedger.get(command.operationReference);
      if (replay) return respond(route, { ...replay, status: "Replayed" });
      expect(command.productReference).toBe(id(4));
      expect(command.expectedProductAggregateVersion).toBe(control.root);
      expect(command.versionReference).toBe(control.draft);
      const publication = heads.get(command.versionReference);
      if (!publication) throw Error("Missing synthetic report head");
      const publicationAction = history.findLast(
        (h) => h.publication.versionReference === command.versionReference,
      )?.publicationAction;
      if (!publicationAction) throw Error("Missing synthetic report action");
      const view = recordedReport(publication, {
        observedAt: now(),
        aggregateVersion: control.root,
        draftReference: control.draft,
        complete: control.completeReport,
        draftContentDigest: control.savedContentDigest,
        publicationAction,
      });
      const report = view.report;
      if (!report) throw Error("Missing synthetic recorded report");
      expect(command.reportOperationReference).toBe(report.operationReference);
      expect(command.reportDigest).toBe(report.digest);
      expect(command.warningBindingDigest).toBe(report.warningBindingDigest);
      expect(command.warningCodes).toEqual(["ChangeImpact"]);
      expect(publication.validationDecision).toBe("WarningAcknowledgementRequired");
      const receipt = warningAcknowledgementResult(command, now());
      acknowledgementLedger.set(command.operationReference, receipt);
      control.ackApplied++;
      if (control.denyManagementAfterNextAck) {
        control.denyManagementAfterNextAck = false;
        control.mode = "Denied";
      }
      if (control.loseNextAck) {
        control.loseNextAck = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    },
  );
  await page.route("**/merchant/catalog/products/publication", (route) => {
    control.legacyWrites++;
    return respond(route, { error: "product_publication_unavailable" }, 503);
  });
  await page.route("**/merchant/catalog/products/publication/v2", async (route) => {
    const text = route.request().postData() ?? "",
      c = JSON.parse(text) as Command;
    control.bodies.push(text);
    control.scopes.push(route.request().headers()["x-bop-catalog-scope"] ?? "");
    expect(c.profile).toBe("CatalogProductPublicationCommandV2");
    expect(Object.keys(c)).toHaveLength(18);
    expect(c.replacementIntentDigest).toBe(c.replacementIntent.digest);
    expect(c.contentDigest).toBe(hash);
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    if (control.commandDenied) return respond(route, { error: "request_denied" }, 403);
    const replay = ledger.get(c.operationReference);
    if (replay) return respond(route, { ...replay, status: "Replayed" });
    expect(c.expectedProductAggregateVersion).toBe(control.root);
    const before = heads.get(c.versionReference),
      pubVersion = (before?.publicationVersion ?? 0) + 1;
    expect(c.expectedPublicationVersion).toBe(pubVersion - 1);
    const states = {
      Validate: "Draft",
      SubmitReview: "InReview",
      Approve: "Approved",
      Reject: "Draft",
      Publish: "Published",
      SchedulePublish: "Scheduled",
      ReschedulePublish: "Scheduled",
      CancelScheduledPublish: "Draft",
    };
    const state = states[c.action],
      resets = state === "Draft",
      actorReference = c.action === "Approve" ? id(71) : id(70),
      recordedAt = now();
    const p: Publication = {
      ...oldPublication(),
      profile: "CatalogProductPublicationVersionV2",
      replacementIntent: c.replacementIntent,
      replacementIntentDigest: c.replacementIntentDigest,
      versionReference: c.versionReference,
      publicationVersion: pubVersion,
      productAggregateVersion: control.root,
      state,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeSet: c.scopeSet,
      scopeDigest: digest(c.scopeSet),
      effectivePeriod: c.effectivePeriod,
      periodDigest: digest(c.effectivePeriod),
      validationEvidenceReference: id(100 + control.root),
      validationDecision: control.hardErrorReport
        ? "HardError"
        : control.warningReport
          ? "WarningAcknowledgementRequired"
          : state === "Draft" || state === "InReview"
            ? "ApprovalPending"
            : "Pass",
      approvalPolicy: "Required",
      reviewReference: resets
        ? null
        : c.action === "SubmitReview"
          ? id(200 + control.root)
          : (before?.reviewReference ?? null),
      reviewVersion: resets
        ? null
        : c.action === "SubmitReview"
          ? pubVersion
          : (before?.reviewVersion ?? null),
      submittedByActorReference: resets
        ? null
        : c.action === "SubmitReview"
          ? id(70)
          : (before?.submittedByActorReference ?? null),
      approvalEvidenceReference:
        resets || state === "InReview"
          ? null
          : c.action === "Approve"
            ? c.operationReference
            : (before?.approvalEvidenceReference ?? null),
      scheduleReference: c.scheduleReference ?? before?.scheduleReference ?? null,
      scheduleVersion: c.scheduleReference
        ? (before?.scheduleVersion ?? 0) + 1
        : (before?.scheduleVersion ?? 0),
      publishedAt: state === "Published" ? recordedAt : null,
      successorDraftVersionReference: c.successorDraftVersionReference,
      operationReference: c.operationReference,
      intentDigest: digest({
        ...c,
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference,
        actorKind: "User",
      }),
      actorReference,
      occurredAt: recordedAt,
    };
    const retirements: unknown[] = [];
    if (state === "Published" && c.replacementIntent.mode === "PermanentSelectorRetirement") {
      const old = heads.get(c.replacementIntent.previousVersionReference);
      expect(old).toBeDefined();
      retirements.push(
        seal({
          profile: "CatalogProductExactStoreSelectorRetirementV1",
          replacementIntent: c.replacementIntent,
          previousPublicationDigest: digest(old),
          retiredAt: recordedAt,
        }),
      );
    }
    headers.push(
      seal({
        profile: "CatalogProductScopeRetirementHeaderV1",
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(4),
        operationReference: p.operationReference,
        versionReference: p.versionReference,
        publicationVersion: p.publicationVersion,
        publicationAction: c.action,
        sourceAggregateVersion: control.root,
        resultAggregateVersion: control.root + 1,
        publicationIntentDigest: p.intentDigest,
        publicationSnapshotDigest: digest(p),
        observedSourceRevision: String(control.root),
        observedSourceHeadDigest: digest({
          profile: "CatalogProductRetirementSourceHeadsV1",
          tenantReference: id(1),
          brandReference: id(2),
          productReference: id(4),
          aggregateVersion: control.root,
          sourceRevision: String(control.root),
          latest: [...heads.values()].sort((a, b) =>
            a.versionReference.localeCompare(b.versionReference),
          ),
        }),
        recordedAt,
        retirements,
      }),
    );
    heads.set(p.versionReference, p);
    history.push({ publicationAction: c.action, publication: p });
    control.root++;
    if (c.successorDraftVersionReference) control.draft = c.successorDraftVersionReference;
    const result = {
      profile: "CatalogProductPublicationCommandResultV2",
      replacementIntentDigest: c.replacementIntentDigest,
      status: "Applied",
      operationReference: c.operationReference,
      productReference: c.productReference,
      versionReference: c.versionReference,
      aggregateVersion: control.root,
      publicationVersion: p.publicationVersion,
      state: p.state,
      scheduleVersion: p.scheduleVersion,
      effectiveFrom: p.effectivePeriod.effectiveFrom.instant,
      successorDraftVersionReference: p.successorDraftVersionReference,
    };
    ledger.set(c.operationReference, result);
    if (control.denyManagementAfterNextCommand) {
      control.denyManagementAfterNextCommand = false;
      control.mode = "Denied";
    }
    if (control.loseNext) {
      control.loseNext = false;
      return route.abort("failed");
    }
    return respond(route, result);
  });
  // Controlled HTTP resolution fixture only. The native acceptance proves the
  // owning fence and concurrent writer exclusion against PostgreSQL.
  const resolutions = new Map<string, Record<string, unknown>>();
  await page.route("**/merchant/catalog/products/publication/resolve/v1", async (route) => {
    const body = route.request().postData() ?? "";
    control.resolutionBodies.push(body);
    if (control.resolutionDenied) return respond(route, { error: "request_denied" }, 403);
    const input = JSON.parse(body) as { originalKind: string; originalCommand: Command };
    const key = input.originalKind + ":" + input.originalCommand.operationReference;
    let result = resolutions.get(key);
    if (!result) {
      result = {
        profile: "CatalogProductPublicationResolutionResultV1",
        outcome: (input.originalKind === "WarningAcknowledgementV1"
          ? acknowledgementLedger
          : ledger
        ).has(input.originalCommand.operationReference)
          ? "Committed"
          : "Abandoned",
        originalKind: input.originalKind,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        productReference: input.originalCommand.productReference,
        versionReference: input.originalCommand.versionReference,
        operationReference: input.originalCommand.operationReference,
        originalCommandDigest: digest(input.originalCommand),
        originalIntentDigest: digest("synthetic resolved full intent"),
        recordedAt: new Date().toISOString(),
        resolutionDigest: digest({ key, synthetic: "resolution" }),
      };
      resolutions.set(key, result);
    }
    if (control.loseNextResolution) {
      control.loseNextResolution = false;
      return route.abort("failed");
    }
    return respond(route, { ...result, currentAggregateVersion: control.root });
  });
  return Object.assign(control, { management, previous, history, headers });
}
const panel = (page: Page) => page.locator(".product-publication");
async function enter(page: Page) {
  await page.goto("/app/commerce/products");
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Current Product content", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Publication requests", exact: true }),
  ).toBeVisible();
  await expect(panel(page).getByText(/Current publication records loaded/)).toBeVisible();
}
async function setPeriod(page: Page, future = false, milliseconds?: number) {
  const time = new Date(Date.now() + (future ? 3600000 : -60000));
  if (milliseconds !== undefined) time.setUTCMilliseconds(milliseconds);
  const instant = time.toISOString();
  // Match the native HTML serialization while retaining the precise expected
  // wire instant. The form must restore milliseconds to three canonical digits.
  const local = instant.slice(0, -1).replace(/0+$/, "").replace(/\.$/, "").replace(/:00$/, "");
  await panel(page).getByLabel("Time zone", { exact: true }).fill("UTC");
  await panel(page).getByLabel("Effective from local time", { exact: true }).fill(local);
  await expect(panel(page).getByLabel("Effective from local time", { exact: true })).toHaveValue(
    local,
  );
  await panel(page).getByLabel("Effective from UTC offset minutes", { exact: true }).fill("0");
  return instant;
}
async function action(page: Page, name: string, root: number, state: string) {
  await panel(page).getByRole("button", { name, exact: true }).click();
  await expect(
    panel(page).getByText(new RegExp(`Current publication records loaded · Revision ${root}\\.`)),
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`Recorded publication history · Revision ${root}\\.`)),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: new RegExp(`Version record \\d+ · ${state}`) }).last(),
  ).toBeVisible();
}
async function records(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-publication-pending-v1", 1);
        open.onerror = () => reject(Error("Journal unavailable"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(Error("Journal unreadable"));
          tx.oncomplete = () => db.close();
        };
      }),
  );
}

test("@production V2 publication first Required review approval publish refreshes editor and recorded history", async ({
  page,
}) => {
  const c = await installSources(page);
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  await expect(panel(page).getByText(/validation ApprovalPending/)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Publish now", exact: true })).toHaveCount(
    0,
  );
  await action(page, "Submit publication review", 9, "InReview");
  await action(page, "Request independent approval", 10, "Approved");
  await action(page, "Publish now", 11, "Published");
  expect(c.bodies.map((body) => (JSON.parse(body) as Command).action)).toEqual([
    "Validate",
    "SubmitReview",
    "Approve",
    "Publish",
  ]);
  expect(c.history.at(-1)?.publication.actorReference).toBe(id(70));
  expect(
    c.history.find((entry) => entry.publicationAction === "Approve")?.publication.actorReference,
  ).toBe(id(71));
  expect(c.headers.every((h) => (h.retirements as unknown[]).length === 0)).toBe(true);
  expect(c.draft).toBe((JSON.parse(c.bodies[3] ?? "{}") as Command).successorDraftVersionReference);
  await expect.poll(() => c.editorRoots.includes(11)).toBe(true);
  expect(await records(page)).toEqual([]);
  expect(c.legacyWrites).toBe(0);
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 publication lost reply survives reload denial and exact IndexedDB replay cleanup", async ({
  page,
  context,
}) => {
  const c = await installSources(page);
  await enter(page);
  const canonicalInstant = await setPeriod(page, false, 350);
  c.loseNext = true;
  await panel(page).getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(panel(page).getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const stored = await records(page),
    original = c.bodies[0],
    reads = c.reads;
  const originalCommand = JSON.parse(original ?? "{}") as Command;
  expect(originalCommand.effectivePeriod.effectiveFrom).toEqual({
    instant: canonicalInstant,
    localDateTime: canonicalInstant.slice(0, -1),
    utcOffsetMinutes: 0,
  });
  expect(originalCommand.effectivePeriod.effectiveFrom.localDateTime).toMatch(/\.350$/);
  expect(stored).toHaveLength(1);
  await expect(
    panel(page).getByRole("button", { name: "Load validation report", exact: true }),
  ).toBeDisabled();
  expect(c.reportReads).toBe(0);
  expect(stored[0]).toMatchObject({
    profile: "CatalogProductPublicationPendingV2",
    body: original,
  });
  expect(JSON.stringify(stored)).not.toContain(csrf);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  // Reload retains navigation revision 7. The owning-style mock refuses it after
  // the lost reply committed revision 8; return through the actual current list.
  await expect(
    page.getByRole("heading", { name: "Current content unavailable", exact: true }),
  ).toBeVisible();
  expect(await records(page)).toEqual(stored);
  expect(c.rejectedEditorRoots).toContain(7);
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(panel(page).getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(c.reads).toBe(reads);
  expect(c.bodies).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Open Draft editor", exact: true })).toBeDisabled();
  await expect(
    panel(page).getByRole("button", { name: "Validate publication", exact: true }),
  ).toHaveCount(0);
  expect(await records(page)).toEqual(stored);
  await expect(
    panel(page).getByRole("button", { name: "Refresh publication records", exact: true }),
  ).toBeDisabled();
  await context.setOffline(true);
  await expect(
    panel(page).getByRole("button", { name: "Retry original publication request", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  c.commandDenied = true;
  await panel(page)
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .click();
  await expect.poll(() => c.bodies.length).toBe(2);
  await expect(
    panel(page).getByRole("button", { name: "Retry original publication request", exact: true }),
  ).toBeEnabled();
  await expect(panel(page).getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  expect(await records(page)).toEqual(stored);
  expect(c.reads).toBe(reads);
  c.commandDenied = false;
  await panel(page)
    .getByRole("button", { name: "Retry original publication request", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    panel(page).getByText(/Current publication records loaded · Revision 8/),
  ).toBeVisible();
  expect(c.bodies).toEqual([original, original, original]);
  expect(new Set(c.scopes).size).toBe(1);
  expect(await records(page)).toEqual([]);
  expect(c.root).toBe(8);
  expect(c.reads).toBeGreaterThan(reads);
  await expect(page.getByText(/Recorded publication history · Revision 8/)).toBeVisible();
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 resolution stops an unexecuted original only after terminal reply and supports keyboard at 320", async ({
  page,
}) => {
  const c = await installSources(page);
  await enter(page);
  await setPeriod(page);
  c.commandDenied = true;
  await panel(page).getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(panel(page).getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const original = await records(page),
    body = c.bodies[0];
  await page.setViewportSize({ width: 320, height: 800 });
  const resolve = panel(page).getByRole("button", {
    name: "Check result and stop retrying",
    exact: true,
  });
  await expect(resolve).toBeVisible();
  await expect(
    panel(page).getByText(/Otherwise the server permanently stops that request/),
  ).toBeVisible();
  c.resolutionDenied = true;
  await resolve.click();
  await expect.poll(() => c.resolutionBodies.length).toBe(1);
  await expect(resolve).toBeEnabled();
  expect(await records(page)).toEqual(original);
  c.resolutionDenied = false;
  c.loseNextResolution = true;
  await resolve.click();
  await expect.poll(() => c.resolutionBodies.length).toBe(2);
  await expect(resolve).toBeEnabled();
  expect(await records(page)).toEqual(original);
  await resolve.focus();
  await page.keyboard.press("Enter");
  await expect(
    panel(page).getByText(/original request was not applied and is now permanently stopped/),
  ).toBeVisible();
  await expect.poll(() => records(page)).toEqual([]);
  expect(c.bodies).toEqual([body]);
  expect(new Set(c.resolutionBodies).size).toBe(1);
  expect(c.root).toBe(7);
  await expect(page.getByRole("button", { name: "Open Draft editor", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 resolution recognizes committed original and reloads current Product without executing it again", async ({
  page,
}) => {
  const c = await installSources(page);
  await enter(page);
  await setPeriod(page);
  c.loseNext = true;
  await panel(page).getByRole("button", { name: "Validate publication", exact: true }).click();
  await expect(panel(page).getByText(/Original Validate request is unconfirmed/)).toBeVisible();
  const original = c.bodies[0];
  await panel(page)
    .getByRole("button", { name: "Check result and stop retrying", exact: true })
    .click();
  await expect(panel(page).getByText(/original request was already committed/)).toBeVisible();
  await expect.poll(() => records(page)).toEqual([]);
  expect(c.bodies).toEqual([original]);
  expect(c.root).toBe(8);
  await expect(page.getByText(/Current Draft content loaded · Revision 8/)).toBeVisible();
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 publication Exact target preserves owner filters and permanently retires only its recorded selector", async ({
  page,
}) => {
  const c = await installSources(page, true);
  await enter(page);
  await setPeriod(page);
  const target = c.management().replacementTargets[0];
  expect(target).toBeDefined();
  await panel(page)
    .getByRole("combobox", { name: /^Replacement / })
    .selectOption(String(target?.replacementIntent.digest));
  await expect(panel(page).getByLabel("Publication scope", { exact: true })).toBeDisabled();
  await action(page, "Validate publication", 8, "Draft");
  const validate = JSON.parse(c.bodies[0] ?? "{}") as Command;
  expect(validate.scopeSet).toEqual([target?.selector]);
  expect(validate.replacementIntent).toEqual(target?.replacementIntent);
  await action(page, "Submit publication review", 9, "InReview");
  await action(page, "Request independent approval", 10, "Approved");
  await action(page, "Publish now", 11, "Published");
  await expect(page.getByText(/Permanently retired at/)).toBeVisible();
  expect(c.headers.at(-1)?.retirements).toHaveLength(1);
  expect(
    c
      .management()
      .replacementTargets.some(
        (t) => t.replacementIntent.previousVersionReference === c.previous?.versionReference,
      ),
  ).toBe(false);
  expect(c.history[2]?.publication).toEqual(c.previous);
  expect(
    c.bodies.every(
      (body) =>
        (JSON.parse(body) as Command).replacementIntentDigest === target?.replacementIntent.digest,
    ),
  ).toBe(true);
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 publication current expiry denial and offline require refresh before any new request", async ({
  page,
  context,
}) => {
  const c = await installSources(page);
  await enter(page);
  await setPeriod(page);
  await expect(panel(page).getByText(/Current publication records unavailable: Stale/)).toBeVisible(
    { timeout: 8000 },
  );
  await expect(
    panel(page).getByRole("button", { name: "Validate publication", exact: true }),
  ).toHaveCount(0);
  expect(c.bodies).toEqual([]);
  c.mode = "Denied";
  await panel(page)
    .getByRole("button", { name: "Refresh publication records", exact: true })
    .click();
  await expect(panel(page).getByText(/not confirmed: Denied/)).toBeVisible();
  expect(c.bodies).toEqual([]);
  c.mode = "Current";
  await context.setOffline(true);
  await expect(
    panel(page).getByRole("button", { name: "Refresh publication records", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  await panel(page)
    .getByRole("button", { name: "Refresh publication records", exact: true })
    .click();
  await expect(panel(page).getByText(/Current publication records loaded/)).toBeVisible();
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 publication phone touch 390 and 320 reflow plus keyboard preserves exact request", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw Error("Production browser URL is required");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage(),
      c = await installSources(page);
    await enter(page);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel(page).getByLabel("Publication scope", { exact: true })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      expect(overflow).toBe(false);
      const box = await panel(page)
        .getByRole("button", { name: "Validate publication", exact: true })
        .boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await setPeriod(page);
    await panel(page).getByRole("button", { name: "Validate publication", exact: true }).tap();
    await expect(
      panel(page).getByText(/Current publication records loaded · Revision 8/),
    ).toBeVisible();
    await panel(page)
      .getByRole("button", { name: "Submit publication review", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      panel(page).getByText(/Current publication records loaded · Revision 9/),
    ).toBeVisible();
    expect(c.bodies.map((body) => (JSON.parse(body) as Command).action)).toEqual([
      "Validate",
      "SubmitReview",
    ]);
    expect(
      c.bodies.every((body) => (JSON.parse(body) as Command).replacementIntent.mode === "None"),
    ).toBe(true);
    expect(c.pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

const reportPanel = (page: Page) => page.locator(".product-validation-report");
async function loadReport(page: Page) {
  await reportPanel(page)
    .getByRole("button", { name: /^(Load|Refresh) validation report$/ })
    .click();
  await expect(reportPanel(page).getByRole("status")).toContainText(
    "Validation report read completed",
  );
}
test("@production V2 validation report explicit no-head legacy and historical ChecksOnly reads keep original evidence", async ({
  page,
}) => {
  const c = await installSources(page, true);
  await enter(page);
  expect(c.reportReads).toBe(0);
  await loadReport(page);
  await expect(
    reportPanel(page).getByText(
      "At read time, this Draft had not been validated. No report was recorded.",
    ),
  ).toBeVisible();
  await panel(page).getByLabel("Publication version", { exact: true }).selectOption(id(5));
  await expect(reportPanel(page).getByText(/this Draft had not been validated/)).toHaveCount(0);
  await loadReport(page);
  await expect(
    reportPanel(page).getByText(
      /No validation report was recorded for this legacy publication revision/,
    ),
  ).toBeVisible();
  await expect(
    reportPanel(page).getByRole("list", { name: "Recorded validation checks" }),
  ).toHaveCount(0);
  await panel(page).getByLabel("Publication version", { exact: true }).selectOption(id(6));
  await setPeriod(page);
  const target = c.management().replacementTargets[0];
  if (!target) throw new Error("Missing synthetic replacement target");
  await panel(page)
    .getByRole("combobox", { name: /^Replacement / })
    .selectOption(target.replacementIntent.digest);
  await action(page, "Validate publication", 8, "Draft");
  const p = c.history.at(-1)?.publication;
  if (!p) throw new Error("Missing synthetic validated head");
  // Wait for the original *validation* lease, without inventing a new report.
  await expect
    .poll(() => Date.now() >= Date.parse(p.occurredAt) + 5000, { timeout: 8000 })
    .toBe(true);
  await loadReport(page);
  const checks = reportPanel(page).getByRole("list", { name: "Recorded validation checks" });
  await expect(checks.getByRole("listitem")).toHaveCount(12);
  await expect(checks.getByText(/Approval policy.*Pending approval/)).toBeVisible();
  await expect(reportPanel(page).getByText(/Only check results were recorded/)).toBeVisible();
  await expect(reportPanel(page).getByText(/original evidence deadline/)).toContainText(
    new Date(Date.parse(p.occurredAt) + 5000).toISOString(),
  );
  expect(c.reportReads).toBe(3);
  expect(c.bodies).toHaveLength(1);
  await expect(reportPanel(page).getByRole("status")).toContainText(
    "Recorded snapshot — current access and source status are stale",
    { timeout: 8000 },
  );
  await expect(checks.getByRole("listitem")).toHaveCount(12);
  await expect(
    reportPanel(page).getByText(/At read time, the report matched the saved Draft/),
  ).toBeVisible();
  expect(c.reportReads).toBe(3); // No unprompted refresh or lease renewal.
  c.reportMode = "Denied";
  await reportPanel(page)
    .getByRole("button", { name: "Refresh validation report", exact: true })
    .click();
  await expect(reportPanel(page).getByRole("status")).toContainText("access denied");
  await expect(checks).toHaveCount(0);
  expect(c.reportReads).toBe(4);
  expect(c.pageErrors).toEqual([]);
});
test("@production V2 validation report Complete warnings reflow at 320 and changed saved content stays historical", async ({
  page,
}) => {
  const c = await installSources(page);
  c.completeReport = true;
  c.warningReport = true;
  await page.setViewportSize({ width: 320, height: 844 });
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  await reportPanel(page)
    .getByRole("button", { name: "Load validation report", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(reportPanel(page).getByRole("status")).toContainText(
    "Validation report read completed",
  );
  await expect(reportPanel(page).getByRole("status")).toBeFocused();
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation findings" })
      .getByRole("listitem")
      .first(),
  ).toContainText("SYNTHETIC_REFERENCE_");
  await expect(
    reportPanel(page).getByText(/Confirmation records your acceptance of these warnings/),
  ).toBeVisible();
  await reportPanel(page).getByText("Related references (1)", { exact: true }).click();
  await expect(reportPanel(page).getByText(id(82), { exact: true })).toBeVisible();
  await expect(reportPanel(page).getByText(id(84), { exact: true })).toBeVisible();
  await expect(reportPanel(page).getByText(id(85), { exact: true })).toBeVisible();
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation findings" })
      .locator(":scope > li"),
  ).toHaveCount(3);
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/wp2421-validation-report-320.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await expect(panel(page).getByRole("button", { name: "Publish now", exact: true })).toHaveCount(
    0,
  );
  // A separately saved synthetic Draft advanced the owning root; the old
  // immutable validation head remains unchanged. This is not a Draft-write test.
  const original = structuredClone(c.history.at(-1));
  c.root++;
  c.savedContentDigest = digest("synthetic later saved Draft content");
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    panel(page).getByText(/Current publication records loaded · Revision 9/),
  ).toBeVisible();
  await loadReport(page);
  await expect(
    reportPanel(page).getByText(/the saved Draft had changed since this report/),
  ).toBeVisible();
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation checks" })
      .getByRole("listitem"),
  ).toHaveCount(12);
  await expect(
    reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }),
  ).toHaveCount(0);
  expect(c.history.at(-1)).toEqual(original);
  expect(c.bodies).toHaveLength(1);
  expect(c.pageErrors).toEqual([]);
});
test("@production V2 validation report denial malformed offline and confirmed-write refresh failure never revive old report", async ({
  page,
  context,
}) => {
  const c = await installSources(page);
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  await loadReport(page);
  c.reportMode = "Denied";
  await reportPanel(page)
    .getByRole("button", { name: "Refresh validation report", exact: true })
    .click();
  await expect(reportPanel(page).getByRole("status")).toContainText("access denied");
  await expect(
    reportPanel(page).getByRole("list", { name: "Recorded validation checks" }),
  ).toHaveCount(0);
  c.reportMode = "Malformed";
  await reportPanel(page)
    .getByRole("button", { name: "Refresh validation report", exact: true })
    .click();
  await expect(reportPanel(page).getByRole("status")).toContainText(
    "Validation report unavailable",
  );
  c.reportMode = "Current";
  await loadReport(page);
  await context.setOffline(true);
  await expect(
    reportPanel(page).getByRole("button", { name: /validation report$/ }),
  ).toBeDisabled();
  await expect(
    reportPanel(page).getByRole("list", { name: "Recorded validation checks" }),
  ).toHaveCount(0);
  await context.setOffline(false);
  await panel(page)
    .getByRole("button", { name: "Refresh publication records", exact: true })
    .click();
  await expect(
    panel(page).getByText(/Current publication records loaded · Revision 8/),
  ).toBeVisible();
  const reads = c.reportReads;
  // Admission still reads current management. Denial starts only after the
  // synthetic command has committed and its exact successful receipt is sent.
  c.denyManagementAfterNextCommand = true;
  await panel(page).getByRole("button", { name: "Submit publication review", exact: true }).click();
  await expect.poll(() => c.bodies.length).toBe(2);
  await expect(page.getByText(/Product change confirmed · Revision 9/)).toBeVisible();
  await expect(
    reportPanel(page).getByRole("button", { name: /validation report$/ }),
  ).toBeDisabled();
  await expect(
    reportPanel(page).getByRole("list", { name: "Recorded validation checks" }),
  ).toHaveCount(0);
  expect(await records(page)).toEqual([]);
  expect(c.reportReads).toBe(reads);
  expect(c.bodies.map((body) => (JSON.parse(body) as Command).action)).toEqual([
    "Validate",
    "SubmitReview",
  ]);
  expect(c.pageErrors).toEqual([]);
});

const confirmationConsent =
  "I have reviewed these recorded warnings and affected references and confirm my acceptance.";
async function prepareWarningConfirmation(page: Page, reason = "REVIEWED_REFERENCES") {
  await reportPanel(page)
    .getByLabel("Confirmation reason code (required)", { exact: true })
    .fill(reason);
  await reportPanel(page).getByRole("checkbox", { name: confirmationConsent, exact: true }).check();
  await expect(
    reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }),
  ).toBeEnabled();
}

test("@production V2 warning confirmation explicit consent keyboard reflow and expired reading preserve root and report", async ({
  page,
}) => {
  const c = await installSources(page);
  c.completeReport = true;
  c.warningReport = true;
  c.missingConfigurationWarnings = true;
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  await loadReport(page);
  const findings = reportPanel(page).getByRole("list", { name: "Recorded validation findings" });
  await expect(findings.locator(":scope > li")).toHaveCount(4);
  for (const [domain, message] of [
    ["PRICING", "This SKU has no recorded price configuration."],
    ["RECIPE", "This SKU has no recorded recipe configuration."],
    ["INVENTORY", "This SKU has no recorded inventory configuration."],
    ["MENU", "This SKU has no recorded menu configuration."],
  ] as const) {
    const finding = findings.locator(":scope > li").filter({ hasText: message });
    await expect(finding).toContainText(`REQUIRED_${domain}_REFERENCE_MISSING`);
    await expect(finding.getByText(message, { exact: true })).toBeVisible();
    await expect(finding.getByText(id(81), { exact: true })).toBeVisible();
  }
  const originalFindings = await findings.innerText();
  const reason = reportPanel(page).getByLabel("Confirmation reason code (required)", {
      exact: true,
    }),
    consent = reportPanel(page).getByRole("checkbox", { name: confirmationConsent, exact: true }),
    confirm = reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }),
    originalHistory = structuredClone(c.history),
    originalHeaders = structuredClone(c.headers),
    editorReads = [...c.editorRoots];
  await expect(confirm).toBeDisabled();
  await reason.fill("not an accepted code");
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(confirm).toBeDisabled();
  await reason.fill("REVIEWED_" + "R".repeat(55));
  await expect(reason).toHaveAttribute("aria-invalid", "false");
  await expect(confirm).toBeDisabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
    for (const target of [reason, consent, confirm]) {
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  }
  // Browser layout zoom uses the existing repository browser acceptance pattern.
  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await expect(confirm).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(reportPanel(page).getByRole("status")).toContainText(
    "Recorded snapshot — current access and source status are stale",
    { timeout: 8000 },
  );
  await expect(
    reportPanel(page).getByText(/read deadline is not a time limit for your decision/),
  ).toBeVisible();
  await consent.focus();
  await page.keyboard.press("Space");
  await expect(consent).toBeChecked();
  await expect(confirm).toBeEnabled();
  const readsBefore = c.reads;
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Warning confirmation recorded for Product revision 8.",
  );
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Current publication records loaded · Revision 8.",
  );
  expect(c.reads).toBeGreaterThan(readsBefore); // Fresh action admission; no human five-second deadline.
  expect(c.ackApplied).toBe(1);
  expect(c.ackBodies).toHaveLength(1);
  const command = parseProductPublicationWarningAcknowledgementCommand(
    JSON.parse(c.ackBodies[0] ?? "{}"),
  );
  expect(command.reasonCode).toBe("REVIEWED_" + "R".repeat(55));
  expect(command.warningCodes).toEqual(["ChangeImpact"]);
  expect(c.root).toBe(8);
  expect(c.history).toEqual(originalHistory);
  expect(c.headers).toEqual(originalHeaders);
  expect(c.editorRoots).toEqual(editorReads); // Ack must not call the Product-changed callback.
  expect(c.bodies).toHaveLength(1);
  expect(await records(page)).toEqual([]);
  await loadReport(page);
  await expect(findings).toHaveText(originalFindings, { useInnerText: true });
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation checks" })
      .getByText(/Change impact.*Warning/),
  ).toBeVisible();
  await expect(panel(page).getByText(/validation WarningAcknowledgementRequired/)).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Submit publication review", exact: true }),
  ).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Publish now", exact: true })).toHaveCount(
    0,
  );
  // A separate new Validate returns explicit synthetic blocking evidence. The
  // original immutable warning report and acknowledgement are not rewritten.
  c.hardErrorReport = true;
  await action(page, "Validate publication", 9, "Draft");
  await loadReport(page);
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation checks" })
      .getByText(/Change impact.*Blocking error/),
  ).toBeVisible();
  await expect(
    reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }),
  ).toHaveCount(0);
  expect(c.ackApplied).toBe(1);
  expect(c.history[0]).toEqual(originalHistory[0]);
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 warning confirmation lost reply reload denial preserves exact IndexedDB request and shared barrier", async ({
  page,
  context,
}) => {
  const c = await installSources(page);
  c.completeReport = true;
  c.warningReport = true;
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  // Obtain a real current navigation entry before Ack. Ack does not change root,
  // so a reload must continue to use the actual revision 8 editor, never a fake 7.
  await page.getByRole("link", { name: "Back to products", exact: true }).click();
  await page
    .getByRole("link", { name: "Publication history", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    panel(page).getByText(/Current publication records loaded · Revision 8/),
  ).toBeVisible();
  await loadReport(page);
  await prepareWarningConfirmation(page, "REVIEWED_BEFORE_LOST_REPLY");
  const originalHistory = structuredClone(c.history),
    originalHeaders = structuredClone(c.headers);
  c.loseNextAck = true;
  await reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }).click();
  await expect(
    panel(page).getByText(/Original warning confirmation request is unconfirmed/),
  ).toBeVisible();
  const stored = await records(page),
    original = c.ackBodies[0],
    reads = c.reads;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    profile: "CatalogProductPublicationWarningAcknowledgementPendingV1",
    body: original,
  });
  expect(JSON.stringify(stored)).not.toContain(csrf);
  await expect(
    panel(page).getByLabel("Original warning confirmation", { exact: true }),
  ).toContainText("REVIEWED_BEFORE_LOST_REPLY");
  c.ackDenied = true;
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Current Product content", exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(/Original warning confirmation request is unconfirmed/),
  ).toBeVisible();
  expect(c.rejectedEditorRoots).toEqual([]);
  expect(c.editorRoots.at(-1)).toBe(8);
  expect(c.reads).toBe(reads); // Recovery precedes current management and new mutation.
  expect(await records(page)).toEqual(stored);
  await expect(
    panel(page).getByLabel("Original warning confirmation", { exact: true }),
  ).toContainText("ChangeImpact");
  await expect(page.getByRole("button", { name: "Open Draft editor", exact: true })).toBeDisabled();
  await expect(
    panel(page).getByRole("button", { name: "Refresh publication records", exact: true }),
  ).toBeDisabled();
  await expect(
    panel(page).getByRole("button", { name: "Validate publication", exact: true }),
  ).toHaveCount(0);
  await expect(
    reportPanel(page).getByRole("button", { name: "Load validation report", exact: true }),
  ).toBeDisabled();
  const retry = panel(page).getByRole("button", {
    name: "Retry original warning confirmation",
    exact: true,
  });
  await context.setOffline(true);
  await expect(retry).toBeDisabled();
  await context.setOffline(false);
  await retry.click();
  await expect.poll(() => c.ackBodies.length).toBe(2);
  await expect(
    panel(page).getByText(/Original warning confirmation request is unconfirmed/),
  ).toBeVisible();
  expect(await records(page)).toEqual(stored);
  expect(c.ackApplied).toBe(1);
  c.ackDenied = false;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Warning confirmation recorded for Product revision 8.",
  );
  await expect.poll(() => records(page)).toEqual([]);
  expect(c.ackBodies).toEqual([original, original, original]);
  expect(new Set(c.ackScopes).size).toBe(1);
  expect(c.ackApplied).toBe(1);
  expect(c.root).toBe(8);
  expect(c.history).toEqual(originalHistory);
  expect(c.headers).toEqual(originalHeaders);
  expect(c.bodies).toHaveLength(1);
  expect(c.legacyWrites).toBe(0);
  expect(c.pageErrors).toEqual([]);
});

test("@production V2 warning confirmation known receipt survives subsequent current-read denial", async ({
  page,
}) => {
  const c = await installSources(page);
  c.completeReport = true;
  c.warningReport = true;
  await enter(page);
  await setPeriod(page);
  await action(page, "Validate publication", 8, "Draft");
  await loadReport(page);
  await prepareWarningConfirmation(page);
  const originalHistory = structuredClone(c.history);
  c.denyManagementAfterNextAck = true;
  await reportPanel(page).getByRole("button", { name: "Confirm warnings", exact: true }).click();
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Warning confirmation recorded for Product revision 8.",
  );
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Current records unavailable: Denied.",
  );
  expect(await records(page)).toEqual([]);
  expect(c.ackApplied).toBe(1);
  expect(c.root).toBe(8);
  expect(c.history).toEqual(originalHistory);
  await expect(
    reportPanel(page).getByRole("list", { name: "Recorded validation checks" }),
  ).toHaveCount(0);
  await expect(
    reportPanel(page).getByRole("button", { name: "Load validation report", exact: true }),
  ).toBeDisabled();
  await expect(
    panel(page).getByRole("button", { name: "Retry original warning confirmation", exact: true }),
  ).toHaveCount(0);
  c.mode = "Current";
  await panel(page)
    .getByRole("button", { name: "Refresh publication records", exact: true })
    .click();
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Warning confirmation recorded for Product revision 8.",
  );
  await expect(panel(page).locator("#publication-request-result")).toContainText(
    "Current publication records loaded · Revision 8.",
  );
  await loadReport(page);
  await expect(
    reportPanel(page)
      .getByRole("list", { name: "Recorded validation checks" })
      .getByText(/Change impact.*Warning/),
  ).toBeVisible();
  expect(c.ackBodies).toHaveLength(1);
  expect(c.bodies).toHaveLength(1);
  expect(c.pageErrors).toEqual([]);
});
