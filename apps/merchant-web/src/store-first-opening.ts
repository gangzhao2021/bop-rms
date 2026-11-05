import {
  createAllergenClient,
  AllergenPageError,
  parseAllergenListView,
  type AllergenClient,
  type AllergenCommand,
  type AllergenListView,
} from "./allergen-declaration-pages.js";
import { FULL_SIGN_IN_REQUIRED } from "./full-sign-in.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  createReceiptTemplateArtifactClient,
  type ReceiptTemplateArtifactKind,
} from "./receipt-template-artifact-client.js";
import {
  createReceiptTemplateArtifactPendingJournal,
  type ReceiptTemplateArtifactPendingJournal,
} from "./receipt-template-artifact-pending-journal.js";
import {
  createReceiptTemplateDraftClient,
  parseReceiptTemplateDraftFields,
  type ReceiptTemplateDraftCurrent,
  type ReceiptTemplateDraftFields,
} from "./receipt-template-draft-client.js";
import {
  createReceiptTemplateDraftPendingJournal,
  type ReceiptTemplateDraftPendingJournal,
} from "./receipt-template-draft-pending-journal.js";
import {
  createReceiptTemplateLifecycleClient,
  loadReceiptTemplateSoleOperatorGate,
} from "./receipt-template-lifecycle-client.js";
import {
  createReceiptTemplateLifecyclePendingJournal,
  type ReceiptTemplateLifecyclePendingJournal,
} from "./receipt-template-lifecycle-pending-journal.js";
import { createReceiptTemplatePublishedClient } from "./receipt-template-published-client.js";
import {
  createReceiptTemplateSubmitClient,
  type ReceiptTemplateReviewCurrent,
} from "./receipt-template-submit-client.js";
import {
  createReceiptTemplateSubmitPendingJournal,
  type ReceiptTemplateSubmitPendingJournal,
} from "./receipt-template-submit-pending-journal.js";
import {
  dispatchReceiptTemplateArtifact,
  recoverReceiptTemplateArtifact,
} from "./ReceiptTemplateArtifactEditor.js";
import {
  advanceReceiptTemplateLifecycle,
  finishReceiptTemplateDraftOriginal,
  finishReceiptTemplateLifecycleOriginal,
  finishReceiptTemplateSubmitOriginal,
  saveReceiptTemplateDraft,
  submitReceiptTemplateDraft,
} from "./ReceiptTemplateDraftEditor.js";
import { applyReceiptTemplateStoreSelection } from "./ReceiptTemplateStoreSelection.js";
import { serviceOperationReference, type ServiceMode } from "./service-control-client.js";
import type { SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";
import {
  createSoleOperatorClient,
  SoleOperatorClientError,
  type SoleOperatorView,
} from "./sole-operator-client.js";
import {
  withdrawStoreConfiguration,
  type StoreConfigurationDeclineReason,
  type StoreConfigurationSnapshot,
} from "./store-configuration-client.js";
import { createStoreConfigurationOrdinaryClient } from "./store-configuration-ordinary-client.js";
import {
  createStoreConfigurationPendingJournal,
  type StoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationPendingJournal,
  type StoreConfigurationPublicationCheckCode,
} from "./store-configuration-pending-journal.js";
import {
  buildStoreConfigurationCommand,
  executeStoreConfigurationOriginal,
  publicationWindowMs,
  recoverStoreConfigurationOriginal,
  storeSetupCreatedFromSaved,
} from "./StoreConfigurationOrdinaryPanel.js";
import {
  createStoreFeaturesClient,
  StoreFeaturesClientError,
  type StoreFeatures,
} from "./store-features-client.js";
import {
  createStoreKitchenSetupClient,
  StoreKitchenSetupClientError,
  type StoreKitchenSetupView,
} from "./store-kitchen-setup-client.js";
import {
  createStorePaymentConfigurationClient,
  type StorePaymentConfigurationContent,
  type StorePaymentConfigurationCurrent,
} from "./store-payment-configuration-client.js";
import {
  createStorePaymentConfigurationPendingJournal,
  type StorePaymentConfigurationPendingJournal,
} from "./store-payment-configuration-pending-journal.js";
import {
  createStorePublicProfileClient,
  StorePublicProfileClientError,
  type StorePublicProfileCurrent,
  type StorePublicProfileView,
} from "./store-public-profile-client.js";
import {
  createStoreReceiptProfileClient,
  StoreReceiptProfileClientError,
  type StoreReceiptProfileView,
} from "./store-receipt-profile-client.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  normalizeStoreSetupContentV2,
  parseStoreSetupContent,
  StoreSetupClientError,
  type StoreSetupContent,
  type StoreSetupFeeContext,
  type StoreSetupScope,
  type StoreSetupSnapshot,
  type StoreSetupWorkspace,
} from "./store-setup-client.js";
import {
  createStoreSetupPendingJournal,
  type StoreSetupPendingJournal,
} from "./store-setup-pending-journal.js";
import {
  createStoreSetupReferenceClient,
  type StoreSetupBusinessAddress,
  type StoreSetupBusinessContact,
  type StoreSetupReferenceKind,
  type StoreSetupReferencesCurrent,
} from "./store-setup-reference-client.js";
import {
  createStoreSetupReferencePendingJournal,
  type StoreSetupReferencePendingJournal,
} from "./store-setup-reference-pending-journal.js";
import {
  dispatchStorePaymentConfiguration,
  dispatchStoreSetupDraft,
  dispatchStoreSetupReference,
  firstOpeningFill,
  recoverStorePaymentConfiguration,
  recoverStoreSetupDraft,
  recoverStoreSetupReference,
  type StoreSetupLiveConfiguration,
} from "./StoreSetupDraftPage.js";

/**
 * WP-2423 item 14 (DEC-STORE-FIRST-OPENING): a first Store gets one page and one action. The press
 * runs what Store setup asks of an established Store, in order, through the same exported, tested
 * functions and the same commands: same permission, version, second-factor window, sole-operator
 * check, append-only record and audit. Every step first recovers its own pending original, then reads
 * the server, and does nothing if what it would do already holds, so pressing again after any stop,
 * on any device, finishes the job and writes nothing twice. A browser run rather than a server one:
 * these commands take prepared cursors, intent digests and journals built for outcome recovery.
 *
 * The store type step (a store type choice and optional feature templates, designed separately)
 * belongs before the answers: it presets `OpeningAnswers`, and this run then works from them as it
 * does from typed ones.
 */
export type OpeningServiceMode = Extract<ServiceMode, "DineIn" | "Pickup">;
export interface OpeningPeriod {
  /** "HH:MM" (with seconds only if a saved record has some). */
  readonly start: string;
  readonly end: string;
}
export interface OpeningDay {
  readonly open: boolean;
  /** One or two opening periods, when the hours differ by day. */
  readonly periods: readonly OpeningPeriod[];
}
export interface OpeningHours {
  /** The same one or two periods on every open day (`everyDay`); otherwise each day's own. */
  readonly sameEveryDay: boolean;
  readonly everyDay: readonly OpeningPeriod[];
  /** Monday first; always seven. */
  readonly days: readonly OpeningDay[];
  /** Whole minutes as typed. */
  readonly lastOrdersMinutes: string;
  readonly preparationMinutes: string;
}
export interface OpeningAnswers {
  readonly serviceModes: readonly OpeningServiceMode[];
  readonly hours: OpeningHours;
  readonly offerTips: boolean;
}
/** Name, address and phone customers see, and what receipts name; as the Owner typed them. */
export interface OpeningDetails {
  readonly names: Readonly<Record<string, string>>;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly businessName: string;
  readonly gstHstNumber: string;
  readonly qstNumber: string;
  readonly pstNumber: string;
}
type WeeklySchedule = StoreConfigurationSnapshot["weeklySchedule"];

export const openingWeekdays = 7;
const waitLimitMinutes = 1440;
const clockSeconds = (value: string) => {
  const [hours = "0", minutes = "0", seconds = "0"] = value.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
};
const fullTime = (value: string) => (/^\d{2}:\d{2}$/u.test(value) ? value + ":00" : value);
const wholeMinutes = (value: string) =>
  /^\d{1,4}$/u.test(value.trim()) && Number(value) <= waitLimitMinutes;
const periodsOf = (hours: OpeningHours, day: OpeningDay) =>
  hours.sameEveryDay ? hours.everyDay : day.periods;
/** The Store's service modes in the one order every record keeps. */
const inOrder = <T extends ServiceMode>(modes: readonly T[]): readonly T[] =>
  Object.freeze(
    (["DineIn", "Pickup", "Delivery"] as const).filter((mode) => modes.includes(mode as T)) as T[],
  );
/** An opening period ending at or before it starts runs into the next day (17:00–00:00). */
export const openingPeriodEndsNextDay = (period: OpeningPeriod) =>
  clockSeconds(period.end) <= clockSeconds(period.start);

export type OpeningHoursProblem =
  | "NoServiceMode"
  | "NoOpenDay"
  | "TimeMissing"
  | "SameTimes"
  | "PeriodsOverlap"
  | "LastOrders"
  | "Preparation";
