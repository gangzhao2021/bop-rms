import { parseStoreSetupFeeContexts } from "./store-setup-client.js";
import { parseSoleOperatorGate, type SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";
import {
  parseServiceIntervals,
  type ServiceMode,
  type ServiceInterval,
} from "./service-control-client.js";
export type StoreConfigurationFeeContext =
  | Readonly<{ chargeType: "ServiceCharge" | "DeliveryFee" | "Tip"; state: "Disabled" }>
  | Readonly<{
      chargeType: "ServiceCharge" | "DeliveryFee" | "Tip";
      state: "Enabled";
      /** `null` only for a Tip (WP-2423 v15 D7: a voluntary tip is not taxed). */
      taxClassificationReference: string | null;
      orderTypes: readonly ServiceMode[];
    }>;
export interface StoreSetupConfigurationBasis {
  readonly profile: "StoreSetupConfigurationBasisV2";
  readonly tenantReference: string;
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
  readonly feeContexts: readonly StoreConfigurationFeeContext[];
}
export interface StoreConfigurationSnapshot {
  readonly setupBasis?: StoreSetupConfigurationBasis;
  readonly configurationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationVersion: number;
  readonly lifecycle:
    "Draft" | "PendingApproval" | "Approved" | "Published" | "Superseded" | "Archived";
  readonly source: "BrandInherited" | "StoreOverride";
  readonly brandBaseVersionReference: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly timeZone: string;
  readonly businessDayStartLocalTime: string;
  readonly addressReference: string;
  readonly contactReference: string;
  readonly receiptReference: string;
  readonly taxConfigurationReference: string;
  readonly paymentConfigurationReference: string;
  readonly capacityConfigurationReference: string | null;
  readonly enabledServiceModes: readonly ServiceMode[];
  readonly weeklySchedule: readonly {
    readonly isoWeekday: number;
    readonly intervals: readonly ServiceInterval[];
  }[];
  readonly exceptions: readonly {
    readonly localDate: string;
    readonly kind: "Holiday" | "TemporaryClosure" | "Override";
    readonly intervals: readonly ServiceInterval[];
  }[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly supersedesConfigurationReference: string | null;
  readonly reasonCode: string;
  readonly authoredByReference: string;
  readonly approvedByReference: string | null;
  readonly approvalEvidenceReference: string | null;
  readonly publicationReference: string | null;
  readonly liveGateEvidenceReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}

const invalid = (): never => {
  throw new Error("Configuration response unavailable.");
};
const reference = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
function exact(raw: unknown, fields: readonly string[]) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Reflect.ownKeys(raw).length !== fields.length
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    fields.some((key) => {
      const d = descriptors[key];
      return !d || !d.enumerable || !("value" in d);
    })
  )
    return invalid();
  return raw as Record<string, unknown>;
}
function instant(v: unknown): string {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)
    return invalid();
  return v;
}
export function parseStoreSetupConfigurationBasis(raw: unknown): StoreSetupConfigurationBasis {
  const v = exact(raw, [
    "profile",
    "tenantReference",
    "setupDraftReference",
    "sourceRevision",
    "sourceSnapshotDigest",
    "feeContexts",
  ]);
  if (
    v.profile !== "StoreSetupConfigurationBasisV2" ||
    typeof v.tenantReference !== "string" ||
    !reference(v.tenantReference) ||
    typeof v.setupDraftReference !== "string" ||
    !reference(v.setupDraftReference) ||
    typeof v.sourceRevision !== "number" ||
    !Number.isSafeInteger(v.sourceRevision) ||
    v.sourceRevision < 1 ||
    v.sourceRevision > 2147483647 ||
    typeof v.sourceSnapshotDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(v.sourceSnapshotDigest)
  )
    return invalid();
  let fees: ReturnType<typeof parseStoreSetupFeeContexts>;
  try {
    fees = parseStoreSetupFeeContexts(v.feeContexts);
  } catch {
    return invalid();
  }
  const feeContexts = Object.freeze(
    fees.map((entry): StoreConfigurationFeeContext => {
      if (entry.state === "Unconfigured") return invalid();
      if (entry.state === "Disabled")
        return Object.freeze({ chargeType: entry.chargeType, state: "Disabled" });
      if (entry.state !== "Enabled") return invalid();
      return Object.freeze({
        chargeType: entry.chargeType,
        state: "Enabled",
        taxClassificationReference: entry.taxClassificationReference,
        orderTypes: entry.orderTypes,
      });
    }),
  );
  return Object.freeze({
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: v.tenantReference,
    setupDraftReference: v.setupDraftReference,
    sourceRevision: v.sourceRevision,
    sourceSnapshotDigest: v.sourceSnapshotDigest,
    feeContexts,
  });
}
export function parseStoreConfigurationSnapshot(
  raw: unknown,
  store: string,
): StoreConfigurationSnapshot {
  const hasBasis = raw !== null && typeof raw === "object" && Object.hasOwn(raw, "setupBasis");
  const v = exact(raw, [
    ...(hasBasis ? ["setupBasis"] : []),
    "configurationReference",
    "brandReference",
    "storeReference",
    "configurationVersion",
    "lifecycle",
    "source",
    "brandBaseVersionReference",
    "defaultLocale",
    "currencyCode",
    "timeZone",
    "businessDayStartLocalTime",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "capacityConfigurationReference",
    "enabledServiceModes",
    "weeklySchedule",
    "exceptions",
    "effectiveFrom",
    "effectiveUntil",
    "supersedesConfigurationReference",
    "reasonCode",
    "authoredByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "liveGateEvidenceReference",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  for (const key of [
    "configurationReference",
    "brandReference",
    "storeReference",
    "brandBaseVersionReference",
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "authoredByReference",
  ])
    if (!reference(v[key])) return invalid();
  for (const key of [
    "capacityConfigurationReference",
    "supersedesConfigurationReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
    "liveGateEvidenceReference",
  ])
    if (v[key] !== null && !reference(v[key])) return invalid();
  if (
    v.storeReference !== store ||
    typeof v.configurationVersion !== "number" ||
    !Number.isSafeInteger(v.configurationVersion) ||
    v.configurationVersion < 1 ||
    !["Draft", "PendingApproval", "Approved", "Published", "Superseded", "Archived"].includes(
      String(v.lifecycle),
    ) ||
    !["BrandInherited", "StoreOverride"].includes(String(v.source)) ||
    v.currencyCode !== "CAD" ||
    v.dataClassification !== "ConfigurationMetadata" ||
    typeof v.defaultLocale !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(v.defaultLocale) ||
    typeof v.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(v.reasonCode) ||
    typeof v.businessDayStartLocalTime !== "string" ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(v.businessDayStartLocalTime)
  )
    return invalid();
  if (typeof v.timeZone !== "string") return invalid();
  try {
    if (
      new Intl.DateTimeFormat("en", { timeZone: v.timeZone }).resolvedOptions().timeZone !==
      v.timeZone
    )
      return invalid();
  } catch {
    return invalid();
  }
  const from = instant(v.effectiveFrom),
    created = instant(v.createdAt),
    updated = instant(v.updatedAt);
  if (updated < created || (v.effectiveUntil !== null && instant(v.effectiveUntil) <= from))
    return invalid();
  if (
    !Array.isArray(v.enabledServiceModes) ||
    v.enabledServiceModes.length < 1 ||
    v.enabledServiceModes.length > 3 ||
    new Set(v.enabledServiceModes).size !== v.enabledServiceModes.length ||
    v.enabledServiceModes.some((mode) => !["DineIn", "Pickup", "Delivery"].includes(mode))
  )
    return invalid();
  if (
    !Array.isArray(v.weeklySchedule) ||
    v.weeklySchedule.length !== 7 ||
    !Array.isArray(v.exceptions) ||
    v.exceptions.length > 366
  )
    return invalid();
  const setupBasis = hasBasis ? parseStoreSetupConfigurationBasis(v.setupBasis) : undefined;
  if (
    setupBasis &&
    setupBasis.feeContexts.some(
      (entry) =>
        entry.state === "Enabled" &&
        entry.orderTypes.some(
          (mode) => !Array.isArray(v.enabledServiceModes) || !v.enabledServiceModes.includes(mode),
        ),
    )
  )
    return invalid();
  const weeklySchedule = v.weeklySchedule.map((day, index) => {
    const d = exact(day, ["isoWeekday", "intervals"]);
    if (d.isoWeekday !== index + 1) return invalid();
    return Object.freeze({ isoWeekday: index + 1, intervals: parseServiceIntervals(d.intervals) });
  });
  const dates = new Set<string>();
  const exceptions = v.exceptions.map((rawException) => {
    const e = exact(rawException, ["localDate", "kind", "intervals"]);
    if (
      typeof e.localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(e.localDate) ||
      !Number.isFinite(Date.parse(e.localDate + "T00:00:00.000Z")) ||
      new Date(e.localDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== e.localDate ||
      dates.has(e.localDate) ||
      !["Holiday", "TemporaryClosure", "Override"].includes(String(e.kind))
    )
      return invalid();
    dates.add(e.localDate);
    return Object.freeze({ ...e, intervals: parseServiceIntervals(e.intervals) });
  });
  return Object.freeze({
    ...v,
    ...(setupBasis ? { setupBasis } : {}),
    weeklySchedule: Object.freeze(weeklySchedule),
    exceptions: Object.freeze(exceptions),
  }) as unknown as StoreConfigurationSnapshot;
}
export interface StoreConfigurationView {
  readonly screenId: "STORE-HOURS-SERVICE";
  readonly storeReference: string;
  readonly current: StoreConfigurationSnapshot | null;
  readonly latest: StoreConfigurationSnapshot | null;
  readonly expectedVersion: number;
  readonly observedAt: string;
  /** WP-2423 (v15 D2/D3): the signed-in person, so the screen says whose change is open. */
  readonly viewerActorReference?: string;
  /** Present when the latest change (not published) was withdrawn by its author or declined. */
  readonly latestWithdrawal?: {
    readonly kind: "Withdrawn" | "Declined";
    readonly withdrawnAt: string;
    readonly byYou: boolean;
    /** WP-2423 (v15): why it was declined, when the Owner gave a reason. */
    readonly reason?: StoreConfigurationDeclineReason | null;
  } | null;
  /** WP-2423 (v15): who made the open change, when it is someone else (their Store name). */
  readonly latestAuthorName?: string | null;
  /** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: whether you may approve your own waiting change alone. */
  readonly soleOperator?: SoleOperatorGateView | null;
  /** WP-2423 (v15 `8bd902e3` D9): you may decline someone else's open change (Store configuration
   * approval). Absent from older servers: treated as not allowed. */
  readonly viewerMayDecline?: boolean;
  /** WP-2423 (v15): you hold Store configuration approval (`store.service.approve`), whoever made
   * the open change; decides what the screen tells a sender. Absent from older servers: unknown. */
  readonly viewerMayApprove?: boolean;
}
/** WP-2423 (v15): why an Owner declined someone else's change (optional). */
export type StoreConfigurationDeclineReason = "NotRight" | "NotNeeded" | "TalkFirst";
export const storeConfigurationDeclineReasonText: Readonly<
  Record<StoreConfigurationDeclineReason, string>
> = Object.freeze({
  NotRight: "Something in it is not right",
  NotNeeded: "It is not needed",
  TalkFirst: "Talk to me before changing this",
});
export function parseStoreConfigurationView(raw: unknown, store: string): StoreConfigurationView {
  const extended =
    raw !== null && typeof raw === "object" && Object.hasOwn(raw, "viewerActorReference");
  const named = extended && Object.hasOwn(raw, "latestAuthorName");
  const declinable = named && Object.hasOwn(raw, "viewerMayDecline");
  const approvable = declinable && Object.hasOwn(raw, "viewerMayApprove");
  const v = exact(raw, [
    "screenId",
    "storeReference",
    "current",
    "latest",
    "expectedVersion",
    "observedAt",
    ...(extended ? ["viewerActorReference", "latestWithdrawal"] : []),
    ...(named ? ["latestAuthorName", "soleOperator"] : []),
    ...(declinable ? ["viewerMayDecline"] : []),
    ...(approvable ? ["viewerMayApprove"] : []),
  ]);
  if (declinable && typeof v.viewerMayDecline !== "boolean") return invalid();
  if (approvable && typeof v.viewerMayApprove !== "boolean") return invalid();
  if (v.screenId !== "STORE-HOURS-SERVICE" || !reference(store) || v.storeReference !== store)
    return invalid();
  const current = v.current === null ? null : parseStoreConfigurationSnapshot(v.current, store);
  const latest = v.latest === null ? null : parseStoreConfigurationSnapshot(v.latest, store);
  const observedAt = instant(v.observedAt);
  if (
    current &&
    (current.lifecycle !== "Published" ||
      current.effectiveFrom > observedAt ||
      (current.effectiveUntil !== null && current.effectiveUntil <= observedAt))
  )
    return invalid();
  if (
    [current, latest].some(
      (c) => c !== null && (c.createdAt > observedAt || c.updatedAt > observedAt),
    ) ||
    v.expectedVersion !== (latest?.configurationVersion ?? current?.configurationVersion ?? 0)
  )
    return invalid();
  let latestWithdrawal: StoreConfigurationView["latestWithdrawal"] = null;
  if (extended && v.latestWithdrawal !== null) {
    const withReason =
      v.latestWithdrawal !== null &&
      typeof v.latestWithdrawal === "object" &&
      Object.hasOwn(v.latestWithdrawal, "reason");
    const w = exact(v.latestWithdrawal, [
      "kind",
      "withdrawnAt",
      "byYou",
      ...(withReason ? ["reason"] : []),
    ]);
    if (
      (w.kind !== "Withdrawn" && w.kind !== "Declined") ||
      typeof w.byYou !== "boolean" ||
      latest === null ||
      latest.lifecycle === "Published" ||
      (withReason &&
        w.reason !== null &&
        (w.kind !== "Declined" ||
          !Object.hasOwn(storeConfigurationDeclineReasonText, String(w.reason))))
    )
      return invalid();
    latestWithdrawal = Object.freeze({
      kind: w.kind,
      withdrawnAt: instant(w.withdrawnAt),
      byYou: w.byYou,
      ...(withReason
        ? { reason: (w.reason ?? null) as StoreConfigurationDeclineReason | null }
        : {}),
    });
  }
  if (
    extended &&
    (typeof v.viewerActorReference !== "string" || !reference(v.viewerActorReference))
  )
    return invalid();
  return Object.freeze({
    screenId: "STORE-HOURS-SERVICE",
    storeReference: store,
    current,
    latest,
    expectedVersion: v.expectedVersion as number,
    observedAt,
    ...(extended
      ? { viewerActorReference: v.viewerActorReference as string, latestWithdrawal }
      : {}),
    ...(named
      ? {
          latestAuthorName:
            v.latestAuthorName === null
              ? null
              : typeof v.latestAuthorName === "string" &&
                  v.latestAuthorName.length > 0 &&
                  v.latestAuthorName.length <= 80
                ? v.latestAuthorName
                : invalid(),
          soleOperator: (() => {
            try {
              return parseSoleOperatorGate(v.soleOperator);
            } catch {
              return invalid();
            }
          })(),
        }
      : {}),
    ...(declinable ? { viewerMayDecline: v.viewerMayDecline as boolean } : {}),
    ...(approvable ? { viewerMayApprove: v.viewerMayApprove as boolean } : {}),
  });
}

export interface StoreConfigurationCommand {
  readonly command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";
  readonly operationReference: string;
  readonly auditReference: string;
  readonly expectedVersion: number;
  readonly configuration: StoreConfigurationSnapshot;
}
/**
 * WP-2423 Q4: an hours change once the configuration came from Store setup. The browser sends only
 * the hours, dated exceptions and the Store setup version it edited; the server makes the Store
 * setup revision and the draft configuration from them.
 */
export interface StoreHoursDraftCommand {
  readonly expectedSetup: {
    readonly setupDraftReference: string;
    readonly sourceRevision: number;
    readonly sourceSnapshotDigest: string;
  };
  readonly setupOperationReference: string;
  readonly operationReference: string;
  readonly auditReference: string;
  readonly configurationReference: string;
  readonly expectedVersion: number;
  readonly weeklySchedule: StoreConfigurationSnapshot["weeklySchedule"];
  readonly exceptions: StoreConfigurationSnapshot["exceptions"];
  /** The server time of the read the change was made from; it applies from then. */
  readonly effectiveFrom: string;
}
/** WP-2423 (v15 D3): another person's change is still open; it is never replaced silently. */
export const OPEN_CHANGE_BY_ANOTHER_MESSAGE =
  "Someone else's change to this Store's configuration is still waiting. It must be approved and published, or withdrawn or declined, before another change can be saved. Ask an Owner.";
/** WP-2423 (v15 D2/D3): the change was withdrawn or declined and takes no further step. */
export const STORE_CONFIGURATION_WITHDRAWN_MESSAGE =
  "This change was withdrawn or declined. Make a new change instead.";
/** WP-2423 (v15): only the person who made a change checks it and sends it for approval. */
export const NOT_YOUR_CHANGE_MESSAGE =
  "Only the person who made this change can check it or send it for approval. Ask them to, or, if you are an Owner, approve or decline it.";
/** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: refusals of an approval, each with what to do next. */
export const APPROVAL_NEEDS_ANOTHER_PERSON_MESSAGE =
  "You made or sent this change, so someone else with Owner access must approve it, or approve it on your own as sole operator.";
/** WP-2423 (v15 2026-10-16): an approval given alone while sole operator was off. */
export const SOLE_OPERATOR_APPROVAL_INVALID_MESSAGE =
  "This change was approved by you alone while Sole operator was off, so it cannot be published. Withdraw it, then send a new change for approval.";
export const SOLE_OPERATOR_OFF_MESSAGE =
  "Sole operator is off, so another person with Owner access must approve this. If you run this business on your own, turn on Sole operator on the Approvals page, then approve again.";
export const SOLE_OPERATOR_OTHERS_MESSAGE =
  "Someone else also holds Owner access at this Store, so they must approve this change.";
export const SOLE_OPERATOR_VERIFY_MESSAGE =
  "Your verification is more than 15 minutes old, so the approval was not recorded. Verify again, then approve.";
/** Refusals after which the form and the open change stay on screen as they were. */
export const storeConfigurationKeptRefusals: ReadonlySet<string> = new Set([
  NOT_YOUR_CHANGE_MESSAGE,
  APPROVAL_NEEDS_ANOTHER_PERSON_MESSAGE,
  SOLE_OPERATOR_OFF_MESSAGE,
  SOLE_OPERATOR_OTHERS_MESSAGE,
  SOLE_OPERATOR_VERIFY_MESSAGE,
]);
/** WP-2423 (v15 D2/D3): withdraw your own open change, or decline someone else's (Owner). */
export async function withdrawStoreConfiguration(
  input: {
    readonly configurationReference: string;
    readonly configurationVersion: number;
    readonly auditReference: string;
    /** Only when declining someone else's change; optional. */
    readonly declineReason?: StoreConfigurationDeclineReason;
  },
  csrf: string,
  fetcher: typeof fetch = fetch,
): Promise<"Withdrawn" | "Declined"> {
  const response = await fetcher("/merchant/store-configuration/withdrawal", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BOP-CSRF": csrf,
    },
    body: JSON.stringify(input),
  });
  if (response.status === 403)
    throw new Error("Permission denied. Only the person who made it, or an Owner, can do this.");
  if (response.status === 409) throw new Error("Source changed. Refresh before trying again.");
  if (!response.ok || response.headers.get("cache-control") !== "no-store")
    throw new Error("Configuration request unavailable.");
  const body = exact(await response.json(), ["status", "kind"]);
  if (
    !["Applied", "AlreadyApplied"].includes(String(body.status)) ||
    (body.kind !== "Withdrawn" && body.kind !== "Declined")
  )
    throw new Error("Configuration request unavailable.");
  return body.kind;
}
/** WP-2423 Q4: Store setup holds saved changes the latest configuration does not include. */
export const STORE_SETUP_UNPUBLISHED_MESSAGE =
  "Store setup has changes that are not published yet. Ask the Owner to publish or finish them in Store setup first.";
