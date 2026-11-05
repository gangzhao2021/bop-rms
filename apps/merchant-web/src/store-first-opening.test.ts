import { describe, expect, it } from "vitest";
import { AllergenPageError } from "./allergen-declaration-pages.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
import {
  createUnconfiguredStoreSetupContent,
  normalizeStoreSetupContentV2,
  parseStoreSetupContent,
  StoreSetupClientError,
} from "./store-setup-client.js";
import {
  emptyOpeningHours,
  loadOpeningFacts,
  openingAnswerProblems,
  openingAnswersFromRecords,
  openingConfirmationFromFacts,
  openingFeeContexts,
  openingMissing,
  openingPeriodEndsNextDay,
  openingWaitsFromFacts,
  openingWeeklySchedule,
  runStoreOpening,
  type OpeningAnswers,
  type OpeningDetails,
  type OpeningWait,
  type StoreOpeningDeps,
  type StoreOpeningInput,
} from "./store-first-opening.js";
import { openingHoursLines } from "./StoreFirstOpeningPanel.js";
import { firstOpeningFill, liveStoreSettingsChange } from "./StoreSetupDraftPage.js";

/**
 * WP-2423 item 14: the order of a first opening, what it refuses, and that pressing again after a
 * stop anywhere finishes the job and does nothing twice. Fake clients behind the real exported
 * functions; the real clients against the real routes as the restricted role are in
 * packages/database/test/store-first-opening-acceptance.test.mjs.
 */