/** What still stands in the way of these answers, in the order the page asks them. */
export function openingAnswerProblems(answers: OpeningAnswers): readonly OpeningHoursProblem[] {
  const problems = new Set<OpeningHoursProblem>();
  const hours = answers.hours;
  if (answers.serviceModes.length === 0) problems.add("NoServiceMode");
  const open = hours.days.filter((day) => day.open);
  if (open.length === 0) problems.add("NoOpenDay");
  for (const day of open) {
    const periods = periodsOf(hours, day);
    if (periods.length === 0) problems.add("TimeMissing");
    for (const period of periods) {
      if (period.start === "" || period.end === "") problems.add("TimeMissing");
      else if (clockSeconds(period.start) === clockSeconds(period.end)) problems.add("SameTimes");
    }
    if (periods.every((period) => period.start !== "" && period.end !== "")) {
      const ordered = periods.toSorted((a, b) => clockSeconds(a.start) - clockSeconds(b.start));
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1],
          current = ordered[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          (openingPeriodEndsNextDay(previous) ||
            clockSeconds(previous.end) > clockSeconds(current.start))
        )
          problems.add("PeriodsOverlap");
      }
    }
  }
  if (!wholeMinutes(hours.lastOrdersMinutes)) problems.add("LastOrders");
  if (!wholeMinutes(hours.preparationMinutes)) problems.add("Preparation");
  return Object.freeze([...problems]);
}
/** The weekly schedule these answers publish. */
export function openingWeeklySchedule(
  answers: Pick<OpeningAnswers, "serviceModes" | "hours">,
): WeeklySchedule {
  const { hours } = answers;
  const serviceModes = inOrder(answers.serviceModes);
  return Object.freeze(
    hours.days.map((day, index) => ({
      isoWeekday: index + 1,
      intervals: Object.freeze(
        !day.open
          ? []
          : periodsOf(hours, day)
              .map((period) => ({
                startLocalTime: fullTime(period.start),
                endLocalTime: fullTime(period.end),
                endsNextDay: openingPeriodEndsNextDay(period),
                serviceModes,
                orderCutoffSeconds: Number(hours.lastOrdersMinutes) * 60,
                leadTimeSeconds: Number(hours.preparationMinutes) * 60,
              }))
              .toSorted((a, b) => clockSeconds(a.startLocalTime) - clockSeconds(b.startLocalTime)),
      ),
    })),
  );
}
export const emptyOpeningHours = (): OpeningHours => ({
  sameEveryDay: true,
  everyDay: [{ start: "", end: "" }],
  days: Array.from({ length: openingWeekdays }, () => ({
    open: true,
    periods: [{ start: "", end: "" }],
  })),
  lastOrdersMinutes: "",
  preparationMinutes: "",
});
/** The answers a schedule says, or null when one set of answers can't say it. */
function answersOfSchedule(
  schedule: WeeklySchedule,
  modes: readonly ServiceMode[],
): Pick<OpeningAnswers, "serviceModes" | "hours"> | null {
  if (schedule.length !== openingWeekdays || modes.includes("Delivery")) return null;
  const intervals = schedule.flatMap((day) => day.intervals);
  const first = intervals[0];
  if (
    first === undefined ||
    intervals.some(
      (interval) =>
        canonical(interval.serviceModes) !== canonical(modes) ||
        interval.orderCutoffSeconds !== first.orderCutoffSeconds ||
        interval.leadTimeSeconds !== first.leadTimeSeconds,
    ) ||
    first.orderCutoffSeconds % 60 !== 0 ||
    first.leadTimeSeconds % 60 !== 0 ||
    schedule.some((day) => day.intervals.length > 2)
  )
    return null;
  // As a time field shows them: seconds, always 00 here, would put a third box in it.
  const shown = (value: string) => (value.endsWith(":00") ? value.slice(0, 5) : value);
  const times = (day: WeeklySchedule[number]) =>
    day.intervals.map((interval) => ({
      start: shown(interval.startLocalTime),
      end: shown(interval.endLocalTime),
    }));
  const open = schedule.filter((day) => day.intervals.length > 0);
  const firstOpen = open[0];
  const sameEveryDay =
    firstOpen !== undefined &&
    open.every((day) => canonical(times(day)) === canonical(times(firstOpen)));
  return {
    serviceModes: modes as readonly OpeningServiceMode[],
    hours: {
      sameEveryDay,
      everyDay: firstOpen === undefined ? [{ start: "", end: "" }] : times(firstOpen),
      days: schedule.map((day) => ({
        open: day.intervals.length > 0,
        periods: day.intervals.length > 0 ? times(day) : [{ start: "", end: "" }],
      })),
      lastOrdersMinutes: String(first.orderCutoffSeconds / 60),
      preparationMinutes: String(first.leadTimeSeconds / 60),
    },
  };
}
/**
 * The Owner's own earlier hours, to fill the page: from their saved setup, or an hours change they
 * published. Never the configuration the Store started with: a TEST Store's reads 24 hours with
 * pickup on, and an Owner who reads past it would take paid orders for a dark kitchen. Null: the page
 * asks.
 */
export function openingAnswersFromRecords(
  content: StoreSetupContent,
  current: StoreConfigurationSnapshot | null,
): Pick<OpeningAnswers, "serviceModes" | "hours"> | null {
  const ownHoursChange = current !== null && current.reasonCode === "STORE_HOURS_UPDATE";
  if (
    content.weeklySchedule.state === "Configured" &&
    content.enabledServiceModes.state === "Configured"
  ) {
    // "Use the live Store's settings" in the wizard copies the starting schedule into the setup.
    const copied =
      current !== null &&
      !ownHoursChange &&
      canonical(content.weeklySchedule.value) === canonical(current.weeklySchedule);
    if (!copied)
      return answersOfSchedule(content.weeklySchedule.value, content.enabledServiceModes.value);
  }
  return ownHoursChange
    ? answersOfSchedule(current.weeklySchedule, current.enabledServiceModes)
    : null;
}

/** Owner decision 11 (DEC-STORE-FEATURES): tips stay on; whether guests are asked is the Store
 * features switch, which works at once. Service charge and delivery fee are Off unless the Owner
 * set one in the wizard; a fee keeps only the service modes this Store offers. */
export function openingFeeContexts(
  content: StoreSetupContent,
  serviceModes: readonly ServiceMode[],
): readonly StoreSetupFeeContext[] {
  const saved = content.feeContexts?.state === "Configured" ? content.feeContexts.value : [];
  const charge = (chargeType: "ServiceCharge" | "DeliveryFee"): StoreSetupFeeContext => {
    const entry = saved.find((fee) => fee.chargeType === chargeType);
    const orderTypes =
      entry?.state === "Enabled"
        ? entry.orderTypes.filter((mode) => serviceModes.includes(mode))
        : [];
    return entry?.state === "Enabled" && orderTypes.length > 0
      ? { ...entry, orderTypes }
      : { chargeType, state: "Disabled" };
  };
  const tip = saved.find((fee) => fee.chargeType === "Tip");
  return Object.freeze([
    charge("ServiceCharge"),
    charge("DeliveryFee"),
    {
      chargeType: "Tip",
      state: "Enabled",
      taxClassificationReference: tip?.state === "Enabled" ? tip.taxClassificationReference : null,
      orderTypes: inOrder(serviceModes),
    },
  ]);
}
/** All three on, saved as rules: card payments still need the Provider account behind them. */
export const openingPaymentChannels: StorePaymentConfigurationContent = Object.freeze({
  customerOnlineCardEnabled: true,
  staffTerminalCardPresentEnabled: true,
  staffTerminalInteracEnabled: true,
});
/** The address and contact Store setup records, from what customers are shown. */
export function openingAddressOf(current: StorePublicProfileCurrent): StoreSetupBusinessAddress {
  return Object.freeze({
    countryCode: current.address.countryCode,
    regionCode: current.address.regionCode,
    locality: current.address.locality,
    postalCode: current.address.postalCode,
    addressLines: current.address.addressLines,
  });
}
const defaultName = (current: StorePublicProfileCurrent) =>
  (current.names.find((entry) => entry.locale === current.defaultLocale) ?? current.names[0])
    ?.storeDisplayName ?? "";
export function openingContactOf(
  current: StorePublicProfileCurrent,
  website: string | null,
): StoreSetupBusinessContact | null {
  return current.businessPhone === null
    ? null
    : Object.freeze({
        contactName: defaultName(current),
        businessPhone: current.businessPhone,
        website,
      });
}
/** The forms the server keeps these in (DEC-STORE-CUSTOMER-NAME), to compare what was typed. */
const textKey = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const postalKey = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, "");
const phoneKey = (value: string) => value.replace(/[^0-9]/gu, "").slice(-10);

/**
 * WP-2423 item 14: what the Owner ticks, in full: everything the opening publishes in their name.
 * Computed from the page before anything is written, and again from the server's records before the
 * approval: if they differ, the run stops before approving and asks for the tick again.
 */
export interface OpeningConfirmation {
  readonly name: string;
  readonly address: {
    readonly lines: readonly string[];
    readonly locality: string;
    readonly regionCode: string;
    readonly postalCode: string;
  };
  readonly phone: string;
  readonly timeZone: string;
  readonly businessDayStart: string;
  readonly serviceModes: readonly ServiceMode[];
  readonly weeklySchedule: WeeklySchedule;
  readonly exceptions: StoreConfigurationSnapshot["exceptions"];
  readonly fees: readonly StoreSetupFeeContext[];
  readonly capacity: string | null;
  readonly taxConfiguration: string;
  readonly payment: StorePaymentConfigurationContent;
  readonly receiptLocale: string;
  /** The allergen list's codes, or null when the Brand already has one. */
  readonly allergens: readonly string[] | null;
}
export function openingConfirmation(input: {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
  readonly phone: string;
  /** The setup as it will be saved: the Owner's answers and `firstOpeningFill` over the draft. */
  readonly filled: StoreSetupContent;
  readonly answers: Pick<OpeningAnswers, "serviceModes" | "hours">;
  readonly payment: StorePaymentConfigurationContent;
  readonly receiptLocale: string;
  readonly allergens: readonly string[] | null;
}): OpeningConfirmation {
  const { filled } = input;
  const value = <T>(entry: { readonly state: string; readonly value?: T }): T => {
    if (entry.state !== "Configured") throw new StoreSetupClientError("Invalid");
    return entry.value as T;
  };
  return Object.freeze({
    name: textKey(input.name),
    address: Object.freeze({
      lines: Object.freeze(input.addressLines.map(textKey).filter((line) => line !== "")),
      locality: textKey(input.locality),
      regionCode: input.regionCode,
      postalCode: postalKey(input.postalCode),
    }),
    phone: phoneKey(input.phone),
    timeZone: value(filled.timeZone),
    businessDayStart: value(filled.businessDayStartLocalTime),
    serviceModes: inOrder(input.answers.serviceModes),
    weeklySchedule: openingWeeklySchedule(input.answers),
    exceptions: value(filled.exceptions),
    fees: openingFeeContexts(filled, input.answers.serviceModes),
    capacity: value(filled.capacityConfigurationReference),
    taxConfiguration: value(filled.taxConfigurationReference),
    payment: input.payment,
    receiptLocale: input.receiptLocale,
    allergens: input.allergens,
  });
}
const sameConfirmation = (left: OpeningConfirmation, right: OpeningConfirmation) =>
  canonical(left) === canonical(right);
/** The record no longer says what the Owner ticked, or nothing was ticked: ask them to look again. */
class ConfirmAgain extends Error {
  constructor() {
    super("OPENING_CONFIRM_AGAIN");
    this.name = "ConfirmAgain";
  }
}

export interface OpeningApprover {
  readonly displayName: string | null;
}
/** Who else holds each approval, whatever the sole-operator setting says. */
export interface OpeningApprovers {
  readonly receiptTemplate: readonly OpeningApprover[];
  readonly storeSetup: readonly OpeningApprover[];
  readonly allergenList: readonly OpeningApprover[];
}
export type OpeningGate = "ReceiptTemplate" | "StoreSetup" | "AllergenList";
const othersFor = (approvers: OpeningApprovers, gate: OpeningGate) =>
  gate === "ReceiptTemplate"
    ? approvers.receiptTemplate
    : gate === "StoreSetup"
      ? approvers.storeSetup
      : approvers.allergenList;