export function createStoreConfigurationClient(fetcher: typeof fetch = fetch) {
  async function request(
    signal: AbortSignal,
    command?: StoreConfigurationCommand | StoreHoursDraftCommand,
    csrf?: string,
    approvalMode?: "SoleOperator",
  ) {
    const hours = command !== undefined && "expectedSetup" in command;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(
        hours ? "/merchant/store-configuration/hours-draft" : "/merchant/store-configuration",
        {
          method: command ? "POST" : "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(command ? { "Content-Type": "application/json", "X-BOP-CSRF": csrf ?? "" } : {}),
          },
          ...(command
            ? {
                body: JSON.stringify(
                  approvalMode === undefined ? command : { ...command, approvalMode },
                ),
              }
            : {}),
        },
      );
      const answer: unknown =
        response.status === 403 || response.status === 409
          ? await response.json().catch(() => null)
          : null;
      const error =
        answer !== null && typeof answer === "object"
          ? Object.getOwnPropertyDescriptor(answer, "error")?.value
          : undefined;
      if (response.status === 403) {
        // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: why your own approval alone was not accepted.
        if (error === "sole_operator_off") throw new Error(SOLE_OPERATOR_OFF_MESSAGE);
        if (error === "sole_operator_not_in_effect") throw new Error(SOLE_OPERATOR_OTHERS_MESSAGE);
        if (error === "sole_operator_needs_verification")
          throw new Error(SOLE_OPERATOR_VERIFY_MESSAGE);
        throw new Error(
          command && "command" in command && command.command === "Approve"
            ? "Permission denied. Someone other than the person who made this change, with approval access, must approve it."
            : "Permission denied. Check your session and Store access.",
        );
      }
      if (response.status === 409) {
        if (hours && error === "store_setup_has_unpublished_changes")
          throw new Error(STORE_SETUP_UNPUBLISHED_MESSAGE);
        if (error === "open_change_by_another") throw new Error(OPEN_CHANGE_BY_ANOTHER_MESSAGE);
        if (error === "sole_operator_approval_invalid")
          throw new Error(SOLE_OPERATOR_APPROVAL_INVALID_MESSAGE);
        if (error === "store_configuration_withdrawn")
          throw new Error(STORE_CONFIGURATION_WITHDRAWN_MESSAGE);
        if (error === "not_your_change") throw new Error(NOT_YOUR_CHANGE_MESSAGE);
        if (error === "approval_needs_another_person")
          throw new Error(APPROVAL_NEEDS_ANOTHER_PERSON_MESSAGE);
        throw new Error("Source changed. Refresh before trying again.");
      }
      // WP-2423 Q4: the change itself was not accepted; keep the form so staff can correct it.
      if (response.status === 422)
        throw new Error(
          "Change not accepted. Only opening hours and dated closures can change here, and a change must be approved by someone other than its author.",
        );
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        throw new Error("Configuration request unavailable.");
      const text = await response.text();
      if (text.length > 2097152 || controller.signal.aborted)
        throw new Error("Configuration request unavailable.");
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    async load(store: string, signal: AbortSignal) {
      return parseStoreConfigurationView(await request(signal), store);
    },
    async execute(
      command: StoreConfigurationCommand,
      csrf: string,
      signal: AbortSignal,
      /** WP-2423: "SoleOperator" when you approve your own change alone. */
      approvalMode?: "SoleOperator",
    ) {
      if (approvalMode !== undefined && command.command !== "Approve")
        throw new Error("Configuration request unavailable.");
      const result = exact(await request(signal, command, csrf, approvalMode), [
        "status",
        "resultingVersion",
      ]);
      if (
        !["Applied", "AlreadyApplied"].includes(String(result.status)) ||
        result.resultingVersion !==
          command.expectedVersion + (command.command === "SaveDraft" ? 1 : 0)
      )
        throw new Error("Configuration request unavailable.");
    },
    async saveHoursDraft(command: StoreHoursDraftCommand, csrf: string, signal: AbortSignal) {
      const result = exact(await request(signal, command, csrf), ["status", "resultingVersion"]);
      if (
        !["Applied", "AlreadyApplied"].includes(String(result.status)) ||
        result.resultingVersion !== command.expectedVersion + 1
      )
        throw new Error("Configuration request unavailable.");
    },
  });
}