const id = (n: number) => `01a8f300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const other = id(5);
const locale = "en-CA";
const window5s = () => {
  const observedAt = new Date().toISOString();
  return { observedAt, validUntil: new Date(Date.parse(observedAt) + 5000).toISOString() };
};
const details: OpeningDetails = {
  names: { [locale]: "Maple Noodle House" },
  addressLines: ["1 King Street West", ""],
  locality: "Toronto",
  regionCode: "ON",
  postalCode: "M5H 1A1",
  phone: "(416) 555-0100",
  businessName: "Maple Noodle House Inc.",
  gstHstNumber: "",
  qstNumber: "",
  pstNumber: "",
};
const answers: OpeningAnswers = {
  serviceModes: ["DineIn"],
  hours: {
    sameEveryDay: true,
    everyDay: [
      { start: "11:30", end: "14:30" },
      { start: "17:00", end: "00:00" },
    ],
    days: Array.from({ length: 7 }, (_, index) => ({
      open: index !== 0,
      periods: [{ start: "", end: "" }],
    })),
    lastOrdersMinutes: "30",
    preparationMinutes: "15",
  },
  offerTips: true,
};
const firstSchedule = Array.from({ length: 7 }, (_, index) => ({
  isoWeekday: index + 1,
  intervals: [
    {
      startLocalTime: "00:00:00",
      endLocalTime: "23:59:59",
      endsNextDay: false,
      serviceModes: ["DineIn", "Pickup"] as const,
      orderCutoffSeconds: 0,
      leadTimeSeconds: 0,
    },
  ],
}));
const firstConfiguration = {
  configurationReference: id(20),
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  configurationVersion: 1,
  lifecycle: "Published",
  source: "StoreOverride",
  brandBaseVersionReference: id(21),
  defaultLocale: locale,
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(22),
  contactReference: id(23),
  // A TEST Store's first configuration names a receipt template that was never published.
  receiptReference: id(24),
  taxConfigurationReference: id(25),
  paymentConfigurationReference: id(26),
  capacityConfigurationReference: null,
  enabledServiceModes: ["DineIn", "Pickup"],
  weeklySchedule: firstSchedule,
  exceptions: [],
  effectiveFrom: "2026-11-01T10:00:00.000Z",
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "INTERNAL_TEST_STORE_SETUP",
  authoredByReference: other,
  approvedByReference: other,
  approvalEvidenceReference: id(27),
  publicationReference: id(28),
  liveGateEvidenceReference: id(29),
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  dataClassification: "ConfigurationMetadata",
} as const;
const memoryJournal = (held: unknown = null) => {
  let value = held;
  return {
    load: async () => value,
    reserve: async (cursor: unknown) => {
      value = cursor;
    },
    complete: async () => {
      value = null;
      return { historical: false };
    },
    get pending() {
      return value;
    },
  };
};
type World = ReturnType<typeof world>;
interface WorldOptions {
  readonly taxReference?: string | null;
  readonly goLive?: boolean;
  readonly gate?: "Effective" | "NotSet" | "OtherApprovers";
  readonly others?: readonly string[];
  /** The Store's own opening writes that fail once, by name. */
  readonly failOnce?: ReadonlySet<string>;
  readonly profilePublished?: boolean;
  readonly noBrandOwner?: boolean;
}
/** Everything a first opening talks to, in memory, keeping the writes in order. */
function world(options: WorldOptions = {}) {
  const writes: string[] = [];
  const failOnce = new Set(options.failOnce ?? []);
  const write = (name: string) => {
    if (failOnce.delete(name)) throw new StoreSetupClientError("Unavailable");
    writes.push(name);
  };
  let nextReference = 0x100;
  const reference = () => id(nextReference++);
  const state = {
    profile: null as null | {
      version: number;
      publishedAt: string;
      defaultLocale: string;
      names: readonly { locale: string; storeDisplayName: string }[];
      address: {
        addressLines: readonly string[];
        locality: string;
        regionCode: string;
        postalCode: string;
        countryCode: string;
      };
      businessPhone: string | null;
    },
    receiptVersion: 0,
    kitchenVersion: 0,
    tips: { version: 0, enabled: true, tierPercents: [10, 15, 18] as const },
    soleOperator: options.gate === "Effective" ? "On" : "Off",
    address: null as null | { reference: string; revision: number; content: unknown },
    contact: null as null | { reference: string; revision: number; content: unknown },
    setup: null as null | {
      setupDraftReference: string;
      revision: number;
      baseConfigurationReference: string | null;
      content: unknown;
      tenantReference: string;
      brandReference: string;
      storeReference: string;
    },
    payment: null as null | {
      configurationReference: string;
      revision: number;
      content: unknown;
    },
    layout: null as null | { artifactReference: string; revision: number },
    compliance: null as null | { artifactReference: string; revision: number },
    template: null as null | {
      templateReference: string;
      versionReference: string;
      revision: number;
      fields: Record<string, unknown>;
      author: string;
    },
    review: null as null | {
      state: "InReview" | "Approved" | "Published";
      version: number;
      submittedBy: string;
      approvedAlone: boolean;
    },
    latest: null as null | Record<string, unknown>,
    current: firstConfiguration as Record<string, unknown>,
    withdrawn: false,
    registry: null as null | { entries: readonly unknown[] },
    proposal: null as null | { proposalReference: string; recordedByYou: boolean },
    allergenApprovals: [] as unknown[],
    configurationApprovals: [] as (string | undefined)[],
    templateApprovals: [] as (string | undefined)[],
    taxReference: options.taxReference === undefined ? id(25) : options.taxReference,
  };
  if (options.profilePublished === true)
    state.profile = {
      version: 1,
      publishedAt: "2026-11-01T10:00:00.000Z",
      defaultLocale: locale,
      names: [{ locale, storeDisplayName: details.names[locale] ?? "" }],
      address: {
        addressLines: ["1 King Street West"],
        locality: "Toronto",
        regionCode: "ON",
        postalCode: "M5H 1A1",
        countryCode: "CA",
      },
      businessPhone: null,
    };
  const others = (options.others ?? []).map((displayName) => ({ displayName }));
  const gateNow = (status = options.gate ?? "NotSet") => ({
    status: state.soleOperator === "On" && status === "NotSet" ? ("Effective" as const) : status,
    otherApprovers: status === "OtherApprovers" ? others : [],
    verifiedUntil: null,
  });
  const setupWorkspace = () => ({
    profile: "StoreSetupWorkspaceV1",
    scope,
    store: {
      storeReference: scope.storeReference,
      code: "MAIN",
      displayName: "Main",
      locale,
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      version: 1,
    },
    setup: {
      snapshot:
        state.setup === null
          ? null
          : { ...state.setup, profile: "StoreSetupDraftV2", defaultLocale: locale },
      ...window5s(),
    },
  });
  const referencesNow = () => ({
    ...scope,
    profile: "StoreSetupReferencesCurrentV1",
    address: state.address,
    contact: state.contact,
    ...window5s(),
  });
  const paymentNow = () => ({ ...scope, snapshot: state.payment, ...window5s() });
  const artifactsNow = () => ({
    ...scope,
    layout: state.layout,
    compliance: state.compliance,
    ...window5s(),
  });
  const snapshotOf = () =>
    state.template === null
      ? null
      : {
          revision: state.template.revision,
          contentDigest: "sha256:" + String(state.template.revision).padStart(64, "0"),
          content: {
            ...state.template.fields,
            templateReference: state.template.templateReference,
            versionReference: state.template.versionReference,
          },
        };
  const templateView = (subject: string | null) => ({
    ...scope,
    templateReference: subject,
    snapshot: subject === null ? null : snapshotOf(),
    ...window5s(),
  });
  const reviewNow = () => {
    const template = state.template;
    if (template === null) throw new StoreSetupClientError("Conflict");
    const snapshot = snapshotOf();
    return {
      ...scope,
      templateReference: template.templateReference,
      currentDraft: {
        versionReference: template.versionReference,
        revision: template.revision,
        contentDigest: snapshot?.contentDigest,
      },
      submission:
        state.review === null
          ? null
          : {
              versionReference: template.versionReference,
              draftRevision: template.revision,
              contentDigest: snapshot?.contentDigest,
              authoredByReference: template.author,
              submittedByReference: state.review.submittedBy,
              validationValidUntil: new Date(Date.now() + 86400000).toISOString(),
            },
      lifecycle:
        state.review === null
          ? null
          : {
              lifecycleReference: id(0x50),
              version: state.review.version,
              state: state.review.state,
              latestMutationOperationReference: id(0x51),
            },
      ...window5s(),
    };
  };
  const configurationNow = () => {
    const pending = state.latest?.lifecycle === "PendingApproval";
    const own =
      pending &&
      (state.latest?.authoredByReference === scope.actorReference ||
        state.latest?.submittedBy === scope.actorReference);
    return {
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest: state.latest,
      current: state.current,
      expectedHead: {
        configurationReference: (state.latest ?? state.current).configurationReference,
        configurationVersion: (state.latest ?? state.current).configurationVersion,
        contentDigest: "sha256:" + "a".repeat(64),
      },
      original: null,
      ...window5s(),
      businessReferenceValidation: "NotEvaluated",
      ...(state.taxReference === undefined
        ? {}
        : { storeTaxConfigurationReference: state.taxReference }),
      ...(options.goLive === undefined ? {} : { goLive: options.goLive }),
      ...(pending
        ? {
            publicationChecks: {
              checks: [{ code: "Tax", outcome: "Pass" }],
            },
          }
        : state.latest?.lifecycle === "Draft"
          ? {
              publicationChecks: {
                checks: [{ code: "Tax", outcome: "Pass" }],
              },
            }
          : {}),
      ...(own ? { soleOperator: gateNow() } : {}),
    };
  };
  const allergensView = () => ({
    screenId: "CMP-ALLERGEN-REVIEW",
    sourceAsOf: new Date().toISOString(),
    viewer: scope.actorReference,
    locale,
    permissions: { mayRead: true, mayDeclare: true, mayManageRegistry: true },
    registry: state.registry,
    registryProposal: state.proposal,
    soleOperator: gateNow(),
    registryTemplate: {
      template: "CA_PRIORITY_TEST",
      jurisdictionCode: "CA",
      policyDocument: "TEST-ONLY",
      allergens: [
        { code: "PEANUT", name: "Peanuts" },
        { code: "MILK", name: "Milk" },
      ],
    },
    sources: [],
    items: [],
  });
  const journals = {
    setup: memoryJournal(),
    reference: new Map<string, ReturnType<typeof memoryJournal>>(),
    payment: memoryJournal(),
    artifact: new Map<string, ReturnType<typeof memoryJournal>>(),
    template: new Map<string, ReturnType<typeof memoryJournal>>(),
    submit: new Map<string, ReturnType<typeof memoryJournal>>(),
    lifecycle: new Map<string, ReturnType<typeof memoryJournal>>(),
    configuration: memoryJournal(),
  };
  const keyed = (map: Map<string, ReturnType<typeof memoryJournal>>) => (key: string | null) => {
    const name = String(key);
    const held = map.get(name) ?? memoryJournal();
    map.set(name, held);
    return held;
  };
  const deps = {
    scope,
    csrf: "c".repeat(43),
    signal: new AbortController().signal,
    locale,
    operations: new Map(),
    setup: {
      load: async () => setupWorkspace(),
      prepare: async (input: { content: unknown }) => ({
        command: input,
        cursor: { kind: "setup", scope },
      }),
      execute: async (value: { command: { content: unknown } }) => {
        write("SaveSetup");
        state.setup = {
          setupDraftReference: state.setup?.setupDraftReference ?? id(0x30),
          revision: (state.setup?.revision ?? 0) + 1,
          baseConfigurationReference: String(
            (state.latest ?? state.current).configurationReference,
          ),
          content: value.command.content,
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        };
        return { outcome: "Committed" };
      },
      resolve: async () => {
        writes.push("ResolveSetup");
        return { outcome: "Abandoned" };
      },
    },
    setupJournal: journals.setup,
    references: {
      load: async () => referencesNow(),
      prepare: async (input: { kind: string; content: unknown }) => ({
        command: input,
        cursor: { kind: input.kind, scope },
      }),
      execute: async (value: { command: { kind: string; content: unknown } }) => {
        const { kind, content } = value.command;
        write("Save" + kind);
        const key = kind === "Address" ? "address" : "contact";
        state[key] = {
          reference: reference(),
          revision: (state[key]?.revision ?? 0) + 1,
          content,
        };
        return { outcome: "Committed" };
      },
      resolve: async () => ({ outcome: "Abandoned" }),
    },
    referenceJournal: keyed(journals.reference),
    payment: {
      load: async () => paymentNow(),
      prepare: async (input: { content: unknown }) => ({ command: input, cursor: { scope } }),
      execute: async (value: { command: { content: unknown } }) => {
        write("SavePayment");
        state.payment = {
          configurationReference: reference(),
          revision: 1,
          content: value.command.content,
        };
        return { outcome: "Committed" };
      },
      resolve: async () => ({ outcome: "Abandoned" }),
    },
    paymentJournal: journals.payment,
    artifacts: {
      load: async () => artifactsNow(),
      prepare: async (input: { artifactKind: string }) => ({ command: input, cursor: { scope } }),
      execute: async (value: { command: { artifactKind: string } }) => {
        const kind = value.command.artifactKind;
        write("Save" + kind);
        const saved = { artifactReference: reference(), revision: 1 };
        if (kind === "Layout") state.layout = saved;
        else state.compliance = saved;
        return { outcome: "Committed" };
      },
      resolve: async () => ({ outcome: "Abandoned" }),
    },
    artifactJournal: keyed(journals.artifact),
    templates: {
      loadRoster: async () => ({
        ...scope,
        entries: state.template === null ? [] : [{ ...snapshotOf() }],
        nextAfter: null,
        ...window5s(),
      }),
      load: async (input: { templateReference: string | null }) =>
        templateView(input.templateReference),
      prepare: async (input: {
        templateReference: string | null;
        fields: Record<string, unknown>;
      }) => ({
        command: input,
        cursor: { kind: "template", scope, templateReference: input.templateReference },
      }),
      execute: async (value: { command: { fields: Record<string, unknown> } }) => {
        write("SaveTemplate");
        state.template = {
          templateReference: id(0x40),
          versionReference: id(0x41 + (state.template?.revision ?? 0)),
          revision: (state.template?.revision ?? 0) + 1,
          fields: value.command.fields,
          author: scope.actorReference,
        };
        state.review = null;
        return { outcome: "Committed", snapshot: snapshotOf() };
      },
      resolve: async () => ({ outcome: "Abandoned", snapshot: null }),
    },
    templateJournal: keyed(journals.template),
    submit: {
      load: async () => reviewNow(),
      prepare: async (input: { templateReference: string }) => ({
        command: input,
        cursor: { kind: "submit", scope, templateReference: input.templateReference },
      }),
      execute: async () => {
        write("SubmitTemplate");
        state.review = {
          state: "InReview",
          version: 2,
          submittedBy: scope.actorReference,
          approvedAlone: false,
        };
        return { outcome: "Committed" };
      },
      resolve: async () => ({ outcome: "Abandoned" }),
    },
    submitJournal: (subject: string) => keyed(journals.submit)(subject),
    lifecycle: {
      prepare: async (input: { action: string; templateReference: string }) => ({
        command: input,
        cursor: {
          kind: "lifecycle",
          action: input.action,
          scope,
          templateReference: input.templateReference,
        },
      }),
      execute: async (
        value: { command: { action: string } },
        _options: unknown,
        approvalMode?: string,
      ) => {
        const action = value.command.action;
        write(action + "Template");
        if (state.review === null) throw new StoreSetupClientError("Conflict");
        if (action === "Approve") state.templateApprovals.push(approvalMode);
        state.review = {
          ...state.review,
          state: action === "Approve" ? "Approved" : "Published",
          version: state.review.version + 1,
        };
        return { outcome: "Committed", action };
      },
      resolve: async () => ({ outcome: "Abandoned" }),
    },
    lifecycleJournal: (subject: string) => keyed(journals.lifecycle)(subject),
    templateGate: async () => gateNow(),
    published: {
      load: async (input: { templateReference: string }) => {
        const template = state.template;
        if (
          template === null ||
          input.templateReference !== template.templateReference ||
          state.review?.state !== "Published"
        )
          throw new StoreSetupClientError("Unavailable");
        const at = new Date(Date.now() - 1000).toISOString();
        return {
          ...scope,
          profile: "DigitalReceiptTemplatePublishedCurrentV1",
          templateReference: template.templateReference,
          locale,
          currentVersion: {
            templateReference: template.templateReference,
            versionReference: template.versionReference,
            versionNumber: 1,
            versionCode: "RECEIPT_V1",
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            locale,
            dataContractVersion: 1,
            renderEngineVersion: 1,
            outputProfile: "AccessibleDigitalReceipt",
            layoutDefinitionReference: id(0x60),
            complianceRuleReference: id(0x61),
            requiredFields: [...receiptTemplateArtifactRequiredFields],
            publicationReference: id(0x62),
            publishedAt: at,
            effectiveFrom: at,
            effectiveUntil: null,
          },
          ...window5s(),
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        };
      },
      loadInstalled: async () => null,
    },
    configuration: {
      load: async () => configurationNow(),
      prepare: async (command: { action: string; setupSelector?: unknown }) => ({
        command,
        cursor: { kind: "configuration", action: command.action },
        intentDigest: "sha256:" + "b".repeat(64),
      }),
      execute: async (
        value: { command: { action: string } },
        _options: unknown,
        approvalMode?: string,
      ) => {
        const { action } = value.command;
        write(action + "Configuration");
        if (action === "Materialize") {
          const setup = state.setup;
          if (setup === null) throw new StoreSetupClientError("Conflict");
          const content = setup.content as Record<string, { state: string; value?: unknown }>;
          state.latest = {
            ...firstConfiguration,
            configurationReference: reference(),
            configurationVersion: Number((state.latest ?? state.current).configurationVersion) + 1,
            lifecycle: "Draft",
            reasonCode: "STORE_SETUP_MATERIALIZATION",
            authoredByReference: scope.actorReference,
            approvedByReference: null,
            enabledServiceModes: content.enabledServiceModes?.value,
            weeklySchedule: content.weeklySchedule?.value,
            exceptions: content.exceptions?.value,
            timeZone: content.timeZone?.value,
            businessDayStartLocalTime: content.businessDayStartLocalTime?.value,
            capacityConfigurationReference: content.capacityConfigurationReference?.value,
            addressReference: content.addressReference?.value,
            contactReference: content.contactReference?.value,
            paymentConfigurationReference: content.paymentConfigurationReference?.value,
            receiptReference: content.receiptReference?.value,
            taxConfigurationReference: content.taxConfigurationReference?.value,
            setupBasis: {
              setupDraftReference: setup.setupDraftReference,
              sourceRevision: setup.revision,
              feeContexts: content.feeContexts?.value,
            },
          };
        } else if (state.latest !== null) {
          state.latest = {
            ...state.latest,
            lifecycle:
              action === "Submit"
                ? "PendingApproval"
                : action === "Approve"
                  ? "Approved"
                  : "Published",
          };
          if (action === "Approve") state.configurationApprovals.push(approvalMode);
          if (action === "Publish") state.current = state.latest;
        }
        return { outcome: "Committed" };
      },
      resolve: async () => {
        writes.push("ResolveConfiguration");
        return { outcome: "Abandoned" };
      },
      refreshOriginal: async () => configurationNow(),
      invalidate: () => undefined,
    },
    configurationJournal: journals.configuration,
    kitchen: {
      load: async () => ({
        canChange: true,
        version: state.kitchenVersion,
        inEffectFrom: null,
        uncoveredDishes: [],
      }),
      apply: async () => {
        write("SetUpKitchen");
        state.kitchenVersion += 1;
      },
    },
    profile: {
      load: async () => ({
        observedAt: new Date().toISOString(),
        canChange: true,
        locales: [locale],
        current: state.profile,
        regionCodes: ["ON"],
      }),
      save: async (body: {
        expectedVersion: number;
        details: {
          storeDisplayNames: Record<string, string>;
          address: {
            addressLines: string[];
            locality: string;
            regionCode: string;
            postalCode: string;
          };
          businessPhone: string | null;
        };
      }) => {
        write("PublishProfile");
        state.profile = {
          version: body.expectedVersion + 1,
          publishedAt: new Date().toISOString(),
          defaultLocale: locale,
          names: [{ locale, storeDisplayName: body.details.storeDisplayNames[locale] ?? "" }],
          address: { ...body.details.address, countryCode: "CA" },
          businessPhone: body.details.businessPhone === null ? null : "+14165550100",
        };
        return state.profile;
      },
    },
    receipts: {
      load: async () => ({
        observedAt: new Date().toISOString(),
        canChange: true,
        version: state.receiptVersion,
        recordedAt: state.receiptVersion > 0 ? "2026-11-01T10:00:00.000Z" : null,
        details: { gstHstNumber: null, qstNumber: null, pstNumber: null, privacyNoticeUrl: null },
        gaps: { taxRegistrationMissing: true, privacyNoticeMissing: true },
        issuer: {
          businessName: state.receiptVersion > 0 ? details.businessName : null,
          suggestedBusinessName: "Maple",
        },
      }),
      save: async () => {
        write("SaveReceiptDetails");
        state.receiptVersion += 1;
        return { version: state.receiptVersion, gaps: {} };
      },
    },
    features: {
      read: async () => ({ tips: { ...state.tips, changedAt: null, offInStoreSetup: false } }),
      changeTips: async (input: { enabled: boolean }) => {
        write("ChangeTips");
        state.tips = { ...state.tips, enabled: input.enabled, version: state.tips.version + 1 };
        return { tips: state.tips };
      },
    },
    soleOperator: {
      read: async () =>
        options.noBrandOwner === true
          ? null
          : { state: state.soleOperator, version: 0, verifiedUntil: null },
      change: async () => {
        write("TurnOnSoleOperator");
        state.soleOperator = "On";
      },
    },
    allergens: {
      load: async () => allergensView(),
      command: async (command: { action: string; approvalMode?: string }) => {
        write(command.action);
        if (command.action === "RecordRegistry")
          state.proposal = { proposalReference: id(0x70), recordedByYou: true };
        else {
          state.allergenApprovals.push(command.approvalMode);
          state.registry = { entries: [] };
          state.proposal = null;
        }
      },
    },
    loadApprovers: async () => ({
      receiptTemplate: others,
      storeSetup: others,
      allergenList: others,
    }),
  } as unknown as StoreOpeningDeps;
  return { deps, state, writes, journals };
}
const approvers = (w: World) => w.deps.loadApprovers();
async function pressAlone(w: World, overrides: Partial<StoreOpeningInput> = {}) {
  const facts = await loadOpeningFacts(w.deps);
  return runStoreOpening(w.deps, {
    details,
    answers,
    confirmed: openingConfirmationFromFacts(facts, details, answers),
    approveAlone: true,
    approveOthers: false,
    approvers: facts.approvers,
    ...overrides,
  });
}
const everyWrite = [
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
];

describe("WP-2423 item 14: the press", () => {
  it("does each step of a new Store once, in order, as the one approver", async () => {
    const w = world();
    const outcome = await pressAlone(w);
    expect(outcome).toEqual({ kind: "Published", waits: [] });
    expect(w.writes).toEqual(everyWrite);
    // Each approval says it was given alone, and the setting was the Owner's explicit request.
    expect(w.state.templateApprovals).toEqual(["SoleOperator"]);
    expect(w.state.configurationApprovals).toEqual(["SoleOperator"]);
    expect(w.state.allergenApprovals).toEqual(["SoleOperator"]);
  });
  it("pressing again after a stop at any step finishes, and writes nothing twice", async () => {
    for (const failing of new Set(everyWrite)) {
      const w = world({ failOnce: new Set([failing]) });
      const stopped = await pressAlone(w);
      expect(stopped.kind, failing).toBe("Stopped");
      const again = await pressAlone(w);
      expect(again, failing).toEqual({ kind: "Published", waits: [] });
      // In the same order, each once (the draft is saved twice by design: answers, then in full).
      // A write that failed after its original was reserved is first resolved as not gone through.
      const written = () => w.writes.filter((name) => !name.startsWith("Resolve"));
      expect(written(), failing).toEqual(everyWrite);
      // A press with nothing left to do writes nothing.
      await pressAlone(w);
      expect(written(), failing).toEqual(everyWrite);
    }
  });
  it("recovers an original still pending before anything else, then carries on", async () => {
    const w = world();
    const journal = w.journals.setup as ReturnType<typeof memoryJournal>;
    await journal.reserve({ kind: "setup", scope, operationReference: id(0x80) });
    const outcome = await pressAlone(w);
    expect(outcome.kind).toBe("Published");
    expect(w.writes[0]).toBe("PublishProfile");
    expect(w.writes).toContain("ResolveSetup");
    expect(w.writes.indexOf("ResolveSetup")).toBeLessThan(w.writes.indexOf("SaveSetup"));
    expect(journal.pending).toBeNull();
  });
  it("hours answered on the page are the hours published, with the order types answered", async () => {
    const w = world();
    await pressAlone(w);
    const published = w.state.current;
    expect(published.enabledServiceModes).toEqual(["DineIn"]);
    expect(published.weeklySchedule).toEqual(openingWeeklySchedule(answers));
    expect(canonical(published.weeklySchedule)).not.toBe(canonical(firstSchedule));
    // Store setup's own button would have put the starting hours back; the opening's fill doesn't.
    const content = parseStoreSetupContent({
      ...normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent()),
      weeklySchedule: { state: "Configured", value: openingWeeklySchedule(answers) },
      enabledServiceModes: { state: "Configured", value: ["DineIn"] },
    });
    const live = {
      current: firstConfiguration as never,
      observedAt: "2026-11-02T10:00:00.000Z",
      storeTaxConfigurationReference: id(25),
    };
    expect(firstOpeningFill(content, live).weeklySchedule).toBeUndefined();
    expect(firstOpeningFill(content, live).enabledServiceModes).toBeUndefined();
    expect(firstOpeningFill(content, live).receiptReference).toBeUndefined();
    expect(liveStoreSettingsChange(content, live).weeklySchedule).toEqual({
      state: "Configured",
      value: firstSchedule,
    });
  });
  it("sets the receipt it published, never the one the first configuration names", async () => {
    const w = world();
    await pressAlone(w);
    const content = w.state.setup?.content as { receiptReference: { value: string } };
    expect(content.receiptReference.value).toBe(id(0x40));
    expect(content.receiptReference.value).not.toBe(firstConfiguration.receiptReference);
    // The installed template is the one a Store really started with, when it has one.
    expect(w.state.current.receiptReference).toBe(id(0x40));
  });
  it("keeps tips on for the Store's order types, and turns service charge and delivery fee off", async () => {
    const w = world();
    await pressAlone(w);
    const content = w.state.setup?.content as { feeContexts: { value: unknown } };
    expect(content.feeContexts.value).toEqual([
      { chargeType: "ServiceCharge", state: "Disabled" },
      { chargeType: "DeliveryFee", state: "Disabled" },
      {
        chargeType: "Tip",
        state: "Enabled",
        taxClassificationReference: null,
        orderTypes: ["DineIn"],
      },
    ]);
    // The switch works on Store features, at once and with no publish of its own.
    const off = world();
    await pressAlone(off, { answers: { ...answers, offerTips: false } });
    expect(off.writes).toContain("ChangeTips");
    expect(off.state.tips.enabled).toBe(false);
    expect(
      (off.state.setup?.content as { feeContexts: { value: { state: string }[] } }).feeContexts
        .value[2]?.state,
    ).toBe("Enabled");
    expect(w.writes).not.toContain("ChangeTips");
  });
  it("a fee the Owner set in the wizard stays, for the order types the Store still offers", () => {
    const content = parseStoreSetupContent({
      ...normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent()),
      feeContexts: {
        state: "Configured",
        value: [
          {
            chargeType: "ServiceCharge",
            state: "Enabled",
            taxClassificationReference: id(0x90),
            orderTypes: ["DineIn", "Pickup"],
          },
          {
            chargeType: "DeliveryFee",
            state: "Enabled",
            taxClassificationReference: id(0x90),
            orderTypes: ["Delivery"],
          },
          { chargeType: "Tip", state: "Disabled" },
        ],
      },
    });
    expect(openingFeeContexts(content, ["DineIn"])).toEqual([
      {
        chargeType: "ServiceCharge",
        state: "Enabled",
        taxClassificationReference: id(0x90),
        orderTypes: ["DineIn"],
      },
      { chargeType: "DeliveryFee", state: "Disabled" },
      {
        chargeType: "Tip",
        state: "Enabled",
        taxClassificationReference: null,
        orderTypes: ["DineIn"],
      },
    ]);
  });
  it("sends no approval or publication write while BOP support has a step to do", async () => {
    for (const [options, missing] of [
      [{ taxReference: null }, ["TaxRates"]],
      [{ goLive: false }, ["GoLive"]],
      [{ taxReference: null, goLive: false }, ["TaxRates", "GoLive"]],
    ] as const) {
      const w = world(options);
      const facts = await loadOpeningFacts(w.deps);
      const outcome = await runStoreOpening(w.deps, {
        details,
        answers,
        confirmed: null,
        approveAlone: false,
        approveOthers: false,
        approvers: facts.approvers,
      });
      expect(outcome).toEqual({ kind: "DetailsSaved", missing });
      // What the Owner typed is kept, and only that: BOP support needs the province from it.
      expect(w.writes).toEqual([
        "PublishProfile",
        "SaveAddress",
        "SaveContact",
        "SaveReceiptDetails",
        "SetUpKitchen",
        "SaveSetup",
      ]);
      expect(openingMissing(facts.live)).toEqual(missing);
    }
  });
  it("refuses to start from hours nobody answered", async () => {
    const w = world();
    const facts = await loadOpeningFacts(w.deps);
    const unanswered = { ...answers, hours: emptyOpeningHours() };
    const outcome = await runStoreOpening(w.deps, {
      details,
      answers: unanswered,
      confirmed: null,
      approveAlone: true,
      approveOthers: false,
      approvers: facts.approvers,
    });
    expect(outcome).toMatchObject({ kind: "Stopped", code: "HoursNotAnswered" });
    expect(w.writes).not.toContain("TurnOnSoleOperator");
    expect(w.state.setup?.content).toBeUndefined();
  });
  it("names the other approver and sends no self-approval", async () => {
    const w = world({ gate: "OtherApprovers", others: ["Mia"] });
    const facts = await loadOpeningFacts(w.deps);
    const outcome = await runStoreOpening(w.deps, {
      details,
      answers,
      confirmed: null,
      approveAlone: false,
      approveOthers: false,
      approvers: facts.approvers,
    });
    expect(outcome.kind).toBe("Waiting");
    const waits = (outcome as { waits: readonly OpeningWait[] }).waits;
    expect(waits.map((wait) => wait.what)).toEqual(["ReceiptTemplate", "AllergenList"]);
    expect(waits.every((wait) => wait.who.some((who) => who.displayName === "Mia"))).toBe(true);
    expect(w.writes).toContain("SubmitTemplate");
    expect(w.writes).toContain("RecordRegistry");
    expect(w.writes).not.toContain("ApproveTemplate");
    expect(w.writes).not.toContain("ApproveRegistry");
    expect(w.writes).not.toContain("TurnOnSoleOperator");
    expect(w.state.templateApprovals).toEqual([]);
    expect(openingWaitsFromFacts(await loadOpeningFacts(w.deps)).forOthers).toHaveLength(2);
  });
  it("a lone Owner never waits for nobody: they are asked for the tick", async () => {
    const w = world();
    const facts = await loadOpeningFacts(w.deps);
    const outcome = await runStoreOpening(w.deps, {
      details,
      answers,
      confirmed: null,
      approveAlone: false,
      approveOthers: false,
      approvers: facts.approvers,
    });
    expect(outcome).toEqual({ kind: "ConfirmAgain" });
    expect(w.writes).not.toContain("ApproveTemplate");
    // Someone who can't turn sole operator on is told it takes the brand owner.
    const notOwner = world({ noBrandOwner: true });
    expect(await pressAlone(notOwner)).toMatchObject({ kind: "Stopped", code: "NotBrandOwner" });
    expect(notOwner.writes).not.toContain("TurnOnSoleOperator");
    expect(notOwner.writes).not.toContain("ApproveTemplate");
  });
  it("what is on record differs from what was ticked: no approval, and the tick is asked again", async () => {
    const w = world();
    const facts = await loadOpeningFacts(w.deps);
    const confirmed = openingConfirmationFromFacts(facts, details, answers);
    if (confirmed === null) throw new Error("expected a confirmation");
    const outcome = await pressAlone(w, {
      confirmed: { ...confirmed, businessDayStart: "05:00:00" },
    });
    expect(outcome).toEqual({ kind: "ConfirmAgain" });
    expect(w.writes).toContain("SubmitConfiguration");
    expect(w.writes).not.toContain("ApproveConfiguration");
    expect(w.state.configurationApprovals).toEqual([]);
    // Ticked again against what is on record: it goes through, with nothing made twice.
    expect(await pressAlone(w, { confirmed })).toEqual({ kind: "Published", waits: [] });
    expect(w.writes.filter((name) => name === "MaterializeConfiguration")).toHaveLength(1);
    // The same for the allergen list and the receipt, each against its own record.
    const list = world();
    expect(await pressAlone(list, { confirmed: { ...confirmed, allergens: ["PEANUT"] } })).toEqual({
      kind: "ConfirmAgain",
    });
    expect(list.writes).not.toContain("ApproveRegistry");
    const receipt = world();
    expect(
      await pressAlone(receipt, { confirmed: { ...confirmed, receiptLocale: "fr-CA" } }),
    ).toEqual({ kind: "ConfirmAgain" });
    expect(receipt.writes).not.toContain("ApproveTemplate");
  });
  it("a corrected address writes a new revision the draft follows, and only then", async () => {
    const w = world();
    const facts = await loadOpeningFacts(w.deps);
    const input = {
      details,
      answers,
      confirmed: null,
      approveAlone: false,
      approveOthers: false,
      approvers: facts.approvers,
    };
    w.state.taxReference = null;
    await runStoreOpening(w.deps, input);
    const first = w.state.address?.reference;
    expect(w.state.address?.revision).toBe(1);
    await runStoreOpening(w.deps, input);
    expect(w.state.address?.reference).toBe(first);
    expect(w.writes.filter((name) => name === "SaveAddress")).toHaveLength(1);
    const corrected = { ...details, regionCode: "BC", locality: "Vancouver" };
    await runStoreOpening(w.deps, { ...input, details: corrected });
    expect(w.state.address?.revision).toBe(2);
    expect((w.state.address?.content as { regionCode: string }).regionCode).toBe("BC");
    expect(
      (w.state.setup?.content as { addressReference: { value: string } }).addressReference.value,
    ).toBe(w.state.address?.reference);
  });
  it("a profile with no phone stops at the contact, named", async () => {
    const w = world({ profilePublished: true });
    const facts = await loadOpeningFacts(w.deps);
    const outcome = await runStoreOpening(w.deps, {
      details: { ...details, phone: "" },
      answers,
      confirmed: null,
      approveAlone: false,
      approveOthers: false,
      approvers: facts.approvers,
    });
    expect(outcome).toMatchObject({ kind: "Stopped", step: "StoreDetails", code: "NeedsPhone" });
    expect(w.writes).not.toContain("SaveContact");
  });
  it("whoever is waited for is told, and their press approves it and carries on", async () => {
    const w = world();
    // Another Owner wrote and sent the receipt, and recorded the allergen list.
    w.state.template = {
      templateReference: id(0x40),
      versionReference: id(0x41),
      revision: 1,
      fields: {
        locale,
        layoutDefinitionReference: id(0x60),
        complianceRuleReference: id(0x61),
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
      author: other,
    };
    w.state.review = { state: "InReview", version: 2, submittedBy: other, approvedAlone: false };
    w.state.proposal = { proposalReference: id(0x70), recordedByYou: false };
    w.state.setup = {
      setupDraftReference: id(0x30),
      revision: 1,
      baseConfigurationReference: firstConfiguration.configurationReference,
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      content: parseStoreSetupContent({
        ...normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent()),
        source: { state: "Configured", value: "StoreOverride" },
        weeklySchedule: { state: "Configured", value: openingWeeklySchedule(answers) },
        enabledServiceModes: { state: "Configured", value: ["DineIn"] },
        addressReference: { state: "Configured", value: id(0x31) },
        contactReference: { state: "Configured", value: id(0x32) },
        feeContexts: {
          state: "Configured",
          value: openingFeeContexts(
            normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent()),
            ["DineIn"],
          ),
        },
      }),
    };
    const facts = await loadOpeningFacts(w.deps);
    expect(openingWaitsFromFacts(facts).forYou).toEqual(["ReceiptTemplate", "AllergenList"]);
    // Pressing the ordinary button approves nothing of someone else's.
    const held = await runStoreOpening(w.deps, {
      details: null,
      answers: null,
      confirmed: null,
      approveAlone: false,
      approveOthers: false,
      approvers: await approvers(w),
    });
    expect(held.kind).toBe("Waiting");
    expect(w.writes).toEqual(["SavePayment"]);
    // "Approve": independent approvals, never marked as given alone, then the rest of the run.
    const outcome = await runStoreOpening(w.deps, {
      details: null,
      answers: null,
      confirmed: null,
      approveAlone: false,
      approveOthers: true,
      approvers: { receiptTemplate: [], storeSetup: [{ displayName: "Mia" }], allergenList: [] },
    });
    expect(outcome.kind).toBe("Waiting");
    expect((outcome as { waits: readonly OpeningWait[] }).waits).toEqual([
      { what: "StoreSetup", who: [{ displayName: "Mia" }] },
    ]);
    expect(w.state.templateApprovals).toEqual([undefined]);
    expect(w.state.allergenApprovals).toEqual([undefined]);
    expect(w.state.configurationApprovals).toEqual([]);
    expect(w.writes).toContain("PublishTemplate");
    expect(w.writes).toContain("SubmitConfiguration");
    // Nothing the second person did not answer was changed: the first Owner's hours are published.
    const content = w.state.setup?.content as { weeklySchedule: { value: unknown } };
    expect(content.weeklySchedule.value).toEqual(openingWeeklySchedule(answers));
  });
  it("a Store Owner without Brand-level allergen access leaves that list to those who hold it", async () => {
    const w = world();
    (w.deps.allergens as { load: () => Promise<unknown> }).load = async () => {
      throw new AllergenPageError("PermissionDenied");
    };
    const facts = await loadOpeningFacts(w.deps);
    expect(facts.allergens).toBeNull();
    const outcome = await runStoreOpening(w.deps, {
      details,
      answers,
      confirmed: openingConfirmationFromFacts(facts, details, answers),
      approveAlone: true,
      approveOthers: false,
      approvers: {
        receiptTemplate: [],
        storeSetup: [],
        allergenList: [{ displayName: "Noah" }],
      },
    });
    expect(outcome).toEqual({
      kind: "Published",
      waits: [{ what: "AllergenList", who: [{ displayName: "Noah" }] }],
    });
    expect(w.writes).not.toContain("RecordRegistry");
  });
});

describe("WP-2423 item 14: the answers", () => {
  it("asks for what is missing, in the order the page asks it", () => {
    const blank: OpeningAnswers = {
      serviceModes: [],
      hours: emptyOpeningHours(),
      offerTips: true,
    };
    expect(openingAnswerProblems(blank)).toEqual([
      "NoServiceMode",
      "TimeMissing",
      "LastOrders",
      "Preparation",
    ]);
    expect(openingAnswerProblems(answers)).toEqual([]);
    const hours = (change: Partial<OpeningAnswers["hours"]>) => ({
      ...answers,
      hours: { ...answers.hours, ...change },
    });
    expect(
      openingAnswerProblems(
        hours({ days: answers.hours.days.map((d) => ({ ...d, open: false })) }),
      ),
    ).toEqual(["NoOpenDay"]);
    expect(openingAnswerProblems(hours({ everyDay: [{ start: "11:00", end: "11:00" }] }))).toEqual([
      "SameTimes",
    ]);
    expect(
      openingAnswerProblems(
        hours({
          everyDay: [
            { start: "11:00", end: "15:00" },
            { start: "14:00", end: "20:00" },
          ],
        }),
      ),
    ).toEqual(["PeriodsOverlap"]);
    // A period past midnight must be the last of its day: the contract refuses anything after it.
    expect(
      openingAnswerProblems(
        hours({
          everyDay: [
            { start: "17:00", end: "01:00" },
            { start: "18:00", end: "20:00" },
          ],
        }),
      ),
    ).toEqual(["PeriodsOverlap"]);
    expect(openingAnswerProblems(hours({ lastOrdersMinutes: "1441" }))).toEqual(["LastOrders"]);
    expect(openingAnswerProblems(hours({ preparationMinutes: "ten" }))).toEqual(["Preparation"]);
  });
  it("writes the schedule the configuration contract takes", () => {
    const schedule = openingWeeklySchedule(answers);
    expect(schedule).toHaveLength(7);
    expect(schedule[0]).toEqual({ isoWeekday: 1, intervals: [] });
    expect(schedule[1]?.intervals).toEqual([
      {
        startLocalTime: "11:30:00",
        endLocalTime: "14:30:00",
        endsNextDay: false,
        serviceModes: ["DineIn"],
        orderCutoffSeconds: 1800,
        leadTimeSeconds: 900,
      },
      {
        startLocalTime: "17:00:00",
        endLocalTime: "00:00:00",
        endsNextDay: true,
        serviceModes: ["DineIn"],
        orderCutoffSeconds: 1800,
        leadTimeSeconds: 900,
      },
    ]);
    expect(openingPeriodEndsNextDay({ start: "17:00", end: "02:00" })).toBe(true);
    expect(openingPeriodEndsNextDay({ start: "17:00", end: "22:00" })).toBe(false);
    // Order types always in the same order, whichever box was ticked first.
    expect(
      openingWeeklySchedule({ ...answers, serviceModes: ["Pickup", "DineIn"] })[1]?.intervals[0]
        ?.serviceModes,
    ).toEqual(["DineIn", "Pickup"]);
  });
  it("different hours by day use each day's own periods", () => {
    const days = answers.hours.days.map((day, index) => ({
      ...day,
      periods: [{ start: "10:00", end: index === 5 ? "23:00" : "21:00" }],
    }));
    const schedule = openingWeeklySchedule({
      ...answers,
      hours: { ...answers.hours, sameEveryDay: false, days },
    });
    expect(schedule[5]?.intervals[0]?.endLocalTime).toBe("23:00:00");
    expect(schedule[4]?.intervals[0]?.endLocalTime).toBe("21:00:00");
    expect(schedule[0]?.intervals).toEqual([]);
  });
  it("never fills the page from the hours a Store started with", () => {
    const blank = normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent());
    expect(openingAnswersFromRecords(blank, firstConfiguration as never)).toBeNull();
    // "Use the live Store's settings" in the wizard copies those hours into the setup: still no.
    const copied = parseStoreSetupContent({
      ...blank,
      weeklySchedule: { state: "Configured", value: firstSchedule },
      enabledServiceModes: { state: "Configured", value: ["DineIn", "Pickup"] },
    });
    expect(openingAnswersFromRecords(copied, firstConfiguration as never)).toBeNull();
    // The Owner's own: their saved answers, or an hours change they published.
    const own = parseStoreSetupContent({
      ...blank,
      weeklySchedule: { state: "Configured", value: openingWeeklySchedule(answers) },
      enabledServiceModes: { state: "Configured", value: ["DineIn"] },
    });
    expect(openingAnswersFromRecords(own, firstConfiguration as never)?.hours).toMatchObject({
      sameEveryDay: true,
      lastOrdersMinutes: "30",
      preparationMinutes: "15",
    });
    const changed = {
      ...firstConfiguration,
      reasonCode: "STORE_HOURS_UPDATE",
      enabledServiceModes: ["DineIn"],
      weeklySchedule: openingWeeklySchedule(answers),
    };
    expect(openingAnswersFromRecords(blank, changed as never)?.serviceModes).toEqual(["DineIn"]);
  });
  it("says the hours in lines people read", () => {
    expect(openingHoursLines(openingWeeklySchedule(answers))).toEqual([
      "Monday: closed",
      "Tuesday to Sunday: 11:30–14:30, 17:00–00:00 (next day)",
    ]);
    const open = openingWeeklySchedule({
      ...answers,
      hours: {
        ...answers.hours,
        everyDay: [{ start: "09:00", end: "17:00" }],
        days: answers.hours.days.map((day) => ({ ...day, open: true })),
      },
    });
    expect(openingHoursLines(open)).toEqual(["Every day: 09:00–17:00"]);
  });
});