export function parseOpeningApprovers(value: unknown): OpeningApprovers {
  const list = (entry: unknown): readonly OpeningApprover[] => {
    if (!Array.isArray(entry) || entry.length > 100) throw new StoreSetupClientError("Unavailable");
    return Object.freeze(
      entry.map((person: unknown) => {
        const name = (person as Record<string, unknown> | null)?.displayName;
        if (name !== null && (typeof name !== "string" || name.length > 80))
          throw new StoreSetupClientError("Unavailable");
        return Object.freeze({ displayName: name as string | null });
      }),
    );
  };
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") throw new StoreSetupClientError("Unavailable");
  return Object.freeze({
    receiptTemplate: list(raw.receiptTemplate),
    storeSetup: list(raw.storeSetup),
    allergenList: list(raw.allergenList),
  });
}
async function loadOpeningApprovers(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<OpeningApprovers> {
  const response = await fetcher("/merchant/store/opening-approvers", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new StoreSetupClientError("Unavailable");
  return parseOpeningApprovers(await response.json());
}

/** Everything the run talks to; the page builds the real ones, a test its own. */
export interface StoreOpeningDeps {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly signal: AbortSignal;
  /** The Store's language: its receipt template is in it. */
  readonly locale: string;
  readonly setup: ReturnType<typeof createStoreSetupClient>;
  readonly setupJournal: StoreSetupPendingJournal;
  readonly references: ReturnType<typeof createStoreSetupReferenceClient>;
  readonly referenceJournal: (kind: StoreSetupReferenceKind) => StoreSetupReferencePendingJournal;
  readonly payment: ReturnType<typeof createStorePaymentConfigurationClient>;
  readonly paymentJournal: StorePaymentConfigurationPendingJournal;
  readonly artifacts: ReturnType<typeof createReceiptTemplateArtifactClient>;
  readonly artifactJournal: (
    kind: ReceiptTemplateArtifactKind,
  ) => ReceiptTemplateArtifactPendingJournal;
  readonly templates: ReturnType<typeof createReceiptTemplateDraftClient>;
  readonly templateJournal: (subject: string | null) => ReceiptTemplateDraftPendingJournal;
  readonly submit: ReturnType<typeof createReceiptTemplateSubmitClient>;
  readonly submitJournal: (subject: string) => ReceiptTemplateSubmitPendingJournal;
  readonly lifecycle: ReturnType<typeof createReceiptTemplateLifecycleClient>;
  readonly lifecycleJournal: (subject: string) => ReceiptTemplateLifecyclePendingJournal;
  readonly templateGate: () => Promise<SoleOperatorGateView | null>;
  readonly published: ReturnType<typeof createReceiptTemplatePublishedClient>;
  readonly configuration: ReturnType<typeof createStoreConfigurationOrdinaryClient>;
  readonly configurationJournal: StoreConfigurationPendingJournal;
  /** Withdraws this person's own version, or declines someone else's. */
  readonly withdrawConfiguration: (input: {
    readonly configurationReference: string;
    readonly configurationVersion: number;
    readonly auditReference: string;
    readonly declineReason?: StoreConfigurationDeclineReason;
  }) => Promise<unknown>;
  readonly kitchen: ReturnType<typeof createStoreKitchenSetupClient>;
  readonly profile: ReturnType<typeof createStorePublicProfileClient>;
  readonly receipts: ReturnType<typeof createStoreReceiptProfileClient>;
  readonly features: ReturnType<typeof createStoreFeaturesClient>;
  readonly soleOperator: ReturnType<typeof createSoleOperatorClient>;
  readonly allergens: AllergenClient;
  readonly loadApprovers: () => Promise<OpeningApprovers>;
  /** One reference per intended write, kept across presses: a lost answer repeats the same write. */
  readonly operations: Map<string, { readonly reference: string; readonly content: string }>;
}
/** The real clients and durable journals; a test gives its own transport and memory journals. */
export function createStoreOpeningDeps(input: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly signal: AbortSignal;
  readonly locale: string;
  readonly operations?: StoreOpeningDeps["operations"];
  readonly fetcher?: typeof fetch;
  readonly journals?: Partial<
    Pick<
      StoreOpeningDeps,
      | "setupJournal"
      | "referenceJournal"
      | "paymentJournal"
      | "artifactJournal"
      | "templateJournal"
      | "submitJournal"
      | "lifecycleJournal"
      | "configurationJournal"
    >
  >;
}): StoreOpeningDeps {
  const { scope, csrf, signal, locale } = input;
  const fetcher = input.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const journals = input.journals ?? {};
  const clients = { csrf, fetcher };
  return Object.freeze<StoreOpeningDeps>({
    scope,
    csrf,
    signal,
    locale,
    setup: createStoreSetupClient(fetcher),
    setupJournal: journals.setupJournal ?? createStoreSetupPendingJournal(scope),
    references: createStoreSetupReferenceClient(fetcher),
    referenceJournal:
      journals.referenceJournal ?? ((kind) => createStoreSetupReferencePendingJournal(scope, kind)),
    payment: createStorePaymentConfigurationClient(fetcher),
    paymentJournal: journals.paymentJournal ?? createStorePaymentConfigurationPendingJournal(scope),
    artifacts: createReceiptTemplateArtifactClient(fetcher),
    artifactJournal:
      journals.artifactJournal ??
      ((kind) => createReceiptTemplateArtifactPendingJournal(scope, kind)),
    templates: createReceiptTemplateDraftClient(fetcher),
    templateJournal:
      journals.templateJournal ??
      ((subject) => createReceiptTemplateDraftPendingJournal(scope, subject)),
    submit: createReceiptTemplateSubmitClient(fetcher),
    submitJournal:
      journals.submitJournal ??
      ((subject) => createReceiptTemplateSubmitPendingJournal(scope, subject)),
    lifecycle: createReceiptTemplateLifecycleClient(fetcher),
    lifecycleJournal:
      journals.lifecycleJournal ??
      ((subject) => createReceiptTemplateLifecyclePendingJournal(scope, subject)),
    templateGate: () => loadReceiptTemplateSoleOperatorGate(scope, { signal }, fetcher),
    published: createReceiptTemplatePublishedClient(fetcher),
    configuration: createStoreConfigurationOrdinaryClient(fetcher),
    configurationJournal:
      journals.configurationJournal ?? createStoreConfigurationPendingJournal(scope),
    withdrawConfiguration: (command) => withdrawStoreConfiguration(command, csrf, fetcher),
    kitchen: createStoreKitchenSetupClient(clients),
    profile: createStorePublicProfileClient(clients),
    receipts: createStoreReceiptProfileClient(clients),
    features: createStoreFeaturesClient(csrf, fetcher),
    soleOperator: createSoleOperatorClient(fetcher),
    allergens: createAllergenClient(csrf, fetcher),
    loadApprovers: () => loadOpeningApprovers(fetcher, signal),
    operations: input.operations ?? new Map(),
  });
}

/** Where a run is; the page says it in the Owner's words. */
export type OpeningStep =
  | "StoreDetails"
  | "ReceiptDetails"
  | "Kitchen"
  | "Tips"
  | "Answers"
  | "SoleOperator"
  | "Payment"
  | "ReceiptTemplate"
  | "AllergenList"
  | "StoreSetup";
export type OpeningStopCode =
  | StoreSetupClientError["code"]
  | "NeedsPhone"
  | "HoursNotAnswered"
  | "AnotherAuthorDraft"
  | "ChecksFailed"
  | "NoAllergenTemplate"
  | "NotBrandOwner";
export interface OpeningWait {
  readonly what: OpeningGate;
  /** Who can approve it, by name; empty only when it waits for the person pressing. */
  readonly who: readonly OpeningApprover[];
}
/** What stands in the way of sending anything: BOP support's tax rates; someone else's open change. */
export type OpeningMissing = "TaxRates" | "OtherChange";
export type StoreOpeningOutcome =
  | { readonly kind: "Published"; readonly waits: readonly OpeningWait[] }
  /** It already was, when this press began: nothing from the page was written. */
  | { readonly kind: "AlreadyPublished" }
  | { readonly kind: "DetailsSaved"; readonly missing: readonly OpeningMissing[] }
  | { readonly kind: "Waiting"; readonly waits: readonly OpeningWait[] }
  | { readonly kind: "ConfirmAgain" }
  | {
      readonly kind: "Stopped";
      readonly step: OpeningStep;
      readonly code: OpeningStopCode;
      readonly failedChecks?: readonly StoreConfigurationPublicationCheckCode[];
    };
/** "Approve": exactly what the page showed as waiting for this person. */
export interface OpeningApprovalRequest {
  readonly gates: readonly OpeningGate[];
  /** The version shown, when the store setup is among them: a newer one is read again first. */
  readonly configuration: string | null;
  /** Afterwards the press goes on to what follows, because someone else approves that. */
  readonly carryOn: boolean;
}
export interface StoreOpeningInput {
  /** What the Owner typed; null when only approving what another Owner sent (nothing typed here). */
  readonly details: OpeningDetails | null;
  readonly answers: OpeningAnswers | null;
  /** What the Owner ticked, when they approve alone (with `approveAlone`). */
  readonly confirmed: OpeningConfirmation | null;
  readonly approveAlone: boolean;
  /** The tick said in full that this turns the Brand's setting on (`openingApprovalPlan`). */
  readonly turnOnSoleOperator: boolean;
  /** Pressed "Approve": these are approved first, before any of the presser's own steps. */
  readonly approve: OpeningApprovalRequest | null;
  readonly approvers: OpeningApprovers;
}
class OpeningStop extends Error {
  constructor(
    readonly code: OpeningStopCode,
    readonly failedChecks?: readonly StoreConfigurationPublicationCheckCode[],
  ) {
    super(code);
    this.name = "OpeningStop";
  }
}
/** Each client's own failure, as what the Owner can do about it. */
export function openingStopCode(error: unknown): OpeningStopCode {
  if (error instanceof OpeningStop) return error.code;
  if (error instanceof StoreSetupClientError) return error.code;
  if (
    error instanceof StorePublicProfileClientError ||
    error instanceof StoreReceiptProfileClientError ||
    error instanceof StoreKitchenSetupClientError
  )
    return error.code === "PermissionDenied"
      ? "Denied"
      : error.code === "Invalid" || error.code === "Conflict" || error.code === "OutcomeUnknown"
        ? error.code
        : "Unavailable";
  if (error instanceof StoreFeaturesClientError)
    return error.code === "Denied"
      ? "Denied"
      : error.code === "Changed"
        ? "Conflict"
        : "Unavailable";
  if (error instanceof SoleOperatorClientError)
    return error.code === "Denied"
      ? "Denied"
      : error.code === FULL_SIGN_IN_REQUIRED
        ? "FullSignInRequired"
        : error.code === "NeedsReverification"
          ? "SoleOperatorNeedsVerification"
          : error.code === "Changed"
            ? "Conflict"
            : error.code === "OutcomeUnknown"
              ? "OutcomeUnknown"
              : "Unavailable";
  if (error instanceof AllergenPageError)
    return error.code === "PermissionDenied"
      ? "Denied"
      : error.code === "NeedsReverification"
        ? "SoleOperatorNeedsVerification"
        : error.code === "SoleOperatorNotInEffect"
          ? "SoleOperatorNotInEffect"
          : error.code === "Conflict"
            ? "Conflict"
            : error.code === "Offline"
              ? "OutcomeUnknown"
              : "Unavailable";
  return "Unavailable";
}

const isCurrent = (deps: StoreOpeningDeps) => () => !deps.signal.aborted;
const noOriginal = () => undefined;
/** One reference per intended write: the same content keeps it until the write is confirmed. */
function operationFor(deps: StoreOpeningDeps, key: string, content: unknown): string {
  const text = canonical(content ?? null);
  const held = deps.operations.get(key);
  if (held !== undefined && held.content === text) return held.reference;
  const reference = serviceOperationReference();
  deps.operations.set(key, { reference, content: text });
  return reference;
}

async function saveStoreDetails(deps: StoreOpeningDeps, details: OpeningDetails) {
  let view = await deps.profile.load();
  const names = Object.fromEntries(
    view.locales.map((locale) => [locale, textKey(details.names[locale] ?? "")]),
  );
  const lines = details.addressLines.map(textKey).filter((line) => line !== "");
  const current = view.current;
  const unchanged =
    current !== null &&
    view.locales.every(
      (locale) =>
        current.names.find((entry) => entry.locale === locale)?.storeDisplayName === names[locale],
    ) &&
    canonical(current.address.addressLines) === canonical(lines) &&
    current.address.locality === textKey(details.locality) &&
    current.address.regionCode === details.regionCode &&
    postalKey(current.address.postalCode) === postalKey(details.postalCode) &&
    phoneKey(current.businessPhone ?? "") === phoneKey(details.phone);
  if (!unchanged) {
    const body = {
      storeDisplayNames: names,
      address: {
        addressLines: lines,
        locality: textKey(details.locality),
        regionCode: details.regionCode,
        postalCode: details.postalCode.trim(),
      },
      businessPhone: details.phone.trim() === "" ? null : details.phone.trim(),
    };
    try {
      await deps.profile.save({
        expectedVersion: current?.version ?? 0,
        operationReference: operationFor(deps, "profile", body),
        details: body,
      });
    } catch (error) {
      if (!(error instanceof StorePublicProfileClientError && error.code === "NoChange"))
        throw error;
    }
    deps.operations.delete("profile");
    view = await deps.profile.load();
  }
  return view;
}
/**
 * The address and contact the configuration records, from the published profile: nobody types them
 * twice. While the Store's setup is not published a corrected profile writes a new revision (history
 * stays append-only and the draft follows it), so the province the tax rates are set for and the
 * address published are the corrected ones. Never after that: this path only runs on a first opening.
 */
async function syncReference(
  deps: StoreOpeningDeps,
  kind: StoreSetupReferenceKind,
  content: (
    head: StoreSetupReferencesCurrent["contact"],
  ) => StoreSetupBusinessAddress | StoreSetupBusinessContact | null,
): Promise<string> {
  const journal = deps.referenceJournal(kind);
  const pending = await journal.load();
  if (pending !== null)
    await recoverStoreSetupReference({
      client: deps.references,
      journal,
      cursor: pending,
      csrf: deps.csrf,
      signal: deps.signal,
      isCurrent: isCurrent(deps),
    });
  const baseline = await deps.references.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    signal: deps.signal,
  });
  const head = kind === "Address" ? baseline.address : baseline.contact;
  const wanted = content(baseline.contact);
  if (wanted === null) throw new OpeningStop("NeedsPhone");
  if (head !== null && canonical(head.content) === canonical(wanted)) return head.reference;
  const { current } = await dispatchStoreSetupReference({
    client: deps.references,
    journal,
    scope: deps.scope,
    kind,
    baseline,
    content: wanted,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
    onReserved: noOriginal,
  });
  const saved = kind === "Address" ? current.address : current.contact;
  if (saved === null) throw new StoreSetupClientError("Unavailable");
  return saved.reference;
}
/** Name, address and phone from the published profile into Store setup's own two records. */
export async function syncOpeningReferences(
  deps: StoreOpeningDeps,
  current: StorePublicProfileCurrent,
) {
  const address = await syncReference(deps, "Address", () => openingAddressOf(current));
  const contact = await syncReference(deps, "Contact", (head) =>
    openingContactOf(
      current,
      head !== null && "website" in head.content ? head.content.website : null,
    ),
  );
  return { address, contact };
}
async function saveReceiptDetails(deps: StoreOpeningDeps, details: OpeningDetails) {
  const view = await deps.receipts.load();
  const compact = (value: string | null) => (value ?? "").trim().toUpperCase().replace(/\s+/gu, "");
  const unchanged =
    view.recordedAt !== null &&
    view.issuer.businessName === details.businessName.trim() &&
    compact(view.details.gstHstNumber) === compact(details.gstHstNumber) &&
    compact(view.details.qstNumber) === compact(details.qstNumber) &&
    compact(view.details.pstNumber) === compact(details.pstNumber);
  if (unchanged) return;
  const value = (text: string) => (text.trim() === "" ? null : text.trim());
  const body = {
    gstHstNumber: value(details.gstHstNumber),
    qstNumber: value(details.qstNumber),
    pstNumber: value(details.pstNumber),
    privacyNoticeUrl: view.details.privacyNoticeUrl,
    businessName: details.businessName.trim(),
  };
  try {
    await deps.receipts.save({
      expectedVersion: view.version,
      operationReference: operationFor(deps, "receipts", body),
      details: body,
    });
  } catch (error) {
    if (!(error instanceof StoreReceiptProfileClientError && error.code === "NoChange"))
      throw error;
  }
  deps.operations.delete("receipts");
}
async function setUpKitchen(deps: StoreOpeningDeps) {
  const view = await deps.kitchen.load();
  if (view.version > 0) return;
  if (!view.canChange) throw new StoreSetupClientError("Denied");
  try {
    await deps.kitchen.apply({
      operationReference: operationFor(deps, "kitchen", view.version),
      expectedVersion: view.version,
    });
  } catch (error) {
    // Someone else set it up just now: that is what this step wanted.
    if (
      !(error instanceof StoreKitchenSetupClientError && error.code === "Conflict") ||
      (await deps.kitchen.load()).version === 0
    )
      throw error;
  }
  deps.operations.delete("kitchen");
}
async function applyTipSwitch(deps: StoreOpeningDeps, offerTips: boolean) {
  const view = await deps.features.read();
  if (view.tips.enabled === offerTips) return;
  await deps.features.changeTips({
    operationReference: operationFor(deps, "tips", offerTips),
    expectedVersion: view.tips.version,
    enabled: offerTips,
    tierPercents: [...view.tips.tierPercents],
  });
  deps.operations.delete("tips");
}
const contentOf = (workspace: StoreSetupWorkspace) =>
  normalizeStoreSetupContentV2(
    workspace.setup.snapshot?.content ?? createUnconfiguredStoreSetupContent(),
  );
