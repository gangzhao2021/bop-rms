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
  openingAnswersInput,
  openingApprovalPlan,
  openingApproveInput,
  openingConfirmationFromFacts,
  openingFeeContexts,
  openingMissing,
  openingPeriodEndsNextDay,
  openingSentSummary,
  openingVersionRanOut,
  openingWaitsFromFacts,
  openingWeeklySchedule,
  runStoreOpening,
  sendOpeningBack,
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
  readonly gate?: "Effective" | "NotSet" | "OtherApprovers";
  readonly others?: readonly string[];
  /** Who else holds each approval, when it is not `others` for all three. */
  readonly approvers?: {
    readonly receiptTemplate: readonly string[];
    readonly storeSetup: readonly string[];
    readonly allergenList: readonly string[];
  };
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
    latestWithdrawal: undefined as
      undefined | { kind: "Withdrawn" | "Declined"; withdrawnAt: string; byYou: boolean },
    declines: [] as unknown[],
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
  const named = (names: readonly string[]) => names.map((displayName) => ({ displayName }));
  const approversNow = {
    receiptTemplate:
      options.approvers === undefined ? others : named(options.approvers.receiptTemplate),
    storeSetup: options.approvers === undefined ? others : named(options.approvers.storeSetup),
    allergenList: options.approvers === undefined ? others : named(options.approvers.allergenList),
  };
  const gateOf = (holders: readonly { displayName: string }[]) => ({
    status:
      options.gate !== undefined && options.approvers === undefined
        ? state.soleOperator === "On" && options.gate === "NotSet"
          ? ("Effective" as const)
          : options.gate
        : state.soleOperator !== "On"
          ? ("NotSet" as const)
          : holders.length > 0
            ? ("OtherApprovers" as const)
            : ("Effective" as const),
    otherApprovers: holders,
    verifiedUntil: null,
  });
  const gateNow = () =>
    options.approvers === undefined
      ? {
          ...gateOf(others),
          otherApprovers: options.gate === "OtherApprovers" ? others : [],
        }
      : gateOf(approversNow.storeSetup);
  const listGateNow = () =>
    options.approvers === undefined ? gateNow() : gateOf(approversNow.allergenList);
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
      ...(state.latestWithdrawal === undefined ? {} : { latestWithdrawal: state.latestWithdrawal }),
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
    soleOperator: listGateNow(),
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
        const held = state.latest;
        const open =
          held !== null &&
          state.latestWithdrawal === undefined &&
          ["Draft", "PendingApproval", "Approved"].includes(String(held.lifecycle));
        // As the server refuses: someone else's open change, and any step on a version run out.
        if (action === "Materialize" && open && held.authoredByReference !== scope.actorReference)
          throw new StoreSetupClientError("OpenChangeByAnother");
        if (
          action !== "Materialize" &&
          held !== null &&
          held.setupBasis !== undefined &&
          Date.parse(String(held.createdAt)) + 14 * 86400000 <= Date.now()
        )
          throw new StoreSetupClientError("Conflict");
        write(action + "Configuration");
        if (action === "Materialize") {
          const setup = state.setup;
          if (setup === null) throw new StoreSetupClientError("Conflict");
          const content = setup.content as Record<string, { state: string; value?: unknown }>;
          state.latestWithdrawal = undefined;
          state.latest = {
            ...firstConfiguration,
            createdAt: new Date().toISOString(),
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
    withdrawConfiguration: async (command: {
      configurationReference: string;
      auditReference: string;
    }) => {
      write("DeclineConfiguration");
      state.declines.push(command);
      state.latestWithdrawal = {
        kind: state.latest?.authoredByReference === scope.actorReference ? "Withdrawn" : "Declined",
        withdrawnAt: new Date(Date.now() - 1000).toISOString(),
        byYou: true,
      };
    },
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
    loadApprovers: async () => approversNow,
  } as unknown as StoreOpeningDeps;
  return { deps, state, writes, journals };
}
/** The ordinary button, deciding as the page does from what it read. */
async function press(
  w: World,
  overrides: Partial<StoreOpeningInput> = {},
  typed: { readonly details: OpeningDetails; readonly answers: OpeningAnswers } = {
    details,
    answers,
  },
) {
  const facts = await loadOpeningFacts(w.deps);
  return runStoreOpening(w.deps, {
    ...openingAnswersInput(
      facts,
      typed.details,
      typed.answers,
      openingConfirmationFromFacts(facts, typed.details, typed.answers),
    ),
    ...overrides,
  });
}
const pressAlone = (w: World, overrides: Partial<StoreOpeningInput> = {}) => press(w, overrides);
/** "Approve", as the page sends it from what it read. */
async function pressApprove(w: World) {
  return runStoreOpening(w.deps, openingApproveInput(await loadOpeningFacts(w.deps)));
}
/** Another Owner's work, as the server has it, for the waiting views. */
function sentByAnother(
  w: World,
  parts: { template?: boolean; proposal?: boolean; answers?: boolean },
) {
  if (parts.template === true) {
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
  }
  if (parts.proposal === true)
    w.state.proposal = { proposalReference: id(0x70), recordedByYou: false };
  if (parts.answers === true) {
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
    w.state.profile = {
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
      businessPhone: "+14165550100",
    };
  }
}
/** A Manager's hours change on the Store's first configuration, waiting: not from Store setup. */
const managerHoursChange = (w: World) => {
  w.state.latest = {
    ...firstConfiguration,
    configurationReference: id(0x77),
    configurationVersion: 2,
    lifecycle: "PendingApproval",
    reasonCode: "STORE_HOURS_UPDATE",
    authoredByReference: other,
    approvedByReference: null,
    createdAt: new Date().toISOString(),
  };
};
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
    const w = world({ taxReference: null });
    const facts = await loadOpeningFacts(w.deps);
    expect(openingMissing(facts.live, scope.actorReference)).toEqual(["TaxRates"]);
    // Asked of a lone Owner too: no tick, no code and no setting for what could not be published.
    const input = openingAnswersInput(facts, details, answers, null);
    expect(input.approveAlone).toBe(false);
    expect(input.turnOnSoleOperator).toBe(false);
    const outcome = await runStoreOpening(w.deps, input);
    expect(outcome).toEqual({ kind: "DetailsSaved", missing: ["TaxRates"] });
    // What the Owner typed is kept, and only that: BOP support needs the province from it.
    expect(w.writes).toEqual([
      "PublishProfile",
      "SaveAddress",
      "SaveContact",
      "SaveReceiptDetails",
      "SetUpKitchen",
      "SaveSetup",
    ]);
  });
  it("refuses to start from hours nobody answered", async () => {
    const w = world();
    const facts = await loadOpeningFacts(w.deps);
    const unanswered = { ...answers, hours: emptyOpeningHours() };
    const outcome = await runStoreOpening(
      w.deps,
      openingAnswersInput(facts, details, unanswered, null),
    );
    expect(outcome).toMatchObject({ kind: "Stopped", code: "HoursNotAnswered" });
    expect(w.writes).not.toContain("TurnOnSoleOperator");
    expect(w.state.setup?.content).toBeUndefined();
  });
  it("names the other approver and sends no self-approval", async () => {
    const w = world({ gate: "OtherApprovers", others: ["Mia"] });
    const outcome = await press(w);
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
    const after = openingWaitsFromFacts(await loadOpeningFacts(w.deps));
    expect(after.forOthers.map((wait) => wait.what)).toEqual(["ReceiptTemplate"]);
    expect(after.listForOthers?.who).toEqual([{ displayName: "Mia" }]);
  });
  it("a lone Owner never waits for nobody: they are asked for the tick", async () => {
    const w = world();
    const outcome = await press(w, { approveAlone: false, turnOnSoleOperator: false });
    expect(outcome).toEqual({ kind: "ConfirmAgain" });
    expect(w.writes).not.toContain("ApproveTemplate");
    // Someone who can't turn sole operator on is told it takes the brand owner, if a page they
    // read before the setting was theirs to change still asks for it.
    const notOwner = world({ noBrandOwner: true });
    expect(openingApprovalPlan(await loadOpeningFacts(notOwner.deps)).needsBrandOwner).toBe(true);
    expect(await press(notOwner, { approveAlone: true, turnOnSoleOperator: true })).toMatchObject({
      kind: "Stopped",
      code: "NotBrandOwner",
    });
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
    w.state.taxReference = null;
    await press(w);
    const first = w.state.address?.reference;
    expect(w.state.address?.revision).toBe(1);
    await press(w);
    expect(w.state.address?.reference).toBe(first);
    expect(w.writes.filter((name) => name === "SaveAddress")).toHaveLength(1);
    const corrected = { ...details, regionCode: "BC", locality: "Vancouver" };
    await press(w, {}, { details: corrected, answers });
    expect(w.state.address?.revision).toBe(2);
    expect((w.state.address?.content as { regionCode: string }).regionCode).toBe("BC");
    expect(
      (w.state.setup?.content as { addressReference: { value: string } }).addressReference.value,
    ).toBe(w.state.address?.reference);
  });
  it("a profile with no phone stops at the contact, named", async () => {
    const w = world({ profilePublished: true });
    const outcome = await press(w, {}, { details: { ...details, phone: "" }, answers });
    expect(outcome).toMatchObject({ kind: "Stopped", step: "StoreDetails", code: "NeedsPhone" });
    expect(w.writes).not.toContain("SaveContact");
  });
  it("whoever is waited for is told, and their press approves it and carries on", async () => {
    const w = world({
      approvers: { receiptTemplate: ["Mia"], storeSetup: ["Mia"], allergenList: ["Mia"] },
    });
    // Another Owner answered the page, wrote and sent the receipt, and recorded the allergen list.
    sentByAnother(w, { template: true, proposal: true, answers: true });
    const facts = await loadOpeningFacts(w.deps);
    expect(openingWaitsFromFacts(facts).forYou).toEqual(["ReceiptTemplate", "AllergenList"]);
    // Pressing the ordinary button approves nothing of someone else's.
    const held = await runStoreOpening(w.deps, {
      details: null,
      answers: null,
      confirmed: null,
      approveAlone: false,
      turnOnSoleOperator: false,
      approve: null,
      approvers: facts.approvers,
    });
    expect(held.kind).toBe("Waiting");
    expect(w.writes).toEqual(["SavePayment"]);
    // "Approve": independent approvals, never marked as given alone, then the rest of the run.
    const outcome = await pressApprove(w);
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
      turnOnSoleOperator: true,
      approve: null,
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

describe("WP-2423 item 14: who decides what, and what a press does about it", () => {
  const plan = async (w: World) => openingApprovalPlan(await loadOpeningFacts(w.deps));
  const spouse = { receiptTemplate: ["Mia"], storeSetup: ["Mia"], allergenList: [] };
  it("a lone Owner approves all three alone, and the press says it turns the setting on", async () => {
    expect(await plan(world())).toMatchObject({
      alone: ["ReceiptTemplate", "AllergenList", "StoreSetup"],
      others: [],
      approveAlone: true,
      turnsOnSoleOperator: true,
      publishes: true,
      allergenListLater: false,
    });
    // Already on: nothing about the setting to say, and nothing to change.
    expect(await plan(world({ gate: "Effective" }))).toMatchObject({
      approveAlone: true,
      turnsOnSoleOperator: false,
    });
  });
  it("a second Owner on the Store role: no tick, no code, and the Brand's setting is left alone", async () => {
    // What the real read answers: Brand-level holders exclude Store roles, so the list names nobody.
    const w = world({ approvers: spouse });
    const shape = await plan(w);
    expect(shape).toMatchObject({
      alone: [],
      approveAlone: false,
      turnsOnSoleOperator: false,
      publishes: false,
      allergenListLater: true,
    });
    expect(shape.others.map((wait) => wait.what)).toEqual(["ReceiptTemplate", "StoreSetup"]);
    const outcome = await press(w);
    expect(outcome.kind).toBe("Waiting");
    expect((outcome as { waits: readonly OpeningWait[] }).waits).toEqual([
      { what: "ReceiptTemplate", who: [{ displayName: "Mia" }] },
    ]);
    // Sent for Mia; the setting untouched; the list neither recorded nor marked as approved alone.
    expect(w.state.soleOperator).toBe("Off");
    expect(w.writes).not.toContain("TurnOnSoleOperator");
    expect(w.writes).not.toContain("RecordRegistry");
    expect(w.writes).not.toContain("ApproveRegistry");
    expect(w.state.templateApprovals).toEqual([]);
    // Pressing again leaves it the same, with nothing written twice.
    const before = w.writes.length;
    expect((await press(w)).kind).toBe("Waiting");
    expect(w.writes).toHaveLength(before);
  });
  it("the same pair at a Brand that has a list: nothing is asked and nothing is said about it", async () => {
    const w = world({ approvers: spouse });
    w.state.registry = { entries: [] };
    expect(await plan(w)).toMatchObject({
      alone: [],
      approveAlone: false,
      turnsOnSoleOperator: false,
      allergenListLater: false,
    });
    await press(w);
    expect(w.writes).not.toContain("TurnOnSoleOperator");
  });
  it("the same pair with the setting already on: only the list is theirs alone, with the setting unchanged", async () => {
    const w = world({ approvers: spouse });
    w.state.soleOperator = "On";
    expect(await plan(w)).toMatchObject({
      alone: ["AllergenList"],
      approveAlone: true,
      turnsOnSoleOperator: false,
      publishes: false,
    });
    const outcome = await press(w);
    expect(outcome.kind).toBe("Waiting");
    expect(w.state.allergenApprovals).toEqual(["SoleOperator"]);
    expect(w.state.templateApprovals).toEqual([]);
    expect(w.writes).not.toContain("TurnOnSoleOperator");
  });
  it("an Owner and a Menu Manager: the Store can't publish without it, so the press asks in full", async () => {
    const w = world({ approvers: { receiptTemplate: [], storeSetup: [], allergenList: ["Noah"] } });
    const shape = await plan(w);
    expect(shape).toMatchObject({
      alone: ["ReceiptTemplate", "StoreSetup"],
      approveAlone: true,
      turnsOnSoleOperator: true,
      publishes: true,
    });
    expect(shape.others).toEqual([{ what: "AllergenList", who: [{ displayName: "Noah" }] }]);
    const outcome = await press(w);
    expect(outcome).toEqual({
      kind: "Published",
      waits: [{ what: "AllergenList", who: [{ displayName: "Noah" }] }],
    });
    expect(w.state.soleOperator).toBe("On");
    expect(w.state.allergenApprovals).toEqual([]);
    expect(w.state.proposal?.recordedByYou).toBe(true);
    const after = openingWaitsFromFacts(await loadOpeningFacts(w.deps));
    expect(after.forOthers).toEqual([]);
  });
  it("a list the Brand already has is never counted as this Owner's alone", async () => {
    const lone = world();
    lone.state.registry = { entries: [] };
    expect((await plan(lone)).alone).toEqual(["ReceiptTemplate", "StoreSetup"]);
  });
  it("what is left waiting on the list never stands in the way of the store", async () => {
    // A press that stopped at the store setup, with the list recorded and waiting for Noah.
    const w = world({
      approvers: { receiptTemplate: [], storeSetup: [], allergenList: ["Noah"] },
      failOnce: new Set(["SubmitConfiguration"]),
    });
    expect(await press(w)).toMatchObject({ kind: "Stopped", step: "StoreSetup" });
    const waits = openingWaitsFromFacts(await loadOpeningFacts(w.deps));
    expect(waits.forOthers).toEqual([]);
    expect(waits.listForOthers?.who).toEqual([{ displayName: "Noah" }]);
    expect((await press(w)).kind).toBe("Published");
  });
});

describe("WP-2423 item 14: Approve acts only on what it names", () => {
  const twoOwners = { receiptTemplate: ["Mia"], storeSetup: ["Mia"], allergenList: ["Mia"] };
  it("approves first, whatever BOP support still has to do, and writes nothing of the presser's", async () => {
    const w = world({ taxReference: null, approvers: twoOwners });
    sentByAnother(w, { template: true, proposal: true, answers: true });
    expect(await pressApprove(w)).toEqual({ kind: "DetailsSaved", missing: ["TaxRates"] });
    expect(w.writes).toEqual(["ApproveTemplate", "PublishTemplate", "ApproveRegistry"]);
    expect(w.state.templateApprovals).toEqual([undefined]);
    expect(w.state.allergenApprovals).toEqual([undefined]);
  });
  it("a Store whose next approval is this person's alone goes back to the page, for the tick", async () => {
    const w = world({ approvers: { receiptTemplate: [], storeSetup: [], allergenList: [] } });
    sentByAnother(w, { template: true, answers: true });
    const input = openingApproveInput(await loadOpeningFacts(w.deps));
    expect(input.approve).toMatchObject({ gates: ["ReceiptTemplate"], carryOn: false });
    expect(await runStoreOpening(w.deps, input)).toEqual({ kind: "Waiting", waits: [] });
    expect(w.writes).toEqual(["ApproveTemplate", "PublishTemplate"]);
  });
  it("what was changed after it was read is shown first, never approved unseen", async () => {
    const w = world({ approvers: twoOwners });
    sentByAnother(w, { answers: true });
    w.state.latest = {
      ...firstConfiguration,
      configurationReference: id(0x78),
      configurationVersion: 2,
      lifecycle: "PendingApproval",
      reasonCode: "STORE_SETUP_MATERIALIZATION",
      authoredByReference: other,
      approvedByReference: null,
      createdAt: new Date().toISOString(),
      setupBasis: {
        setupDraftReference: id(0x30),
        sourceRevision: 1,
        feeContexts: [{ chargeType: "ServiceCharge", state: "Disabled" }],
      },
    };
    const facts = await loadOpeningFacts(w.deps);
    expect(openingWaitsFromFacts(facts).forYou).toEqual(["StoreSetup"]);
    const input = openingApproveInput(facts);
    expect(input.approve?.configuration).toBe(id(0x78));
    w.state.latest = { ...w.state.latest, configurationReference: id(0x79) };
    expect(await runStoreOpening(w.deps, input)).toEqual({ kind: "ConfirmAgain" });
    expect(w.writes).toEqual([]);
    // Read again, it is approved and published: the last press of a two-Owner opening.
    expect(await pressApprove(w)).toEqual({ kind: "Published", waits: [] });
    expect(w.writes).toEqual(["ApproveConfiguration", "PublishConfiguration"]);
    expect(w.state.configurationApprovals).toEqual([undefined]);
  });
  it("nothing answered yet: nothing is approved here, and the form stays, whoever recorded what", async () => {
    for (const taxReference of [id(25), null]) {
      const w = world({ taxReference });
      sentByAnother(w, { proposal: true });
      const facts = await loadOpeningFacts(w.deps);
      const waits = openingWaitsFromFacts(facts);
      expect(waits.forYou).toEqual([]);
      expect(waits.forOthers).toEqual([]);
      expect(waits.listForYou).toBe(true);
      // The list is decided on Allergens; nothing about it is pressed or marked from the form.
      const outcome = await press(w);
      expect(w.writes).not.toContain("ApproveRegistry");
      expect(w.writes).not.toContain("RecordRegistry");
      if (taxReference === null) {
        expect(outcome).toEqual({ kind: "DetailsSaved", missing: ["TaxRates"] });
        expect(w.writes).not.toContain("SavePayment");
      } else
        expect(outcome).toEqual({
          kind: "Published",
          waits: [{ what: "AllergenList", who: [] }],
        });
    }
    // A receipt someone sent before anyone answered: answer first, then it is approved here.
    const w = world({ approvers: twoOwners });
    sentByAnother(w, { template: true });
    const before = await loadOpeningFacts(w.deps);
    expect(openingSentSummary(before)).toBeNull();
    expect(openingWaitsFromFacts(before)).toMatchObject({
      forYou: [],
      beforeAnswers: ["ReceiptTemplate"],
    });
    expect((await press(w)).kind).toBe("Waiting");
    expect(w.writes).not.toContain("ApproveTemplate");
    const after = await loadOpeningFacts(w.deps);
    expect(openingSentSummary(after)).not.toBeNull();
    expect(openingWaitsFromFacts(after).forYou).toEqual(["ReceiptTemplate"]);
  });
  it("a Manager's hours change is named, not approved here, and stops the press before anything is sent", async () => {
    for (const taxReference of [id(25), null]) {
      const w = world({ taxReference });
      managerHoursChange(w);
      const facts = await loadOpeningFacts(w.deps);
      const waits = openingWaitsFromFacts(facts);
      expect(waits.forYou).toEqual([]);
      expect(waits.forOthers).toEqual([]);
      expect(openingMissing(facts.live, scope.actorReference)).toEqual(
        taxReference === null ? ["TaxRates", "OtherChange"] : ["OtherChange"],
      );
      const input = openingAnswersInput(facts, details, answers, null);
      expect(input.approveAlone).toBe(false);
      expect(await runStoreOpening(w.deps, input)).toEqual({
        kind: "DetailsSaved",
        missing: taxReference === null ? ["TaxRates", "OtherChange"] : ["OtherChange"],
      });
      // What they typed is kept; no payment rule, receipt or approval in their name.
      expect(w.writes).toEqual([
        "PublishProfile",
        "SaveAddress",
        "SaveContact",
        "SaveReceiptDetails",
        "SetUpKitchen",
        "SaveSetup",
      ]);
      expect(w.writes).not.toContain("TurnOnSoleOperator");
    }
  });
  it("the approver sends it back: declined, and the answers open again", async () => {
    const w = world({ approvers: twoOwners });
    sentByAnother(w, { answers: true });
    w.state.latest = {
      ...firstConfiguration,
      configurationReference: id(0x78),
      configurationVersion: 2,
      lifecycle: "PendingApproval",
      reasonCode: "STORE_SETUP_MATERIALIZATION",
      authoredByReference: other,
      approvedByReference: null,
      createdAt: new Date().toISOString(),
      setupBasis: {
        setupDraftReference: id(0x30),
        sourceRevision: 1,
        feeContexts: [{ chargeType: "ServiceCharge", state: "Disabled" }],
      },
    };
    await sendOpeningBack(w.deps);
    expect(w.writes).toEqual(["DeclineConfiguration"]);
    expect(w.state.declines).toEqual([
      expect.objectContaining({ configurationReference: id(0x78), declineReason: "NotRight" }),
    ]);
    const waits = openingWaitsFromFacts(await loadOpeningFacts(w.deps));
    expect(waits.forYou).toEqual([]);
    expect(waits.forOthers).toEqual([]);
  });
  it("the page says sent back to whoever made it", async () => {
    const w = world({ approvers: twoOwners });
    sentByAnother(w, { answers: true });
    w.state.latest = {
      ...firstConfiguration,
      configurationReference: id(0x78),
      configurationVersion: 2,
      lifecycle: "PendingApproval",
      authoredByReference: scope.actorReference,
      approvedByReference: null,
      createdAt: new Date().toISOString(),
      setupBasis: {
        setupDraftReference: id(0x30),
        sourceRevision: 1,
        feeContexts: [{ chargeType: "ServiceCharge", state: "Disabled" }],
      },
    };
    w.state.latestWithdrawal = {
      kind: "Declined",
      withdrawnAt: new Date(Date.now() - 1000).toISOString(),
      byYou: false,
    };
    const waits = openingWaitsFromFacts(await loadOpeningFacts(w.deps));
    expect(waits).toMatchObject({ sentBack: true, forOthers: [], forYou: [] });
  });
});

describe("WP-2423 item 14: a page left open", () => {
  it("a press after the Store is published writes nothing, and says so", async () => {
    const w = world();
    expect((await pressAlone(w)).kind).toBe("Published");
    const written = [...w.writes];
    const live = w.state.current;
    const profile = w.state.profile;
    const later = {
      ...answers,
      hours: { ...answers.hours, everyDay: [{ start: "09:00", end: "22:00" }] },
      offerTips: false,
    };
    const stale = await runStoreOpening(w.deps, {
      details: { ...details, phone: "(416) 555-0199", businessName: "Another Name Inc." },
      answers: later,
      confirmed: null,
      approveAlone: true,
      turnOnSoleOperator: true,
      approve: null,
      approvers: { receiptTemplate: [], storeSetup: [], allergenList: [] },
    });
    expect(stale).toEqual({ kind: "AlreadyPublished" });
    expect(w.writes).toEqual(written);
    expect(w.state.current).toBe(live);
    expect(w.state.profile).toBe(profile);
    expect(w.state.tips.enabled).toBe(true);
  });
  it("an original still pending when it is already published is settled, not left behind", async () => {
    const w = world();
    await pressAlone(w);
    const journal = w.journals.configuration as ReturnType<typeof memoryJournal>;
    await journal.reserve({ kind: "configuration", action: "Publish", scope });
    await expect(pressAlone(w)).resolves.toEqual({ kind: "AlreadyPublished" });
    expect(journal.pending).toBeNull();
  });
  it("what was typed is not what stands once it is published, so the read knows too", async () => {
    const w = world();
    await pressAlone(w);
    const facts = await loadOpeningFacts(w.deps);
    expect(facts.live.current?.setupBasis).toBeDefined();
  });
  it("a version past its 14 days is not waited on: the owner's is made again and asked again", async () => {
    const w = world({ failOnce: new Set(["ApproveConfiguration"]) });
    expect((await pressAlone(w)).kind).toBe("Stopped");
    if (w.state.latest === null) throw new Error("expected a version");
    const first = w.state.latest.configurationReference;
    w.state.latest = {
      ...w.state.latest,
      createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
    };
    const facts = await loadOpeningFacts(w.deps);
    expect(openingVersionRanOut(w.state.latest as never, facts.live.observedAt)).toBe(true);
    expect(openingWaitsFromFacts(facts)).toMatchObject({ ranOut: true, forOthers: [], forYou: [] });
    // Made again from the saved setup, compared and approved again; never the old one.
    expect(await pressAlone(w)).toEqual({ kind: "Published", waits: [] });
    expect(w.state.current.configurationReference).not.toBe(first);
    expect(w.state.configurationApprovals).toEqual(["SoleOperator"]);
    expect(w.writes.filter((name) => name === "MaterializeConfiguration")).toHaveLength(2);
    expect(w.writes.filter((name) => name === "DeclineConfiguration")).toHaveLength(0);
  });
  it("someone else's past its 14 days is declined first, and the second person still approves", async () => {
    const w = world({
      approvers: { receiptTemplate: ["Mia"], storeSetup: ["Mia"], allergenList: ["Mia"] },
    });
    w.state.registry = { entries: [] };
    expect((await press(w)).kind).toBe("Waiting");
    // Mia approved the receipt; her version waited for this Owner, past its 14 days.
    w.state.review = {
      ...(w.state.review as NonNullable<typeof w.state.review>),
      state: "Published",
    };
    w.state.latest = {
      ...firstConfiguration,
      configurationReference: id(0x78),
      configurationVersion: 2,
      lifecycle: "PendingApproval",
      reasonCode: "STORE_SETUP_MATERIALIZATION",
      authoredByReference: other,
      approvedByReference: null,
      createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
      setupBasis: {
        setupDraftReference: id(0x30),
        sourceRevision: 99,
        feeContexts: [{ chargeType: "ServiceCharge", state: "Disabled" }],
      },
    };
    const facts = await loadOpeningFacts(w.deps);
    expect(openingWaitsFromFacts(facts)).toMatchObject({ ranOut: true, forYou: [] });
    const outcome = await press(w);
    expect(w.writes).toContain("DeclineConfiguration");
    expect(w.state.declines).toEqual([
      expect.not.objectContaining({ declineReason: expect.anything() }),
    ]);
    expect(outcome.kind).toBe("Waiting");
    expect((outcome as { waits: readonly OpeningWait[] }).waits).toEqual([
      { what: "StoreSetup", who: [{ displayName: "Mia" }] },
    ]);
    expect(w.writes).not.toContain("ApproveConfiguration");
  });
});

describe("WP-2423 item 14: what is approved is said in full", () => {
  it("the summary of what was sent reads the version waiting, when one is", async () => {
    const w = world({
      approvers: { receiptTemplate: ["Mia"], storeSetup: ["Mia"], allergenList: ["Mia"] },
    });
    sentByAnother(w, { answers: true });
    const answered = openingSentSummary(await loadOpeningFacts(w.deps));
    expect(answered?.weeklySchedule).toEqual(openingWeeklySchedule(answers));
    expect(answered?.name).toBe("Maple Noodle House");
    // The version waiting is what is being approved, whatever the draft says since.
    const other24 = openingWeeklySchedule({
      ...answers,
      hours: { ...answers.hours, everyDay: [{ start: "09:00", end: "22:00" }] },
    });
    w.state.latest = {
      ...firstConfiguration,
      configurationReference: id(0x78),
      configurationVersion: 2,
      lifecycle: "PendingApproval",
      enabledServiceModes: ["Pickup"],
      weeklySchedule: other24,
      authoredByReference: other,
      approvedByReference: null,
      createdAt: new Date().toISOString(),
      setupBasis: {
        setupDraftReference: id(0x30),
        sourceRevision: 1,
        feeContexts: [{ chargeType: "ServiceCharge", state: "Disabled" }],
      },
    };
    const sent = openingSentSummary(await loadOpeningFacts(w.deps));
    expect(sent?.weeklySchedule).toEqual(other24);
    expect(sent?.serviceModes).toEqual(["Pickup"]);
  });
  it("a Store whose configuration can't be read at all fails the read, and says so", async () => {
    const w = world();
    (w.deps.configuration as unknown as { load: () => Promise<unknown> }).load = async () => ({
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest: null,
      current: null,
      original: null,
      ...window5s(),
    });
    await expect(loadOpeningFacts(w.deps)).rejects.toMatchObject({ code: "Unavailable" });
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
