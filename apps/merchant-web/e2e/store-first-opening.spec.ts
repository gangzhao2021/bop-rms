import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseStorePaymentConfigurationCurrent,
  parseStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationVersion,
  type StorePaymentConfigurationVersion,
} from "../../../packages/rms/payment/src/contracts/store-payment-configuration.js";
import {
  parseDigitalReceiptTemplateArtifactCurrent,
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactVersion,
  type DigitalReceiptTemplateArtifactVersion,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-artifact.js";
import { materializeDigitalReceiptTemplateContent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-content.js";
import {
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftReceipt,
  parseDigitalReceiptTemplateDraftRoster,
  parseDigitalReceiptTemplateDraftSave,
  type DigitalReceiptTemplateDraft,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-draft.js";
import { createDigitalReceiptTemplateDraftContent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-draft-fields.js";
import {
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleReceipt,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-lifecycle-action.js";
import { parseDigitalReceiptTemplatePublishedCurrent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-published-current.js";
import { parseDigitalReceiptTemplateReviewCurrent } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-review.js";
import { parseDigitalReceiptTemplateSubmission } from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-submission.js";
import {
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitReceipt,
} from "../../../packages/rms/printing-device/src/contracts/digital-receipt-template-submit.js";
import { createStoreConfigurationVersion } from "../../../packages/rms/store/src/contracts/store-configuration-administration.js";
import {
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryResolve,
  type StoreConfigurationOrdinaryReceipt,
} from "../../../packages/rms/store/src/contracts/store-configuration-original.js";
import {
  createStoreSetupDraft,
  materializeStoreSetupConfigurationVersionV2,
  replaceStoreSetupDraftContent,
  type StoreSetupDraft,
} from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import {
  parseStoreSetupOperationReceipt,
  parseStoreSetupSaveCommand,
} from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import {
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferenceSave,
  parseStoreSetupReferencesCurrent,
  parseStoreSetupReferenceVersion,
  type StoreSetupReferenceKind,
  type StoreSetupReferenceVersion,
} from "../../../packages/rms/store/src/contracts/store-setup-reference.js";
import { parseMerchantStoreConfigurationOrdinaryWorkspace } from "../../api/src/merchant-store-configuration-ordinary-values.js";
import { canonicalPublicationValue as canonical } from "../src/product-publication-command-client-v2.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 14 (DEC-STORE-FIRST-OPENING): a first Store's one page, on the production build with
 * the real browser clients and IndexedDB. The server here is a stand-in holding state through the
 * owners' own contract parsers (TEST-ONLY); the real routes under the restricted role are in
 * packages/database/test/store-first-opening-acceptance.test.mjs.
 */
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "A".repeat(43);
const owner = id(4),
  secondOwner = id(40);
const scopeOf = (actorReference: string) => ({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference,
});
const href = `/app/organization/stores/${id(3)}/setup`;
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
const window5s = () => {
  const at = new Date().toISOString();
  return { at, until: new Date(Date.parse(at) + 5000).toISOString() };
};
const firstConfiguration = () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  return createStoreConfigurationVersion({
    configurationReference: id(20),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(21),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(22),
    contactReference: id(23),
    receiptReference: id(24),
    taxConfigurationReference: id(25),
    paymentConfigurationReference: id(26),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    // The TEST tool's first configuration: every day, all day, nothing to wait for.
    weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals: [
        {
          startLocalTime: "00:00:00",
          endLocalTime: "23:59:59",
          endsNextDay: false,
          serviceModes: ["DineIn", "Pickup"],
          orderCutoffSeconds: 0,
          leadTimeSeconds: 0,
        },
      ],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST_STORE_SETUP",
    authoredByReference: id(30),
    approvedByReference: id(31),
    approvalEvidenceReference: id(32),
    publicationReference: id(33),
    liveGateEvidenceReference: id(34),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
};
interface Options {
  readonly setupPublished?: boolean;
  readonly openingListFails?: boolean;
  readonly taxRatesSet?: boolean;
  readonly secondOwnerExists?: boolean;
}
async function install(page: Page, options: Options = {}) {
  const control = {
    actor: owner,
    setupPublished: options.setupPublished ?? false,
    openingListFails: options.openingListFails ?? false,
    taxReference: options.taxRatesSet === false ? null : id(25),
    soleOperator: "Off" as "On" | "Off",
    soleOperatorVersion: 0,
    verifiedUntil: null as string | null,
    writes: [] as string[],
    stepUpPurposes: [] as string[],
    approvals: [] as string[],
    errors: [] as string[],
    tipsEnabled: true,
    tipsVersion: 0,
    /** The next POST to this path answers 503, once. */
    stopOnce: null as string | null,
    /** The next read of who else approves fails, once. */
    readFailsOnce: false,
  };
  const scope = () => scopeOf(control.actor);
  const othersFor = () =>
    options.secondOwnerExists === true
      ? [{ displayName: control.actor === owner ? "Mia" : "Sam" }]
      : [];
  const gate = () => {
    const status =
      control.soleOperator === "Off"
        ? "NotSet"
        : othersFor().length > 0
          ? "OtherApprovers"
          : "Effective";
    return {
      status,
      otherApprovers: status === "OtherApprovers" ? othersFor() : [],
      verifiedUntil: control.verifiedUntil,
    };
  };
  let profile: Record<string, unknown> | null = null;
  let receiptVersion = 0,
    receiptName: string | null = null,
    receiptDetails = {
      gstHstNumber: null as string | null,
      qstNumber: null as string | null,
      pstNumber: null as string | null,
      privacyNoticeUrl: null as string | null,
    },
    kitchenVersion = 0;
  let setup: StoreSetupDraft | null = null;
  const references = new Map<StoreSetupReferenceKind, StoreSetupReferenceVersion>();
  const ledger = new Map<string, unknown>();
  let payment: StorePaymentConfigurationVersion | null = null;
  const artifacts = new Map<string, DigitalReceiptTemplateArtifactVersion>();
  const drafts = new Map<string, DigitalReceiptTemplateDraft>();
  const submissions = new Map<string, ReturnType<typeof parseDigitalReceiptTemplateSubmission>>();
  const lifecycleHeads = new Map<
    string,
    NonNullable<ReturnType<typeof parseDigitalReceiptTemplateReviewCurrent>["lifecycle"]>
  >();
  const lifecycleReceipts = new Map<
    string,
    ReturnType<typeof parseDigitalReceiptTemplateLifecycleReceipt>
  >();
  let allocation = 0x200;
  const next = () => id(allocation++);
  let latest: ReturnType<typeof createStoreConfigurationVersion> | null = null,
    current = firstConfiguration();
  let registry: Record<string, unknown> | null = null,
    proposal: { proposalReference: string; recordedBy: string; recordedAt: string } | null = null;
  const workspace = (original: StoreConfigurationOrdinaryReceipt | null = null) => {
    const { at, until } = window5s();
    const head = latest ?? current;
    const open =
      latest !== null && ["Draft", "PendingApproval", "Approved"].includes(latest.lifecycle);
    const own =
      latest?.lifecycle === "PendingApproval" && latest.authoredByReference === control.actor;
    return parseMerchantStoreConfigurationOrdinaryWorkspace(
      {
        profile: "StoreConfigurationOrdinaryWorkspaceV1",
        scope: scope(),
        latest,
        current,
        expectedHead: {
          configurationReference: head.configurationReference,
          configurationVersion: head.configurationVersion,
          contentDigest: hash(head),
        },
        original,
        observedAt: at,
        validUntil: until,
        businessReferenceValidation: "NotEvaluated",
        storeTaxConfigurationReference: control.taxReference,
        ...(open && latest !== null
          ? {
              publicationChecks: {
                profile: "StoreConfigurationPublicationChecksV1",
                configurationReference: latest.configurationReference,
                checkedAt: at,
                checks: [
                  "Tax",
                  "BrandSettings",
                  "TimeZone",
                  "BusinessDayStart",
                  "Hours",
                  "EffectiveDate",
                  "Fees",
                  "GoLive",
                ].map((code) => ({ code, outcome: "Pass" })),
              },
            }
          : {}),
        ...(own ? { soleOperator: gate() } : {}),
      },
      scope(),
    );
  };
  page.on("pageerror", (error) => control.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      post = request.method() === "POST",
      body = (post ? request.postDataJSON() : null) as Record<string, unknown> | null;
    const { at, until } = window5s();
    if (post && path === control.stopOnce) {
      control.stopOnce = null;
      return respond(route, { error: "retry_later" }, 503);
    }
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
        timeZone: "America/Toronto",
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
          businessDate: "2026-11-05",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (path === "/merchant/store/opening-list") {
      if (control.openingListFails) return respond(route, { error: "request_denied" }, 503);
      return respond(route, {
        setupPublished: control.setupPublished,
        allergenList: registry !== null,
        menuListed: false,
        taxRatesSet: control.taxReference !== null,
      });
    }
    if (path === "/merchant/store/opening-approvers" && control.readFailsOnce) {
      control.readFailsOnce = false;
      return respond(route, { error: "request_denied" }, 503);
    }
    if (path === "/merchant/store/opening-approvers")
      return respond(route, {
        receiptTemplate: othersFor(),
        storeSetup: othersFor(),
        allergenList: othersFor(),
      });
    if (path === "/merchant/store/public-profile") {
      if (!post)
        return respond(route, {
          observedAt: at,
          canChange: true,
          locales: ["en-CA"],
          current: profile,
          regionCodes: ["BC", "ON", "QC"],
        });
      const details = body?.details as {
        storeDisplayNames: Record<string, string>;
        address: Record<string, unknown>;
      };
      control.writes.push("PublishProfile");
      profile = {
        version: Number(body?.expectedVersion) + 1,
        publishedAt: at,
        defaultLocale: "en-CA",
        names: [{ locale: "en-CA", storeDisplayName: details.storeDisplayNames["en-CA"] }],
        address: { ...details.address, countryCode: "CA", postalCode: "M5H 1A1" },
        businessPhone: "+14165550100",
      };
      return respond(route, { status: "Published", current: profile });
    }
    if (path === "/merchant/store/receipt-profile") {
      if (!post)
        return respond(route, {
          observedAt: at,
          canChange: true,
          version: receiptVersion,
          recordedAt: receiptVersion > 0 ? at : null,
          details: receiptDetails,
          gaps: { taxRegistrationMissing: true, privacyNoticeMissing: true },
          issuer: { businessName: receiptName, suggestedBusinessName: "Synthetic Brand" },
        });
      control.writes.push("SaveReceiptDetails");
      receiptVersion += 1;
      const saved = body?.details as typeof receiptDetails & { businessName: string };
      receiptName = String(saved.businessName);
      receiptDetails = {
        gstHstNumber: saved.gstHstNumber,
        qstNumber: saved.qstNumber,
        pstNumber: saved.pstNumber,
        privacyNoticeUrl: saved.privacyNoticeUrl,
      };
      return respond(route, {
        status: "Recorded",
        version: receiptVersion,
        gaps: { taxRegistrationMissing: true, privacyNoticeMissing: true },
      });
    }
    if (path === "/merchant/store/kitchen-setup") {
      if (post) {
        control.writes.push("SetUpKitchen");
        kitchenVersion += 1;
        return respond(route, { status: "Applied" });
      }
      return respond(route, {
        canChange: true,
        version: kitchenVersion,
        inEffectFrom: kitchenVersion > 0 ? at : null,
        uncoveredDishes: [],
      });
    }
    if (path === "/merchant/store/support-access")
      return respond(route, { version: 1, mode: "Off", allowedUntil: null, log: [] });
    if (path === "/merchant/store/features") {
      if (body?.action === "ChangeTips") {
        control.writes.push("ChangeTips");
        control.tipsEnabled = body.enabled === true;
        control.tipsVersion += 1;
      }
      return respond(route, {
        version: 0,
        templateCode: null,
        modules: {
          counterOrder: true,
          pickup: true,
          inventory: true,
          loyalty: true,
          alcohol: true,
        },
        changedAt: null,
        services: {
          version: 0,
          staffCall: false,
          chaseDish: false,
          askPartySize: false,
          changedAt: null,
        },
        teaCharge: { version: 0, teaSellableReference: null, changedAt: null },
        teaChoices: [],
        tips: {
          version: control.tipsVersion,
          enabled: control.tipsEnabled,
          tierPercents: [10, 15, 18],
          changedAt: null,
          offInStoreSetup: false,
        },
      });
    }
    if (path === "/merchant/organization/sole-operator") {
      if (post) {
        control.writes.push("TurnOnSoleOperator");
        expect(body?.reasonCode).toBe("OWNER_RUNS_STORE_ALONE");
        control.soleOperator = "On";
        control.soleOperatorVersion += 1;
        return respond(route, {
          status: "Created",
          state: "On",
          version: control.soleOperatorVersion,
          recordedAt: at,
        });
      }
      return respond(route, {
        observedAt: at,
        state: control.soleOperator,
        version: control.soleOperatorVersion,
        changeCount: control.soleOperatorVersion,
        history: [],
        refundApproval: {
          status: control.soleOperator === "On" ? "Effective" : "NotSet",
          youHoldApproval: true,
          otherApprovers: othersFor(),
        },
        verifiedUntil: control.verifiedUntil,
        reasons: {},
      });
    }
    if (path === "/merchant/identity/step-up") {
      if (!post) return respond(route, { validUntil: control.verifiedUntil });
      control.stepUpPurposes.push(String(body?.purpose));
      control.verifiedUntil = new Date(Date.now() + 15 * 60000).toISOString();
      return respond(route, {
        status: "Verified",
        verifiedAt: at,
        validUntil: control.verifiedUntil,
      });
    }
    if (path === "/merchant/compliance/allergens/query")
      return respond(route, {
        screenId: "CMP-ALLERGEN-REVIEW",
        sourceAsOf: at,
        viewer: control.actor,
        locale: "en-CA",
        permissions: { mayRead: true, mayDeclare: true, mayManageRegistry: true },
        registry,
        registryProposal:
          proposal === null
            ? null
            : {
                proposalReference: proposal.proposalReference,
                recordedAt: proposal.recordedAt,
                recordedByYou: proposal.recordedBy === control.actor,
              },
        soleOperator: gate(),
        registryTemplate: {
          template: "CA_PRIORITY_TEST",
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY internal pilot list.",
          allergens: [
            { code: "PEANUT", name: "Peanuts" },
            { code: "MILK", name: "Milk" },
          ],
        },
        sources: ["SupplierSpecification"],
        items: [],
      });
    if (path === "/merchant/compliance/allergens/command") {
      control.writes.push(String(body?.action));
      if (body?.action === "RecordRegistry") {
        proposal = { proposalReference: next(), recordedBy: control.actor, recordedAt: at };
        return respond(route, { status: "Created", proposalReference: proposal.proposalReference });
      }
      if (body?.approvalMode === "SoleOperator") control.approvals.push("AllergenList:Alone");
      else control.approvals.push("AllergenList:Other");
      registry = {
        registryVersionReference: next(),
        jurisdictionCode: "CA",
        reviewedAt: at,
        reviewerReference: control.actor,
        entries: [],
      };
      proposal = null;
      return respond(route, { status: "Created" });
    }
    if (path === "/merchant/store-setup") {
      if (!post)
        return respond(route, {
          profile: "StoreSetupWorkspaceV1",
          scope: scope(),
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
            readerActorReference: control.actor,
            snapshot: setup,
            observedAt: at,
            validUntil: until,
            businessReferenceValidation: "NotEvaluated",
          },
        });
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("SaveSetup");
      const command = parseStoreSetupSaveCommand({
        profile: "StoreSetupSaveV2",
        ...scope(),
        operationReference: body?.operationReference,
        expectedSetupReference: body?.expectedSetupReference,
        expectedRevision: body?.expectedRevision,
        content: body?.content,
        purposeCode: "STORE_SETUP_DRAFT",
      });
      const actual = {
        ...scope(),
        defaultLocale: "en-CA",
        currencyCode: "CAD" as const,
        baseConfigurationReference: (latest ?? current).configurationReference,
      };
      setup =
        setup === null
          ? createStoreSetupDraft(
              {
                profile: "StoreSetupDraftV2",
                tenantReference: id(1),
                brandReference: id(2),
                storeReference: id(3),
                setupDraftReference: id(0x30),
                revision: 1,
                authoredByReference: control.actor,
                defaultLocale: "en-CA",
                currencyCode: "CAD",
                baseConfigurationReference: actual.baseConfigurationReference,
                content: command.content,
                createdAt: at,
                updatedAt: at,
                purposeCode: "STORE_SETUP_DRAFT",
                dataClassification: "ConfigurationMetadata",
              },
              actual,
            )
          : replaceStoreSetupDraftContent(setup, command.content, actual, {
              expectedRevision: command.expectedRevision,
              observedAt: at,
            });
      const receipt = parseStoreSetupOperationReceipt({
        profile: "StoreSetupOperationReceiptV1",
        ...scope(),
        operationReference: command.operationReference,
        expectedSetupReference: command.expectedSetupReference,
        expectedRevision: command.expectedRevision,
        purposeCode: "STORE_SETUP_DRAFT",
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot: setup,
        auditReference: next(),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/references")
      return respond(
        route,
        parseStoreSetupReferencesCurrent({
          profile: "StoreSetupReferencesCurrentV1",
          ...scope(),
          address: references.get("Address") ?? null,
          contact: references.get("Contact") ?? null,
          observedAt: at,
          validUntil: until,
          businessReferenceValidation: "NotEvaluated",
        }),
      );
    if (path.startsWith("/merchant/store-setup/references/")) {
      const kind: StoreSetupReferenceKind = path.endsWith("address") ? "Address" : "Contact";
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("Save" + kind);
      const command = parseStoreSetupReferenceSave({
        profile: "StoreSetupReferenceSaveV1",
        ...scope(),
        kind,
        operationReference: body?.operationReference,
        expectedReference: body?.expectedReference,
        expectedRevision: body?.expectedRevision,
        content: body?.content,
        purposeCode: "STORE_SETUP_REFERENCE",
      });
      const previous = references.get(kind);
      const snapshot = parseStoreSetupReferenceVersion({
        profile: "StoreSetupReferenceVersionV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        kind,
        reference: next(),
        revision: command.expectedRevision + 1,
        authoredByReference: control.actor,
        previousReference: previous?.reference ?? null,
        content: command.content,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      references.set(kind, snapshot);
      const receipt = parseStoreSetupReferenceReceipt({
        profile: "StoreSetupReferenceReceiptV1",
        ...scope(),
        kind,
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedReference: command.expectedReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot,
        auditReference: next(),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/payment-configuration") {
      if (!post)
        return respond(
          route,
          parseStorePaymentConfigurationCurrent({
            profile: "StorePaymentConfigurationCurrentV1",
            ...scope(),
            snapshot: payment,
            observedAt: at,
            validUntil: until,
            providerReadiness: "NotEvaluated",
          }),
        );
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("SavePayment");
      const command = parseStorePaymentConfigurationSave({
        profile: "StorePaymentConfigurationSaveV1",
        ...scope(),
        operationReference: body?.operationReference,
        expectedConfigurationReference: body?.expectedConfigurationReference,
        expectedRevision: body?.expectedRevision,
        content: body?.content,
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
      });
      payment = parseStorePaymentConfigurationVersion({
        profile: "StorePaymentConfigurationV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        configurationReference: next(),
        revision: command.expectedRevision + 1,
        authoredByReference: control.actor,
        previousConfigurationReference: command.expectedConfigurationReference,
        content: command.content,
        currencyCode: "CAD",
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      const receipt = parseStorePaymentConfigurationReceipt({
        profile: "StorePaymentConfigurationReceiptV1",
        ...scope(),
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedConfigurationReference: command.expectedConfigurationReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot: payment,
        auditReference: next(),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-artifacts")
      return respond(
        route,
        parseDigitalReceiptTemplateArtifactCurrent({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...scope(),
          layout: artifacts.get("Layout") ?? null,
          compliance: artifacts.get("Compliance") ?? null,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    if (path.startsWith("/merchant/store-setup/receipt-artifacts/")) {
      const kind = path.endsWith("/layout") ? "Layout" : "Compliance";
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("Save" + kind);
      const command = parseDigitalReceiptTemplateArtifactSave({
        profile: "DigitalReceiptTemplateArtifactSaveV1",
        ...scope(),
        artifactKind: kind,
        operationReference: body?.operationReference,
        expectedArtifactReference: body?.expectedArtifactReference,
        expectedRevision: body?.expectedRevision,
        content: body?.content,
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
      });
      const snapshot = parseDigitalReceiptTemplateArtifactVersion({
        profile: "DigitalReceiptTemplateArtifactV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        artifactKind: kind,
        artifactReference: next(),
        revision: command.expectedRevision + 1,
        authoredByReference: control.actor,
        previousArtifactReference: command.expectedArtifactReference,
        content: command.content,
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      artifacts.set(kind, snapshot);
      const receipt = parseDigitalReceiptTemplateArtifactReceipt({
        profile: "DigitalReceiptTemplateArtifactReceiptV1",
        ...scope(),
        artifactKind: kind,
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedArtifactReference: command.expectedArtifactReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot,
        auditReference: next(),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-published") {
      if (url.searchParams.get("installed") === "true")
        return respond(route, { error: "receipt_template_installed_none" }, 404);
      const template = url.searchParams.get("templateReference");
      const head = template === null ? undefined : lifecycleHeads.get(template);
      const terminal =
        head === undefined
          ? undefined
          : lifecycleReceipts.get(head.latestMutationOperationReference);
      const version = terminal?.result?.publishedVersion;
      if (version === undefined || version === null || head?.state !== "Published")
        return respond(route, { error: "receipt_template_published_unavailable" }, 503);
      return respond(
        route,
        parseDigitalReceiptTemplatePublishedCurrent({
          profile: "DigitalReceiptTemplatePublishedCurrentV1",
          ...scope(),
          templateReference: template,
          locale: url.searchParams.get("locale"),
          currentVersion: version,
          observedAt: at,
          validUntil: until,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        }),
      );
    }
    if (path === "/merchant/store-setup/receipt-template-drafts")
      return respond(
        route,
        parseDigitalReceiptTemplateDraftRoster({
          profile: "DigitalReceiptTemplateDraftRosterV1",
          ...scope(),
          afterTemplate: url.searchParams.get("afterTemplate"),
          entries: [...drafts.values()],
          nextAfter: null,
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    if (path === "/merchant/store-setup/receipt-template-sole-operator")
      return respond(route, { soleOperator: gate() });
    if (path === "/merchant/store-setup/receipt-template-review") {
      const template = String(url.searchParams.get("templateReference"));
      const draft = drafts.get(template);
      if (draft === undefined) return respond(route, { error: "conflict" }, 409);
      const submission = submissions.get(template) ?? null;
      return respond(
        route,
        parseDigitalReceiptTemplateReviewCurrent({
          profile: "DigitalReceiptTemplateReviewCurrentV1",
          ...scope(),
          templateReference: template,
          currentDraft: {
            versionReference: draft.content.versionReference,
            revision: draft.revision,
            contentDigest: draft.contentDigest,
          },
          submission,
          lifecycle:
            submission === null
              ? null
              : (lifecycleHeads.get(template) ?? {
                  lifecycleReference: submission.reviewLifecycleReference,
                  version: submission.reviewVersion,
                  state: "InReview",
                  latestMutationOperationReference: submission.operationReference,
                  changedAt: submission.submittedAt,
                  validationEvidenceReference: submission.validationEvidenceReference,
                  approvalEvidenceReference: null,
                }),
          observedAt: at,
          validUntil: until,
          sourceQualification: "NotEvaluated",
        }),
      );
    }
    if (path === "/merchant/store-setup/receipt-template-draft") {
      if (!post) {
        const template = url.searchParams.get("templateReference");
        return respond(
          route,
          parseDigitalReceiptTemplateDraftCurrent({
            profile: "DigitalReceiptTemplateDraftCurrentV1",
            ...scope(),
            templateReference: template,
            snapshot: template === null ? null : (drafts.get(template) ?? null),
            observedAt: at,
            validUntil: until,
            sourceQualification: "NotEvaluated",
          }),
        );
      }
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("SaveTemplate");
      const command = parseDigitalReceiptTemplateDraftSave({
        profile: "DigitalReceiptTemplateDraftSaveV1",
        ...scope(),
        operationReference: body?.operationReference,
        templateReference: body?.templateReference,
        expectedVersionReference: body?.expectedVersionReference,
        expectedRevision: body?.expectedRevision,
        fields: body?.fields,
        purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
      });
      const template = command.templateReference ?? next();
      const content = createDigitalReceiptTemplateDraftContent({
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        templateReference: template,
        versionReference: next(),
        versionNumber: 1,
        fields: command.fields,
      });
      const snapshot = parseDigitalReceiptTemplateDraft({
        profile: "DigitalReceiptTemplateDraftV2",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        familyReference: next(),
        revision: command.expectedRevision + 1,
        authoredByReference: control.actor,
        previousVersionReference: command.expectedVersionReference,
        content,
        contentDigest: hash(content),
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      drafts.set(template, snapshot);
      const receipt = parseDigitalReceiptTemplateDraftReceipt({
        profile: "DigitalReceiptTemplateDraftReceiptV1",
        ...scope(),
        operationReference: command.operationReference,
        templateReference: command.templateReference,
        expectedVersionReference: command.expectedVersionReference,
        expectedRevision: command.expectedRevision,
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot,
        auditReference: next(),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-submit") {
      if (body?.command === "ResolveOriginal")
        return respond(route, ledger.get(String(body.operationReference)));
      control.writes.push("SubmitTemplate");
      const command = parseDigitalReceiptTemplateSubmit({
        profile: "DigitalReceiptTemplateSubmitV1",
        ...scope(),
        operationReference: body?.operationReference,
        templateReference: body?.templateReference,
        expectedVersionReference: body?.expectedVersionReference,
        expectedRevision: body?.expectedRevision,
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      });
      const draft = drafts.get(command.templateReference);
      if (draft === undefined) throw new Error("fixture draft missing");
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
        submittedByReference: control.actor,
        operationReference: command.operationReference,
        reviewLifecycleReference: next(),
        reviewVersion: 2,
        validationEvidenceReference: next(),
        checkedAt: at,
        validationValidUntil: new Date(Date.parse(at) + 72 * 3600000).toISOString(),
        submittedAt: at,
        auditReference: next(),
        dataClassification: "Internal",
      });
      submissions.set(command.templateReference, submission);
      const receipt = parseDigitalReceiptTemplateSubmitReceipt({
        profile: "DigitalReceiptTemplateSubmitReceiptV1",
        ...scope(),
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
      ledger.set(command.operationReference, receipt);
      return respond(route, receipt);
    }
    if (path === "/merchant/store-setup/receipt-template-lifecycle") {
      const old = lifecycleReceipts.get(String(body?.operationReference));
      if (old !== undefined) return respond(route, old);
      const action = String(body?.command);
      const command = parseDigitalReceiptTemplateLifecycleAction({
        profile: "DigitalReceiptTemplateLifecycleActionV1",
        ...scope(),
        action,
        operationReference: body?.operationReference,
        templateReference: body?.templateReference,
        expectedVersionReference: body?.expectedVersionReference,
        expectedRevision: body?.expectedRevision,
        reviewLifecycleReference: body?.reviewLifecycleReference,
        expectedReviewVersion: body?.expectedReviewVersion,
        expectedReviewOperationReference: body?.expectedReviewOperationReference,
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      });
      const draft = drafts.get(command.templateReference),
        submission = submissions.get(command.templateReference);
      if (draft === undefined || submission === undefined)
        throw new Error("fixture review missing");
      const alone = body?.approvalMode === "SoleOperator";
      if (action === "Approve") {
        if (alone && control.verifiedUntil === null)
          return respond(route, { error: "sole_operator_needs_verification" }, 403);
        if (alone && gate().status !== "Effective")
          return respond(route, { error: "sole_operator_not_in_effect" }, 403);
        if (!alone) expect(control.actor).not.toBe(submission.submittedByReference);
        control.approvals.push(alone ? "ReceiptTemplate:Alone" : "ReceiptTemplate:Other");
      }
      control.writes.push(action + "Template");
      const prior =
        action === "Publish"
          ? lifecycleReceipts.get(
              lifecycleHeads.get(command.templateReference)?.latestMutationOperationReference ?? "",
            )?.result
          : undefined;
      const approval =
        action === "Approve"
          ? {
              approvalEvidenceReference: next(),
              approvedByReference: control.actor,
              approvedAt: at,
              approvalValidUntil: new Date(
                Math.min(Date.parse(at) + 86400000, Date.parse(submission.validationValidUntil)),
              ).toISOString(),
            }
          : {
              approvalEvidenceReference: prior?.approvalEvidenceReference,
              approvedByReference: prior?.approvedByReference,
              approvedAt: prior?.approvedAt,
              approvalValidUntil: prior?.approvalValidUntil,
            };
      const receipt = parseDigitalReceiptTemplateLifecycleReceipt({
        profile: "DigitalReceiptTemplateLifecycleReceiptV1",
        ...scope(),
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
        auditReference: next(),
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
                  publicationReference: next(),
                  publishedAt: at,
                })
              : null,
        },
      });
      lifecycleReceipts.set(command.operationReference, receipt);
      lifecycleHeads.set(command.templateReference, {
        lifecycleReference: command.reviewLifecycleReference,
        version: command.expectedReviewVersion + 1,
        state: action === "Approve" ? "Approved" : "Published",
        latestMutationOperationReference: command.operationReference,
        changedAt: at,
        validationEvidenceReference: submission.validationEvidenceReference,
        approvalEvidenceReference: approval.approvalEvidenceReference ?? null,
      });
      return respond(route, receipt);
    }
    if (path === "/merchant/store-configuration/ordinary") return respond(route, workspace());
    if (path === "/merchant/store-configuration/ordinary-state") {
      const original = parseStoreConfigurationOrdinaryResolve(body?.original);
      return respond(
        route,
        workspace(ledger.get(original.operationReference) as StoreConfigurationOrdinaryReceipt),
      );
    }
    if (path === "/merchant/store-configuration/ordinary-command") {
      const raw = body?.command as { profile?: string };
      if (raw.profile === "StoreConfigurationOrdinaryResolveV1") {
        const original = parseStoreConfigurationOrdinaryResolve(raw);
        return respond(route, ledger.get(original.operationReference));
      }
      const command = parseStoreConfigurationOrdinaryCommand(raw);
      const alone = body?.approvalMode === "SoleOperator";
      const occurredAt = new Date().toISOString();
      if (command.action === "Materialize") {
        if (setup === null) throw new Error("fixture setup missing");
        latest = materializeStoreSetupConfigurationVersionV2(
          setup,
          {
            ...scope(),
            defaultLocale: "en-CA",
            currencyCode: "CAD",
            baseConfigurationReference: (latest ?? current).configurationReference,
          },
          {
            configurationReference: next(),
            configurationVersion: (latest ?? current).configurationVersion + 1,
            reasonCode: command.reasonCode,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          {
            canonicalize: canonical,
            hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          },
        );
      } else {
        if (latest === null) throw new Error("fixture configuration missing");
        if (command.action === "Approve") {
          if (alone && control.verifiedUntil === null)
            return respond(route, { error: "sole_operator_needs_verification" }, 403);
          if (!alone) expect(control.actor).not.toBe(latest.authoredByReference);
          control.approvals.push(alone ? "StoreSetup:Alone" : "StoreSetup:Other");
        }
        latest = createStoreConfigurationVersion({
          ...latest,
          lifecycle:
            command.action === "Submit"
              ? "PendingApproval"
              : command.action === "Approve"
                ? "Approved"
                : "Published",
          updatedAt: occurredAt,
          ...(command.action === "Approve"
            ? { approvedByReference: control.actor, approvalEvidenceReference: next() }
            : {}),
          ...(command.action === "Publish"
            ? { publicationReference: next(), liveGateEvidenceReference: next() }
            : {}),
        });
      }
      control.writes.push(command.action + "Configuration");
      const receipt = parseStoreConfigurationOrdinaryReceipt({
        ...command,
        profile: "StoreConfigurationOrdinaryReceiptV1",
        intentDigest: hash(command),
        outcome: "Committed",
        operation: {
          command: command.action === "Materialize" ? "SaveDraft" : command.action,
          operationReference: command.operationReference,
          brandReference: id(2),
          storeReference: id(3),
          intentDigest: "sha256:" + "b".repeat(64),
          resultingVersion: latest.configurationVersion,
          configuration: latest,
        },
        auditReference: next(),
        occurredAt,
        dataClassification: "ConfigurationMetadata",
      });
      ledger.set(command.operationReference, receipt);
      if (command.action === "Publish") {
        current = latest;
        control.setupPublished = true;
      }
      return respond(route, receipt);
    }
    return respond(route, { error: "fixture_unavailable" }, 503);
  });
  return Object.assign(control, {
    published: () => current,
    setup: () => setup,
    latest: () => latest,
  });
}
const panel = (page: Page) => page.getByRole("region", { name: "Open your store", exact: true });
/** What the Owner types: every field the page asks for, counted. */
async function answer(page: Page) {
  const inPanel = panel(page);
  await inPanel.getByLabel("Store name customers see").fill("Maple Noodle House");
  await inPanel.getByLabel("Street address").fill("1 King Street West");
  await inPanel.getByLabel("City or town").fill("Toronto");
  await inPanel.getByLabel("Province or territory").selectOption("ON");
  await inPanel.getByLabel("Postal code").fill("M5H 1A1");
  await inPanel.getByLabel("Store phone number").fill("(416) 555-0100");
  await inPanel.getByLabel("Business name on receipts").fill("Maple Noodle House Inc.");
  await inPanel.getByLabel("GST/HST registration number").fill("123456789RT0001");
  await inPanel.getByLabel("Dine-in", { exact: true }).check();
  await inPanel.getByRole("button", { name: "Add a second opening period" }).click();
  const opens = inPanel.getByLabel("Opens", { exact: true }),
    closes = inPanel.getByLabel("Closes", { exact: true });
  await opens.fill("11:30");
  await closes.fill("14:30");
  await inPanel.getByLabel("Opens again").fill("17:00");
  await inPanel.getByLabel("Closes again").fill("00:00");
  await inPanel.getByRole("checkbox", { name: "Monday" }).uncheck();
  await inPanel.getByLabel("Last orders (minutes before closing)").fill("30");
  await inPanel.getByLabel("Preparation time (minutes)").fill("15");
}
const publish = (page: Page) =>
  panel(page).getByRole("button", { name: "Publish my store setup", exact: true });

test("@production a first Store's Owner answers one page, ticks once, enters one code and presses once", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  // One page: no wizard, no second address form, no draft language.
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
  await expect(page.getByText("Saving a draft does not change the live Store.")).toHaveCount(0);
  await expect(page.getByLabel("Address line 1")).toHaveCount(0);
  await expect(page.getByLabel("Country code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save address configuration" })).toHaveCount(0);
  // Nothing is answered for the Owner, least of all the starting configuration's 24 hours.
  await expect(panel(page).getByLabel("Opens", { exact: true })).toHaveValue("");
  await expect(panel(page).getByLabel("Dine-in", { exact: true })).not.toBeChecked();
  await expect(panel(page).getByLabel("Pickup", { exact: true })).not.toBeChecked();
  await expect(panel(page).getByText("What you are approving")).toHaveCount(0);
  await expect(publish(page)).toBeDisabled();
  await expect(panel(page).getByText(/^Still to do:/u)).toBeVisible();
  // The real count: 7 for the store, 2 for receipts, opening and closing, last orders and
  // preparation; besides these, the two order types, and a second opening period if they have one.
  expect(
    await panel(page)
      .locator("> form")
      .locator("input:not([type=checkbox],[type=radio]),select")
      .count(),
  ).toBe(13);
  await answer(page);
  // Everything that will be published, read before anything is written.
  const summary = panel(page).getByRole("region", { name: "What you are approving" });
  await expect(summary).toContainText("Monday: closed");
  await expect(summary).toContainText("Tuesday to Sunday: 11:30–14:30, 17:00–00:00 (next day)");
  await expect(summary).toContainText("Last orders 30 minutes before closing. Preparation 15");
  await expect(summary).toContainText("The standard receipt, in Canadian English");
  await expect(summary).toContainText("Card on the guest's phone");
  await expect(summary).toContainText("Service charge and delivery fee: off.");
  await expect(summary).toContainText("Offered at 10%, 15% and 18%");
  await expect(summary).toContainText("Peanuts");
  await expect(summary).not.toContainText("Up to 20 orders an hour");
  await expectNoInternalText(page);
  expect(state.writes).toEqual([]);
  await expect(publish(page)).toBeDisabled();
  const tick = panel(page).getByRole("checkbox", { name: /I run this business on my own/u });
  await tick.check();
  // Changing an answer takes the tick back: it was given to what was shown.
  await panel(page).getByLabel("Preparation time (minutes)").fill("20");
  await expect(tick).not.toBeChecked();
  await panel(page).getByLabel("Preparation time (minutes)").fill("15");
  await tick.check();
  await publish(page).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText("Your store setup is published.")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  // The page as it always was, for a Store that is open.
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  // One code, recorded for what it was asked for, and every approval recorded as given alone.
  expect(state.stepUpPurposes).toEqual(["SoleOperatorSetting"]);
  expect(state.approvals).toEqual([
    "ReceiptTemplate:Alone",
    "AllergenList:Alone",
    "StoreSetup:Alone",
  ]);
  expect(state.writes).toEqual([
    "PublishProfile",
    "SaveAddress",
    "SaveContact",
    "SaveReceiptDetails",
    "SetUpKitchen",
    "SaveSetup",
    "TurnOnSoleOperator",
    "SavePayment",
    "SaveLayout",
    "SaveCompliance",
    "SaveTemplate",
    "SubmitTemplate",
    "ApproveTemplate",
    "PublishTemplate",
    "RecordRegistry",
    "ApproveRegistry",
    "SaveSetup",
    "MaterializeConfiguration",
    "SubmitConfiguration",
    "ApproveConfiguration",
    "PublishConfiguration",
  ]);
  // The hours answered are the hours published, on the order types answered.
  const published = state.published();
  expect(published.setupBasis).toBeDefined();
  expect(published.enabledServiceModes).toEqual(["DineIn"]);
  expect(published.weeklySchedule[0]?.intervals).toEqual([]);
  expect(published.weeklySchedule[1]?.intervals.map((i) => i.endLocalTime)).toEqual([
    "14:30:00",
    "00:00:00",
  ]);
  expect(published.setupBasis?.feeContexts.at(-1)).toEqual({
    chargeType: "Tip",
    state: "Enabled",
    taxClassificationReference: null,
    orderTypes: ["DineIn"],
  });
  expect(state.errors).toEqual([]);
});

test("@production a press that stops says where, keeps what was done, and Continue finishes without doing it twice", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  await answer(page);
  await panel(page)
    .getByRole("checkbox", { name: /I run this business on my own/u })
    .check();
  // As on a dropped connection: the write stops, and so does the read after it.
  state.stopOnce = "/merchant/store/receipt-profile";
  state.readFailsOnce = true;
  await publish(page).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "This stopped at your receipt details. What was done stays.",
  );
  await expectNoInternalText(page);
  // Everything typed is still on the page, even what was never saved, and nothing has been sent
  // for approval. So is the tick: what it was given to has not changed.
  await expect(panel(page).getByLabel("Business name on receipts")).toHaveValue(
    "Maple Noodle House Inc.",
  );
  await expect(panel(page).getByLabel("Preparation time (minutes)")).toHaveValue("15");
  await expect(panel(page).getByLabel("Opens", { exact: true })).toHaveValue("11:30");
  await expect(
    panel(page).getByRole("checkbox", { name: /I run this business on my own/u }),
  ).toBeChecked();
  expect(state.approvals).toEqual([]);
  await panel(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Your store setup is published.")).toBeVisible();
  // One code; each write once.
  expect(state.stepUpPurposes).toEqual(["SoleOperatorSetting"]);
  const counted = state.writes.filter((write) => write !== "SaveSetup");
  expect(counted).toEqual([...new Set(counted)]);
  expect(state.errors).toEqual([]);
});

test("@production an established Store sees the page as it always was", async ({ page }) => {
  await install(page, { setupPublished: true });
  await page.goto(href);
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await expect(page.getByText("Saving a draft does not change the live Store.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh saved setup" })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("All settings, step by step")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
});

test("@production a failed read says so and keeps the steps folded, and a retry recovers", async ({
  page,
}) => {
  const state = await install(page, { openingListFails: true });
  await page.goto(href);
  await expect(page.getByText("This didn't load. Try again.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
  state.openingListFails = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel(page)).toBeVisible();
});

test("@production the step-by-step settings stay usable under the fold", async ({ page }) => {
  await install(page);
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  const fold = page.locator("details.store-opening__all");
  await expect(fold.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
  await fold.locator("summary").click();
  await expect(fold.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await expect(fold.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
  // A link to one of its sections opens it.
  await page.goto(href + "#kitchen-setup");
  await expect(
    page
      .locator("details.store-opening__all")
      .getByRole("heading", { name: "Kitchen", exact: true }),
  ).toBeVisible();
});

test("@production a name and address published from the fold reach the page and Store setup's records; typed hours stay", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  await answer(page);
  const tick = panel(page).getByRole("checkbox", { name: /I run this business on my own/u });
  await tick.check();
  const fold = page.locator("details.store-opening__all");
  await fold.locator("summary").click();
  const profile = fold.getByRole("region", { name: "Name and contact shown to customers" });
  await profile.getByLabel("Store name customers see").fill("Birch Noodle House");
  await profile.getByLabel("Street address").fill("2 Queen Street East");
  await profile.getByLabel("City or town").fill("Toronto");
  await profile.getByLabel("Province or territory").selectOption("ON");
  await profile.getByLabel("Postal code").fill("M5H 1A1");
  await profile.getByLabel("Phone number (optional)").fill("(416) 555-0100");
  await profile.getByRole("button", { name: "Publish name and contact details" }).click();
  // Nobody types the address twice: the page and Store setup's own records follow it.
  await expect(panel(page).getByLabel("Street address")).toHaveValue("2 Queen Street East");
  await expect.poll(() => state.writes).toEqual(["PublishProfile", "SaveAddress", "SaveContact"]);
  // What was typed and not saved stays; the tick was given to the old address, so it goes.
  await expect(panel(page).getByLabel("Opens", { exact: true })).toHaveValue("11:30");
  await expect(panel(page).getByLabel("Business name on receipts")).toHaveValue(
    "Maple Noodle House Inc.",
  );
  await expect(tick).not.toBeChecked();
  expect(state.errors).toEqual([]);
});

test("@production while BOP support has the tax rates to set, nothing is asked that can't finish", async ({
  page,
}) => {
  const state = await install(page, { taxRatesSet: false });
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  await answer(page);
  // Half an answer is not lost by saving the rest: it is on the page until it is finished.
  await panel(page).getByLabel("Last orders (minutes before closing)").fill("");
  await panel(page).getByRole("button", { name: "Save my details", exact: true }).click();
  await expect(
    panel(page).getByText(/Come back here once they have: nothing else is needed/u),
  ).toBeVisible();
  await expect(panel(page).getByLabel("Opens", { exact: true })).toHaveValue("11:30");
  await expect(panel(page).getByLabel("Preparation time (minutes)")).toHaveValue("15");
  expect(state.writes).not.toContain("SaveSetup");
  await panel(page).getByLabel("Last orders (minutes before closing)").fill("30");
  await expect(
    panel(page).getByText(/Waiting for BOP support to set your tax rates/u),
  ).toBeVisible();
  await expect(panel(page).getByRole("checkbox", { name: /I run this business/u })).toHaveCount(0);
  await expect(panel(page).getByText("What you are approving")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Save my details", exact: true }).click();
  await expect(
    panel(page).getByText(/Come back here once they have: nothing else is needed/u),
  ).toBeVisible();
  // What BOP support needs is saved, nothing to approve or publish is, and no code was asked.
  await expect
    .poll(() => state.writes)
    .toEqual([
      "PublishProfile",
      "SaveAddress",
      "SaveContact",
      "SaveReceiptDetails",
      "SetUpKitchen",
      "SaveSetup",
    ]);
  expect(state.stepUpPurposes).toEqual([]);
  // They set them; the Owner comes back to their answers, and carries on.
  state.taxReference = id(25);
  await page.reload();
  await expect(panel(page).getByLabel("Street address")).toHaveValue("1 King Street West");
  await expect(panel(page).getByLabel("Closes again")).toHaveValue("00:00");
  await expect(panel(page).getByRole("region", { name: "What you are approving" })).toBeVisible();
});

test("@production two Owners: each approves what the other sent, on this page", async ({
  page,
}) => {
  const state = await install(page, { secondOwnerExists: true });
  await page.goto(href);
  await expect(panel(page)).toBeVisible();
  // The other approver is named, nothing is offered to approve alone, and no code is asked.
  await answer(page);
  await expect(panel(page).getByRole("checkbox", { name: /on my own/u })).toHaveCount(0);
  await expect(panel(page).getByText(/Mia also approves here/u)).toBeVisible();
  await panel(page).getByRole("button", { name: "Send for approval", exact: true }).click();
  await expect(
    panel(page).getByText(
      "Waiting for Mia to approve the receipt and the allergen list. They open Store setup and press Approve.",
    ),
  ).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Check again" })).toBeVisible();
  expect(state.stepUpPurposes).toEqual([]);
  expect(state.approvals).toEqual([]);
  // The second Owner opens the page: one press approves all that waits for them, and carries on.
  state.actor = secondOwner;
  await page.reload();
  await expect(
    panel(page).getByText(/Waiting for you: the receipt and the allergen list/u),
  ).toBeVisible();
  await expect(panel(page).getByRole("region", { name: "What you are approving" })).toContainText(
    "Tuesday to Sunday: 11:30–14:30, 17:00–00:00 (next day)",
  );
  await panel(page).getByRole("button", { name: "Approve and continue", exact: true }).click();
  await expect(
    panel(page).getByText(
      "Waiting for Sam to approve the store setup. They open Store setup and press Approve.",
    ),
  ).toBeVisible();
  expect(state.approvals).toEqual(["ReceiptTemplate:Other", "AllergenList:Other"]);
  // Back to the first Owner: one press approves the last of it, and publishes.
  state.actor = owner;
  await page.reload();
  await expect(panel(page).getByText(/Waiting for you: the store setup/u)).toBeVisible();
  await panel(page).getByRole("button", { name: "Approve and continue", exact: true }).click();
  await expect(page.getByText("Your store setup is published.")).toBeVisible();
  expect(state.approvals).toEqual([
    "ReceiptTemplate:Other",
    "AllergenList:Other",
    "StoreSetup:Other",
  ]);
  // Three presses in all, no code, and the person who wrote it never approved it.
  expect(state.published().authoredByReference).toBe(secondOwner);
  expect(state.published().approvedByReference).toBe(owner);
  expect(state.errors).toEqual([]);
});

for (const width of [1440, 1024, 390])
  test(`@production the page fits at ${width}px, with no sideways scroll and no accessibility faults`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page);
    await page.goto(href);
    await expect(panel(page)).toBeVisible();
    await answer(page);
    await panel(page).getByRole("radio", { name: "Different hours by day" }).check();
    await expect(page.getByLabel("Saturday Opens", { exact: true })).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    const faults = await new AxeBuilder({ page }).include("#store-opening").analyze();
    expect(faults.violations.map((violation) => violation.id)).toEqual([]);
    await page.screenshot({
      path: `test-results/store-first-opening-${width}.png`,
      fullPage: true,
    });
  });