async function recoverSetupDraft(deps: StoreOpeningDeps) {
  const pending = await deps.setupJournal.load();
  if (pending !== null)
    await recoverStoreSetupDraft({
      client: deps.setup,
      journal: deps.setupJournal,
      cursor: pending,
      csrf: deps.csrf,
      signal: deps.signal,
    });
}
const readSetup = (deps: StoreOpeningDeps) =>
  deps.setup.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    signal: deps.signal,
  });
/** Writes the setup draft when `change` says something new, or when it builds on an old head. */
async function saveSetup(
  deps: StoreOpeningDeps,
  change: (content: StoreSetupContent) => Partial<StoreSetupContent>,
  head: string | null,
): Promise<StoreSetupSnapshot> {
  await recoverSetupDraft(deps);
  const workspace = await readSetup(deps);
  const content = contentOf(workspace);
  const next = parseStoreSetupContent({ ...content, ...change(content) });
  const saved = workspace.setup.snapshot;
  if (
    saved !== null &&
    canonical(next) === canonical(content) &&
    (head === null || saved.baseConfigurationReference === head)
  )
    return saved;
  const result = await dispatchStoreSetupDraft({
    client: deps.setup,
    journal: deps.setupJournal,
    baseline: workspace,
    content: next,
    csrf: deps.csrf,
    signal: deps.signal,
    onReserved: noOriginal,
  });
  const after = result.workspace.setup.snapshot;
  if (after === null) throw new StoreSetupClientError("Unavailable");
  return after;
}
const configured = <T>(value: T) => ({ state: "Configured" as const, value });
/** The saved answers, so another device or a second Owner carries on from them. */
const answersChange =
  (
    answers: Pick<OpeningAnswers, "serviceModes" | "hours"> | null,
    references: { readonly address: string; readonly contact: string } | null,
  ) =>
  (content: StoreSetupContent): Partial<StoreSetupContent> => ({
    source: configured("StoreOverride" as const),
    ...(answers === null
      ? {}
      : {
          enabledServiceModes: configured(inOrder(answers.serviceModes)),
          weeklySchedule: configured(
            openingWeeklySchedule(answers),
          ) as StoreSetupContent["weeklySchedule"],
          feeContexts: configured(openingFeeContexts(content, answers.serviceModes)),
        }),
    ...(references === null
      ? {}
      : {
          addressReference: configured(references.address),
          contactReference: configured(references.contact),
        }),
  });

const openStates: ReadonlySet<string> = new Set(["Draft", "PendingApproval", "Approved"]);
/** Past its 14 days a version made from Store setup takes no further step: the server refuses it. */
export const openingVersionRanOut = (
  version: Pick<StoreConfigurationSnapshot, "setupBasis" | "createdAt">,
  observedAt: string,
) =>
  version.setupBasis !== undefined &&
  Date.parse(version.createdAt) + publicationWindowMs <= Date.parse(observedAt);
type VersionRead = Pick<
  StoreConfigurationOrdinaryWorkspace,
  "latest" | "latestWithdrawal" | "observedAt"
>;
/** The latest version while it can still take a step: not published, withdrawn or run out. */
const openVersion = ({ latest, latestWithdrawal, observedAt }: VersionRead) =>
  latest !== null &&
  latestWithdrawal === undefined &&
  openStates.has(latest.lifecycle) &&
  !openingVersionRanOut(latest, observedAt)
    ? latest
    : null;
/**
 * What only someone else can settle: nothing is sent for approval until it is. The tax rates are BOP
 * support's. A change that did not come from Store setup (a Manager's hours, sent on Hours & ordering)
 * has to be approved or declined there before a configuration can be made over it.
 */
export function openingMissing(
  live: VersionRead & Pick<StoreConfigurationOrdinaryWorkspace, "storeTaxConfigurationReference">,
  actor: string,
): readonly OpeningMissing[] {
  const open = openVersion(live);
  return Object.freeze([
    ...(live.storeTaxConfigurationReference === null ? (["TaxRates"] as const) : []),
    ...(open !== null && open.setupBasis === undefined && open.authoredByReference !== actor
      ? (["OtherChange"] as const)
      : []),
  ]);
}

