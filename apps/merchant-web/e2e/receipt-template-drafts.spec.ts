import { parseDigitalReceiptTemplatePublishedCurrent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-published-current.js";
import {
  createStoreSetupDraft,
  replaceStoreSetupDraftContent,
  type StoreSetupDraft,
} from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import {
  parseStoreSetupSaveCommand,
  parseStoreSetupOperationReceipt,
} from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import {
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleReceipt,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-lifecycle-action.js";
import { materializeDigitalReceiptTemplateContent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-content.js";
import { parseDigitalReceiptTemplateReviewCurrent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-review.js";
import { parseDigitalReceiptTemplateSubmission } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-submission.js";
import {
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitReceipt,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-submit.js";
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactCurrent,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-artifact.js";
import {
  parseDigitalReceiptTemplateDraftSave,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftReceipt,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftRoster,
  type DigitalReceiptTemplateDraft,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-draft.js";
import { createDigitalReceiptTemplateDraftContent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-draft-fields.js";
import { digitalReceiptRequiredFields } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template.js";
import { canonicalPublicationValue } from "../src/product-publication-command-client-v2.js";
// Production App/client and real IndexedDB. HTTP facts are synthetic; no native
// IAM, PostgreSQL, template publication or professional review is claimed.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  href = `/app/organization/stores/${id(3)}/setup`;
const hash = (v: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalPublicationValue(v)).digest("hex");
const respond = (route: Route, v: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(v),
  });
async function cursors(page: Page, submission: boolean | "Lifecycle" | "Setup" = false) {
  return page.evaluate(
    (submission) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(
          submission === "Setup"
            ? "bop-store-setup-pending-v1"
            : submission === "Lifecycle"
              ? "bop-receipt-template-lifecycle-pending-v1"
              : submission
                ? "bop-receipt-template-submit-pending-v1"
                : "bop-receipt-template-draft-pending-v1",
          1,
        );
        open.onerror = () => reject(new Error("journal unavailable"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            r = tx.objectStore("originals").getAll();
          let values: unknown[] = [];
          r.onsuccess = () => {
            values = r.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(values);
          };
          tx.onabort = () => reject(new Error("journal unavailable"));
        };
      }),
    submission,
  );
}
async function install(page: Page) {
  const selectedScope = { ...scope };
  const state = {
    loseSetup: false,
    denySetupResolve: false,
    setupPosts: [] as Record<string, unknown>[],
    publishedGets: 0,
    lose: false,
    loseSubmit: false,
    loseLifecycle: false,
    denyLifecycle: false,
    lifecyclePosts: [] as Record<string, unknown>[],
    selectActor(reference: string) {
      selectedScope.actorReference = reference;
    },
    denySubmit: false,
    failReview: 0,
    submitPosts: [] as Record<string, unknown>[],
    deny: false,
    conflict: false,
    posts: [] as Record<string, unknown>[],
    errors: [] as string[],
  };
  let savedSetup: StoreSetupDraft | null = null;
  const setupLedger = new Map<string, ReturnType<typeof parseStoreSetupOperationReceipt>>();
  const drafts = new Map<string, DigitalReceiptTemplateDraft>(),
    ledger = new Map<string, ReturnType<typeof parseDigitalReceiptTemplateDraftReceipt>>();
  const submitted = new Map<string, ReturnType<typeof parseDigitalReceiptTemplateSubmission>>(),
    submitLedger = new Map<string, ReturnType<typeof parseDigitalReceiptTemplateSubmitReceipt>>();
  const lifecycleHeads = new Map<
      string,
      NonNullable<ReturnType<typeof parseDigitalReceiptTemplateReviewCurrent>["lifecycle"]>
    >(),
    lifecycleLedger = new Map<
      string,
      ReturnType<typeof parseDigitalReceiptTemplateLifecycleReceipt>
    >();
  const seededAt = new Date(Date.now() - 1000).toISOString();
  const artifact = (kind: "Layout" | "Compliance") =>
    parseDigitalReceiptTemplateArtifactVersion({
      profile: "DigitalReceiptTemplateArtifactV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      artifactKind: kind,
      artifactReference: kind === "Layout" ? id(5) : id(6),
      revision: 1,
      authoredByReference: id(4),
      previousArtifactReference: null,
      content:
        kind === "Layout"
          ? {
              profile: "AccessibleDigitalReceiptLayoutV1",
              dataContractVersion: 1,
              renderEngineVersion: 1,
              outputProfile: "AccessibleDigitalReceipt",
              requiredFields: [...digitalReceiptRequiredFields],
            }
          : {
              profile: "DigitalReceiptRequiredFieldRuleV1",
              dataContractVersion: 1,
              requiredFields: [...digitalReceiptRequiredFields],
              professionalReviewStatus: "NotEvaluated",
              legalConclusion: "NotEvaluated",
            },
      createdAt: seededAt,
      updatedAt: seededAt,
      dataClassification: "Internal",
    });
  const layout = artifact("Layout"),
    compliance = artifact("Compliance");
  page.on("pageerror", (e) => state.errors.push(e.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString();
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
      };
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: selected,
          authorizedStores: [selected],
          navigation: [
            {
              screenId: "STORE-SETUP",
              href,
              label: "Store setup",
              permission: "organization.manage",
            },
          ],
          businessDate: "2026-10-05",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (path === "/merchant/store-setup" && request.method() === "GET")
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope: selectedScope,
        store: {
          storeReference: id(3),
          code: "SYNTH_STORE",
          displayName: "Synthetic Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: {
          profile: "StoreSetupCurrentV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          readerActorReference: selectedScope.actorReference,
          snapshot: savedSetup,
          observedAt: at,
          validUntil: until,
          businessReferenceValidation: "NotEvaluated",
        },
      });
    if (path === "/merchant/store-setup" && request.method() === "POST") {
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      const body: Record<string, unknown> = request.postDataJSON();
      state.setupPosts.push(body);
      expect(Object.keys(body).sort()).toEqual(
        [
          "command",
          "operationReference",
          "expectedSetupReference",
          "expectedRevision",
          body.command === "ResolveOriginal" ? "intentDigest" : "content",
        ].sort(),
      );
      const original = setupLedger.get(String(body.operationReference));
      if (body.command === "ResolveOriginal") {
        expect(body).not.toHaveProperty("content");
        if (state.denySetupResolve) return respond(route, { error: "request_denied" }, 403);
        if (!original) throw new Error("controlled setup terminal missing");
        expect(body.intentDigest).toBe(original.intentDigest);
        expect(body.expectedRevision).toBe(original.expectedRevision);
        expect(body.expectedSetupReference).toBe(original.expectedSetupReference);
        return respond(route, original);
      }
      expect(body.command).toBe("SaveDraft");
      const command = parseStoreSetupSaveCommand({
        profile: "StoreSetupSaveV1",
        ...selectedScope,
        operationReference: body.operationReference,
        expectedSetupReference: body.expectedSetupReference,
        expectedRevision: body.expectedRevision,
        content: body.content,
        purposeCode: "STORE_SETUP_DRAFT",
      });
      if (original) {
        expect(hash(command)).toBe(original.intentDigest);
        return respond(route, original);
      }
      expect(command.expectedRevision).toBe(savedSetup?.revision ?? 0);
      expect(command.expectedSetupReference).toBe(savedSetup?.setupDraftReference ?? null);
      const actual = {
        ...selectedScope,
        defaultLocale: "en-CA",
        currencyCode: "CAD" as const,
        baseConfigurationReference: null,
      };
      savedSetup = savedSetup
        ? replaceStoreSetupDraftContent(savedSetup, command.content, actual, {
            expectedRevision: command.expectedRevision,
            observedAt: at,
          })
        : createStoreSetupDraft(
            {
              profile: "StoreSetupDraftV1",
              tenantReference: selectedScope.tenantReference,
              brandReference: selectedScope.brandReference,
              storeReference: selectedScope.storeReference,
              setupDraftReference: id(1500),
              revision: 1,
              authoredByReference: selectedScope.actorReference,
              defaultLocale: "en-CA",
              currencyCode: "CAD",
              baseConfigurationReference: null,
              content: command.content,
              createdAt: at,
              updatedAt: at,
              purposeCode: "STORE_SETUP_DRAFT",
              dataClassification: "ConfigurationMetadata",
            },
            actual,
          );
      const receipt = parseStoreSetupOperationReceipt({
        profile: "StoreSetupOperationReceiptV1",
        ...selectedScope,
        operationReference: command.operationReference,
        expectedSetupReference: command.expectedSetupReference,
        expectedRevision: command.expectedRevision,
        purposeCode: "STORE_SETUP_DRAFT",
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot: savedSetup,
        auditReference: id(1510 + savedSetup.revision),
        occurredAt: at,
      });
      setupLedger.set(command.operationReference, receipt);
      if (state.loseSetup) {
        state.loseSetup = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-published" && request.method() === "GET") {
      state.publishedGets++;
      expect([...url.searchParams.keys()].sort()).toEqual(
        ["storeReference", "templateReference", "locale"].sort(),
      );
      expect(url.searchParams.get("storeReference")).toBe(selectedScope.storeReference);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      expect(request.headers()["x-bop-csrf"]).toBeUndefined();
      const template = url.searchParams.get("templateReference"),
        head = template ? lifecycleHeads.get(template) : undefined,
        terminal = head ? lifecycleLedger.get(head.latestMutationOperationReference) : undefined,
        currentVersion = terminal?.result?.publishedVersion;
      if (
        !currentVersion ||
        head?.state !== "Published" ||
        currentVersion.locale !== url.searchParams.get("locale")
      )
        return respond(route, { error: "receipt_template_published_unavailable" }, 503);
      return respond(
        route,
        parseDigitalReceiptTemplatePublishedCurrent({
          profile: "DigitalReceiptTemplatePublishedCurrentV1",
          ...selectedScope,
          templateReference: template,
          locale: url.searchParams.get("locale"),
          currentVersion,
          observedAt: at,
          validUntil: until,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        }),
      );
    }
    if (path === "/merchant/store-setup/references")
      return respond(route, {
        profile: "StoreSetupReferencesCurrentV1",
        ...selectedScope,
        address: null,
        contact: null,
        observedAt: at,
        validUntil: until,
        businessReferenceValidation: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/payment-configuration")
      return respond(route, {
        profile: "StorePaymentConfigurationCurrentV1",
        ...selectedScope,
        snapshot: null,
        observedAt: at,
        validUntil: until,
        providerReadiness: "NotEvaluated",
      });

    if (path === "/merchant/store-setup/receipt-artifacts" && request.method() === "GET")
      return respond(
        route,
        parseDigitalReceiptTemplateArtifactCurrent({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...selectedScope,
          layout,
          compliance,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    if (path === "/merchant/store-setup/receipt-template-drafts") {
      const afterTemplate = url.searchParams.get("afterTemplate"),
        entries = [...drafts.values()]
          .sort((a, b) => (a.content.templateReference < b.content.templateReference ? -1 : 1))
          .filter((s) => afterTemplate === null || s.content.templateReference > afterTemplate)
          .slice(0, 20);
      return respond(
        route,
        parseDigitalReceiptTemplateDraftRoster({
          profile: "DigitalReceiptTemplateDraftRosterV1",
          ...selectedScope,
          afterTemplate,
          entries,
          nextAfter: null,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    }
    if (path === "/merchant/store-setup/receipt-template-review" && request.method() === "GET") {
      if (state.failReview > 0) {
        state.failReview--;
        return respond(route, { error: "receipt_template_review_unavailable" }, 503);
      }
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      const templateReference = url.searchParams.get("templateReference"),
        draft = templateReference ? drafts.get(templateReference) : undefined;
      if (!draft) return respond(route, { error: "receipt_template_review_conflict" }, 409);
      const submission = submitted.get(draft.content.templateReference) ?? null;
      return respond(
        route,
        parseDigitalReceiptTemplateReviewCurrent({
          profile: "DigitalReceiptTemplateReviewCurrentV1",
          ...selectedScope,
          templateReference: draft.content.templateReference,
          currentDraft: {
            versionReference: draft.content.versionReference,
            revision: draft.revision,
            contentDigest: draft.contentDigest,
          },
          submission,
          lifecycle: submission
            ? (lifecycleHeads.get(draft.content.templateReference) ?? {
                lifecycleReference: submission.reviewLifecycleReference,
                version: submission.reviewVersion,
                state: "InReview",
                latestMutationOperationReference: submission.operationReference,
                changedAt: submission.submittedAt,
                validationEvidenceReference: submission.validationEvidenceReference,
                approvalEvidenceReference: null,
              })
            : null,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    }
    if (
      path === "/merchant/store-setup/receipt-template-lifecycle" &&
      request.method() === "POST"
    ) {
      const body: Record<string, unknown> = request.postDataJSON();
      state.lifecyclePosts.push(body);
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      const stored = await cursors(page, "Lifecycle");
      expect(stored).toContainEqual(
        expect.objectContaining({
          operationReference: body.operationReference,
          templateReference: body.templateReference,
        }),
      );
      for (const key of [
        "content",
        "fields",
        "locale",
        "csrf",
        "approvalValidUntil",
        "publishedVersion",
      ])
        expect(JSON.stringify(stored)).not.toContain(key);
      if (state.denyLifecycle) return respond(route, { error: "request_denied" }, 403);
      const old = lifecycleLedger.get(String(body.operationReference));
      if (old) {
        if (body.command === "ResolveOriginal") expect(body.intentDigest).toBe(old.intentDigest);
        return respond(route, old);
      }
      const action = body.command === "ResolveOriginal" ? body.action : body.command;
      const command = parseDigitalReceiptTemplateLifecycleAction({
        profile: "DigitalReceiptTemplateLifecycleActionV1",
        ...selectedScope,
        action,
        operationReference: body.operationReference,
        templateReference: body.templateReference,
        expectedVersionReference: body.expectedVersionReference,
        expectedRevision: body.expectedRevision,
        reviewLifecycleReference: body.reviewLifecycleReference,
        expectedReviewVersion: body.expectedReviewVersion,
        expectedReviewOperationReference: body.expectedReviewOperationReference,
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      });
      const draft = drafts.get(command.templateReference),
        submission = submitted.get(command.templateReference);
      if (!draft || !submission) throw new Error("fixture reviewed draft missing");
      const head = lifecycleHeads.get(command.templateReference);
      expect(command.expectedVersionReference).toBe(submission.versionReference);
      expect(command.expectedReviewVersion).toBe(head?.version ?? submission.reviewVersion);
      expect(command.expectedReviewOperationReference).toBe(
        head?.latestMutationOperationReference ?? submission.operationReference,
      );
      const prior = head ? lifecycleLedger.get(head.latestMutationOperationReference) : undefined;
      if (action === "Publish" && !prior?.result)
        throw new Error("fixture independent approval missing");
      if (action === "Approve") {
        expect(selectedScope.actorReference).not.toBe(submission.authoredByReference);
        expect(selectedScope.actorReference).not.toBe(submission.submittedByReference);
      }
      const approval = (() => {
        if (action === "Approve")
          return {
            approvalEvidenceReference: id(900 + lifecycleLedger.size),
            approvedByReference: selectedScope.actorReference,
            approvedAt: at,
            approvalValidUntil: new Date(
              Math.min(Date.parse(at) + 86400000, Date.parse(submission.validationValidUntil)),
            ).toISOString(),
          };
        if (!prior?.result) throw new Error("fixture independent approval missing");
        return {
          approvalEvidenceReference: prior.result.approvalEvidenceReference,
          approvedByReference: prior.result.approvedByReference,
          approvedAt: prior.result.approvedAt,
          approvalValidUntil: prior.result.approvalValidUntil,
        };
      })();
      const receipt = parseDigitalReceiptTemplateLifecycleReceipt({
        profile: "DigitalReceiptTemplateLifecycleReceiptV1",
        ...selectedScope,
        action,
        operationReference: command.operationReference,
        templateReference: command.templateReference,
        expectedVersionReference: command.expectedVersionReference,
        expectedRevision: command.expectedRevision,
        reviewLifecycleReference: command.reviewLifecycleReference,
        expectedReviewVersion: command.expectedReviewVersion,
        expectedReviewOperationReference: command.expectedReviewOperationReference,
        intentDigest: hash(command),
        outcome: "Committed",
        auditReference: id(920 + lifecycleLedger.size),
        occurredAt: at,
        result: {
          lifecycleReference: command.reviewLifecycleReference,
          lifecycleVersion: command.expectedReviewVersion + 1,
          state: action === "Approve" ? "Approved" : "Published",
          mutationOperationReference: command.operationReference,
          changedAt: at,
          ...approval,
          publishedVersion:
            action === "Publish"
              ? materializeDigitalReceiptTemplateContent({
                  content: draft.content,
                  publicationReference: id(940),
                  publishedAt: at,
                })
              : null,
        },
      });
      lifecycleLedger.set(command.operationReference, receipt);
      lifecycleHeads.set(command.templateReference, {
        lifecycleReference: command.reviewLifecycleReference,
        version: command.expectedReviewVersion + 1,
        state: action === "Approve" ? "Approved" : "Published",
        latestMutationOperationReference: command.operationReference,
        changedAt: at,
        validationEvidenceReference: submission.validationEvidenceReference,
        approvalEvidenceReference: approval.approvalEvidenceReference,
      });
      if (state.loseLifecycle) {
        state.loseLifecycle = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-submit" && request.method() === "POST") {
      const body: Record<string, unknown> = request.postDataJSON();
      state.submitPosts.push(body);
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      expect(await cursors(page, true)).toContainEqual(
        expect.objectContaining({
          profile: "ReceiptTemplateSubmitPendingOriginalV1",
          operationReference: body.operationReference,
          templateReference: body.templateReference,
        }),
      );
      if (state.denySubmit) return respond(route, { error: "request_denied" }, 403);
      const old = submitLedger.get(String(body.operationReference));
      if (old) {
        if (body.command === "ResolveOriginal") expect(body.intentDigest).toBe(old.intentDigest);
        return respond(route, old);
      }
      const command = parseDigitalReceiptTemplateSubmit({
        profile: "DigitalReceiptTemplateSubmitV1",
        ...selectedScope,
        operationReference: body.operationReference,
        templateReference: body.templateReference,
        expectedVersionReference: body.expectedVersionReference,
        expectedRevision: body.expectedRevision,
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      });
      const draft = drafts.get(command.templateReference);
      if (
        !draft ||
        draft.revision !== command.expectedRevision ||
        draft.content.versionReference !== command.expectedVersionReference
      )
        return respond(route, { error: "receipt_template_submit_conflict" }, 409);
      const submission = parseDigitalReceiptTemplateSubmission({
        profile: "DigitalReceiptTemplateSubmissionV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        templateReference: command.templateReference,
        familyReference: draft.familyReference,
        versionReference: command.expectedVersionReference,
        draftRevision: draft.revision,
        contentDigest: draft.contentDigest,
        authoredByReference: draft.authoredByReference,
        submittedByReference: selectedScope.actorReference,
        operationReference: command.operationReference,
        reviewLifecycleReference: id(800),
        reviewVersion: 2,
        validationEvidenceReference: id(801),
        checkedAt: at,
        validationValidUntil: new Date(Date.parse(at) + 72 * 60 * 60 * 1000).toISOString(),
        submittedAt: at,
        auditReference: id(802),
        dataClassification: "Internal",
      });
      submitted.set(command.templateReference, submission);
      const receipt = parseDigitalReceiptTemplateSubmitReceipt({
        profile: "DigitalReceiptTemplateSubmitReceiptV1",
        ...selectedScope,
        operationReference: command.operationReference,
        templateReference: command.templateReference,
        expectedVersionReference: command.expectedVersionReference,
        expectedRevision: command.expectedRevision,
        intentDigest: hash(command),
        outcome: "Committed",
        submission,
        auditReference: submission.auditReference,
        occurredAt: at,
      });
      submitLedger.set(command.operationReference, receipt);
      if (state.loseSubmit) {
        state.loseSubmit = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-draft" && request.method() === "GET") {
      const templateReference = url.searchParams.get("templateReference");
      return respond(
        route,
        parseDigitalReceiptTemplateDraftCurrent({
          profile: "DigitalReceiptTemplateDraftCurrentV1",
          ...selectedScope,
          templateReference,
          snapshot: templateReference ? (drafts.get(templateReference) ?? null) : null,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    }
    if (path === "/merchant/store-setup/receipt-template-draft" && request.method() === "POST") {
      const body: Record<string, unknown> = request.postDataJSON();
      state.posts.push(body);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(),
        ),
      ).toEqual(selectedScope);
      expect(request.headers()["x-bop-csrf"]).toBe(csrf);
      const stored = await cursors(page);
      expect(stored).toContainEqual(
        expect.objectContaining({
          profile: "ReceiptTemplateDraftPendingOriginalV1",
          operationReference: body.operationReference,
          templateReference: body.templateReference,
          expectedVersionReference: body.expectedVersionReference,
          expectedRevision: body.expectedRevision,
        }),
      );
      for (const key of ["fields", "content", "locale", "csrf"])
        expect(JSON.stringify(stored)).not.toContain(key);
      if (state.deny) return respond(route, { error: "request_denied" }, 403);
      if (body.command === "ResolveOriginal") {
        const original = ledger.get(String(body.operationReference));
        if (!original) throw new Error("fixture original missing");
        expect(body.intentDigest).toBe(original.intentDigest);
        return respond(route, original);
      }
      if (state.conflict) return respond(route, { error: "receipt_template_draft_conflict" }, 409);
      const command = parseDigitalReceiptTemplateDraftSave({
        profile: "DigitalReceiptTemplateDraftSaveV1",
        ...selectedScope,
        operationReference: body.operationReference,
        templateReference: body.templateReference,
        expectedVersionReference: body.expectedVersionReference,
        expectedRevision: body.expectedRevision,
        fields: body.fields,
        purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
      });
      const original = ledger.get(command.operationReference);
      if (original) {
        expect(original.intentDigest).toBe(hash(command));
        return respond(route, original);
      }
      const template = command.templateReference ?? id(100 + state.posts.length),
        prior = drafts.get(template);
      expect(prior?.revision ?? 0).toBe(command.expectedRevision);
      expect(prior?.content.versionReference ?? null).toBe(command.expectedVersionReference);
      const content = createDigitalReceiptTemplateDraftContent({
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        templateReference: template,
        versionReference: id(200 + state.posts.length),
        versionNumber: 1,
        fields: command.fields,
      });
      const snapshot = parseDigitalReceiptTemplateDraft({
        profile: "DigitalReceiptTemplateDraftV2",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        familyReference: prior?.familyReference ?? id(300 + state.posts.length),
        revision: command.expectedRevision + 1,
        authoredByReference: id(4),
        previousVersionReference: command.expectedVersionReference,
        content,
        contentDigest: hash(content),
        createdAt: prior?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      drafts.set(template, snapshot);
      const receipt = parseDigitalReceiptTemplateDraftReceipt({
        profile: "DigitalReceiptTemplateDraftReceiptV1",
        ...selectedScope,
        operationReference: command.operationReference,
        templateReference: command.templateReference,
        expectedVersionReference: command.expectedVersionReference,
        expectedRevision: command.expectedRevision,
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot,
        auditReference: id(400 + state.posts.length),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      if (state.lose) {
        state.lose = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    return respond(route, { error: "fixture_unavailable" }, 503);
  });
  return Object.assign(state, {
    savedSetup: () => savedSetup,
    setupReceipts: () => [...setupLedger.values()],
  });
}
async function open(page: Page) {
  await page.goto("/app");
  await page
    .getByRole("link", { name: "Store setup", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  const region = page.getByRole("region", { name: "Receipt template drafts", exact: true });
  await expect(region.getByRole("textbox", { name: "Template locale", exact: true })).toBeEnabled();
  return region;
}
async function fill(page: Page, locale = "fr-CA") {
  const region = page.getByRole("region", { name: "Receipt template drafts", exact: true });
  await region.getByRole("textbox", { name: "Template locale", exact: true }).fill(locale);
  await region
    .getByRole("combobox", { name: "Receipt layout selection", exact: true })
    .selectOption({ label: "Saved layout revision 1" });
  await region
    .getByRole("combobox", { name: "Receipt required fields selection", exact: true })
    .selectOption({ label: "Saved required fields revision 1" });
  return region;
}
test("@production ordinary template draft save, actual generated current and roster resume", async ({
  page,
}) => {
  const state = await install(page);
  const region = await open(page);
  await fill(page);
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByText("Saved fr-CA, revision 1, RECEIPT_1. Publication has not been evaluated."),
  ).toBeVisible();
  expect(await cursors(page)).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  await expect(region.getByRole("textbox", { name: "Template locale", exact: true })).toHaveValue(
    "fr-CA",
  );
  await region
    .getByRole("textbox", { name: "Template effective until UTC (optional)", exact: true })
    .fill("2026-10-07T00:00:00.000Z");
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByText("Saved fr-CA, revision 2, RECEIPT_1. Publication has not been evaluated."),
  ).toBeVisible();
  expect(state.posts.filter((p) => p.command === "SaveDraft")).toHaveLength(2);
  expect(state.errors).toEqual([]);
});
test("@production lost template reply retains real payload-free IDB through denied reload recovery", async ({
  page,
}) => {
  const state = await install(page),
    region = await open(page);
  await fill(page);
  state.lose = true;
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Recover original template draft save", exact: true }),
  ).toBeVisible();
  const original = state.posts[0];
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Recover original template draft save", exact: true }),
  ).toBeEnabled();
  state.deny = true;
  await region
    .getByRole("button", { name: "Recover original template draft save", exact: true })
    .click();
  await expect(region.getByRole("alert")).toContainText("Permission denied");
  expect(await cursors(page)).toHaveLength(1);
  state.deny = false;
  await region
    .getByRole("button", { name: "Recover original template draft save", exact: true })
    .click();
  await expect.poll(() => cursors(page)).toEqual([]);
  expect(state.posts.at(-1)).toEqual({
    command: "ResolveOriginal",
    operationReference: original?.operationReference,
    templateReference: null,
    expectedVersionReference: null,
    expectedRevision: 0,
    intentDigest: expect.stringMatching(/^sha256:/u),
  });
  expect(state.errors).toEqual([]);
});
test("@production 390px keyboard preview and conflict preserve the exact pending original", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page),
    region = await open(page);
  await fill(page);
  const locale = region.getByRole("textbox", { name: "Template locale", exact: true });
  await locale.focus();
  await page.keyboard.press("Tab");
  await expect(
    region.getByRole("combobox", { name: "Receipt layout selection", exact: true }),
  ).toBeFocused();
  await expect(
    region.getByRole("region", { name: "Receipt field preview", exact: true }),
  ).toContainText("RefundedTotal");
  const sizes = await region
    .locator("button, input, select")
    .evaluateAll((controls) =>
      controls
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => control.getBoundingClientRect().height),
    );
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.every((height) => height >= 44)).toBe(true);
  state.conflict = true;
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("original save conflicts");
  await expect(
    region.getByRole("combobox", { name: "Receipt template", exact: true }),
  ).toBeDisabled();
  expect(await cursors(page)).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await region.screenshot({ path: "/private/tmp/wp2421-receipt-template-draft-mobile.png" });
  expect(state.errors).toEqual([]);
});

test("@production ordinary template review submission reloads real state and freezes editing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page),
    region = await open(page);
  await fill(page);
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  const submit = region.getByRole("button", { name: "Submit template for review", exact: true });
  await expect(submit).toBeEnabled();
  await region.getByRole("textbox", { name: "Template locale", exact: true }).fill("en-CA");
  await expect(submit).toBeDisabled();
  await region.getByRole("textbox", { name: "Template locale", exact: true }).fill("fr-CA");
  await expect(submit).toBeEnabled();
  const submitBox = await submit.boundingBox();
  expect(submitBox?.height).toBeGreaterThanOrEqual(44);
  expect(submitBox?.width).toBeGreaterThanOrEqual(44);
  await submit.focus();
  await expect(submit).toBeFocused();
  await submit.press("Enter");
  await expect(
    region.getByRole("textbox", { name: "Template locale", exact: true }),
  ).toBeDisabled();
  await expect(
    region.getByRole("button", { name: "Save template draft", exact: true }),
  ).toBeDisabled();
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("InReview");
  await expect.poll(() => cursors(page, true)).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  await expect(
    region.getByRole("textbox", { name: "Template locale", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await region.screenshot({ path: "/private/tmp/wp2421-receipt-template-submit-mobile.png" });
  expect(state.submitPosts.filter((p) => p.command === "SubmitReview")).toHaveLength(1);
  expect(state.errors).toEqual([]);
});
test("@production lost template submission survives reload and denied recovery without enabling edits", async ({
  page,
}) => {
  const state = await install(page),
    region = await open(page);
  await fill(page);
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Submit template for review", exact: true }),
  ).toBeEnabled();
  state.loseSubmit = true;
  await region.getByRole("button", { name: "Submit template for review", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Recover earlier template submission", exact: true }),
  ).toBeEnabled();
  const original = state.submitPosts[0];
  expect(await cursors(page, true)).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  state.denySubmit = true;
  await region
    .getByRole("button", { name: "Recover earlier template submission", exact: true })
    .click();
  await expect(region.getByRole("alert")).toContainText("Permission denied");
  expect(await cursors(page, true)).toHaveLength(1);
  await expect(
    region.getByRole("button", { name: "Save template draft", exact: true }),
  ).toBeDisabled();
  state.denySubmit = false;
  await region
    .getByRole("button", { name: "Recover earlier template submission", exact: true })
    .click();
  await expect.poll(() => cursors(page, true)).toEqual([]);
  expect(state.submitPosts.at(-1)).toEqual({
    command: "ResolveOriginal",
    operationReference: original?.operationReference,
    templateReference: original?.templateReference,
    expectedVersionReference: original?.expectedVersionReference,
    expectedRevision: original?.expectedRevision,
    intentDigest: expect.stringMatching(/^sha256:/u),
  });
  expect(state.errors).toEqual([]);
});

test("@production template submission recovery restores readiness after initial review read failure", async ({
  page,
}) => {
  const state = await install(page),
    region = await open(page);
  await fill(page);
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Submit template for review", exact: true }),
  ).toBeEnabled();
  state.loseSubmit = true;
  await region.getByRole("button", { name: "Submit template for review", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Recover earlier template submission", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  state.failReview = 1;
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  await expect(region.getByRole("alert")).toContainText("unavailable");
  await expect(
    region.getByRole("combobox", { name: "Receipt template", exact: true }),
  ).toBeDisabled();
  await region
    .getByRole("button", { name: "Recover earlier template submission", exact: true })
    .click();
  await expect.poll(() => cursors(page, true)).toEqual([]);
  await expect(
    region.getByRole("combobox", { name: "Receipt template", exact: true }),
  ).toBeEnabled();
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("InReview");
  await expect(
    region.getByRole("textbox", { name: "Template locale", exact: true }),
  ).toBeDisabled();
  expect(state.submitPosts.at(-1)?.command).toBe("ResolveOriginal");
  expect(state.errors).toEqual([]);
});

async function independentReview(
  page: Page,
  state: Awaited<ReturnType<typeof install>>,
  locale = "fr-CA",
) {
  const region = await open(page);
  await fill(page, locale);
  await region.getByRole("button", { name: "Save template draft", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Submit template for review", exact: true }),
  ).toBeEnabled();
  await region.getByRole("button", { name: "Submit template for review", exact: true }).click();
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("InReview");
  await expect(
    region.getByRole("button", { name: "Approve receipt template", exact: true }),
  ).toBeDisabled();
  await expect(
    region.getByText("Approval requires an actor other than the original author and submitter."),
  ).toBeVisible();
  state.selectActor(id(40));
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: `${locale} · Revision 1 · RECEIPT_1` });
  await expect(
    region.getByRole("button", { name: "Approve receipt template", exact: true }),
  ).toBeEnabled();
  return region;
}

test("@production 390px independent template approval and publication refresh real UI and IDB", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page),
    region = await independentReview(page, state);
  const approve = region.getByRole("button", { name: "Approve receipt template", exact: true });
  await approve.focus();
  await expect(approve).toBeFocused();
  await approve.press("Enter");
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("Approved");
  expect(await cursors(page, "Lifecycle")).toEqual([]);
  const publish = region.getByRole("button", { name: "Publish receipt template", exact: true });
  await expect(publish).toBeEnabled();
  const box = await publish.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await publish.focus();
  await expect(publish).toBeFocused();
  await publish.press("Enter");
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("Published");
  await expect(
    region.getByRole("region", { name: "Original template publication", exact: true }),
  ).toContainText("RECEIPT_1");
  await expect(
    region.getByText("Saved fr-CA, revision 1, RECEIPT_1. Publication recorded.", { exact: true }),
  ).toBeVisible();
  expect(await cursors(page, "Lifecycle")).toEqual([]);
  expect(state.lifecyclePosts.map((p) => p.command)).toEqual(["Approve", "Publish"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await region.screenshot({ path: "/private/tmp/wp2421-receipt-template-lifecycle-mobile.png" });
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("Published");
  await expect(
    region.getByRole("button", { name: "Publish receipt template", exact: true }),
  ).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test("@production lost template publication survives denied reload recovery and clears only its exact original", async ({
  page,
}) => {
  const state = await install(page),
    region = await independentReview(page, state);
  await region.getByRole("button", { name: "Approve receipt template", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Publish receipt template", exact: true }),
  ).toBeEnabled();
  state.loseLifecycle = true;
  await region.getByRole("button", { name: "Publish receipt template", exact: true }).click();
  const recover = region.getByRole("button", {
    name: "Recover earlier template review action",
    exact: true,
  });
  await expect(recover).toBeEnabled();
  const original = await cursors(page, "Lifecycle");
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({
    action: "Publish",
    scope: { ...scope, actorReference: id(40) },
  });
  state.denyLifecycle = true;
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await region
    .getByRole("combobox", { name: "Receipt template", exact: true })
    .selectOption({ label: "fr-CA · Revision 1 · RECEIPT_1" });
  await expect(recover).toBeEnabled();
  await expect(
    region.getByRole("button", { name: "Save template draft", exact: true }),
  ).toBeDisabled();
  await expect(
    region.getByRole("combobox", { name: "Receipt template", exact: true }),
  ).toBeDisabled();
  await expect(
    region.getByRole("button", { name: "Retry exact template review action", exact: true }),
  ).toHaveCount(0);
  await recover.click();
  await expect(region.getByRole("alert")).toBeVisible();
  expect(await cursors(page, "Lifecycle")).toEqual(original);
  state.denyLifecycle = false;
  await recover.click();
  await expect(recover).toHaveCount(0);
  expect(await cursors(page, "Lifecycle")).toEqual([]);
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("Published");
  await expect(
    region.getByRole("combobox", { name: "Receipt template", exact: true }),
  ).toBeEnabled();
  expect(state.lifecyclePosts.map((p) => p.command)).toEqual([
    "Approve",
    "Publish",
    "ResolveOriginal",
    "ResolveOriginal",
  ]);
  expect(state.lifecyclePosts[2]?.operationReference).toBe(
    state.lifecyclePosts[1]?.operationReference,
  );
  expect(state.lifecyclePosts[3]?.operationReference).toBe(
    state.lifecyclePosts[1]?.operationReference,
  );
  expect(state.errors).toEqual([]);
});

test("@production published receipt template selection saves stable Store reference and recovers a lost setup reply", async ({
  page,
}) => {
  // Full DOM lifecycle and real IDB; all HTTP identity/publication/Store facts are controlled synthetic records.
  const state = await install(page),
    region = await independentReview(page, state, "en-CA");
  await region.getByRole("button", { name: "Approve receipt template", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Publish receipt template", exact: true }),
  ).toBeEnabled();
  await region.getByRole("button", { name: "Publish receipt template", exact: true }).click();
  await expect(
    region.getByRole("region", { name: "Receipt template review status", exact: true }),
  ).toContainText("Published");
  expect(await cursors(page, "Lifecycle")).toEqual([]);
  state.selectActor(scope.actorReference);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  const picker = page.getByRole("region", {
    name: "Published receipt template selection",
    exact: true,
  });
  await picker
    .getByRole("combobox", { name: "Saved templates", exact: true })
    .selectOption({ label: "en-CA · Revision 1 · RECEIPT_1" });
  await picker
    .getByRole("button", { name: "Check published receipt template", exact: true })
    .click();
  const use = picker.getByRole("button", { name: "Use published receipt template", exact: true });
  await expect(use).toBeEnabled();
  await expect(picker).toContainText(
    "Professional review and legal conclusion have not been evaluated.",
  );
  await use.click();
  expect(state.setupPosts).toEqual([]);
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  const first = state.savedSetup();
  if (!first) throw new Error("controlled actual setup save required");
  const selected = first.content.receiptReference;
  if (selected.state !== "Configured") throw new Error("template selection missing");
  const template = selected.value;
  expect(first.revision).toBe(1);
  const published = state.lifecyclePosts.find((p) => p.command === "Publish");
  expect(published?.templateReference).toBe(template);
  expect(template).not.toBe(published?.expectedVersionReference);
  expect(first.content.receiptReference).toEqual({ state: "Configured", value: template });
  expect(await cursors(page, "Setup")).toEqual([]);
  expect(state.publishedGets).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page
      .getByRole("heading", { name: "Receipt configuration", exact: true })
      .locator("xpath=following-sibling::p[1]"),
  ).toHaveText("Already configured.");
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
  state.loseSetup = true;
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  const recover = page.getByRole("button", { name: "Recover original save", exact: true });
  await expect(recover).toBeEnabled();
  const original = await cursors(page, "Setup");
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({
    scope,
    expectedSetupReference: first.setupDraftReference,
    expectedRevision: 1,
  });
  for (const name of ["content", "receiptReference", "fields", "csrf", "locale"])
    expect(JSON.stringify(original)).not.toContain(name);
  expect(state.savedSetup()?.revision).toBe(2);
  expect(state.savedSetup()?.content.receiptReference).toEqual({
    state: "Configured",
    value: template,
  });
  state.denySetupResolve = true;
  await page.reload();
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await cursors(page, "Setup")).toEqual(original);
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    picker.getByRole("combobox", { name: "Saved templates", exact: true }),
  ).toBeDisabled();
  state.denySetupResolve = false;
  await recover.click();
  await expect(recover).toHaveCount(0);
  expect(await cursors(page, "Setup")).toEqual([]);
  expect(state.savedSetup()?.revision).toBe(2);
  expect(state.savedSetup()?.content.receiptReference).toEqual({
    state: "Configured",
    value: template,
  });
  expect(state.setupReceipts()).toHaveLength(2);
  expect(state.setupPosts.map((p) => p.command)).toEqual([
    "SaveDraft",
    "SaveDraft",
    "ResolveOriginal",
    "ResolveOriginal",
  ]);
  expect(state.setupPosts[2]?.operationReference).toBe(state.setupPosts[1]?.operationReference);
  expect(state.setupPosts[3]?.operationReference).toBe(state.setupPosts[1]?.operationReference);
  expect(state.setupPosts[2]).not.toHaveProperty("content");
  await expect(
    page
      .getByRole("heading", { name: "Receipt configuration", exact: true })
      .locator("xpath=following-sibling::p[1]"),
  ).toHaveText("Already configured.");
  expect(state.errors).toEqual([]);
});