async function turnOnSoleOperator(deps: StoreOpeningDeps) {
  const view = await deps.soleOperator.read(deps.signal);
  if (view === null || view.state === "On") return;
  try {
    await deps.soleOperator.change(
      {
        state: "On",
        reasonCode: "OWNER_RUNS_STORE_ALONE",
        expectedVersion: view.version,
        operationReference: operationFor(deps, "sole-operator", view.version),
      },
      deps.csrf,
      deps.signal,
    );
  } catch (error) {
    if (!(error instanceof SoleOperatorClientError && error.code === "NoChange")) throw error;
  }
  deps.operations.delete("sole-operator");
}
async function ensurePayment(deps: StoreOpeningDeps): Promise<string> {
  const pending = await deps.paymentJournal.load();
  if (pending !== null)
    await recoverStorePaymentConfiguration({
      client: deps.payment,
      journal: deps.paymentJournal,
      cursor: pending,
      csrf: deps.csrf,
      signal: deps.signal,
      isCurrent: isCurrent(deps),
    });
  const baseline = await deps.payment.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    signal: deps.signal,
  });
  if (baseline.snapshot !== null) return baseline.snapshot.configurationReference;
  const { current } = await dispatchStorePaymentConfiguration({
    client: deps.payment,
    journal: deps.paymentJournal,
    scope: deps.scope,
    baseline,
    content: openingPaymentChannels,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
    onReserved: noOriginal,
  });
  if (current.snapshot === null) throw new StoreSetupClientError("Unavailable");
  return current.snapshot.configurationReference;
}
async function ensureArtifacts(deps: StoreOpeningDeps) {
  const common = {
    client: deps.artifacts,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
  };
  const references: Partial<Record<ReceiptTemplateArtifactKind, string>> = {};
  for (const kind of ["Layout", "Compliance"] as const) {
    const journal = deps.artifactJournal(kind);
    const pending = await journal.load();
    if (pending !== null)
      await recoverReceiptTemplateArtifact({ ...common, journal, cursor: pending });
    const baseline = await deps.artifacts.load({
      storeReference: deps.scope.storeReference,
      expectedScope: deps.scope,
      signal: deps.signal,
    });
    const held = kind === "Layout" ? baseline.layout : baseline.compliance;
    if (held !== null) {
      references[kind] = held.artifactReference;
      continue;
    }
    const { current } = await dispatchReceiptTemplateArtifact({
      ...common,
      journal,
      scope: deps.scope,
      artifactKind: kind,
      baseline,
      onReserved: noOriginal,
    });
    const saved = kind === "Layout" ? current.layout : current.compliance;
    if (saved === null) throw new StoreSetupClientError("Unavailable");
    references[kind] = saved.artifactReference;
  }
  const { Layout: layout, Compliance: compliance } = references;
  if (layout === undefined || compliance === undefined)
    throw new StoreSetupClientError("Unavailable");
  return { layout, compliance };
}
export interface OpeningTemplateState {
  readonly view: ReceiptTemplateDraftCurrent | null;
  readonly review: ReceiptTemplateReviewCurrent | null;
}
/** The Store's receipt template in its own language, as far as it has come. */
export async function readOpeningTemplate(deps: StoreOpeningDeps): Promise<OpeningTemplateState> {
  const roster = await deps.templates.loadRoster({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    afterTemplate: null,
    csrf: deps.csrf,
    signal: deps.signal,
  });
  const entry = roster.entries.find((snapshot) => snapshot.content.locale === deps.locale);
  if (entry === undefined) return { view: null, review: null };
  const subject = entry.content.templateReference;
  const view = await deps.templates.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    templateReference: subject,
    signal: deps.signal,
  });
  const review = await deps.submit.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    templateReference: subject,
    csrf: deps.csrf,
    signal: deps.signal,
  });
  return { view, review };
}
const savedTemplateFields = (view: ReceiptTemplateDraftCurrent): ReceiptTemplateDraftFields => {
  const content = view.snapshot?.content;
  if (content === undefined) throw new StoreSetupClientError("Conflict");
  return parseReceiptTemplateDraftFields({
    locale: content.locale,
    layoutDefinitionReference: content.layoutDefinitionReference,
    complianceRuleReference: content.complianceRuleReference,
    activation: content.activation,
    effectiveUntil: content.effectiveUntil,
  });
};
/**
 * What the signed-in Owner sent now waits for someone: named, always. With nobody else to approve it
 * only this Owner can, alone: they are asked for the tick, or told that it takes the brand owner to
 * turn sole operator on. A lone Owner never waits for nobody.
 */
function waitFor(
  input: StoreOpeningInput,
  what: OpeningGate,
  named: readonly OpeningApprover[],
): OpeningWait {
  const who = named.length > 0 ? named : othersFor(input.approvers, what);
  if (who.length > 0) return Object.freeze({ what, who });
  if (input.turnOnSoleOperator) throw new OpeningStop("NotBrandOwner");
  // Who can approve is not what the page said: it reads again, and asks what now applies.
  throw new ConfirmAgain();
}
const waitOnYou = (what: OpeningGate): OpeningWait => Object.freeze({ what, who: [] });

/** The template's state once any request still pending from this browser has been resolved. */
async function templateAfterRecovery(deps: StoreOpeningDeps): Promise<OpeningTemplateState> {
  const newTemplate = deps.templateJournal(null);
  const pendingNew = await newTemplate.load();
  const common = {
    client: deps.templates,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
  };
  if (pendingNew !== null)
    await finishReceiptTemplateDraftOriginal({
      ...common,
      journal: newTemplate,
      cursor: pendingNew,
    });
  const state = await readOpeningTemplate(deps);
  const subject = state.view?.templateReference ?? null;
  if (subject === null) return state;
  const draftJournal = deps.templateJournal(subject);
  const pendingDraft = await draftJournal.load();
  if (pendingDraft !== null)
    await finishReceiptTemplateDraftOriginal({
      ...common,
      journal: draftJournal,
      cursor: pendingDraft,
    });
  const submitJournal = deps.submitJournal(subject);
  const pendingSubmit = await submitJournal.load();
  if (pendingSubmit !== null)
    await finishReceiptTemplateSubmitOriginal({
      submitClient: deps.submit,
      client: deps.templates,
      journal: submitJournal,
      csrf: deps.csrf,
      signal: deps.signal,
      isCurrent: isCurrent(deps),
      cursor: pendingSubmit,
    });
  const lifecycleJournal = deps.lifecycleJournal(subject);
  const pendingLifecycle = await lifecycleJournal.load();
  if (pendingLifecycle !== null)
    await finishReceiptTemplateLifecycleOriginal({
      client: deps.templates,
      submitClient: deps.submit,
      lifecycleClient: deps.lifecycle,
      journal: lifecycleJournal,
      csrf: deps.csrf,
      signal: deps.signal,
      isCurrent: isCurrent(deps),
      cursor: pendingLifecycle,
    });
  return pendingDraft !== null || pendingSubmit !== null || pendingLifecycle !== null
    ? readOpeningTemplate(deps)
    : state;
}
/** The arguments every approve or publish of a template takes. */
const templateLifecycleStep = (
  deps: StoreOpeningDeps,
  view: ReceiptTemplateDraftCurrent,
  review: ReceiptTemplateReviewCurrent,
  fields: ReceiptTemplateDraftFields,
  templateReference: string,
) => ({
  client: deps.templates,
  submitClient: deps.submit,
  lifecycleClient: deps.lifecycle,
  journal: deps.lifecycleJournal(templateReference),
  csrf: deps.csrf,
  signal: deps.signal,
  isCurrent: isCurrent(deps),
  scope: deps.scope,
  baseline: view,
  review,
  fields,
  onReserved: noOriginal,
});
const sentByYou = (deps: StoreOpeningDeps, review: ReceiptTemplateReviewCurrent) =>
  review.submission !== null &&
  (deps.scope.actorReference === review.submission.authoredByReference ||
    deps.scope.actorReference === review.submission.submittedByReference);
/**
 * The Store's published receipt template: the setup's choice if it is published here, else the one
 * the Store started with, else the standard one, written, sent, approved and published. Null when it
 * now waits for someone. The first configuration of a TEST Store names a template that was never
 * published, and is never carried.
 */
async function ensureReceiptTemplate(
  deps: StoreOpeningDeps,
  input: StoreOpeningInput,
  chosen: string | null,
  waits: OpeningWait[],
): Promise<string | null> {
  const usable = async (templateReference: string | null) => {
    if (templateReference === null) return null;
    const current = await deps.published
      .load({
        expectedScope: deps.scope,
        templateReference,
        locale: deps.locale,
        signal: deps.signal,
      })
      .catch(() => null);
    return current === null ? null : templateReference;
  };
  const kept = await usable(chosen);
  if (kept !== null) return kept;
  const installed = await deps.published.loadInstalled({
    expectedScope: deps.scope,
    locale: deps.locale,
    signal: deps.signal,
  });
  if (installed !== null) return installed.templateReference;
  const common = {
    client: deps.templates,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
  };
  let state = await templateAfterRecovery(deps);
  // A draft nobody can use any more (its checks ran out, or it was retired) starts a new revision.
  const unusable = (review: ReceiptTemplateReviewCurrent | null) =>
    review?.lifecycle?.state === "Archived" ||
    (review?.submission !== undefined &&
      review.submission !== null &&
      (review.lifecycle?.state === "InReview" || review.lifecycle?.state === "Approved") &&
      Date.parse(review.submission.validationValidUntil) <= Date.now());
  if (state.view === null || unusable(state.review)) {
    const artifacts = await ensureArtifacts(deps);
    const baseline =
      state.view ??
      (await deps.templates.load({
        storeReference: deps.scope.storeReference,
        expectedScope: deps.scope,
        templateReference: null,
        signal: deps.signal,
      }));
    const journal = deps.templateJournal(baseline.templateReference);
    await saveReceiptTemplateDraft({
      ...common,
      journal,
      scope: deps.scope,
      baseline,
      fields: parseReceiptTemplateDraftFields({
        locale: deps.locale,
        layoutDefinitionReference: artifacts.layout,
        complianceRuleReference: artifacts.compliance,
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      }),
      onReserved: noOriginal,
    });
    state = await readOpeningTemplate(deps);
  }
  // Each step reads the review again: another Owner may have moved it on.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { view, review } = state;
    if (view === null || view.snapshot === null || review === null)
      throw new StoreSetupClientError("Conflict");
    const templateReference = view.snapshot.content.templateReference;
    const fields = savedTemplateFields(view);
    const sentThisVersion =
      review.submission !== null &&
      review.submission.versionReference === view.snapshot.content.versionReference;
    const lifecycle = sentThisVersion ? (review.lifecycle?.state ?? null) : null;
    if (lifecycle === "Published") {
      const current = await deps.published.load({
        expectedScope: deps.scope,
        templateReference,
        locale: deps.locale,
        signal: deps.signal,
      });
      let selected: string | null = null;
      applyReceiptTemplateStoreSelection(current, deps.scope, deps.locale, (reference) => {
        selected = reference;
      });
      return selected;
    }
    const lifecycleStep = templateLifecycleStep(deps, view, review, fields, templateReference);
    if (lifecycle === null) {
      await submitReceiptTemplateDraft({
        submitClient: deps.submit,
        client: deps.templates,
        journal: deps.submitJournal(templateReference),
        csrf: deps.csrf,
        signal: deps.signal,
        isCurrent: isCurrent(deps),
        scope: deps.scope,
        baseline: view,
        fields,
        onReserved: noOriginal,
      });
    } else if (lifecycle === "InReview") {
      if (!sentByYou(deps, review)) {
        waits.push(waitOnYou("ReceiptTemplate"));
        return null;
      }
      const gate = await deps.templateGate();
      if (gate?.status !== "Effective" || !input.approveAlone) {
        waits.push(waitFor(input, "ReceiptTemplate", gate?.otherApprovers ?? []));
        return null;
      }
      if (input.confirmed === null || input.confirmed.receiptLocale !== fields.locale)
        throw new ConfirmAgain();
      await advanceReceiptTemplateLifecycle({
        ...lifecycleStep,
        action: "Approve",
        approvalMode: "SoleOperator",
      });
    } else if (lifecycle === "Approved") {
      await advanceReceiptTemplateLifecycle({ ...lifecycleStep, action: "Publish" });
    } else throw new StoreSetupClientError("Conflict");
    state = await readOpeningTemplate(deps);
  }
  throw new StoreSetupClientError("Conflict");
}
const sendAllergenCommand = async (deps: StoreOpeningDeps, command: AllergenCommand) => {
  if (deps.allergens.command === undefined) throw new StoreSetupClientError("Unavailable");
  await deps.allergens.command(command);
};
const approveAllergenProposal = async (
  deps: StoreOpeningDeps,
  proposalReference: string,
  soleOperator: boolean,
) => {
  const key = "allergen-approve:" + proposalReference;
  await sendAllergenCommand(deps, {
    action: "ApproveRegistry",
    operationReference: operationFor(deps, key, soleOperator),
    proposalReference,
    ...(soleOperator ? { approvalMode: "SoleOperator" as const } : {}),
  });
  deps.operations.delete(key);
};
/** The allergen list, recorded and approved; a Brand that has one has nothing to do here. */
async function ensureAllergenList(
  deps: StoreOpeningDeps,
  input: StoreOpeningInput,
  waits: OpeningWait[],
) {
  const read = async () => parseAllergenListView(await deps.allergens.load(null));
  let view: AllergenListView | null = await read().catch((error: unknown) => {
    // A Store Owner without Brand-level allergen access: the Brand's holders do this.
    if (error instanceof AllergenPageError && error.code === "PermissionDenied") return null;
    throw error;
  });
  if (view !== null && view.registry !== null) return;
  // Only someone holding allergen list approval records or approves it: the others are named.
  if (view === null || !view.permissions.mayManageRegistry) {
    const who = othersFor(input.approvers, "AllergenList");
    if (who.length > 0) waits.push(Object.freeze({ what: "AllergenList" as const, who }));
    return;
  }
  // Recorded by someone else: this person decides that on Allergens, unless they pressed Approve.
  if (view.registryProposal !== null && !view.registryProposal.recordedByYou) {
    waits.push(waitOnYou("AllergenList"));
    return;
  }
  // Nobody else holds its approval and this press does not approve alone: the Brand's setting stays
  // as it is. Recorded, the list would wait for nobody; the Owner decides it on Allergens.
  if (
    !input.approveAlone &&
    othersFor(input.approvers, "AllergenList").length === 0 &&
    (view.soleOperator?.otherApprovers.length ?? 0) === 0
  )
    return;
  // The list the server offers: the pilot's own, labelled TEST, until a reviewed one exists.
  const offered = view.registryTemplate;
  if (offered.allergens.length === 0) throw new OpeningStop("NoAllergenTemplate");
  if (view.registryProposal === null) {
    const key = "allergen-record";
    await sendAllergenCommand(deps, {
      action: "RecordRegistry",
      operationReference: operationFor(deps, key, offered.template),
      template: offered.template,
    });
    deps.operations.delete(key);
    view = await read();
    if (view.registry !== null) return;
  }
  const proposal = view.registryProposal;
  if (proposal === null) throw new StoreSetupClientError("Conflict");
  const gate = view.soleOperator;
  if (gate?.status !== "Effective" || !input.approveAlone) {
    waits.push(waitFor(input, "AllergenList", gate?.otherApprovers ?? []));
    return;
  }
  if (
    input.confirmed === null ||
    canonical(input.confirmed.allergens) !==
      canonical(view.registryTemplate.allergens.map((entry) => entry.code))
  )
    throw new ConfirmAgain();
  await approveAllergenProposal(deps, proposal.proposalReference, true);
}
/** What is about to be approved, as the server has it, in the form the Owner ticked. */
async function confirmationOnRecord(
  deps: StoreOpeningDeps,
  latest: StoreConfigurationSnapshot,
  confirmed: OpeningConfirmation,
): Promise<OpeningConfirmation> {
  const references = await deps.references.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    signal: deps.signal,
  });
  const payment = await deps.payment.load({
    storeReference: deps.scope.storeReference,
    expectedScope: deps.scope,
    signal: deps.signal,
  });
  const address = references.address,
    contact = references.contact;
  if (
    address === null ||
    contact === null ||
    payment.snapshot === null ||
    address.reference !== latest.addressReference ||
    contact.reference !== latest.contactReference ||
    payment.snapshot.configurationReference !== latest.paymentConfigurationReference ||
    !("addressLines" in address.content) ||
    "addressLines" in contact.content
  )
    throw new ConfirmAgain();
  return Object.freeze({
    name: textKey(contact.content.contactName),
    address: Object.freeze({
      lines: address.content.addressLines.map(textKey),
      locality: textKey(address.content.locality),
      regionCode: address.content.regionCode,
      postalCode: postalKey(address.content.postalCode),
    }),
    phone: phoneKey(contact.content.businessPhone),
    timeZone: latest.timeZone,
    businessDayStart: latest.businessDayStartLocalTime,
    serviceModes: latest.enabledServiceModes,
    weeklySchedule: latest.weeklySchedule,
    exceptions: latest.exceptions,
    fees: latest.setupBasis?.feeContexts ?? [],
    capacity: latest.capacityConfigurationReference,
    taxConfiguration: latest.taxConfigurationReference,
    payment: payment.snapshot.content,
    // Checked when the template and the allergen list are approved, each against its own record.
    receiptLocale: confirmed.receiptLocale,
    allergens: confirmed.allergens,
  });
}
/** The live configuration as Store setup's own fill reads it. */
export const openingLive = (
  workspace: Pick<
    StoreConfigurationOrdinaryWorkspace,
    "observedAt" | "storeTaxConfigurationReference"
  >,
  current: StoreConfigurationSnapshot,
): StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot } => ({
  current,
  observedAt: workspace.observedAt,
  ...(workspace.storeTaxConfigurationReference === undefined
    ? {}
    : { storeTaxConfigurationReference: workspace.storeTaxConfigurationReference }),
});
async function recoverConfiguration(deps: StoreOpeningDeps) {
  const pending = await deps.configurationJournal.load();
  if (pending !== null)
    await recoverStoreConfigurationOriginal({
      client: deps.configuration,
      journal: deps.configurationJournal,
      cursor: pending,
      csrf: deps.csrf,
      signal: deps.signal,
      isCurrent: isCurrent(deps),
    });
}
async function configurationStep(
  deps: StoreOpeningDeps,
  workspace: StoreConfigurationOrdinaryWorkspace,
  action: "Materialize" | "Submit" | "Approve" | "Publish",
  saved: StoreSetupSnapshot | null,
  approvalMode?: "SoleOperator",
) {
  const prepared = await deps.configuration.prepare(
    await buildStoreConfigurationCommand({
      scope: deps.scope,
      action,
      operationReference: serviceOperationReference(),
      expectedHead: workspace.expectedHead,
      saved,
    }),
    { signal: deps.signal },
  );
  await executeStoreConfigurationOriginal({
    client: deps.configuration,
    journal: deps.configurationJournal,
    prepared,
    csrf: deps.csrf,
    signal: deps.signal,
    isCurrent: isCurrent(deps),
    canDispatch: () => true,
    onReserved: noOriginal,
    ...(approvalMode === undefined ? {} : { approvalMode }),
  });
}
/** Someone else's version is declined: it stays in the history and takes no further step. */
async function declineVersion(
  deps: StoreOpeningDeps,
  version: Pick<StoreConfigurationSnapshot, "configurationReference" | "configurationVersion">,
  declineReason?: StoreConfigurationDeclineReason,
) {
  const key = "decline:" + version.configurationReference;
  await deps.withdrawConfiguration({
    configurationReference: version.configurationReference,
    configurationVersion: version.configurationVersion,
    auditReference: operationFor(deps, key, null),
    ...(declineReason === undefined ? {} : { declineReason }),
  });
  deps.operations.delete(key);
}
/** The approver sends back what they were asked to approve, so it can be changed and sent again. */
export async function sendOpeningBack(deps: StoreOpeningDeps) {
  const workspace = await deps.configuration.load(deps.scope, { signal: deps.signal });
  const version = openVersion(workspace);
  if (version === null) return;
  await declineVersion(deps, version, "NotRight");
}
/** Saves the finished setup, makes the configuration from it, sends, approves and publishes it. */
async function publishConfiguration(
  deps: StoreOpeningDeps,
  input: StoreOpeningInput,
  references: { readonly address: string | null; readonly contact: string | null },
  chosen: { readonly payment: string; readonly receipt: string },
  waits: OpeningWait[],
) {
  const actor = deps.scope.actorReference;
  await recoverConfiguration(deps);
  // Materialize, Submit, Approve, Publish: at most these four, each from what the server says now,
  // and declining a version that ran out.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await recoverSetupDraft(deps);
    const workspace = await deps.configuration.load(deps.scope, { signal: deps.signal });
    const latest = workspace.latest,
      current = workspace.current;
    if (current?.setupBasis !== undefined) return;
    if (current === null) throw new StoreSetupClientError("Unavailable");
    // Past its 14 days a version can't go further, and someone else's would stop a new one being
    // made. The new one goes through the same comparison and the same approval.
    if (
      latest !== null &&
      workspace.latestWithdrawal === undefined &&
      openStates.has(latest.lifecycle) &&
      openingVersionRanOut(latest, workspace.observedAt) &&
      latest.authoredByReference !== actor
    ) {
      await declineVersion(deps, latest);
      continue;
    }
    const saved = (await readSetup(deps)).setup.snapshot;
    const open = openVersion(workspace);
    if (open !== null && !storeSetupCreatedFromSaved(saved, open)) {
      // Someone else's change is open: it is approved and published, or declined, first.
      if (open.authoredByReference !== actor)
        throw new StoreSetupClientError("OpenChangeByAnother");
    }
    if (open === null || !storeSetupCreatedFromSaved(saved, open)) {
      const fresh = await saveSetup(
        deps,
        (content) => ({
          ...answersChange(input.answers, null)(content),
          ...firstOpeningFill(content, openingLive(workspace, current)),
          ...(references.address === null
            ? {}
            : { addressReference: configured(references.address) }),
          ...(references.contact === null
            ? {}
            : { contactReference: configured(references.contact) }),
          paymentConfigurationReference: configured(chosen.payment),
          receiptReference: configured(chosen.receipt),
        }),
        (latest ?? current).configurationReference,
      );
      if (fresh.content.weeklySchedule.state !== "Configured")
        throw new OpeningStop("HoursNotAnswered");
      await configurationStep(deps, workspace, "Materialize", fresh);
      continue;
    }
    if (open.lifecycle === "Draft") {
      if (open.authoredByReference !== actor) throw new OpeningStop("AnotherAuthorDraft");
      const failed = (workspace.publicationChecks?.checks ?? [])
        .filter((check) => check.outcome === "Fail")
        .map((check) => check.code);
      if (failed.length > 0) throw new OpeningStop("ChecksFailed", failed);
      await configurationStep(deps, workspace, "Submit", saved);
    } else if (open.lifecycle === "PendingApproval") {
      const gate = workspace.soleOperator;
      if (gate === undefined && open.authoredByReference !== actor) {
        waits.push(waitOnYou("StoreSetup"));
        return;
      }
      if (gate?.status !== "Effective" || !input.approveAlone) {
        waits.push(waitFor(input, "StoreSetup", gate?.otherApprovers ?? []));
        return;
      }
      // What was ticked is what is on record, or the approval is not given.
      if (
        input.confirmed === null ||
        !sameConfirmation(await confirmationOnRecord(deps, open, input.confirmed), input.confirmed)
      )
        throw new ConfirmAgain();
      await configurationStep(deps, workspace, "Approve", saved, "SoleOperator");
    } else if (open.lifecycle === "Approved") {
      await configurationStep(deps, workspace, "Publish", saved);
    } else throw new StoreSetupClientError("Conflict");
  }
  throw new StoreSetupClientError("Conflict");
}

/** What someone else sent: approved as it stands, and published once it is. Independent approvals. */
async function approveWhatWaits(
  deps: StoreOpeningDeps,
  request: OpeningApprovalRequest,
  enter: (step: OpeningStep) => void,
) {
  if (request.gates.includes("ReceiptTemplate")) {
    enter("ReceiptTemplate");
    let state = await templateAfterRecovery(deps);
    // Approve, then publish: each from what the server says now.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { view, review } = state;
      if (
        view === null ||
        view.snapshot === null ||
        review?.submission?.versionReference === undefined
      )
        break;
      if (review.submission.versionReference !== view.snapshot.content.versionReference) break;
      const lifecycle = review.lifecycle?.state ?? null;
      if (lifecycle !== "Approved" && (lifecycle !== "InReview" || sentByYou(deps, review))) break;
      const templateReference = view.snapshot.content.templateReference;
      await advanceReceiptTemplateLifecycle({
        ...templateLifecycleStep(deps, view, review, savedTemplateFields(view), templateReference),
        action: lifecycle === "InReview" ? "Approve" : "Publish",
      });
      state = await readOpeningTemplate(deps);
    }
  }
  if (request.gates.includes("AllergenList")) {
    enter("AllergenList");
    const view = parseAllergenListView(await deps.allergens.load(null));
    const proposal = view.registryProposal;
    if (view.registry === null && proposal !== null && !proposal.recordedByYou)
      await approveAllergenProposal(deps, proposal.proposalReference, false);
  }
  if (request.gates.includes("StoreSetup")) {
    enter("StoreSetup");
    await recoverConfiguration(deps);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workspace = await deps.configuration.load(deps.scope, { signal: deps.signal });
      const open = openVersion(workspace);
      if (open === null) break;
      // A newer version than the one read: it is shown first, never approved unseen.
      if (open.configurationReference !== request.configuration) throw new ConfirmAgain();
      if (open.lifecycle === "PendingApproval") {
        if (
          workspace.soleOperator !== undefined ||
          open.authoredByReference === deps.scope.actorReference
        )
          break;
        await configurationStep(deps, workspace, "Approve", null);
      } else if (open.lifecycle === "Approved") {
        await configurationStep(deps, workspace, "Publish", null);
      } else break;
    }
  }
}

/** The press: everything the Owner answered, then the rest, in order. Pressing again carries on. */
export async function runStoreOpening(
  deps: StoreOpeningDeps,
  input: StoreOpeningInput,
  onProgress: (step: OpeningStep) => void = () => undefined,
): Promise<StoreOpeningOutcome> {
  let at: OpeningStep = "StoreDetails";
  const enter = (step: OpeningStep) => {
    at = step;
    onProgress(step);
  };
  const waits: OpeningWait[] = [];
  const liveNow = () => deps.configuration.load(deps.scope, { signal: deps.signal });
  try {
    // First, before anything is written: this page may have been open a long time. Once the Store's
    // setup is published its details, hours and tips are changed on purpose, on the page for that.
    await recoverConfiguration(deps);
    if ((await liveNow()).current?.setupBasis !== undefined) {
      await recoverSetupDraft(deps).catch(() => undefined);
      return Object.freeze({ kind: "AlreadyPublished" });
    }
    if (input.approve !== null) {
      await approveWhatWaits(deps, input.approve, enter);
      if ((await liveNow()).current?.setupBasis !== undefined)
        return Object.freeze({ kind: "Published", waits: Object.freeze([]) });
      if (!input.approve.carryOn)
        return Object.freeze({ kind: "Waiting", waits: Object.freeze([]) });
    }
    let references: { readonly address: string | null; readonly contact: string | null } = {
      address: null,
      contact: null,
    };
    if (input.details !== null) {
      enter("StoreDetails");
      const view: StorePublicProfileView = await saveStoreDetails(deps, input.details);
      if (view.current === null) throw new StoreSetupClientError("Unavailable");
      references = await syncOpeningReferences(deps, view.current);
      enter("ReceiptDetails");
      await saveReceiptDetails(deps, input.details);
      enter("Kitchen");
      await setUpKitchen(deps);
    }
    if (input.answers !== null) {
      enter("Tips");
      await applyTipSwitch(deps, input.answers.offerTips);
      if (openingAnswerProblems(input.answers).length === 0) {
        enter("Answers");
        const known =
          references.address !== null && references.contact !== null
            ? { address: references.address, contact: references.contact }
            : null;
        await saveSetup(deps, answersChange(input.answers, known), null);
      }
    }
    enter("Answers");
    // What only someone else can settle: nothing is sent for approval until it is.
    const missing = openingMissing(await liveNow(), deps.scope.actorReference);
    if (missing.length > 0) return Object.freeze({ kind: "DetailsSaved", missing });
    if (input.answers !== null && openingAnswerProblems(input.answers).length > 0)
      throw new OpeningStop("HoursNotAnswered");
    if (input.turnOnSoleOperator) {
      enter("SoleOperator");
      await turnOnSoleOperator(deps);
    }
    enter("Payment");
    const payment = await ensurePayment(deps);
    enter("ReceiptTemplate");
    const draft = contentOf(await readSetup(deps));
    const receipt = await ensureReceiptTemplate(
      deps,
      input,
      draft.receiptReference.state === "Configured" ? draft.receiptReference.value : null,
      waits,
    );
    // Before the configuration: its publish is the last thing, so nothing is left behind it.
    enter("AllergenList");
    await ensureAllergenList(deps, input, waits);
    if (receipt === null) return Object.freeze({ kind: "Waiting", waits: Object.freeze(waits) });
    enter("StoreSetup");
    await publishConfiguration(deps, input, references, { payment, receipt }, waits);
    return (await liveNow()).current?.setupBasis !== undefined
      ? Object.freeze({ kind: "Published", waits: Object.freeze(waits) })
      : Object.freeze({ kind: "Waiting", waits: Object.freeze(waits) });
  } catch (error) {
    if (error instanceof ConfirmAgain) return Object.freeze({ kind: "ConfirmAgain" });
    return Object.freeze({
      kind: "Stopped",
      step: at,
      code: openingStopCode(error),
      ...(error instanceof OpeningStop && error.failedChecks !== undefined
        ? { failedChecks: error.failedChecks }
        : {}),
    });
  }
}

/** What the page reads when it opens, and again after a press. */
export interface OpeningFacts {
  readonly workspace: StoreSetupWorkspace;
  readonly live: StoreConfigurationOrdinaryWorkspace;
  readonly profile: StorePublicProfileView;
  readonly receipts: StoreReceiptProfileView;
  readonly kitchen: StoreKitchenSetupView;
  readonly features: StoreFeatures;
  /** Null: the signed-in Owner is not the Brand Owner, so they can't turn it on. */
  readonly soleOperator: SoleOperatorView | null;
  readonly approvers: OpeningApprovers;
  /** Null: this Owner has no Brand-level allergen access. */
  readonly allergens: AllergenListView | null;
  readonly payment: StorePaymentConfigurationCurrent;
  readonly template: OpeningTemplateState;
}
export async function loadOpeningFacts(deps: StoreOpeningDeps): Promise<OpeningFacts> {
  const [
    workspace,
    live,
    profile,
    receipts,
    kitchen,
    features,
    soleOperator,
    approvers,
    allergens,
    payment,
    template,
  ] = await Promise.all([
    readSetup(deps),
    deps.configuration.load(deps.scope, { signal: deps.signal }),
    deps.profile.load(),
    deps.receipts.load(),
    deps.kitchen.load(),
    deps.features.read(),
    deps.soleOperator.read(deps.signal).catch((error: unknown) => {
      if (error instanceof SoleOperatorClientError && error.code === "Denied") return null;
      throw error;
    }),
    deps.loadApprovers(),
    deps.allergens
      .load(null)
      .then(parseAllergenListView)
      .catch((error: unknown) => {
        if (error instanceof AllergenPageError && error.code === "PermissionDenied") return null;
        throw error;
      }),
    deps.payment.load({
      storeReference: deps.scope.storeReference,
      expectedScope: deps.scope,
      signal: deps.signal,
    }),
    readOpeningTemplate(deps),
  ]);
  // No configuration to start from, in the real composition, fails the read above. Said the same way.
  if (live.current === null) throw new StoreSetupClientError("Unavailable");
  return Object.freeze({
    workspace,
    live,
    profile,
    receipts,
    kitchen,
    features,
    soleOperator,
    approvers,
    allergens,
    payment,
    template,
  });
}
export const openingContentOf = (facts: Pick<OpeningFacts, "workspace">): StoreSetupContent =>
  contentOf(facts.workspace);
/** What the summary and the approval rest on: the answers, over the setup as it will be saved. */
export function openingConfirmationFromFacts(
  facts: OpeningFacts,
  details: Pick<
    OpeningDetails,
    "names" | "addressLines" | "locality" | "regionCode" | "postalCode" | "phone"
  >,
  answers: Pick<OpeningAnswers, "serviceModes" | "hours">,
): OpeningConfirmation | null {
  const current = facts.live.current;
  if (current === null) return null;
  const content = contentOf(facts.workspace);
  const allergens = facts.allergens;
  const locale = facts.profile.current?.defaultLocale ?? facts.workspace.store.locale;
  try {
    return openingConfirmation({
      name: details.names[locale] ?? Object.values(details.names)[0] ?? "",
      addressLines: details.addressLines,
      locality: details.locality,
      regionCode: details.regionCode,
      postalCode: details.postalCode,
      phone: details.phone,
      filled: parseStoreSetupContent({
        ...content,
        ...firstOpeningFill(content, openingLive(facts.live, current)),
      }),
      answers,
      payment: facts.payment.snapshot?.content ?? openingPaymentChannels,
      receiptLocale: facts.workspace.store.locale,
      allergens:
        allergens === null || allergens.registry !== null
          ? null
          : allergens.registryTemplate.allergens.map((entry) => entry.code),
    });
  } catch {
    // What was typed can't be read as a setup: the page says what is missing.
    return null;
  }
}
/**
 * What was sent, as it is on record, for whoever reads it next: the version waiting, or the answers
 * saved. Null when nothing has been answered yet: there is nothing to show, so nothing to approve here.
 */
export function openingSentSummary(facts: OpeningFacts): OpeningConfirmation | null {
  const profile = facts.profile.current;
  if (profile === null) return null;
  const details = {
    names: Object.fromEntries(
      profile.names.map((entry) => [entry.locale, entry.storeDisplayName] as const),
    ),
    addressLines: profile.address.addressLines,
    locality: profile.address.locality,
    regionCode: profile.address.regionCode,
    postalCode: profile.address.postalCode,
    phone: profile.businessPhone ?? "",
  };
  const version = openVersion(facts.live);
  if (version?.setupBasis !== undefined) {
    const allergens = facts.allergens;
    return Object.freeze({
      name: textKey(defaultName(profile)),
      address: Object.freeze({
        lines: Object.freeze(details.addressLines.map(textKey).filter((line) => line !== "")),
        locality: textKey(details.locality),
        regionCode: details.regionCode,
        postalCode: postalKey(details.postalCode),
      }),
      phone: phoneKey(details.phone),
      timeZone: version.timeZone,
      businessDayStart: version.businessDayStartLocalTime,
      serviceModes: version.enabledServiceModes,
      weeklySchedule: version.weeklySchedule,
      exceptions: version.exceptions,
      fees: version.setupBasis.feeContexts,
      capacity: version.capacityConfigurationReference,
      taxConfiguration: version.taxConfigurationReference,
      payment: facts.payment.snapshot?.content ?? openingPaymentChannels,
      receiptLocale: facts.workspace.store.locale,
      allergens:
        allergens === null || allergens.registry !== null
          ? null
          : allergens.registryTemplate.allergens.map((entry) => entry.code),
    });
  }
  const content = contentOf(facts.workspace);
  if (
    content.weeklySchedule.state !== "Configured" ||
    content.enabledServiceModes.state !== "Configured"
  )
    return null;
  const answers = openingAnswersFromRecords(content, null);
  return answers === null ? null : openingConfirmationFromFacts(facts, details, answers);
}
/**
 * Who decides what on this opening, from what the page read. The page says it and the press does it:
 * one answer for both, so what the tick says is what the press sends.
 *
 * Approving alone needs the Brand's sole-operator setting on (DEC-SOLE-OPERATOR-APPROVAL: an explicit
 * request, and it also reaches refunds). So a press changes the setting only when the Store can't be
 * published any other way (nobody else holds a Store gate), and then the tick says all of it. Where
 * someone else approves the Store's gates the setting is left as the Brand Owner has it, even if the
 * allergen list has nobody else: that one is decided separately, on Allergens.
 */
export interface OpeningApprovalPlan {
  /** What only this Owner can approve, and approves with the tick and one code. */
  readonly alone: readonly OpeningGate[];
  /** What goes to someone else, named. */
  readonly others: readonly OpeningWait[];
  /** The press sends this person's own approvals as given alone. */
  readonly approveAlone: boolean;
  /** The press turns on the Brand's setting; the tick must say so in full. */
  readonly turnsOnSoleOperator: boolean;
  /** Only the Brand Owner can turn it on, and this is not them. */
  readonly needsBrandOwner: boolean;
  /** Nobody else holds the allergen list's approval, and this press leaves it for Allergens. */
  readonly allergenListLater: boolean;
  /** The press can end in publication: no Store gate waits for someone else. */
  readonly publishes: boolean;
}
export function openingApprovalPlan(
  facts: Pick<OpeningFacts, "approvers" | "allergens" | "soleOperator">,
): OpeningApprovalPlan {
  const { approvers, allergens, soleOperator } = facts;
  const storeGates = ["ReceiptTemplate", "StoreSetup"] as const;
  const storeAlone = storeGates.filter((gate) => othersFor(approvers, gate).length === 0);
  // The list is this person's while the Brand has none and nobody else has recorded one.
  const proposal = allergens?.registryProposal ?? null;
  const listOpen =
    allergens !== null &&
    allergens.registry === null &&
    allergens.permissions.mayManageRegistry &&
    (proposal === null || proposal.recordedByYou);
  const listAlone = listOpen && approvers.allergenList.length === 0;
  const needsBrandOwner = storeAlone.length > 0 && soleOperator === null;
  const approveAlone =
    !needsBrandOwner && (storeAlone.length > 0 || (listAlone && soleOperator?.state === "On"));
  const alone: readonly OpeningGate[] = !approveAlone
    ? []
    : [
        ...(storeAlone.includes("ReceiptTemplate") ? (["ReceiptTemplate"] as const) : []),
        ...(listAlone ? (["AllergenList"] as const) : []),
        ...(storeAlone.includes("StoreSetup") ? (["StoreSetup"] as const) : []),
      ];
  const named = (what: OpeningGate): readonly OpeningWait[] => {
    const who = othersFor(approvers, what);
    return who.length === 0 ? [] : [Object.freeze({ what, who })];
  };
  return Object.freeze({
    alone: Object.freeze(alone),
    others: Object.freeze([
      ...named("ReceiptTemplate"),
      ...(listOpen ? named("AllergenList") : []),
      ...named("StoreSetup"),
    ]),
    approveAlone,
    turnsOnSoleOperator: approveAlone && soleOperator?.state === "Off",
    needsBrandOwner,
    allergenListLater: listAlone && !alone.includes("AllergenList"),
    publishes: storeAlone.length === storeGates.length,
  });
}
/** The press of the answers form, as the page shows it. */
export function openingAnswersInput(
  facts: OpeningFacts,
  details: OpeningDetails,
  answers: OpeningAnswers,
  confirmed: OpeningConfirmation | null,
): StoreOpeningInput {
  const plan = openingApprovalPlan(facts);
  const blocked = openingMissing(facts.live, facts.workspace.scope.actorReference).length > 0;
  return Object.freeze({
    details,
    answers,
    confirmed,
    approveAlone: !blocked && plan.approveAlone,
    turnOnSoleOperator: !blocked && plan.turnsOnSoleOperator,
    approve: null,
    approvers: facts.approvers,
  });
}
/** The press of "Approve", as the page shows it: what waits for this person, and nothing typed. */
export function openingApproveInput(facts: OpeningFacts): StoreOpeningInput {
  return Object.freeze({
    details: null,
    answers: null,
    confirmed: null,
    approveAlone: false,
    turnOnSoleOperator: false,
    approve: Object.freeze({
      gates: openingWaitsFromFacts(facts).forYou,
      configuration: openVersion(facts.live)?.configurationReference ?? null,
      // Someone else approves what follows, so this press can go on to it. Otherwise it is this
      // person's alone: back to the page, for the tick and the code.
      carryOn: !openingApprovalPlan(facts).publishes,
    }),
    approvers: facts.approvers,
  });
}
export interface OpeningWaits {
  /** Approved here, with what was sent shown above the button. */
  readonly forYou: readonly OpeningGate[];
  /** This person sent these and the run can't pass them until the people named approve. */
  readonly forOthers: readonly OpeningWait[];
  /** The allergen list, recorded, for the people named. Nothing else waits on it. */
  readonly listForOthers: OpeningWait | null;
  /** Someone else recorded the allergen list, on its own: it is decided on Allergens. */
  readonly listForYou: boolean;
  /** Sent to this person before anyone answered this page: approved here once it is answered. */
  readonly beforeAnswers: readonly OpeningGate[];
  /** The version sent has run out; a press makes a new one. */
  readonly ranOut: boolean;
  /** Someone sent back what this person's Store setup made. */
  readonly sentBack: boolean;
}
/**
 * What another Owner has sent that waits for this one, and what this one sent that waits for
 * someone else: the page shows either on opening, from server state, on whichever device.
 */
export function openingWaitsFromFacts(facts: OpeningFacts): OpeningWaits {
  const actor = facts.workspace.scope.actorReference;
  const observedAt = facts.live.observedAt;
  const answered = openingSentSummary(facts) !== null;
  const forOthers: OpeningWait[] = [];
  const beforeAnswers: OpeningGate[] = [];
  const named = (what: OpeningGate) => {
    const who = othersFor(facts.approvers, what);
    if (who.length > 0) forOthers.push(Object.freeze({ what, who }));
  };
  let receiptForYou = false,
    storeSetupForYou = false;
  const review = facts.template.review;
  if (
    review?.lifecycle?.state === "InReview" &&
    review.submission !== null &&
    // Its checks ran out: a press starts a new revision, nobody can approve this one.
    Date.parse(review.submission.validationValidUntil) > Date.parse(observedAt)
  ) {
    const own =
      actor === review.submission.authoredByReference ||
      actor === review.submission.submittedByReference;
    if (own) named("ReceiptTemplate");
    else if (answered) receiptForYou = true;
    else beforeAnswers.push("ReceiptTemplate");
  }
  const version = openVersion(facts.live);
  // A change that did not come from Store setup is not this page's: it stops the press, by name.
  if (version?.setupBasis !== undefined && version.lifecycle === "PendingApproval") {
    if (facts.live.soleOperator !== undefined || version.authoredByReference === actor)
      named("StoreSetup");
    else if (answered) storeSetupForYou = true;
    else beforeAnswers.push("StoreSetup");
  }
  const allergens = facts.allergens;
  const proposal =
    allergens !== null && allergens.registry === null ? allergens.registryProposal : null;
  const listSent =
    proposal !== null &&
    !proposal.recordedByYou &&
    allergens?.permissions.mayManageRegistry === true;
  // On its own a list recorded by someone else takes nothing from this page: the answers still
  // have to be given here. With something else to approve it goes with that, in the same press.
  const listHere = listSent && (receiptForYou || storeSetupForYou);
  const who = othersFor(facts.approvers, "AllergenList");
  const latest = facts.live.latest;
  return Object.freeze({
    forYou: Object.freeze([
      ...(receiptForYou ? (["ReceiptTemplate"] as const) : []),
      ...(listHere ? (["AllergenList"] as const) : []),
      ...(storeSetupForYou ? (["StoreSetup"] as const) : []),
    ]),
    forOthers: Object.freeze(forOthers),
    listForOthers:
      proposal?.recordedByYou === true && who.length > 0
        ? Object.freeze({ what: "AllergenList" as const, who })
        : null,
    listForYou: listSent && !listHere,
    beforeAnswers: Object.freeze(beforeAnswers),
    ranOut:
      latest !== null &&
      facts.live.latestWithdrawal === undefined &&
      openStates.has(latest.lifecycle) &&
      openingVersionRanOut(latest, observedAt),
    sentBack:
      latest?.setupBasis !== undefined &&
      facts.live.latestWithdrawal?.kind === "Declined" &&
      !facts.live.latestWithdrawal.byYou,
  });
}
