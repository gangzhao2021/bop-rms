import {
  forgetKeptThroughLanguageSwitch,
  keepThroughLanguageSwitch,
  listSeparator,
  serviceModeText,
  t,
  takeKeptThroughLanguageSwitch,
  holdUnsavedWork,
} from "./i18n/i18n.js";
import { wordGap } from "./word-gap.js";
export { wordGap };
import { StoreConfigurationOrdinaryPanel } from "./StoreConfigurationOrdinaryPanel.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import { createStoreConfigurationOrdinaryClient } from "./store-configuration-ordinary-client.js";
import { createStoreConfigurationPendingJournal } from "./store-configuration-pending-journal.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { ReceiptTemplateStoreSelection } from "./ReceiptTemplateStoreSelection.js";
import { ReceiptTemplateArtifactEditor } from "./ReceiptTemplateArtifactEditor.js";
import { ReceiptTemplateDraftEditor } from "./ReceiptTemplateDraftEditor.js";
import { storeSetupMissingItems, type StoreSetupLayout } from "./store-setup-missing.js";
import { createStorePublicProfileClient } from "./store-public-profile-client.js";
import {
  createStorePaymentConfigurationClient,
  parseStorePaymentConfigurationContent,
  type StorePaymentConfigurationCurrent,
  type StorePaymentConfigurationCursor,
  type StorePaymentConfigurationContent,
} from "./store-payment-configuration-client.js";
import {
  createStorePaymentConfigurationPendingJournal,
  type StorePaymentConfigurationPendingJournal,
} from "./store-payment-configuration-pending-journal.js";
import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferenceContent,
  type StoreSetupReferenceKind,
  type StoreSetupReferencesCurrent,
  type StoreSetupReferenceCursor,
} from "./store-setup-reference-client.js";
import {
  createStoreSetupReferencePendingJournal,
  type StoreSetupReferencePendingJournal,
} from "./store-setup-reference-pending-journal.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { lazyPage } from "./route-chunks.js";
import {
  loadOpeningListRead,
  StoreProfilePublishedContext,
  StoreSetupInPlaceContext,
  StoreSetupOwnerOnlyContext,
} from "./store-opening-list-client.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  createUnconfiguredStoreSetupContentV2,
  normalizeStoreSetupContentV2,
  storeSetupFeeCharges,
  type StoreSetupFeeContext,
  parseStoreSetupContent,
  StoreSetupClientError,
  type StoreSetupContent,
  type StoreSetupWorkspace,
  type StoreSetupCursor,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  createStoreSetupPendingJournal,
  type StoreSetupPendingJournal,
} from "./store-setup-pending-journal.js";
import { serviceOperationReference, type ServiceMode } from "./service-control-client.js";
import { plainLanguageName } from "./staff-text.js";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import {
  storeTimeZoneChoices,
  storeTimeZoneName,
  storeTimeZoneNamesApart,
} from "./time-zone-names.js";
import { useScrollToAnchor } from "./scroll-to-anchor.js";
const StoreFirstOpeningPanel = lazyPage(
  () => import("./StoreFirstOpeningPanel.js"),
  "StoreFirstOpeningPanel",
);
type OpeningPublished = import("./StoreFirstOpeningPanel.js").OpeningPublished;
type OpeningListStill = import("./StoreFirstOpeningPanel.js").OpeningListStill;
const steps = [
  t("Identity"),
  t("Address and timezone"),
  t("Service modes"),
  t("Hours"),
  t("Tax and payment"),
  t("Capacity"),
  t("Contacts"),
  t("Review"),
] as const;
/**
 * b18 (Owner 2026-11-14 "opening wizard only while a store is being opened"): an open Store's
 * "Settings that need approval" shows only the steps whose settings need approval there. Identity
 * is read-only, opening hours are changed in Hours & ordering, the name, address and phone in Store
 * details, and order limits are asked with the services. Indices are the eight steps above.
 */
const openStoreSteps = [1, 2, 4, 7] as const;
const openStoreStepNames: Readonly<Record<number, string>> = {
  1: t("Time zone and business day"),
  2: t("Services"),
  4: t("Fees, tax and payment"),
  7: t("Review and publish"),
};
const days = [
  t("Monday"),
  t("Tuesday"),
  t("Wednesday"),
  t("Thursday"),
  t("Friday"),
  t("Saturday"),
  t("Sunday"),
];
const modes: readonly ServiceMode[] = ["DineIn", "Pickup", "Delivery"];
export interface StoreSetupHourInput {
  readonly start: string;
  readonly end: string;
  readonly followingDay: boolean;
  readonly modes: readonly ServiceMode[];
  /** Staff type wait times in whole minutes; the stored contract keeps seconds. */
  readonly cutoff: string;
  readonly lead: string;
  /**
   * The saved seconds behind a prefilled minute field, kept until staff edit that field (then
   * null). A saved value that is not a whole number of minutes (e.g. 90 seconds) is shown rounded
   * (2) but saved back unchanged, so opening and saving setup never alters a value staff did not
   * touch; typing any value replaces it with exactly that many minutes.
   */
  readonly savedCutoffSeconds?: number | null;
  readonly savedLeadSeconds?: number | null;
}
/** Largest wait the contract accepts: 86,400 seconds = 24 hours = 1,440 minutes. */
const maxWaitMinutes = 1440;
/** Minutes shown for saved seconds; rounded only for display (see StoreSetupHourInput). */
export const waitMinutesText = (seconds: number) => String(Math.round(seconds / 60));
/** "1 minute 30 seconds" for a saved wait that is not a whole number of minutes. */
export function savedWaitText(seconds: number): string {
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  return [
    minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
    rest > 0 ? `${rest} second${rest === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
export interface StoreSetupEditorInputs {
  readonly timeZone: string;
  readonly businessStart: string;
  readonly serviceModes: readonly ServiceMode[];
  readonly hours: readonly (readonly StoreSetupHourInput[])[] | null;
}
/** Shown only when a saved wait is not a whole number of minutes and staff have not edited it. */
function SavedWaitNote({ seconds }: { readonly seconds?: number | null | undefined }) {
  if (typeof seconds !== "number" || seconds % 60 === 0) return null;
  return (
    <p>
      {t("Saved as {seconds}. It stays as saved unless you change it here.", {
        seconds: savedWaitText(seconds),
      })}
    </p>
  );
}
/** b19: a time field shows hours and minutes ("04:00", not "04:00:00 AM"); a saved time with
 * seconds other than zero (never entered here) is shown whole so it is never changed unseen. */
export const clockField = (value: string) =>
  /^\d{2}:\d{2}:00$/u.test(value) ? value.slice(0, 5) : value;
function editInputs(content: StoreSetupContent): StoreSetupEditorInputs {
  return {
    timeZone: content.timeZone.state === "Configured" ? content.timeZone.value : "",
    businessStart:
      content.businessDayStartLocalTime.state === "Configured"
        ? clockField(content.businessDayStartLocalTime.value)
        : "",
    serviceModes:
      content.enabledServiceModes.state === "Configured" ? content.enabledServiceModes.value : [],
    hours:
      content.weeklySchedule.state === "Configured"
        ? content.weeklySchedule.value.map((day) =>
            day.intervals.map((i) => ({
              start: i.startLocalTime,
              end: i.endLocalTime,
              followingDay: i.endsNextDay,
              modes: i.serviceModes,
              cutoff: waitMinutesText(i.orderCutoffSeconds),
              lead: waitMinutesText(i.leadTimeSeconds),
              savedCutoffSeconds: i.orderCutoffSeconds,
              savedLeadSeconds: i.leadTimeSeconds,
            })),
          )
        : null,
  };
}
/** Ordinary raw input remains local while offline or an original is pending.
 * The closed wire parser is used before reservation; invalid text is not coerced. */
export function buildStoreSetupEditedContent(
  content: StoreSetupContent,
  inputs: StoreSetupEditorInputs,
): StoreSetupContent {
  const configured = <T,>(value: T) => ({ state: "Configured" as const, value }),
    empty = { state: "Unconfigured" as const };
  const waitSeconds = (minutes: string, saved: number | null | undefined) => {
    if (typeof saved === "number" && minutes === waitMinutesText(saved)) return saved;
    if (!/^\d+$/u.test(minutes) || Number(minutes) > maxWaitMinutes)
      throw new StoreSetupClientError("Invalid");
    return Number(minutes) * 60;
  };
  const time = (value: string) => (/^\d{2}:\d{2}$/u.test(value) ? value + ":00" : value);
  const weeklySchedule =
    inputs.hours === null
      ? empty
      : configured(
          inputs.hours.map((intervals, i) => ({
            isoWeekday: i + 1,
            intervals: intervals.map((value) => ({
              startLocalTime: time(value.start),
              endLocalTime: time(value.end),
              endsNextDay: value.followingDay,
              serviceModes: value.modes,
              orderCutoffSeconds: waitSeconds(value.cutoff, value.savedCutoffSeconds),
              leadTimeSeconds: waitSeconds(value.lead, value.savedLeadSeconds),
            })),
          })),
        );
  return parseStoreSetupContent({
    ...content,
    timeZone: inputs.timeZone === "" ? empty : configured(inputs.timeZone),
    businessDayStartLocalTime:
      inputs.businessStart === "" ? empty : configured(time(inputs.businessStart)),
    enabledServiceModes: inputs.serviceModes.length === 0 ? empty : configured(inputs.serviceModes),
    weeklySchedule,
  });
}
/** The actual page uses this reserve-before-dispatch routine. Storage failure
 * never dispatches, and a reserved original survives all transport failures. */
export async function dispatchStoreSetupDraft(input: {
  readonly client: ReturnType<typeof createStoreSetupClient>;
  readonly journal: StoreSetupPendingJournal;
  readonly baseline: StoreSetupWorkspace;
  readonly content: StoreSetupContent;
  readonly csrf: string;
  readonly signal: AbortSignal;
  readonly onReserved: (cursor: StoreSetupCursor) => void;
}) {
  const { client, journal, baseline, content, csrf, signal, onReserved } = input;
  const fresh = await client.load({
    storeReference: baseline.scope.storeReference,
    expectedScope: baseline.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("Unavailable");
  if (!sameRoot(baseline, fresh)) throw new StoreSetupClientError("Conflict");
  const prepared = await client.prepare({
    expectedScope: fresh.scope,
    operationReference: serviceOperationReference(),
    expectedSetupReference: root(baseline).reference,
    expectedRevision: root(baseline).revision,
    content,
  });
  if (signal.aborted) throw new StoreSetupClientError("Unavailable");
  await journal.reserve(prepared.cursor);
  onReserved(prepared.cursor);
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  const receipt = await client.execute(prepared, { csrf, signal });
  const workspace = await client.load({
    storeReference: fresh.scope.storeReference,
    expectedScope: fresh.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  await journal.complete(prepared.cursor, receipt, workspace);
  return { receipt, workspace };
}
export async function recoverStoreSetupDraft(input: {
  readonly client: ReturnType<typeof createStoreSetupClient>;
  readonly journal: StoreSetupPendingJournal;
  readonly cursor: StoreSetupCursor;
  readonly csrf: string;
  readonly signal: AbortSignal;
}) {
  const { client, journal, cursor, csrf, signal } = input;
  const receipt = await client.resolve(cursor, { csrf, signal });
  const workspace = await client.load({
    storeReference: cursor.scope.storeReference,
    expectedScope: cursor.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  await journal.complete(cursor, receipt, workspace);
  return { receipt, workspace };
}
const messages: Record<StoreSetupClientError["code"], string> = {
  Invalid: t(
    "Check the edited settings. Each service interval needs valid times and at least one service mode. Wait times are whole minutes, up to 24 hours (1,440 minutes). A service charge or delivery fee that is On needs a tax classification that is still in use, and every fee that is On needs at least one order type.",
  ),
  Denied: t("Your current permission or selected Store does not allow this action."),
  Conflict: t(
    "The saved settings or their baseline changed. Refresh, then discard your local edits to use the latest saved version.",
  ),
  Unavailable: t(
    "The current Store settings could not be loaded. Connect and refresh to try again.",
  ),
  OutcomeUnknown: t(
    "The save result could not be confirmed. Recover the original save before making another change.",
  ),
  ScopeChanged: t(
    "The selected Store or signed-in session changed. Open setup for the current Store.",
  ),
  Stale: t("The current settings check expired. Refresh to read the current Store again."),
  NotRegistered: t("No tax classifications are set up for this Brand yet."),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  SoleOperatorNotInEffect: t(
    "Sole operator is not in effect for you now, so another person with Owner access must approve this.",
  ),
  SoleOperatorNeedsVerification: t(
    "Your verification is more than 15 minutes old. Verify again, then approve.",
  ),
  SoleOperatorOff: t(
    "Sole operator is off, so another person with Owner access must approve this. If you run this business on your own, turn on Sole operator in Store setup, then approve again.",
  ),
  NotYourChange: t(
    "Only the person who made this configuration can check it or send it for approval. Ask them to, or approve or decline it.",
  ),
  SetupIncomplete: t(
    "The saved setup still has settings that are not set (see the list in this step). Finish them, save the setup, then create the configuration.",
  ),
  SetupOutdated: t(
    "The Store's configuration changed after this setup was saved. Save the setup again, then create the configuration.",
  ),
  OpenChangeByAnother: t(
    "Someone else's configuration change is still waiting. It must be approved and published, or declined, before a new configuration can be created.",
  ),
  Withdrawn: t(
    "This configuration was withdrawn or declined. Create a new one from the saved setup.",
  ),
  SoleOperatorApprovalInvalid: t(
    "This configuration was approved by you alone while Sole operator was off, so it cannot be published. Withdraw it, then send a new change for approval.",
  ),
  ReceiptTemplateUnavailable: t(
    "This Store has no receipt template in use yet, so nothing was created. In the fees, tax and payment step, choose or create this Store's receipt template and save the setup, then create the configuration again.",
  ),
  StorePhoneRequired: t(
    "This setup offers pickup, and pickup guests call the store about allergies or their order, so it was not sent. Add the store's phone number in Store details, or take pickup out of the services this setup offers, then send it again.",
  ),
};
const root = (view: StoreSetupWorkspace) => ({
  reference: view.setup.snapshot?.setupDraftReference ?? null,
  revision: view.setup.snapshot?.revision ?? 0,
});
const sameRoot = (a: StoreSetupWorkspace, b: StoreSetupWorkspace) =>
  JSON.stringify(root(a)) === JSON.stringify(root(b));
const feeLabel = (chargeType: string) =>
  chargeType === "ServiceCharge"
    ? t("Service charge")
    : chargeType === "DeliveryFee"
      ? t("Delivery fee")
      : t("Tip");
function SavedReference({ value }: { value: StoreSetupContent["addressReference"] }) {
  return <p>{value.state === "Configured" ? t("Already configured.") : t("Not configured.")}</p>;
}
/**
 * v15 finding: a Store Manager reads this page (organization.store.read) but only the Owner changes
 * setup (organization.manage). When the setup read itself is refused, the setup steps are
 * permission-trimmed: no "not allowed" error and no refresh of a draft they cannot read, while the
 * Store sections on the page stay readable with their own "Only the Owner can change" notes.
 */
export function storeSetupOwnerOnly(
  error: StoreSetupClientError["code"] | null,
  workspace: StoreSetupWorkspace | null,
  sameStore: boolean,
): boolean {
  return error === "Denied" && workspace === null && sameStore;
}
export function StoreSetupHeader({
  ownerOnly,
  displayName,
}: {
  readonly ownerOnly: boolean;
  readonly displayName: string | null;
  /** Kept for callers; the draft's own controls are in the draft place (b18). */
  readonly refreshDisabled?: boolean;
  readonly onRefresh?: () => void;
  readonly firstStore?: boolean;
  readonly draft?: boolean;
}) {
  return (
    <header className="screen-heading">
      <div>
        <h2>{t("Store setup")}</h2>
        {displayName !== null && <p>{displayName}</p>}
        {ownerOnly ? (
          <p role="note">
            {t(
              "Only the Owner can change Store setup. You can see the details customers and receipts use below.",
            )}
          </p>
        ) : null}
      </div>
      {/* Owner 2026-10-26 (v3): the language switch ends the title row, as on Orders. The draft's
          "Restore the last saved draft" sits with the draft, not in this corner (b18 review). */}
      <LanguageSwitch className="workspace-page__language" />
    </header>
  );
}
/**
 * b18: reading the saved draft again belongs to the place that keeps a draft. It keeps unsaved
 * edits and says so if someone else saved in between.
 */
export function StoreSetupReloadDraft({
  disabled,
  onReload,
}: {
  readonly disabled: boolean;
  readonly onReload: () => void;
}) {
  return (
    <p className="store-setup-reload">
      <button type="button" disabled={disabled} onClick={onReload}>
        {t("Restore the last saved draft")}
      </button>
    </p>
  );
}
/**
 * b18 (Owner 2026-11-14 "先改吧，太多了我记不住"): an open Store's setup is a few places, each doing
 * one thing and saying whether a change is live at once or a draft that needs approval. The
 * address keeps working with the anchors other pages already link to (#kitchen-setup, …).
 */
export type StoreSetupPlace = "profile" | "receipts" | "kitchen" | "access" | "changes";
export const storeSetupPlaces: readonly StoreSetupPlace[] = [
  "profile",
  "receipts",
  "kitchen",
  "access",
  "changes",
];
const placeAnchors: Readonly<Record<string, StoreSetupPlace>> = {
  "#store-public-profile": "profile",
  "#receipts-and-privacy": "receipts",
  "#kitchen-setup": "kitchen",
  "#support-access": "access",
  "#sole-operator": "access",
  "#store-setup-changes": "changes",
};
/** The place an address asks for: `?section=` first, then an anchor other pages link to. */
export function storeSetupPlaceOf(search: string, hash: string): StoreSetupPlace | null {
  const asked = new URLSearchParams(search).get("section");
  if (asked !== null && (storeSetupPlaces as readonly string[]).includes(asked))
    return asked as StoreSetupPlace;
  return placeAnchors[hash] ?? null;
}
export const storeSetupPlaceHref = (storeReference: string, place: StoreSetupPlace) =>
  "/app/organization/stores/" +
  storeReference +
  "/setup" +
  (place === "profile" ? "" : "?section=" + place);
/** Each place's name, and one line on what it holds and when a change there takes effect. */
export function storeSetupPlaceText(
  place: StoreSetupPlace,
  /** b19: the reader cannot change anything here (a Store Manager): no "live once you save it". */
  readOnly = false,
): {
  readonly name: string;
  readonly lead: string;
} {
  switch (place) {
    case "profile":
      return {
        name: t("Store details"),
        lead: readOnly
          ? t("The name, address and phone customers see.")
          : t(
              "The name, address and phone customers see. A change is live as soon as you save it.",
            ),
      };
    case "receipts":
      return {
        name: t("Receipts and tax numbers"),
        lead: readOnly
          ? t("The business name and tax numbers printed on receipts, and your privacy notice.")
          : t(
              "The business name and tax numbers printed on receipts, and your privacy notice. A change is live as soon as you save it, for receipts issued from then on.",
            ),
      };
    case "kitchen":
      return {
        name: t("Kitchen setup"),
        lead: readOnly
          ? t("Whether every dish reaches this Store's Kitchen screen.")
          : t(
              "Whether every dish reaches this Store's Kitchen screen. A change is live at once, for orders confirmed from then on.",
            ),
      };
    case "access":
      return {
        name: t("Permissions and safety"),
        lead: t(
          "Who besides you may change things: platform support, and approving your own changes when you run the business alone. Each change is live at once and is recorded.",
        ),
      };
    case "changes":
      return {
        name: t("Settings that need approval"),
        lead: t(
          "Time zone, services, fees, tax, payment and receipt layout. A change here is saved as a draft first; it takes effect only after it is submitted, approved and published in the last step.",
        ),
      };
  }
}
/** One section of an open Store's setup, in the place it belongs to. */
export interface StoreSetupPanel {
  readonly place: Exclude<StoreSetupPlace, "changes">;
  readonly key: string;
  /** The section, told how to say "this person doesn't see me" (then its place is not offered). */
  readonly render: (onHidden: () => void) => ReactNode;
}
/** The places an open Store's setup offers, as text links (no boxes, the selected one marked). */
function StoreSetupPlaces({
  storeReference,
  places,
  selected,
}: {
  readonly storeReference: string;
  readonly places: readonly StoreSetupPlace[];
  readonly selected: StoreSetupPlace;
}) {
  return (
    <nav className="store-setup-places" aria-label={t("Store setup sections")}>
      <ul>
        {places.map((place) => (
          <li key={place}>
            <Link
              to={storeSetupPlaceHref(storeReference, place)}
              aria-current={place === selected ? "page" : undefined}
            >
              {storeSetupPlaceText(place).name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
/**
 * WP-2423 item 14: on a first Store everything Store setup offers an established one stays usable,
 * folded under the one page. Nothing in it is read until it is opened; a link to one of its sections
 * opens it.
 */
function FirstStoreFold({
  active,
  panel,
  status,
  sections,
  children,
}: {
  readonly active: boolean;
  readonly panel: ReactNode;
  /** What the step-by-step settings have to say about themselves: it belongs with them. */
  readonly status: ReactNode;
  readonly sections: ReactNode;
  readonly children: ReactNode;
}) {
  const { hash } = useLocation();
  const [opened, setOpened] = useState(false);
  if (!active) return <>{children}</>;
  const open = opened || (hash !== "" && hash !== "#store-opening");
  return (
    <>
      {panel}
      <details
        className="store-opening__all"
        open={open}
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary>{t("All settings, step by step")}</summary>
        {open ? (
          <>
            {status}
            {sections}
            {children}
          </>
        ) : null}
      </details>
    </>
  );
}
/**
 * b20 (v15 live check): fields typed in a place of Store setup and not saved yet hold the language
 * switch, which then asks first (as other forms do) instead of reloading them away.
 */
function useUnsavedHold() {
  const release = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      release.current?.();
      release.current = null;
    },
    [],
  );
  return useMemo(
    () => ({
      mark: () => {
        release.current ??= holdUnsavedWork();
      },
      clear: () => {
        release.current?.();
        release.current = null;
      },
    }),
    [],
  );
}
/** b20: the unsaved edits Store setup keeps across the language switch's reload, in this tab. */
export interface StoreSetupKeptEdits {
  readonly setupDraftReference: string | null;
  readonly revision: number | null;
  readonly content: StoreSetupContent;
  readonly inputs: StoreSetupEditorInputs;
  readonly step: number;
}
export const storeSetupKeptKey = (storeReference: string) => "storeSetup:" + storeReference;
const keptText = (value: unknown, max = 64) => typeof value === "string" && value.length <= max;
const keptModes = (value: unknown): value is readonly ServiceMode[] =>
  Array.isArray(value) &&
  value.length <= modes.length &&
  value.every((mode) => modes.includes(mode as ServiceMode));
const keptHour = (value: unknown): value is StoreSetupHourInput => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const h = value as Record<string, unknown>;
  const seconds = (v: unknown) =>
    v === undefined || v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  return (
    keptText(h.start, 8) &&
    keptText(h.end, 8) &&
    typeof h.followingDay === "boolean" &&
    keptModes(h.modes) &&
    keptText(h.cutoff, 8) &&
    keptText(h.lead, 8) &&
    seconds(h.savedCutoffSeconds) &&
    seconds(h.savedLeadSeconds)
  );
};
/**
 * b20 (v15 live check): what Store setup kept at a language switch, read back against the saved
 * draft the reloaded page shows. "Outdated" when the draft was saved again in between (the edits
 * then build on something else, so they are not brought back and the page says so); null when
 * nothing usable was kept.
 */
export function storeSetupKeptEdits(
  value: unknown,
  saved: { readonly setupDraftReference: string; readonly revision: number } | null,
): Omit<StoreSetupKeptEdits, "setupDraftReference" | "revision"> | "Outdated" | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const k = value as Record<string, unknown>;
  const i = k.inputs as Record<string, unknown> | null | undefined;
  if (
    !(k.setupDraftReference === null || keptText(k.setupDraftReference, 128)) ||
    !(
      k.revision === null ||
      (typeof k.revision === "number" && Number.isSafeInteger(k.revision))
    ) ||
    typeof k.step !== "number" ||
    !Number.isSafeInteger(k.step) ||
    k.step < 0 ||
    k.step >= steps.length ||
    i === null ||
    typeof i !== "object" ||
    !keptText(i.timeZone) ||
    !keptText(i.businessStart, 8) ||
    !keptModes(i.serviceModes) ||
    !(
      i.hours === null ||
      (Array.isArray(i.hours) &&
        i.hours.length === 7 &&
        i.hours.every((day) => Array.isArray(day) && day.length <= 12 && day.every(keptHour)))
    )
  )
    return null;
  let content: StoreSetupContent;
  try {
    content = normalizeStoreSetupContentV2(parseStoreSetupContent(k.content));
  } catch {
    return null;
  }
  if (
    k.setupDraftReference !== (saved?.setupDraftReference ?? null) ||
    k.revision !== (saved?.revision ?? null)
  )
    return "Outdated";
  return { content, inputs: i as unknown as StoreSetupEditorInputs, step: k.step };
}
export function StoreSetupDraftPage({
  storeReference,
  csrf,
  client: injected,
  journalFactory = createStoreSetupPendingJournal,
  children,
  taxClassificationsHref,
  fetcher,
  staffRoles,
  panels,
}: {
  readonly storeReference: string;
  readonly csrf: string;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StoreSetupPendingJournal;
  /** Store-level sections shown above the setup steps (WP-2423 Q15/Q16 receipts and privacy). */
  readonly children?: ReactNode;
  /** Where the Brand Owner manages tax classifications (only for people who can). */
  readonly taxClassificationsHref?: string;
  /** Test seam: the opening read's transport. */
  readonly fetcher?: typeof fetch;
  /**
   * WP-2423 store-type starter roles: "Who does what", shown on a first Store's one page too (never
   * folded), for people who may change roles.
   */
  readonly staffRoles?: ReactNode;
  /**
   * b18: the Store's own sections (name and contact, receipts, kitchen, permissions), each in its
   * place. On a first Store they all sit folded under the one page, as before.
   */
  readonly panels?: readonly StoreSetupPanel[];
}) {
  const { id } = useParams(),
    { search, hash } = useLocation(),
    client = useMemo(() => injected ?? createStoreSetupClient(), [injected]),
    feeClient = useMemo(() => createStoreSetupClient(), []);
  // b19: a link to a section (#sole-operator from Approvals) brings it into view once it loads.
  useScrollToAnchor(hash);
  const [workspace, setWorkspace] = useState<StoreSetupWorkspace | null>(null),
    [baseline, setBaseline] = useState<StoreSetupWorkspace | null>(null),
    [content, setContent] = useState<StoreSetupContent>(createUnconfiguredStoreSetupContentV2),
    [inputs, setInputs] = useState<StoreSetupEditorInputs>(() =>
      editInputs(createUnconfiguredStoreSetupContent()),
    ),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<StoreSetupCursor | null>(null),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState(""),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine),
    [ready, setReady] = useState(false),
    [setupAnswered, setSetupAnswered] = useState(false),
    [live, setLive] = useState<StoreSetupLiveConfiguration | null>(null);
  const running = useRef(false),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    journal = useRef<StoreSetupPendingJournal | null>(null),
    savedScope = useRef<StoreSetupScope | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null);
  // b20 (v15 live check): switching the language reloads the page; edits not saved yet come back
  // with it (this tab only, for a minute), so a language switch never drops them unseen.
  const keptKey = storeSetupKeptKey(storeReference);
  const keptNow = useRef<StoreSetupKeptEdits | null>(null);
  keptNow.current =
    dirty && baseline !== null
      ? {
          setupDraftReference: baseline.setup.snapshot?.setupDraftReference ?? null,
          revision: baseline.setup.snapshot?.revision ?? null,
          content,
          inputs,
          step,
        }
      : null;
  useEffect(() => keepThroughLanguageSwitch(keptKey, () => keptNow.current), [keptKey]);
  const current = (value: number, signal: AbortSignal) =>
    value === epoch.current && !signal.aborted;
  const apply = (view: StoreSetupWorkspace) => {
    const next = normalizeStoreSetupContentV2(
      view.setup.snapshot?.content ?? createUnconfiguredStoreSetupContent(),
    );
    setWorkspace(view);
    setBaseline(view);
    setContent(next);
    setInputs(editInputs(next));
    setDirty(false);
  };
  useEffect(() => {
    const request = new AbortController(),
      token = ++epoch.current;
    controller.current = request;
    running.current = true;
    setBusy(true);
    setReady(false);
    setError(null);
    setWorkspace(null);
    setPending(null);
    savedScope.current = null;
    journal.current = null;
    const offline = () => {
      setOnline(false);
      controller.current?.abort();
      setError("Unavailable");
      setBusy(false);
      running.current = false;
    };
    const reconnect = () => setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", reconnect);
    setSetupAnswered(false);
    if (id !== storeReference) {
      setError("ScopeChanged");
      setBusy(false);
      running.current = false;
      setSetupAnswered(true);
    } else if (!navigator.onLine) {
      setBusy(false);
      running.current = false;
      setError("Unavailable");
      setSetupAnswered(true);
    } else
      void client
        .load({ storeReference, signal: request.signal })
        .then(async (view) => {
          if (!current(token, request.signal)) return;
          const original = journalFactory(view.scope);
          const cursor = await original.load();
          if (!current(token, request.signal)) return;
          savedScope.current = view.scope;
          journal.current = original;
          apply(view);
          const kept = storeSetupKeptEdits(
            takeKeptThroughLanguageSwitch(keptKey),
            view.setup.snapshot ?? null,
          );
          forgetKeptThroughLanguageSwitch(keptKey);
          if (kept === "Outdated")
            setNotice(
              t(
                "What you had not saved before switching the language was not brought back: this setup was saved again in between. Make those changes again here.",
              ),
            );
          else if (kept !== null && cursor === null) {
            setContent(kept.content);
            setInputs(kept.inputs);
            setStep(kept.step);
            setDirty(true);
            setNotice(
              t(
                "Your changes that are not saved yet are kept after switching the language. Save as draft to keep them.",
              ),
            );
          }
          setPending(cursor);
          setReady(true);
          if (cursor)
            setNotice(
              t(
                "An earlier save needs recovery. Your new changes stay locked until its result is known.",
              ),
            );
        })
        .catch((value: unknown) => {
          if (current(token, request.signal))
            setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
        })
        .finally(() => {
          if (token === epoch.current) {
            setBusy(false);
            running.current = false;
            setSetupAnswered(true);
          }
        });
    return () => {
      epoch.current++;
      request.abort();
      controller.current?.abort();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", reconnect);
    };
    // keptKey follows storeReference.
  }, [client, csrf, id, journalFactory, storeReference]);
  const begin = () => {
    running.current = true;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const token = ++epoch.current;
    setBusy(true);
    setError(null);
    setNotice("");
    return { request, token };
  };
  const refresh = async (discard = false) => {
    if (running.current || busy || !online || id !== storeReference) return;
    const { request, token } = begin();
    try {
      const view = await client.load({
        storeReference,
        ...(savedScope.current ? { expectedScope: savedScope.current } : {}),
        signal: request.signal,
      });
      if (!current(token, request.signal)) return;
      const original = journal.current ?? journalFactory(view.scope),
        cursor = await original.load();
      if (!current(token, request.signal)) return;
      // A save this page was holding was settled elsewhere (a first opening's run, another tab):
      // what the server says now is what stands.
      const settledElsewhere = pending !== null && cursor === null;
      journal.current = original;
      savedScope.current = view.scope;
      setPending(cursor);
      if (settledElsewhere) setNotice("");
      if (discard || !dirty || settledElsewhere) apply(view);
      else {
        setWorkspace(view);
        if (baseline && !sameRoot(baseline, view)) setError("Conflict");
      }
      setReady(true);
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const save = async () => {
    if (
      running.current ||
      !ready ||
      !workspace ||
      !baseline ||
      busy ||
      pending ||
      !online ||
      id !== storeReference ||
      !journal.current
    )
      return;
    const activeJournal = journal.current;
    let candidate: StoreSetupContent;
    try {
      candidate = buildStoreSetupEditedContent(content, inputs);
    } catch {
      setError("Invalid");
      setStep(7);
      heading.current?.focus();
      return;
    }
    const { request, token } = begin();
    try {
      if (
        candidate.feeContexts?.state === "Configured" &&
        candidate.feeContexts.value.some(
          // WP-2423 (v15 D7): a Tip On without a tax classification needs no classification read.
          (v) => v.state === "Enabled" && v.taxClassificationReference !== null,
        )
      ) {
        const choices = await feeClient.classifications({
          storeReference,
          expectedScope: workspace.scope,
          signal: request.signal,
        });
        validateStoreSetupFeeSelections(candidate, choices);
        if (!current(token, request.signal)) return;
      }
      const result = await dispatchStoreSetupDraft({
        client,
        journal: activeJournal,
        baseline,
        content: candidate,
        csrf,
        signal: request.signal,
        onReserved: (cursor) => {
          if (token === epoch.current) setPending(cursor);
        },
      });
      if (!current(token, request.signal)) return;
      const { receipt, workspace: after } = result;
      setPending(null);
      apply(after);
      setNotice(
        receipt.outcome === "Committed"
          ? t("Setup draft saved. These settings have not been validated or published.")
          : t("The original save was not committed. You can continue editing."),
      );
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const recover = async () => {
    if (running.current || busy || !online || !pending || !journal.current) return;
    const activeJournal = journal.current,
      original = pending;
    // Settled elsewhere since this page read it: nothing is left to recover, only to read again.
    if ((await activeJournal.load()) === null) {
      setPending(null);
      await refresh(true);
      return;
    }
    const { request, token } = begin();
    try {
      const { receipt, workspace: fresh } = await recoverStoreSetupDraft({
        client,
        journal: activeJournal,
        cursor: original,
        csrf,
        signal: request.signal,
      });
      if (!current(token, request.signal)) return;
      setPending(null);
      apply(fresh);
      setNotice(
        receipt.outcome === "Committed"
          ? t("The original save was committed. Current saved settings are shown.")
          : t("The original save was not committed. You can continue with a new save."),
      );
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const changeInputs = (change: Partial<StoreSetupEditorInputs>) => {
    setInputs((old) => ({ ...old, ...change }));
    setDirty(true);
    setError(null);
  };
  const changeContent = (change: Partial<StoreSetupContent>) => {
    setContent((old) => ({ ...old, ...change }));
    setDirty(true);
    setError(null);
  };
  const disabled = busy || !!pending || !online || !ready;
  const intervalChange = (day: number, index: number, change: Partial<StoreSetupHourInput>) => {
    const hours = inputs.hours;
    if (!hours) return;
    changeInputs({
      hours: hours.map((values, i) =>
        i !== day
          ? values
          : values.map((value, j) => (j !== index ? value : { ...value, ...change })),
      ),
    });
  };
  // b21: Canadian zones by plain name; the zone the Store runs on, the saved one and the one chosen
  // stay selectable even when they are not on that list.
  const runningZone = workspace?.store.timeZone ?? "",
    savedZone = content.timeZone.state === "Configured" ? content.timeZone.value : "";
  const zones = useMemo(
    () => storeTimeZoneChoices([runningZone, savedZone, inputs.timeZone]),
    [runningZone, savedZone, inputs.timeZone],
  );
  let parsed: StoreSetupContent | null = null;
  try {
    parsed = buildStoreSetupEditedContent(content, inputs);
  } catch {
    /* Review shows a safe validation state; local raw input remains. */
  }
  const ownerOnly = storeSetupOwnerOnly(error, workspace, id === storeReference);
  // WP-2423 item 14 (DEC-STORE-FIRST-OPENING): a Store whose setup has not been published gets one
  // page and one action, and only once a read has said so. A read that fails shows the page as it
  // always was: an established Store never loses its page to a moment's failure, and a first Store
  // still has every step. Someone who can't read the setup is not asked anything.
  const [opening, setOpening] = useState<"Loading" | "First" | "Established" | "Failed">("Loading"),
    [publishedNote, setPublishedNote] = useState<{
      readonly text: string;
      readonly list: OpeningListStill;
    } | null>(null);
  useEffect(() => {
    const request = new AbortController();
    setOpening("Loading");
    loadOpeningListRead(fetcher, request.signal).then(
      (view) => {
        if (!request.signal.aborted) setOpening(view.setupPublished ? "Established" : "First");
      },
      () => {
        if (!request.signal.aborted) setOpening("Failed");
      },
    );
    return () => request.abort();
  }, [fetcher, storeReference]);
  const profileSync = useRef<(() => void) | null>(null);
  const registerProfileSync = useCallback((sync: (() => void) | null) => {
    profileSync.current = sync;
  }, []);
  const profilePublished = useCallback(() => profileSync.current?.(), []);
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  });
  const openingPublished = useCallback((result: OpeningPublished, list: OpeningListStill) => {
    setPublishedNote(
      result.kind === "AlreadyPublished"
        ? {
            text: t(
              "This store's setup was already published, on another device or by another Owner, so what was on that page was not saved. Check the live settings below and change them here if you need to.",
            ),
            list: null,
          }
        : {
            text:
              list === null
                ? t("Your store setup is published.")
                : list.kind === "You"
                  ? t(
                      "Your store setup is published. The allergen list still needs your approval before you list a menu.",
                    )
                  : t(
                      "Your store setup is published. The allergen list is waiting for {people}. They approve it on Allergens.",
                      { people: list.people },
                    ),
            list,
          },
    );
    setOpening("Established");
    void latestRefresh.current(true);
  }, []);
  const firstStore = workspace !== null && id === storeReference && opening === "First";
  // Until the read has said which page this is, neither is drawn: one would only be swapped for the
  // other, and a first Store's sections, put there and then folded, would each load twice.
  const deciding = workspace !== null && id === storeReference && opening === "Loading";
  // b18: an open Store (setup published, or a read that could not say) shows the approval steps
  // only; a Store being opened walks all eight.
  const openLayout = workspace !== null && id === storeReference && !firstStore && !deciding;
  const shownSteps: readonly number[] = openLayout ? openStoreSteps : steps.map((_, i) => i);
  const activeStep = shownSteps.includes(step) ? step : (shownSteps[0] ?? 0);
  const stepName = (i: number) => (openLayout ? openStoreStepNames[i] : steps[i]) ?? "";
  const layout = openLayout ? "Open" : "Opening";
  const addressMissing = content.addressReference.state !== "Configured",
    contactMissing = content.contactReference.state !== "Configured";
  // An open Store whose saved setup has no address or contact yet: fill them in from Store details.
  const [profileSuggestion, setProfileSuggestion] = useState<{
    readonly address: Partial<StoreSetupReferenceFields>;
    readonly contact: Partial<StoreSetupReferenceFields>;
  } | null>(null);
  const wantsProfile = openLayout && activeStep === 7 && (addressMissing || contactMissing);
  useEffect(() => {
    if (!wantsProfile || profileSuggestion !== null) return;
    let stopped = false;
    void createStorePublicProfileClient({ csrf, ...(fetcher === undefined ? {} : { fetcher }) })
      .load()
      .then((view) => {
        if (stopped || view.current === null) return;
        const current = view.current;
        const name =
          current.names.find((entry) => entry.locale === current.defaultLocale)?.storeDisplayName ??
          current.names[0]?.storeDisplayName ??
          "";
        setProfileSuggestion({
          address: {
            countryCode: current.address.countryCode,
            regionCode: current.address.regionCode,
            locality: current.address.locality,
            postalCode: current.address.postalCode,
            line1: current.address.addressLines[0] ?? "",
            line2: current.address.addressLines[1] ?? "",
            line3: current.address.addressLines[2] ?? "",
          },
          contact: { contactName: name, businessPhone: current.businessPhone ?? "" },
        });
      })
      // Not read: the fields stay empty and the Owner types them, as before.
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [wantsProfile, profileSuggestion === null, csrf, fetcher]);
  const draftTimeZoneSaved = content.timeZone.state === "Configured",
    draftBusinessStartSaved = content.businessDayStartLocalTime.state === "Configured";
  // WP-2423 (v15): step 5 offers the receipt template the live Store issues receipts with; read
  // the live configuration once when it is needed (step 8 reads it again with its panel).
  // b18 review: an open Store's step 1 needs it too while the saved draft has no business day
  // start, so the field starts from the one the Store runs on instead of blank. That read waits
  // for this device's record of an unconfirmed configuration request: while one is waiting to be
  // recovered, nothing reads the live configuration before the recovery does.
  const liveScope = workspace ? JSON.stringify(workspace.scope) : null;
  const wantsLiveStart = openLayout && activeStep === 1 && !draftBusinessStartSaved;
  useEffect(() => {
    if (liveScope === null || workspace === null || live !== null) return;
    if (activeStep !== 4 && !wantsLiveStart) return;
    const c = new AbortController();
    void (async () => {
      if (activeStep !== 4) {
        const waiting = await createStoreConfigurationPendingJournal(workspace.scope).load();
        if (waiting !== null || c.signal.aborted) return;
      }
      const read = await createStoreConfigurationOrdinaryClient().load(workspace.scope, {
        signal: c.signal,
      });
      if (!c.signal.aborted)
        setLive((old) => old ?? { current: read.current, observedAt: read.observedAt });
    })().catch(() => undefined);
    return () => c.abort();
  }, [liveScope, activeStep, wantsLiveStart, live === null]);
  // b18 polish (Owner 2026-11-14): an open Store already runs on a time zone and a business day
  // start. While the saved draft has none and nothing was typed, the draft starts from them instead
  // of saying "Not configured"; saving the draft keeps them, as any other value in it. Until it is
  // saved, Review lists them as filled in but not saved (the publication checks the saved draft).
  const storeTimeZone = openLayout && workspace !== null ? workspace.store.timeZone : null;
  const liveStart = openLayout ? (live?.current?.businessDayStartLocalTime ?? null) : null;
  const liveBusinessStart = liveStart === null ? null : clockField(liveStart);
  useEffect(() => {
    if (storeTimeZone === null) return;
    setInputs((old) => {
      const timeZone =
        old.timeZone === "" && !draftTimeZoneSaved && storeTimeZone !== "" ? storeTimeZone : null;
      const businessStart =
        old.businessStart === "" && !draftBusinessStartSaved && liveBusinessStart !== null
          ? liveBusinessStart
          : null;
      if (timeZone === null && businessStart === null) return old;
      return {
        ...old,
        ...(timeZone === null ? {} : { timeZone }),
        ...(businessStart === null ? {} : { businessStart }),
      };
    });
  }, [storeTimeZone, liveBusinessStart, draftTimeZoneSaved, draftBusinessStartSaved, inputs]);
  // On a first Store these are about the steps under the fold (a save pending, a read that failed);
  // the one page says what concerns it. Above it they would read as something being wrong with it.
  const stepsStatus = (
    <>
      {error && !ownerOnly && (
        <p id="setup-validation-error" role="alert">
          {messages[error]}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">{t("Checking current Store settings…")}</p>}
      {pending && (
        <section className="store-setup-recovery" aria-label={t("Original save recovery")}>
          <p>{t("An earlier save has not been cleared. A new save is blocked.")}</p>
          <button type="button" disabled={busy || !online} onClick={() => void recover()}>
            {t("Recover original save")}
          </button>
        </section>
      )}
    </>
  );
  // b18: which places this person is offered. A section that says it is not for them drops out;
  // a place none of whose sections are for them is not offered. The draft place is not offered to
  // someone the setup read refuses (a Store Manager); a read that failed says so there.
  const [hiddenPanels, setHiddenPanels] = useState<ReadonlySet<string>>(() => new Set());
  const hidePanel = useCallback(
    (key: string) => setHiddenPanels((old) => (old.has(key) ? old : new Set([...old, key]))),
    [],
  );
  const hiders = useMemo(
    () => new Map((panels ?? []).map((panel) => [panel.key, () => hidePanel(panel.key)])),
    [panels, hidePanel],
  );
  const offered = storeSetupPlaces.filter((place) =>
    place === "changes"
      ? !ownerOnly
      : (panels ?? []).some((panel) => panel.place === place && !hiddenPanels.has(panel.key)),
  );
  const asked = storeSetupPlaceOf(search, hash);
  // An address for a place this person is not offered shows the first one they are.
  const place: StoreSetupPlace =
    asked !== null && offered.includes(asked) ? asked : (offered[0] ?? "profile");
  const placeText = storeSetupPlaceText(place, ownerOnly);
  const renderedPanels = (only: StoreSetupPlace | null) =>
    (panels ?? []).map((panel) => (
      <div
        key={panel.key}
        className="store-setup-place__panel"
        hidden={only !== null && panel.place !== only}
      >
        <StoreSetupInPlaceContext.Provider value={only !== null}>
          <StoreSetupOwnerOnlyContext.Provider value={ownerOnly}>
            <Suspense fallback={only === panel.place ? <p role="status">{t("Loading…")}</p> : null}>
              {panel.render(hiders.get(panel.key) ?? (() => undefined))}
            </Suspense>
          </StoreSetupOwnerOnlyContext.Provider>
        </StoreSetupInPlaceContext.Provider>
      </div>
    ));
  const established = id === storeReference && !firstStore && !deciding;
  const draftPlace = !established || place === "changes";
  const stepsShown = workspace !== null && !deciding && (firstStore || place === "changes");
  // Order limits: their own step while a Store is opened, asked with the services once it is open.
  const orderLimits = (
    <>
      <label>
        {t("Order limits")}
        <select
          disabled={
            disabled ||
            (content.capacityConfigurationReference.state === "Configured" &&
              content.capacityConfigurationReference.value !== null)
          }
          value={
            content.capacityConfigurationReference.state === "Unconfigured"
              ? "unconfigured"
              : content.capacityConfigurationReference.value === null
                ? "none"
                : "saved"
          }
          onChange={(e) =>
            changeContent({
              capacityConfigurationReference:
                e.currentTarget.value === "none"
                  ? { state: "Configured", value: null }
                  : { state: "Unconfigured" },
            })
          }
        >
          <option value="unconfigured">{t("Not decided yet")}</option>
          <option value="none">{t("No order limits")}</option>
          {content.capacityConfigurationReference.state === "Configured" &&
            content.capacityConfigurationReference.value !== null && (
              <option value="saved">{t("Limits saved earlier")}</option>
            )}
        </select>
      </label>
      <p>
        {t(
          "Choose “No order limits” when the Store accepts every order it receives; staff pause ordering from Hours & ordering when the kitchen is busy.",
        )}
      </p>
    </>
  );
  return (
    <AppFrame
      className="store-setup-draft-page"
      title={t("Store setup")}
      description={
        ownerOnly ? t("The Store's details") : t("Save unfinished settings and continue later")
      }
    >
      <StoreSetupHeader ownerOnly={ownerOnly} displayName={workspace?.store.displayName ?? null} />
      {publishedNote === null ? null : (
        <p role="status" className="store-opening__published">
          {publishedNote.text}{" "}
          {publishedNote.list?.kind === "You" ? (
            <Link to="/app/compliance/allergens">{t("Approve it on Allergens")}</Link>
          ) : (
            <Link to="/app/commerce/menus">{t("Add your menu")}</Link>
          )}
        </p>
      )}
      {id !== storeReference && (
        <StatePanel heading={t("Select this Store")} tone="error" status>
          <p>{t("Choose this Store in the workspace before opening its setup.")}</p>
        </StatePanel>
      )}
      {established && (opening !== "Loading" || setupAnswered) ? (
        <>
          <StoreSetupPlaces storeReference={storeReference} places={offered} selected={place} />
          {/* The selected link names the place; one line says when a change here takes effect. */}
          <div
            className="store-setup-place"
            id={place === "changes" ? "store-setup-changes" : undefined}
          >
            <p className="store-setup-place__lead">{placeText.lead}</p>
            {place === "changes" ? (
              <p className="store-setup-place__lead">
                {/* b19: Chinese runs words and links together; English puts a space between. */}
                {t("Opening hours and holidays are changed in")}
                {wordGap()}
                <Link to={"/app/organization/stores/" + storeReference + "/service"}>
                  {t("Hours & ordering")}
                </Link>
                {t("; the name, address and phone customers see in")}
                {wordGap()}
                <Link to={storeSetupPlaceHref(storeReference, "profile")}>
                  {t("Store details")}
                </Link>
                {t(", where a change is live as soon as you save it.")}
              </p>
            ) : null}
          </div>
          {children}
          {renderedPanels(place === "changes" ? "changes" : place)}
        </>
      ) : null}
      {/* b18 polish: before the draft is read (or when the read failed) this is how to read it
          again; once the steps show, it sits quietly under them. */}
      {draftPlace && !ownerOnly && !firstStore && !stepsShown ? (
        <StoreSetupReloadDraft
          disabled={busy || !online || id !== storeReference}
          onReload={() => void refresh()}
        />
      ) : null}
      {!online && (
        <p role="status">
          {t("Offline. Your local edits are retained. Reconnect and refresh before saving.")}
        </p>
      )}
      {firstStore || !draftPlace ? null : stepsStatus}
      {deciding ? <p role="status">{t("Loading…")}</p> : null}
      {stepsShown && workspace && (
        <FirstStoreFold
          active={firstStore}
          status={stepsStatus}
          sections={
            <StoreProfilePublishedContext.Provider value={profilePublished}>
              {children}
              {renderedPanels(null)}
            </StoreProfilePublishedContext.Provider>
          }
          panel={
            <Suspense fallback={<p role="status">{t("Loading your store…")}</p>}>
              <StoreFirstOpeningPanel
                scope={workspace.scope}
                locale={workspace.store.locale}
                csrf={csrf}
                onChanged={() => void refresh()}
                onPublished={openingPublished}
                registerProfileSync={registerProfileSync}
              />
            </Suspense>
          }
        >
          <nav className="store-setup-steps" aria-label={t("Setup steps")}>
            <ol>
              {shownSteps.map((i, shown) => (
                <li key={i}>
                  <button
                    type="button"
                    aria-current={activeStep === i ? "step" : undefined}
                    onClick={() => {
                      setStep(i);
                      heading.current?.focus();
                    }}
                  >
                    {shown + 1}. {stepName(i)}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section className="store-setup-step-content" aria-labelledby="setup-step-heading">
            {/* b19 review: the step's name is the marked tab right above; the heading names the
                step's region and takes focus when moving between steps, without repeating it. */}
            <h3 id="setup-step-heading" className="visually-hidden" ref={heading} tabIndex={-1}>
              {stepName(activeStep)}
            </h3>
            {activeStep === 0 && (
              <dl>
                <dt>{t("Store")}</dt>
                <dd>{workspace.store.displayName}</dd>
                <dt>{t("Language")}</dt>
                <dd>{plainLanguageName(workspace.store.locale)}</dd>
                <dt>{t("Currency")}</dt>
                <dd>
                  {workspace.store.currencyCode === "CAD"
                    ? t("Canadian dollars ($)")
                    : workspace.store.currencyCode}
                </dd>
                <dt>{t("Current timezone")}</dt>
                <dd>{storeTimeZoneName(workspace.store.timeZone)}</dd>
                <dt>{t("Saved draft")}</dt>
                <dd>
                  {workspace.setup.snapshot ? t("A draft is saved") : t("No draft saved yet")}
                </dd>
              </dl>
            )}
            {activeStep === 1 && (
              <>
                {openLayout ? (
                  !draftTimeZoneSaved && inputs.timeZone === workspace.store.timeZone ? (
                    <p>
                      {!draftBusinessStartSaved &&
                      liveBusinessStart !== null &&
                      inputs.businessStart === liveBusinessStart
                        ? t(
                            "Filled in with the time zone and business day start the Store runs on today; saving the draft keeps them.",
                          )
                        : t(
                            "Filled in with the time zone the Store runs on today; saving the draft keeps it.",
                          )}
                    </p>
                  ) : inputs.timeZone !== workspace.store.timeZone ? (
                    <p>
                      {t("The Store runs on {zone} today.", {
                        zone: storeTimeZoneName(workspace.store.timeZone),
                      })}
                    </p>
                  ) : null
                ) : (
                  <>
                    <h4>{t("Address")}</h4>
                    <SavedReference value={content.addressReference} />
                    <p>{t("Save an address below, then choose it for this draft.")}</p>
                  </>
                )}
                <label>
                  {t("Time zone")}
                  <select
                    disabled={disabled}
                    value={inputs.timeZone}
                    onChange={(e) => changeInputs({ timeZone: e.currentTarget.value })}
                  >
                    {/* b18 polish: an open Store says "Not configured" only while nothing is set. */}
                    {!openLayout || inputs.timeZone === "" ? (
                      <option value="">{t("Not configured")}</option>
                    ) : null}
                    {zones.map((zone) => (
                      <option key={zone.value} value={zone.value}>
                        {zone.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("Business day starts at (local time)")}
                  <input
                    type="time"
                    step={inputs.businessStart.length > 5 ? 1 : 60}
                    disabled={disabled}
                    value={inputs.businessStart}
                    onChange={(e) => changeInputs({ businessStart: e.currentTarget.value })}
                  />
                </label>
                {openLayout ? null : (
                  <p>
                    {t(
                      "Choose draft values explicitly. Current Store values are shown in Identity.",
                    )}
                  </p>
                )}
              </>
            )}
            {activeStep === 2 && (
              <>
                <label>
                  {t("Use service settings from")}
                  <select
                    disabled={disabled}
                    value={content.source.state === "Configured" ? content.source.value : ""}
                    onChange={(e) =>
                      changeContent({
                        source:
                          e.currentTarget.value === ""
                            ? { state: "Unconfigured" }
                            : { state: "Configured", value: "StoreOverride" },
                      })
                    }
                  >
                    <option value="">{t("Not chosen yet")}</option>
                    <option value="StoreOverride">{t("This Store")}</option>
                    {content.source.state === "Configured" &&
                      content.source.value === "BrandInherited" && (
                        <option value="BrandInherited" disabled>
                          {t("The Brand (saved earlier)")}
                        </option>
                      )}
                  </select>
                </label>
                <fieldset disabled={disabled}>
                  <legend>{t("Service modes")}</legend>
                  {modes.map((mode) => (
                    <label key={mode}>
                      <input
                        type="checkbox"
                        checked={inputs.serviceModes.includes(mode)}
                        onChange={(e) =>
                          changeInputs({
                            serviceModes: e.currentTarget.checked
                              ? [...inputs.serviceModes, mode]
                              : inputs.serviceModes.filter((v) => v !== mode),
                          })
                        }
                      />
                      {mode === "DineIn" ? t("Dine in") : serviceModeText(mode)}
                    </label>
                  ))}
                </fieldset>
                <p>
                  {inputs.serviceModes.length === 0
                    ? t("Service modes are not configured.")
                    : t("Selected modes are draft settings until validated and published.")}
                </p>
                {openLayout ? (
                  <>
                    <p>
                      {t(
                        "These are the services this Store is set up for. To stop or restart pickup for a while, use",
                      )}{" "}
                      <Link to={"/app/organization/stores/" + storeReference + "/capabilities"}>
                        {t("Store features")}
                      </Link>{" "}
                      {t("or pause ordering in")}{" "}
                      <Link to={"/app/organization/stores/" + storeReference + "/service"}>
                        {t("Hours & ordering")}
                      </Link>
                      {t("; that is live at once and needs no approval.")}
                    </p>
                    {orderLimits}
                  </>
                ) : null}
              </>
            )}
            {activeStep === 3 && (
              <>
                <p>
                  {t(
                    "Weekly times are in the store’s timezone chosen in step 2. Wait times are in whole minutes, up to 24 hours (1,440 minutes).",
                  )}
                </p>
                {inputs.hours === null ? (
                  <>
                    <p>{t("Weekly hours are not configured.")}</p>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => changeInputs({ hours: Array.from({ length: 7 }, () => []) })}
                    >
                      {t("Configure weekly hours")}
                    </button>
                  </>
                ) : (
                  <>
                    {inputs.hours.map((intervals, day) => (
                      <fieldset key={day} disabled={disabled}>
                        <legend>{days[day]}</legend>
                        {intervals.length === 0 && <p>{t("No service intervals on this day.")}</p>}
                        {intervals.map((value, index) => (
                          <div className="store-setup-interval" key={index}>
                            <h4>{t("Interval {value}", { value: index + 1 })}</h4>
                            <label>
                              {days[day]} {t("interval")} {index + 1} {t("start")}
                              <input
                                type="time"
                                step="1"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid" ? "setup-validation-error" : undefined
                                }
                                value={value.start}
                                onChange={(e) =>
                                  intervalChange(day, index, { start: e.currentTarget.value })
                                }
                              />
                            </label>
                            <label>
                              {days[day]} {t("interval")} {index + 1} {t("end")}
                              <input
                                type="time"
                                step="1"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid" ? "setup-validation-error" : undefined
                                }
                                value={value.end}
                                onChange={(e) =>
                                  intervalChange(day, index, { end: e.currentTarget.value })
                                }
                              />
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={value.followingDay}
                                onChange={(e) =>
                                  intervalChange(day, index, {
                                    followingDay: e.currentTarget.checked,
                                  })
                                }
                              />
                              {t("Ends on the following day")}
                            </label>
                            <fieldset>
                              <legend>
                                {days[day]} {t("interval")} {index + 1} {t("service modes")}
                              </legend>
                              {modes.map((mode) => (
                                <label key={mode}>
                                  <input
                                    type="checkbox"
                                    checked={value.modes.includes(mode)}
                                    onChange={(e) =>
                                      intervalChange(day, index, {
                                        modes: e.currentTarget.checked
                                          ? [...value.modes, mode]
                                          : value.modes.filter((v) => v !== mode),
                                      })
                                    }
                                  />
                                  {mode === "DineIn" ? t("Dine in") : serviceModeText(mode)}
                                </label>
                              ))}
                            </fieldset>
                            <label>
                              {t("Last orders (minutes before closing)")}
                              <input
                                inputMode="numeric"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid"
                                    ? "setup-wait-help setup-validation-error"
                                    : "setup-wait-help"
                                }
                                value={value.cutoff}
                                onChange={(e) =>
                                  intervalChange(day, index, {
                                    cutoff: e.currentTarget.value,
                                    savedCutoffSeconds: null,
                                  })
                                }
                              />
                            </label>
                            <SavedWaitNote seconds={value.savedCutoffSeconds} />
                            <label>
                              {t("Preparation time (minutes)")}
                              <input
                                inputMode="numeric"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid"
                                    ? "setup-wait-help setup-validation-error"
                                    : "setup-wait-help"
                                }
                                value={value.lead}
                                onChange={(e) =>
                                  intervalChange(day, index, {
                                    lead: e.currentTarget.value,
                                    savedLeadSeconds: null,
                                  })
                                }
                              />
                            </label>
                            <SavedWaitNote seconds={value.savedLeadSeconds} />
                            <button
                              type="button"
                              onClick={() =>
                                changeInputs({
                                  hours:
                                    inputs.hours?.map((values, i) =>
                                      i !== day ? values : values.filter((_, j) => j !== index),
                                    ) ?? null,
                                })
                              }
                            >
                              {t("Remove")} {days[day]} {t("interval")} {index + 1}
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          disabled={intervals.length >= 16}
                          onClick={() =>
                            changeInputs({
                              hours:
                                inputs.hours?.map((values, i) =>
                                  i !== day
                                    ? values
                                    : [
                                        ...values,
                                        {
                                          start: "",
                                          end: "",
                                          followingDay: false,
                                          modes: [],
                                          cutoff: "",
                                          lead: "",
                                        },
                                      ],
                                ) ?? null,
                            })
                          }
                        >
                          {t("Add")} {days[day]} {t("interval")}
                        </button>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => changeInputs({ hours: null })}
                    >
                      {t("Leave weekly hours unconfigured")}
                    </button>
                  </>
                )}
                <p id="setup-wait-help">
                  {t(
                    "Enter each wait as whole minutes, from 0 to 1,440 (24 hours). Opening periods on the same day must not overlap.",
                  )}
                </p>
                {content.exceptions.state === "Configured" ? (
                  <>
                    <h4>{t("Saved special-date hours")}</h4>
                    {content.exceptions.value.length === 0 ? (
                      <p>{t("No special dates selected.")}</p>
                    ) : (
                      <ul>
                        {content.exceptions.value.map((value) => (
                          <li key={value.localDate}>
                            {value.localDate} ·{" "}
                            {value.kind === "Holiday" ? t("Holiday") : t("Special hours")} ·{" "}
                            {value.intervals.length === 0
                              ? t("closed")
                              : t("{length} opening period{value}", {
                                  length: value.intervals.length,
                                  value: value.intervals.length === 1 ? "" : "s",
                                })}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p>
                      {t(
                        "Saved special dates are kept. Holidays and special hours are changed in Hours & ordering.",
                      )}
                    </p>
                  </>
                ) : (
                  <p>{t("No holidays or special hours are set. Add them in Hours & ordering.")}</p>
                )}
              </>
            )}
            {activeStep === 4 && (
              <>
                <StoreSetupFeeContextEditor
                  key={`fees:${JSON.stringify(workspace.scope)}:${csrf}`}
                  scope={workspace.scope}
                  csrf={csrf}
                  value={content.feeContexts ?? { state: "Unconfigured" }}
                  disabled={disabled}
                  onChange={(feeContexts) => changeContent({ feeContexts })}
                  {...(taxClassificationsHref === undefined ? {} : { taxClassificationsHref })}
                />
                <h4>{t("Tax settings")}</h4>
                <SavedReference value={content.taxConfigurationReference} />
                <h4>{t("Payment settings")}</h4>
                <SavedReference value={content.paymentConfigurationReference} />
                <h4>{t("Receipt settings")}</h4>
                <SavedReference value={content.receiptReference} />
                <p>{t("Tax rates and tax names are set in Tax review.")}</p>
              </>
            )}
            {activeStep === 5 && orderLimits}
            {activeStep === 6 && (
              <>
                <h4>{t("Contact configuration")}</h4>
                <SavedReference value={content.contactReference} />
                <p>{t("Save contact details below, then choose them for this draft.")}</p>
              </>
            )}
            <ReceiptTemplateStoreSelection
              key={`receipt-selection:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              locale={workspace.store.locale}
              csrf={csrf}
              value={content.receiptReference}
              liveTemplateReference={live?.current?.receiptReference ?? null}
              hidden={activeStep !== 4}
              disabled={busy || !ready || !online || !!pending}
              onSelect={(templateReference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    receiptReference:
                      templateReference === null
                        ? { state: "Unconfigured" }
                        : { state: "Configured", value: templateReference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            <ReceiptTemplateArtifactEditor
              key={`receipt-artifacts:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              hidden={activeStep !== 4}
              disabled={busy || !online || !!pending}
            />
            <ReceiptTemplateDraftEditor
              key={`receipt-templates:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              defaultLocale={workspace.store.locale}
              hidden={activeStep !== 4}
              disabled={busy || !online || !!pending}
            />
            <StorePaymentConfigurationEditor
              key={`payment:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              hidden={activeStep !== 4}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    paymentConfigurationReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            {openLayout && activeStep === 7 && (addressMissing || contactMissing) ? (
              <section aria-labelledby="setup-still-needed">
                <h4 id="setup-still-needed">{t("Still needed")}</h4>
                <p>
                  {t(
                    "These settings also carry the Store's address and phone. They are filled in from Store details: check them, save, choose “Use saved”, then save as draft.",
                  )}
                </p>
              </section>
            ) : null}
            <StoreSetupReferenceEditor
              key={`address:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              kind="Address"
              hidden={openLayout ? !(activeStep === 7 && addressMissing) : activeStep !== 1}
              suggested={openLayout ? (profileSuggestion?.address ?? null) : null}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    addressReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            <StoreSetupReferenceEditor
              key={`contact:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              kind="Contact"
              hidden={openLayout ? !(activeStep === 7 && contactMissing) : activeStep !== 6}
              suggested={openLayout ? (profileSuggestion?.contact ?? null) : null}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    contactReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            {activeStep === 7 && (
              <>
                <StoreSetupDraftReview
                  content={parsed}
                  saved={workspace.setup.snapshot?.content ?? null}
                  layout={layout}
                  current={live?.current ?? null}
                />
                <StoreSetupLiveSettings
                  layout={layout}
                  content={parsed ?? content}
                  live={live}
                  disabled={disabled}
                  onUse={(change) => {
                    const next = parseStoreSetupContent({ ...content, ...change });
                    setContent(next);
                    // WP-2423 (v15): time zone, business day start, service modes and opening
                    // hours are edited through the step 2-4 inputs, which Review and Save read;
                    // carry each value taken from the live Store into them too.
                    const edited = editInputs(next);
                    setInputs((old) => ({
                      ...old,
                      ...(change.timeZone !== undefined ? { timeZone: edited.timeZone } : {}),
                      ...(change.businessDayStartLocalTime !== undefined
                        ? { businessStart: edited.businessStart }
                        : {}),
                      ...(change.enabledServiceModes !== undefined
                        ? { serviceModes: edited.serviceModes }
                        : {}),
                      ...(change.weeklySchedule !== undefined ? { hours: edited.hours } : {}),
                    }));
                    setDirty(true);
                    setError(null);
                  }}
                />
                <StoreConfigurationOrdinaryPanel
                  key={JSON.stringify(workspace.scope)}
                  setupLayout={layout}
                  scope={workspace.scope}
                  csrf={csrf}
                  saved={workspace.setup.snapshot}
                  freshDisabled={disabled || dirty}
                  unsavedEdits={dirty}
                  onLiveConfiguration={setLive}
                  onSetupChanged={() => void refresh()}
                  // b20: the saved-draft notice no longer describes the page once a step here
                  // changes where the change stands; the status sentence there says it.
                  onChanged={() => setNotice("")}
                />
              </>
            )}
          </section>
          <footer className="store-setup-actions">
            <button
              type="button"
              disabled={activeStep === shownSteps[0]}
              onClick={() => {
                const to = shownSteps[shownSteps.indexOf(activeStep) - 1] ?? activeStep;
                setStep(to);
                heading.current?.focus();
              }}
            >
              {t("Previous step")}
            </button>
            <button
              type="button"
              disabled={activeStep === 7}
              onClick={() => {
                const to = shownSteps[shownSteps.indexOf(activeStep) + 1] ?? activeStep;
                setStep(to);
                heading.current?.focus();
              }}
            >
              {t("Next step")}
            </button>
            {/* b19 review: on Review and publish, the step's own next action is the one solid button;
                saving again is accent text there unless something is not saved yet. */}
            <button
              className={
                activeStep === 7 && !dirty
                  ? "store-setup-save store-setup-save--quiet"
                  : "store-setup-save"
              }
              type="button"
              disabled={disabled}
              onClick={() => void save()}
            >
              {t("Save as draft")}
            </button>
            <button
              className="store-setup-discard"
              type="button"
              disabled={disabled || !dirty}
              onClick={() => void refresh(true)}
            >
              {t("Discard unsaved changes")}
            </button>
          </footer>
          {/* b18 polish: with nothing unsaved, reading the saved draft again shows the last one
              saved (here or elsewhere); with unsaved changes, "Discard unsaved changes" does that. */}
          {!ownerOnly && !firstStore && !dirty ? (
            <StoreSetupReloadDraft
              disabled={busy || !online || id !== storeReference}
              onReload={() => void refresh()}
            />
          ) : null}
        </FirstStoreFold>
      )}
      {/* b18: the store-type question ("What kind of store is this?") is an opening question:
          asked on a first Store only. An open Store's owner finds the same starter roles on Roles. */}
      {id === storeReference && opening === "First" && staffRoles !== undefined ? (
        <Suspense fallback={null}>{staffRoles}</Suspense>
      ) : null}
    </AppFrame>
  );
}
/** b19: one setting of the summary: its name and, in plain words, what it is in this setup. */
export interface StoreSetupSummaryItem {
  readonly label: string;
  readonly value: readonly string[];
  /** b20: what the Store runs with today, for a setting with one value ("04:00"); settings with
   * several lines (opening hours, fees) say "… becomes …" on each line instead. */
  readonly now?: string;
  /** b20: set on this page but not saved yet, so the change created below does not have it. */
  readonly unsaved?: boolean;
}
interface FeeLike {
  readonly chargeType: string;
  readonly state: string;
  readonly orderTypes?: readonly string[];
  readonly taxClassificationReference?: string | null;
}
const feesKey = (fees: readonly FeeLike[]) =>
  JSON.stringify(
    fees.map((fee) => [
      fee.chargeType,
      fee.state === "Enabled" ? "Enabled" : "Off",
      [...(fee.orderTypes ?? [])].sort(),
      fee.taxClassificationReference ?? null,
    ]),
  );
const feeText = (fee: FeeLike) =>
  fee.state === "Enabled"
    ? t("{fee}: on ({services})", {
        fee: feeLabel(fee.chargeType),
        services: (fee.orderTypes ?? []).map(serviceModeText).join(listSeparator()),
      })
    : t("{fee}: off", { fee: feeLabel(fee.chargeType) });
const openDaysText = (schedule: WeeklySchedule) => {
  const open = schedule.filter((day) => day.intervals.length > 0).length;
  return open === 1 ? t("Open 1 day a week") : t("Open {open} days a week", { open });
};
/**
 * b21: a fee's state in words, "on (Dine-in, Pickup)" or "off", for "becomes" lines. The services
 * are put in one order first (as feesKey does), so the same services stored in another order never
 * read as a change.
 */
const feeStateText = (fee: FeeLike) =>
  fee.state === "Enabled"
    ? t("on ({services})", {
        services: [...(fee.orderTypes ?? [])].sort().map(serviceModeText).join(listSeparator()),
      })
    : t("off");
/** b21: each configured setting of a setup as one comparable value, by its field name. */
function storeSetupSettingValues(content: StoreSetupContent): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const put = (
    key: string,
    field: { readonly state: string; readonly value?: unknown } | undefined,
  ) => {
    if (field?.state === "Configured") values.set(key, JSON.stringify(field.value ?? null));
  };
  if (content.businessDayStartLocalTime.state === "Configured")
    values.set("businessDayStartLocalTime", clock(content.businessDayStartLocalTime.value));
  if (content.enabledServiceModes.state === "Configured")
    values.set(
      "enabledServiceModes",
      JSON.stringify([...content.enabledServiceModes.value].sort()),
    );
  if (content.feeContexts?.state === "Configured")
    values.set("feeContexts", feesKey(content.feeContexts.value));
  put("timeZone", content.timeZone);
  put("weeklySchedule", content.weeklySchedule);
  put("capacityConfigurationReference", content.capacityConfigurationReference);
  put("addressReference", content.addressReference);
  put("contactReference", content.contactReference);
  put("paymentConfigurationReference", content.paymentConfigurationReference);
  put("receiptReference", content.receiptReference);
  put("taxConfigurationReference", content.taxConfigurationReference);
  return values;
}
/**
 * b19 (Owner: step 4 was messy): what publishing this setup changes, in plain values. Against the
 * Store as it runs today (`current`), settings that differ are listed with their new value and the
 * rest are named as unchanged; with nothing published to compare with, every setting that has a
 * value shows it and the saved records (address, contact, payment, …) are named as filled in.
 * Settings not set yet are not here: Review lists them with where to set them.
 */
export function storeSetupChangeSummary(
  content: StoreSetupContent,
  current: StoreConfigurationSnapshot | null,
  /**
   * b20: the saved draft. A setting whose value here differs from it is marked as not saved yet,
   * since the change created below is made from the saved draft only.
   */
  saved: StoreSetupContent | null = null,
): {
  readonly changed: readonly StoreSetupSummaryItem[];
  readonly unchanged: readonly string[];
  readonly filledIn: readonly string[];
} {
  const changed: StoreSetupSummaryItem[] = [],
    unchanged: string[] = [],
    filledIn: string[] = [];
  // b21: "not saved yet" compares the setting itself with the saved draft, not its words, so a
  // newly chosen address (worded like the saved one) or a setting put back is still marked.
  const savedSettings = saved === null ? null : storeSetupSettingValues(saved),
    settings = storeSetupSettingValues(content);
  // b21 review: what the saved draft itself changes, read only for a setting put back below.
  let savedChanges: readonly StoreSetupSummaryItem[] | null = null;
  const savedChange = (label: string) => {
    if (saved === null) return undefined;
    savedChanges ??= storeSetupChangeSummary(saved, current).changed;
    return savedChanges.find((item) => item.label === label);
  };
  const add = (
    label: string,
    key: string,
    same: boolean | null,
    value: () => readonly string[],
    now?: () => string,
  ) => {
    const unsaved = savedSettings !== null && savedSettings.get(key) !== settings.get(key);
    if (same === true) {
      // b21: an unsaved edit that puts a setting back to how the Store runs today, while the saved
      // draft still changes it, is named with its mark (the change below would still change it).
      // b21 review: it names the values, "now saved as X → changes to Y, as the Store runs today".
      if (unsaved && savedSettings?.has(key) === true) {
        const before = savedChange(label);
        changed.push({
          label,
          value:
            before?.now !== undefined && before.value.length === 1
              ? [
                  t("Now saved as {saved} → changes to {value}, as the Store runs today", {
                    saved: before.value[0] ?? "",
                    value: before.now,
                  }),
                ]
              : [
                  t("Back to how the Store runs today. The saved draft changes:"),
                  ...(before?.value ?? []),
                ],
          unsaved,
        });
      } else unchanged.push(label);
      return;
    }
    changed.push({
      label,
      value: value(),
      ...(same === false && now !== undefined ? { now: now() } : {}),
      ...(unsaved ? { unsaved } : {}),
    });
  };
  const known = current !== null;
  if (content.timeZone.state === "Configured") {
    const zone = content.timeZone.value;
    const names = current === null ? null : storeTimeZoneNamesApart(current.timeZone, zone);
    add(
      t("Time zone"),
      "timeZone",
      known ? zone === current.timeZone : null,
      () => [names?.next ?? storeTimeZoneName(zone)],
      () => names?.now ?? "",
    );
  }
  if (content.businessDayStartLocalTime.state === "Configured") {
    const start = content.businessDayStartLocalTime.value;
    add(
      t("Business day start"),
      "businessDayStartLocalTime",
      known ? clock(start) === clock(current.businessDayStartLocalTime) : null,
      () => [clock(start)],
      () => clock(current?.businessDayStartLocalTime ?? ""),
    );
  }
  if (content.enabledServiceModes.state === "Configured") {
    const services = content.enabledServiceModes.value;
    add(
      t("Service modes"),
      "enabledServiceModes",
      known
        ? JSON.stringify([...services].sort()) ===
            JSON.stringify([...current.enabledServiceModes].sort())
        : null,
      () => [services.map(serviceModeText).join(listSeparator())],
      () => (current?.enabledServiceModes ?? []).map(serviceModeText).join(listSeparator()),
    );
  }
  if (content.weeklySchedule.state === "Configured") {
    const schedule = content.weeklySchedule.value;
    // Each changed day reads "Monday: 09:00–17:00 becomes 10:00–22:00".
    const lines = known ? openingHoursChanges(current.weeklySchedule, schedule) : [];
    add(t("Opening hours"), "weeklySchedule", known ? lines.length === 0 : null, () =>
      known
        ? lines
        : [
            openDaysText(schedule),
            ...schedule
              .filter((day) => day.intervals.length > 0)
              .map((day) =>
                t("{day}: {times}", {
                  day: days[day.isoWeekday - 1] ?? "",
                  times: dayText(day.intervals, false),
                }),
              ),
          ],
    );
  }
  if (content.feeContexts?.state === "Configured") {
    const fees = content.feeContexts.value;
    const live = current?.setupBasis?.feeContexts;
    // b21: each fee that changes reads "Tip: off becomes on (Dine-in)", like opening hours; a fee
    // the Store has no setting for is not charged today, so it reads as off.
    // b19 review: a fee whose tax treatment changes says so, so a change is never invisible.
    const changes = fees.flatMap((fee) => {
      const before: FeeLike = live?.find((old) => old.chargeType === fee.chargeType) ?? {
        chargeType: fee.chargeType,
        state: "Disabled",
      };
      const after: FeeLike = fee;
      const lines: string[] = [];
      if (feeStateText(before) !== feeStateText(after))
        lines.push(
          t("{name}: {before} becomes {after}", {
            name: feeLabel(fee.chargeType),
            before: feeStateText(before),
            after: feeStateText(after),
          }),
        );
      if (
        before.state === "Enabled" &&
        after.state === "Enabled" &&
        (before.taxClassificationReference ?? null) !== (after.taxClassificationReference ?? null)
      )
        lines.push(
          t("{fee}: taxed differently (see Tax review)", { fee: feeLabel(fee.chargeType) }),
        );
      return lines;
    });
    add(t("Fees"), "feeContexts", known ? changes.length === 0 : null, () =>
      known ? changes : fees.map(feeText),
    );
  }
  if (content.capacityConfigurationReference.state === "Configured") {
    const limits = content.capacityConfigurationReference.value;
    add(
      t("Order limits"),
      "capacityConfigurationReference",
      known ? limits === current.capacityConfigurationReference : null,
      () =>
        known
          ? [limits === null ? t("no order limits") : t("the order limits saved earlier")]
          : [limits === null ? t("No order limits") : t("The order limits saved earlier")],
      () =>
        current?.capacityConfigurationReference === null
          ? t("no order limits")
          : t("the order limits the Store uses"),
    );
  }
  const records: readonly (readonly [
    string,
    (
      | "addressReference"
      | "contactReference"
      | "paymentConfigurationReference"
      | "receiptReference"
      | "taxConfigurationReference"
    ),
    string | null,
    string,
    string,
  ])[] = [
    [
      t("Address"),
      "addressReference",
      current?.addressReference ?? null,
      t("the address the Store uses"),
      t("the address saved in this setup"),
    ],
    [
      t("Contact details"),
      "contactReference",
      current?.contactReference ?? null,
      t("the contact details the Store uses"),
      t("the contact details saved in this setup"),
    ],
    [
      t("Payment"),
      "paymentConfigurationReference",
      current?.paymentConfigurationReference ?? null,
      t("the payment settings the Store uses"),
      t("the payment settings saved in this setup"),
    ],
    [
      t("Receipt template"),
      "receiptReference",
      current?.receiptReference ?? null,
      t("the receipt layout the Store uses"),
      t("the receipt layout chosen in this setup"),
    ],
    [
      t("Tax settings"),
      "taxConfigurationReference",
      current?.taxConfigurationReference ?? null,
      t("the tax settings the Store uses"),
      t("the tax settings chosen in this setup (see Tax review)"),
    ],
  ];
  for (const [label, key, live, before, after] of records) {
    const value = content[key];
    if (value.state !== "Configured") continue;
    if (!known) filledIn.push(label);
    else
      add(
        label,
        key,
        value.value === live,
        () => [after],
        () => before,
      );
  }
  return { changed, unchanged, filledIn };
}

/** b19: the summary of what publishing changes, as rows of name and new value. */
function StoreSetupChangeSummary({
  content,
  current,
  saved,
}: {
  readonly content: StoreSetupContent;
  readonly current: StoreConfigurationSnapshot | null;
  readonly saved: StoreSetupContent | null;
}) {
  const { changed, unchanged, filledIn } = storeSetupChangeSummary(content, current, saved);
  const known = current !== null;
  return (
    <section className="store-setup-summary" aria-labelledby="store-setup-summary-heading">
      <h4 id="store-setup-summary-heading">
        {known ? t("What changes when it is published") : t("What this setup holds")}
      </h4>
      {known && changed.length === 0 ? (
        <p>{t("Nothing changes: every setting is the same as the Store runs with today.")}</p>
      ) : (
        <dl className="store-setup-summary__rows">
          {changed.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                {/* b20: a setting with one value reads "now → changes to"; one not saved yet
                    says so, since the change created below is made from the saved draft. */}
                {item.now !== undefined && item.value.length === 1 ? (
                  <span>
                    {t("Now {now} → changes to {value}", {
                      now: item.now,
                      value: item.value[0] ?? "",
                    })}
                  </span>
                ) : (
                  item.value.map((line) => <span key={line}>{line}</span>)
                )}
                {item.unsaved ? (
                  <span className="store-setup-summary__unsaved">{t("Not saved yet")}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {changed.some((item) => item.unsaved) && (
        <p className="store-setup-summary__rest">
          {t(
            "What is marked not saved yet goes into the change below only after you save as draft.",
          )}
        </p>
      )}
      {unchanged.length > 0 && (
        <p className="store-setup-summary__rest">
          {t("Staying as they are: {list}.", { list: unchanged.join(listSeparator()) })}
        </p>
      )}
      {filledIn.length > 0 && (
        <p className="store-setup-summary__rest">
          {t("Also filled in: {list}.", { list: filledIn.join(listSeparator()) })}
        </p>
      )}
    </section>
  );
}

export function StoreSetupDraftReview({
  content,
  saved = null,
  layout = "Opening",
  current = null,
}: {
  readonly content: StoreSetupContent | null;
  /** The saved draft; what is set here but not in it is named as not saved yet. */
  readonly saved?: StoreSetupContent | null;
  readonly layout?: StoreSetupLayout;
  /** b19: the configuration the Store runs with today, when read: the summary says what changes. */
  readonly current?: StoreConfigurationSnapshot | null;
}) {
  // WP-2423 (v15): the count is exactly the list of what is not set, each with where to set it.
  const missing = content ? storeSetupMissingItems(content, layout) : null;
  // b18 review: the publication below checks the saved draft. A setting filled in on this page
  // (by staff, or from the Store's own time zone and business day start) but not saved yet is said
  // to be exactly that, so Review and the publication never seem to disagree.
  const unsaved =
    missing === null
      ? []
      : (saved === null
          ? storeSetupMissingItems(createUnconfiguredStoreSetupContent(), layout)
          : storeSetupMissingItems(saved, layout)
        ).filter((item) => !missing.some((m) => m.label === item.label));
  return (
    <>
      {missing === null && (
        <p>{t("Some edited times or wait values need correction before saving.")}</p>
      )}
      {missing !== null && missing.length > 0 && (
        <section aria-label={t("Settings not set yet")}>
          <h4>{t("Not set yet")}</h4>
          <p>
            {missing.length === 1
              ? t("1 setting is not set yet. An unfinished draft can be saved.")
              : t("{length} settings are not set yet. An unfinished draft can be saved.", {
                  length: missing.length,
                })}
          </p>
          <ul>
            {missing.map((item) => (
              <li key={item.label}>
                {t("{label}: set it in {where}", { label: item.label, where: item.where })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {unsaved.length > 0 && (
        <section aria-label={t("Filled in, not saved yet")}>
          <h4>{t("Filled in, not saved yet")}</h4>
          <ul>
            {unsaved.map((item) => (
              <li key={item.label}>{item.label}</li>
            ))}
          </ul>
          <p>
            {t(
              "Save as draft to keep them. Until then, publishing below counts them as not set, because it uses the saved draft.",
            )}
          </p>
        </section>
      )}
      {content && <StoreSetupChangeSummary content={content} current={current} saved={saved} />}
    </>
  );
}

/** Independent reference originals survive wizard-step changes; selecting a saved
 * version only updates the local setup draft, whose own save remains explicit. */
/** The fields of an address or contact saved for Store setup. */
export interface StoreSetupReferenceFields {
  readonly countryCode: string;
  readonly regionCode: string;
  readonly locality: string;
  readonly postalCode: string;
  readonly line1: string;
  readonly line2: string;
  readonly line3: string;
  readonly contactName: string;
  readonly businessPhone: string;
  readonly website: string;
}
export function StoreSetupReferenceEditor({
  scope,
  csrf,
  kind,
  hidden = false,
  disabled = false,
  suggested,
  onSelect,
  client: injected,
  journalFactory = createStoreSetupReferencePendingJournal,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly kind: StoreSetupReferenceKind;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  /**
   * b18: what to fill in while nothing is saved yet (an open Store's name, address and phone from
   * Store details), so the Owner checks and saves rather than typing it again.
   */
  readonly suggested?: Partial<StoreSetupReferenceFields> | null;
  readonly onSelect: (reference: string) => void;
  readonly client?: ReturnType<typeof createStoreSetupReferenceClient>;
  readonly journalFactory?: (
    scope: StoreSetupScope,
    kind: StoreSetupReferenceKind,
  ) => StoreSetupReferencePendingJournal;
}) {
  const client = useMemo(() => injected ?? createStoreSetupReferenceClient(), [injected]);
  const [view, setView] = useState<StoreSetupReferencesCurrent | null>(null),
    [pending, setPending] = useState<StoreSetupReferenceCursor | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState("");
  const [fields, setFields] = useState<StoreSetupReferenceFields>({
    countryCode: "",
    regionCode: "",
    locality: "",
    postalCode: "",
    line1: "",
    line2: "",
    line3: "",
    contactName: "",
    businessPhone: "",
    website: "",
  });
  const hold = useUnsavedHold();
  const dirty = useRef(false),
    epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<StoreSetupReferencePendingJournal | null>(null);
  const selected = view ? (kind === "Address" ? view.address : view.contact) : null;
  // b18: nothing saved yet and nothing typed: start from what Store details already holds.
  const suggestedKey = suggested ? JSON.stringify(suggested) : null;
  useEffect(() => {
    if (!ready || view === null || selected || dirty.current || !suggested) return;
    setFields((old) => ({ ...old, ...suggested }));
  }, [ready, view === null, !selected, suggestedKey]);
  const apply = (v: StoreSetupReferencesCurrent) => {
    setView(v);
    const s = kind === "Address" ? v.address : v.contact;
    if (s && !dirty.current) {
      const c = s.content;
      if ("addressLines" in c)
        setFields({
          countryCode: c.countryCode,
          regionCode: c.regionCode,
          locality: c.locality,
          postalCode: c.postalCode,
          line1: c.addressLines[0] ?? "",
          line2: c.addressLines[1] ?? "",
          line3: c.addressLines[2] ?? "",
          contactName: "",
          businessPhone: "",
          website: "",
        });
      else
        setFields({
          countryCode: "",
          regionCode: "",
          locality: "",
          postalCode: "",
          line1: "",
          line2: "",
          line3: "",
          contactName: c.contactName,
          businessPhone: c.businessPhone,
          website: c.website ?? "",
        });
    }
  };
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current = c;
    setReady(false);
    setView(null);
    setPending(null);
    setError(null);
    running.current = false;
    setBusy(true);
    journal.current = null;
    void client
      .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
      .then(async (v) => {
        const j = journalFactory(scope, kind),
          p = await j.load();
        if (e !== epoch.current || c.signal.aborted) return;
        journal.current = j;
        apply(v);
        setPending(p);
        setReady(true);
      })
      .catch((value) => {
        if (e === epoch.current && !c.signal.aborted)
          setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
      })
      .finally(() => {
        if (e === epoch.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      c.abort();
      active.current = null;
    };
  }, [client, scopeKey, csrf, kind, journalFactory]);
  useEffect(() => {
    if (disabled) {
      active.current?.abort();
      running.current = false;
      setBusy(false);
    }
  }, [disabled]);
  const action = async (mode: "Refresh" | "Save" | "Resolve") => {
    if (running.current || disabled || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () => e === epoch.current && !c.signal.aborted;
    try {
      let j = journal.current;
      if (!j) {
        j = journalFactory(scope, kind);
        journal.current = j;
      }
      const stored = await j.load();
      if (!valid()) return;
      setPending(stored);
      if (mode === "Refresh") {
        const v = await client.load({
          storeReference: scope.storeReference,
          expectedScope: scope,
          signal: c.signal,
        });
        if (valid()) {
          apply(v);
          setReady(true);
        }
        return;
      }
      if (mode === "Resolve") {
        if (!stored) throw new StoreSetupClientError("Conflict");
        const { receipt, current: v } = await recoverStoreSetupReference({
          client,
          journal: j,
          cursor: stored,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        });
        if (valid()) {
          setPending(null);
          apply(v);
          setReady(true);
          setNotice(
            receipt.outcome === "Committed"
              ? t(
                  "Earlier save confirmed. Choose this saved configuration to use it in the setup draft.",
                )
              : t("Earlier save did not commit. You can save again."),
          );
        }
        return;
      }
      if (stored) throw new StoreSetupClientError("Conflict");
      if (!view || !ready) throw new StoreSetupClientError("Unavailable");
      const value =
        kind === "Address"
          ? {
              countryCode: fields.countryCode,
              regionCode: fields.regionCode,
              locality: fields.locality,
              postalCode: fields.postalCode,
              addressLines: [
                fields.line1,
                ...(fields.line2 ? [fields.line2] : []),
                ...(fields.line3 ? [fields.line3] : []),
              ],
            }
          : {
              contactName: fields.contactName,
              businessPhone: fields.businessPhone,
              website: fields.website === "" ? null : fields.website,
            };
      const content = parseStoreSetupReferenceContent(kind, value);
      if (!valid()) return;
      const { current: v } = await dispatchStoreSetupReference({
        client,
        journal: j,
        scope,
        kind,
        baseline: view,
        content,
        csrf,
        signal: c.signal,
        isCurrent: valid,
        onReserved: (cursor) => {
          if (valid()) setPending(cursor);
        },
      });
      if (valid()) {
        setPending(null);
        dirty.current = false;
        hold.clear();
        apply(v);
        setNotice(
          t(
            "Configuration saved. Choose it below, then save the setup draft to keep that selection.",
          ),
        );
      }
    } catch (value) {
      if (valid()) setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (valid()) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const field = (key: keyof typeof fields, label: string, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        value={fields[key]}
        disabled={disabled || busy || !!pending}
        onChange={(e) => {
          const value = e.currentTarget.value;
          dirty.current = true;
          hold.mark();
          setFields((v) => ({ ...v, [key]: value }));
          setError(null);
        }}
      />
    </label>
  );
  return (
    <section
      hidden={hidden}
      aria-label={t("{kind} configuration", {
        kind: kind === "Address" ? t("Address") : t("Contact"),
      })}
    >
      <h4>{kind === "Address" ? t("Store address") : t("Store contact")}</h4>
      {error && (
        <p role="alert">
          {error === "Invalid"
            ? t(
                "Check the entered details. Phone numbers need a country code; websites must use HTTPS.",
              )
            : error === "Conflict"
              ? t("This configuration changed. Refresh and review before saving.")
              : error === "Denied"
                ? t("You cannot access this configuration in the current Store.")
                : error === "OutcomeUnknown"
                  ? t(
                      "The save could not be confirmed. Recover the original save before making another change.",
                    )
                  : t(
                      "These details could not be loaded. Refresh when connected; an earlier save remains protected.",
                    )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <>
          <p role="status">
            {t("An earlier {value} save must be recovered before another save.", {
              value: kind === "Address" ? t("address") : t("contact"),
            })}
          </p>
          <button type="button" disabled={disabled || busy} onClick={() => void action("Resolve")}>
            {t("Recover original {value} save", {
              value: kind === "Address" ? t("address") : t("contact"),
            })}
          </button>
        </>
      )}
      {kind === "Address" ? (
        <>
          {field("countryCode", t("Country code"))}
          {field("regionCode", t("Province or region code"))}
          {field("locality", t("City"))}
          {field("postalCode", t("Postal code"))}
          {field("line1", t("Address line 1"))}
          {field("line2", t("Address line 2 (optional)"))}
          {field("line3", t("Address line 3 (optional)"))}
        </>
      ) : (
        <>
          {field("contactName", t("Contact name"))}
          {field("businessPhone", t("Business phone with country code"), "tel")}
          {field("website", t("Website (optional)"), "url")}
        </>
      )}
      <button type="button" disabled={disabled || busy} onClick={() => void action("Refresh")}>
        {t("Refresh saved {value}", { value: kind === "Address" ? t("address") : t("contact") })}
      </button>
      <button
        type="button"
        disabled={disabled || busy || !ready || !!pending}
        onClick={() => void action("Save")}
      >
        {t("Save {value} configuration", {
          value: kind === "Address" ? t("address") : t("contact"),
        })}
      </button>
      {selected && (
        <>
          <p>
            {/* b18: no revision numbers on the page; what matters is that it is saved. */}
            {t("Saved. It is checked when the setup is submitted for approval.")}
          </p>
          <button
            type="button"
            disabled={disabled || busy || !!pending}
            onClick={() => {
              if (!view || Date.now() >= Date.parse(view.validUntil)) {
                setError("Stale");
                return;
              }
              onSelect(selected.reference);
              setNotice(t("Selection changed locally. Save the setup draft to keep it."));
            }}
          >
            {t("Use saved {value}", { value: kind === "Address" ? t("address") : t("contact") })}
          </button>
        </>
      )}
    </section>
  );
}

export async function dispatchStoreSetupReference(input: {
  client: ReturnType<typeof createStoreSetupReferenceClient>;
  journal: StoreSetupReferencePendingJournal;
  scope: StoreSetupScope;
  kind: StoreSetupReferenceKind;
  baseline: StoreSetupReferencesCurrent;
  content: unknown;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  onReserved: (cursor: StoreSetupReferenceCursor) => void;
}) {
  const check = () => {
    if (input.signal.aborted || input.isCurrent?.() === false)
      throw new StoreSetupClientError("ScopeChanged");
  };
  const content = parseStoreSetupReferenceContent(input.kind, input.content),
    fresh = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  const key = input.kind === "Address" ? "address" : "contact",
    head = fresh[key],
    old = input.baseline[key];
  if (head?.reference !== old?.reference || head?.revision !== old?.revision)
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    kind: input.kind,
    operationReference: serviceOperationReference(),
    expectedReference: head?.reference ?? null,
    expectedRevision: head?.revision ?? 0,
    content,
  });
  check();
  await input.journal.reserve(prepared.cursor);
  check();
  input.onReserved(prepared.cursor);
  const receipt = await input.client.execute(prepared, { csrf: input.csrf, signal: input.signal }),
    current = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  await input.journal.complete(prepared.cursor, receipt, current);
  check();
  return { receipt, current };
}
export async function recoverStoreSetupReference(input: {
  client: ReturnType<typeof createStoreSetupReferenceClient>;
  journal: StoreSetupReferencePendingJournal;
  cursor: StoreSetupReferenceCursor;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const receipt = await input.client.resolve(input.cursor, {
      csrf: input.csrf,
      signal: input.signal,
    }),
    current = await input.client.load({
      storeReference: input.cursor.scope.storeReference,
      expectedScope: input.cursor.scope,
      signal: input.signal,
    });
  if (input.signal.aborted || input.isCurrent?.() === false)
    throw new StoreSetupClientError("ScopeChanged");
  await input.journal.complete(input.cursor, receipt, current);
  return { receipt, current };
}

/** Saves immutable channel rules, not Provider readiness. Explicit selection is a
 * separate local setup edit and never follows a newer Manager's save silently. */
export function StorePaymentConfigurationEditor({
  scope,
  csrf,
  hidden = false,
  disabled = false,
  onSelect,
  client: injected,
  journalFactory = createStorePaymentConfigurationPendingJournal,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (reference: string) => void;
  readonly client?: ReturnType<typeof createStorePaymentConfigurationClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StorePaymentConfigurationPendingJournal;
}) {
  const client = useMemo(() => injected ?? createStorePaymentConfigurationClient(), [injected]);
  const [view, setView] = useState<StorePaymentConfigurationCurrent | null>(null),
    [pending, setPending] = useState<StorePaymentConfigurationCursor | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState("");
  const [fields, setFields] = useState<StorePaymentConfigurationContent>({
    customerOnlineCardEnabled: false,
    staffTerminalCardPresentEnabled: false,
    staffTerminalInteracEnabled: false,
  });
  const hold = useUnsavedHold();
  const dirty = useRef(false),
    epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<StorePaymentConfigurationPendingJournal | null>(null);
  const apply = (v: StorePaymentConfigurationCurrent) => {
    setView(v);
    if (v.snapshot && !dirty.current) setFields(v.snapshot.content);
  };
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current = c;
    setReady(false);
    setView(null);
    setPending(null);
    setError(null);
    setBusy(true);
    running.current = false;
    journal.current = null;
    dirty.current = false;
    hold.clear();
    setFields({
      customerOnlineCardEnabled: false,
      staffTerminalCardPresentEnabled: false,
      staffTerminalInteracEnabled: false,
    });
    void client
      .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
      .then(async (v) => {
        const j = journalFactory(scope),
          p = await j.load();
        if (e !== epoch.current || c.signal.aborted) return;
        journal.current = j;
        apply(v);
        setPending(p);
        setReady(true);
      })
      .catch((value) => {
        if (e === epoch.current && !c.signal.aborted)
          setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
      })
      .finally(() => {
        if (e === epoch.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      c.abort();
      active.current = null;
    };
  }, [client, scopeKey, csrf, journalFactory]);
  // Parent draft saves may temporarily disable this child. Keep its initial
  // read alive; cancel only an active command, whose durable original survives.
  useEffect(() => {
    if (disabled && running.current) {
      active.current?.abort();
      running.current = false;
      setBusy(false);
    }
  }, [disabled]);
  const action = async (mode: "Save" | "Refresh" | "Resolve") => {
    if (running.current || disabled || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () => e === epoch.current && !c.signal.aborted;
    try {
      const j = journal.current ?? journalFactory(scope);
      journal.current = j;
      const stored = await j.load();
      if (!valid()) return;
      setPending(stored);
      if (mode === "Refresh") {
        const v = await client.load({
          storeReference: scope.storeReference,
          expectedScope: scope,
          signal: c.signal,
        });
        if (valid()) {
          apply(v);
          setReady(true);
        }
        return;
      }
      if (mode === "Resolve") {
        if (!stored) throw new StoreSetupClientError("Conflict");
        const result = await recoverStorePaymentConfiguration({
          client,
          journal: j,
          cursor: stored,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        });
        if (valid()) {
          setPending(null);
          apply(result.current);
          setReady(true);
          setNotice(
            result.receipt.outcome === "Committed"
              ? t("Earlier payment save confirmed. Choose the saved configuration to use it.")
              : t("Earlier payment save did not commit. You can save again."),
          );
        }
        return;
      }
      if (stored) throw new StoreSetupClientError("Conflict");
      if (!view || !ready) throw new StoreSetupClientError("Unavailable");
      const result = await dispatchStorePaymentConfiguration({
        client,
        journal: j,
        scope,
        baseline: view,
        content: fields,
        csrf,
        signal: c.signal,
        isCurrent: valid,
        onReserved: (cursor) => {
          if (valid()) setPending(cursor);
        },
      });
      if (valid()) {
        setPending(null);
        dirty.current = false;
        hold.clear();
        apply(result.current);
        setNotice(
          t(
            "Payment configuration saved. Choose it below, then save the setup draft to keep that selection.",
          ),
        );
      }
    } catch (value) {
      if (valid()) setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (valid()) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const labels: readonly [keyof StorePaymentConfigurationContent, string][] = [
    ["customerOnlineCardEnabled", t("Customer online card")],
    ["staffTerminalCardPresentEnabled", t("Staff terminal card present")],
    ["staffTerminalInteracEnabled", t("Staff terminal Interac")],
  ];
  return (
    <section hidden={hidden} aria-label={t("Payment configuration")}>
      <h4>{t("Store payment rules")}</h4>
      <p>
        {t(
          "Saving these rules does not turn on card payments by itself: the payment provider account must be set up, and the rules approved and published.",
        )}
      </p>
      {error === "FullSignInRequired" ? (
        <>
          <FullSignInPrompt csrf={csrf} />
          {pending ? (
            <p role="status">
              {t(
                "After you verify, choose Recover original payment save. If it shows the save did not go through, save again — your choices are kept.",
              )}
            </p>
          ) : null}
        </>
      ) : error ? (
        <p role="alert">
          {error === "Denied"
            ? t("You cannot access payment configuration in the current Store.")
            : error === "Conflict"
              ? t("Payment configuration changed. Refresh and review before saving.")
              : error === "OutcomeUnknown"
                ? t(
                    "The payment save could not be confirmed. Recover the original save before making another change.",
                  )
                : error === "Invalid"
                  ? t("Check the three payment channel settings.")
                  : t(
                      "Payment settings could not be loaded. Refresh when connected; an earlier save remains protected.",
                    )}
        </p>
      ) : null}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">{t("Loading payment configuration…")}</p>}
      {pending && (
        <>
          <p role="status">{t("An earlier payment save must be recovered before another save.")}</p>
          <button type="button" disabled={disabled || busy} onClick={() => void action("Resolve")}>
            {t("Recover original payment save")}
          </button>
        </>
      )}
      <fieldset disabled={disabled || busy || !ready || !!pending}>
        <legend>{t("Allowed payment channels")}</legend>
        {labels.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={fields[key]}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                dirty.current = true;
                hold.mark();
                setFields((v) => ({ ...v, [key]: checked }));
                setError(null);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={disabled || busy} onClick={() => void action("Refresh")}>
        {t("Refresh saved payment configuration")}
      </button>
      <button
        type="button"
        disabled={disabled || busy || !ready || !!pending}
        onClick={() => void action("Save")}
      >
        {t("Save payment configuration")}
      </button>
      {view?.snapshot && (
        <>
          <p>
            {t(
              "Saved payment rules, version {revision}. Card payments still need the payment provider account to be set up.",
              { revision: view.snapshot.revision },
            )}
          </p>
          <button
            type="button"
            disabled={disabled || busy || !!pending}
            onClick={() => {
              if (Date.now() >= Date.parse(view.validUntil)) {
                setError("Stale");
                return;
              }
              const selected = view.snapshot;
              if (!selected) return;
              onSelect(selected.configurationReference);
              setNotice(t("Selection changed locally. Save the setup draft to keep it."));
            }}
          >
            {t("Use saved payment configuration")}
          </button>
        </>
      )}
    </section>
  );
}
export async function dispatchStorePaymentConfiguration(input: {
  client: ReturnType<typeof createStorePaymentConfigurationClient>;
  journal: StorePaymentConfigurationPendingJournal;
  scope: StoreSetupScope;
  baseline: StorePaymentConfigurationCurrent;
  content: unknown;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  onReserved: (cursor: StorePaymentConfigurationCursor) => void;
}) {
  const check = () => {
    if (input.signal.aborted || input.isCurrent?.() === false)
      throw new StoreSetupClientError("ScopeChanged");
  };
  const content = parseStorePaymentConfigurationContent(input.content),
    fresh = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  if (
    fresh.snapshot?.configurationReference !== input.baseline.snapshot?.configurationReference ||
    fresh.snapshot?.revision !== input.baseline.snapshot?.revision
  )
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    operationReference: serviceOperationReference(),
    expectedConfigurationReference: fresh.snapshot?.configurationReference ?? null,
    expectedRevision: fresh.snapshot?.revision ?? 0,
    content,
  });
  check();
  await input.journal.reserve(prepared.cursor);
  check();
  input.onReserved(prepared.cursor);
  const receipt = await input.client.execute(prepared, { csrf: input.csrf, signal: input.signal }),
    current = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  await input.journal.complete(prepared.cursor, receipt, current);
  check();
  return { receipt, current };
}
export async function recoverStorePaymentConfiguration(input: {
  client: ReturnType<typeof createStorePaymentConfigurationClient>;
  journal: StorePaymentConfigurationPendingJournal;
  cursor: StorePaymentConfigurationCursor;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const receipt = await input.client.resolve(input.cursor, {
      csrf: input.csrf,
      signal: input.signal,
    }),
    current = await input.client.load({
      storeReference: input.cursor.scope.storeReference,
      expectedScope: input.cursor.scope,
      signal: input.signal,
    });
  if (input.signal.aborted || input.isCurrent?.() === false)
    throw new StoreSetupClientError("ScopeChanged");
  await input.journal.complete(input.cursor, receipt, current);
  return { receipt, current };
}

/** Fresh owning choices validate only recorded classification selection, never legal qualification. */
export function validateStoreSetupFeeSelections(
  content: StoreSetupContent,
  choices: Awaited<ReturnType<ReturnType<typeof createStoreSetupClient>["classifications"]>>,
  now = Date.now(),
): void {
  if (Date.parse(choices.observedAt) > now || Date.parse(choices.validUntil) <= now)
    throw new StoreSetupClientError("Stale");
  if (content.feeContexts?.state !== "Configured") return;
  for (const entry of content.feeContexts.value) {
    if (
      entry.state === "Enabled" &&
      // WP-2423 (v15 D7): only a Tip may be On with no tax classification (not taxed).
      (entry.taxClassificationReference !== null || entry.chargeType !== "Tip") &&
      !choices.choices.some(
        (v) =>
          v.classificationReference === entry.taxClassificationReference &&
          v.lifecycle === "Active",
      )
    )
      throw new StoreSetupClientError("Invalid");
  }
}
export function StoreSetupFeeContextEditor({
  scope,
  csrf,
  value,
  disabled,
  onChange,
  client: injected,
  taxClassificationsHref,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly value: NonNullable<StoreSetupContent["feeContexts"]>;
  readonly disabled: boolean;
  readonly onChange: (value: NonNullable<StoreSetupContent["feeContexts"]>) => void;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
  /** WP-2423: where the Brand Owner adds tax classifications (only for people who can). */
  readonly taxClassificationsHref?: string;
}) {
  const client = useMemo(() => injected ?? createStoreSetupClient(), [injected]);
  const [choices, setChoices] = useState<Awaited<ReturnType<typeof client.classifications>> | null>(
    null,
  );
  const [error, setError] = useState<false | "Unavailable" | "NotRegistered" | "Denied">(false),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current,
      controller = new AbortController();
    setChoices(null);
    setError(false);
    void client
      .classifications({
        storeReference: scope.storeReference,
        expectedScope: scope,
        signal: controller.signal,
      })
      .then((v) => {
        if (token === generation.current && !controller.signal.aborted) setChoices(v);
      })
      .catch((reason: unknown) => {
        if (token === generation.current && !controller.signal.aborted)
          setError(
            reason instanceof StoreSetupClientError &&
              (reason.code === "NotRegistered" || reason.code === "Denied")
              ? reason.code
              : "Unavailable",
          );
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [client, scope, csrf, reload]);
  const entries: readonly StoreSetupFeeContext[] =
    value.state === "Configured"
      ? value.value
      : storeSetupFeeCharges.map((chargeType) => ({ chargeType, state: "Unconfigured" as const }));
  const change = (index: number, entry: StoreSetupFeeContext) =>
    onChange({ state: "Configured", value: entries.map((v, i) => (i === index ? entry : v)) });
  // WP-2423 (v15 D5): the choices load as soon as this step opens. They are only what can be
  // picked: the server answers within seconds of reading them, and Save reads them again and
  // refuses a classification no longer in use, so picking never waits for a manual refresh.
  const loading = choices === null && error === false;
  return (
    <section className="store-setup-fee-contexts" aria-label={t("Fees")}>
      <h4>{t("Fees")}</h4>
      <p>
        {t(
          "Choose whether this store uses a service charge, a delivery fee and tips, and which orders each one applies to. Saving the setup draft keeps these choices. It does not set fee amounts or tax rates, and customers are not charged anything new until the store settings are approved and published.",
        )}
      </p>
      {loading && <p role="status">{t("Loading tax classification choices…")}</p>}
      {error === "NotRegistered" && (
        <p role="status">
          {t(
            "No tax classifications are set up for this Brand yet, so a service charge or delivery fee cannot be turned on here. Leave them as Not set or Off; tips can still be turned on, and you can save the rest of this setup.",
          )}
        </p>
      )}
      {taxClassificationsHref !== undefined &&
        (error === "NotRegistered" ||
          (choices !== null && !choices.choices.some((v) => v.lifecycle === "Active"))) && (
          <p>
            <Link to={taxClassificationsHref}>{t("Set up the Brand’s tax classifications")}</Link>
            {t(", then come back and choose Refresh fee classification choices.")}
          </p>
        )}
      {error === "Denied" && (
        <p role="status">
          {t(
            "Choosing a tax classification needs permission to read Products and tax settings. Leave the service charge and delivery fee as Not set or Off; tips can still be turned on, and you can save the rest of this setup.",
          )}
        </p>
      )}
      {error === "Unavailable" && (
        <p role="status">
          {t(
            "Tax classifications could not be loaded. Choose Refresh fee classification choices to try again; tips, and fees that are Not set or Off, can still be saved.",
          )}
        </p>
      )}
      <button type="button" disabled={disabled || loading} onClick={() => setReload((v) => v + 1)}>
        {t("Refresh fee classification choices")}
      </button>
      {entries.map((entry, index) => (
        <fieldset disabled={disabled} key={entry.chargeType}>
          <legend>{feeLabel(entry.chargeType)}</legend>
          <label>
            {feeLabel(entry.chargeType)}
            <select
              aria-label={feeLabel(entry.chargeType)}
              value={entry.state}
              onChange={(e) => {
                const state = e.currentTarget.value;
                if (state === "Unconfigured" || state === "Disabled")
                  change(index, { chargeType: entry.chargeType, state });
                else if (state === "Enabled")
                  change(
                    index,
                    entry.state === "Enabled"
                      ? entry
                      : {
                          chargeType: entry.chargeType,
                          state: "Enabled",
                          // WP-2423 (v15 D7): a tip is not taxed, so it starts without one.
                          taxClassificationReference: entry.chargeType === "Tip" ? null : "",
                          orderTypes: [],
                        },
                  );
              }}
            >
              <option value="Unconfigured">{t("Not set")}</option>
              <option value="Disabled">{t("Off")}</option>
              <option value="Enabled">{t("On")}</option>
            </select>
          </label>
          {entry.chargeType === "Tip" ? (
            <p>
              {t(
                "Off: once published, guests and staff are not asked for a tip at this Store. On: tips are offered; the percentages are under Store features.",
              )}
            </p>
          ) : null}
          <label>
            {t("{chargeType} tax classification", { chargeType: feeLabel(entry.chargeType) })}
            <select
              aria-label={t("{chargeType} tax classification", {
                chargeType: feeLabel(entry.chargeType),
              })}
              disabled={
                disabled ||
                entry.state !== "Enabled" ||
                (choices === null && entry.chargeType !== "Tip")
              }
              value={
                entry.state === "Enabled" && entry.taxClassificationReference !== null
                  ? entry.taxClassificationReference
                  : ""
              }
              onChange={(e) => {
                if (entry.state !== "Enabled") return;
                if (e.currentTarget.value === "" && entry.chargeType === "Tip") {
                  change(index, { ...entry, taxClassificationReference: null });
                  return;
                }
                const selected = choices?.choices.find(
                  (v) =>
                    v.classificationReference === e.currentTarget.value && v.lifecycle === "Active",
                );
                if (!selected) return;
                change(index, {
                  ...entry,
                  taxClassificationReference: selected.classificationReference,
                });
              }}
            >
              <option value="">
                {entry.chargeType === "Tip"
                  ? t("No tax classification (tips are not taxed)")
                  : t("Choose a tax classification to turn this on")}
              </option>
              {entry.state === "Enabled" &&
                entry.taxClassificationReference !== null &&
                entry.taxClassificationReference !== "" &&
                !choices?.choices.some(
                  (v) => v.classificationReference === entry.taxClassificationReference,
                ) && (
                  <option value={entry.taxClassificationReference}>
                    {t("Saved classification retained")}
                  </option>
                )}
              {choices?.choices.map((choice) => (
                <option
                  key={choice.classificationReference}
                  value={choice.classificationReference}
                  disabled={choice.lifecycle !== "Active"}
                >
                  {choice.localizedNames[choices.defaultLocale] ??
                    Object.values(choice.localizedNames)[0] ??
                    t("Unnamed tax classification")}
                  {choice.lifecycle === "Active" ? "" : t(" (no longer in use)")}
                </option>
              ))}
            </select>
          </label>
          {entry.state === "Enabled" && (
            <fieldset>
              <legend>
                {t("{chargeType} order types", { chargeType: feeLabel(entry.chargeType) })}
              </legend>
              {modes.map((mode) => (
                <label key={mode}>
                  <input
                    type="checkbox"
                    checked={entry.orderTypes.includes(mode)}
                    onChange={(e) =>
                      change(index, {
                        ...entry,
                        orderTypes: e.currentTarget.checked
                          ? modes.filter((v) => v === mode || entry.orderTypes.includes(v))
                          : entry.orderTypes.filter((v) => v !== mode),
                      })
                    }
                  />
                  {mode === "DineIn" ? t("Dine in") : serviceModeText(mode)}
                </label>
              ))}
            </fieldset>
          )}
        </fieldset>
      ))}
      <p>
        {t(
          "A service charge or delivery fee that is On needs a tax classification, and every fee that is On needs at least one order type before saving. Tips customers choose to give go to staff and are generally not subject to GST/HST, so a tip needs no tax classification (a service charge every customer must pay is taxed). The classification is the Brand’s own choice; it has not been checked by a tax professional.",
        )}
      </p>
    </section>
  );
}

/** The live Store's own operating settings "Use the live Store's settings" also fills in where the
 * setup has none yet (WP-2423 v15: a running Store starts its setup from what it runs today),
 * including the receipt template it issues receipts with today (checked again when the
 * configuration is created). The address, contact and payment settings it runs with were set at
 * installation and are not Store setup records: they are entered and saved in their steps. */
const liveOperatingFields = [
  "source",
  "timeZone",
  "businessDayStartLocalTime",
  "enabledServiceModes",
  "weeklySchedule",
  "capacityConfigurationReference",
  "receiptReference",
] as const;
/** The setup change "Use the live Store's settings" makes: tax and Brand settings of the live Store,
 * its opening hours (DEC-STORE-SETUP-PUBLICATION 13: using the live settings carries what the live
 * Store runs with, so publishing does not silently change its hours; the screen says so before the
 * button is used), its holidays when the setup has none, a start as soon as it is published (server
 * time), and the live Store's time zone, business day start, service modes, order limits and receipt
 * template where the setup has none yet. Those other settings already in the setup are kept. */
export function liveStoreSettingsChange(
  content: StoreSetupContent,
  live: StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot },
): Partial<StoreSetupContent> {
  const current = live.current;
  const operating = Object.fromEntries(
    liveOperatingFields
      .filter((field) => content[field].state !== "Configured")
      .map((field) => [field, { state: "Configured", value: current[field] }]),
  ) as Partial<StoreSetupContent>;
  return {
    ...operating,
    weeklySchedule: { state: "Configured", value: current.weeklySchedule },
    taxConfigurationReference: { state: "Configured", value: liveStoreTaxReference(live) },
    brandBaseVersionReference: { state: "Configured", value: current.brandBaseVersionReference },
    exceptions:
      content.exceptions.state === "Configured"
        ? content.exceptions
        : { state: "Configured", value: current.exceptions },
    effectiveFrom: { state: "Configured", value: live.observedAt },
    effectiveUntil: { state: "Configured", value: null },
  };
}
/** WP-2423 item 14 (DEC-STORE-FIRST-OPENING): what a first opening takes from the live Store: tax and
 * Brand settings, holidays and a start as soon as it is published. Unlike the button above it never
 * replaces hours the Owner answered, and it carries neither the hours, the service modes nor the
 * receipt template of the configuration a Store starts with: a TEST Store's reads 24 hours with pickup
 * on and names a template that was never published. The time zone and business day start are the
 * Store's own, the only values the publication checks accept. */
const firstOpeningCarried = liveOperatingFields.filter(
  (field) =>
    field !== "weeklySchedule" && field !== "enabledServiceModes" && field !== "receiptReference",
);
export function firstOpeningFill(
  content: StoreSetupContent,
  live: StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot },
): Partial<StoreSetupContent> {
  const current = live.current;
  const carried = Object.fromEntries(
    firstOpeningCarried
      .filter((field) => content[field].state !== "Configured")
      .map((field) => [field, { state: "Configured", value: current[field] }]),
  ) as Partial<StoreSetupContent>;
  return {
    ...carried,
    timeZone: { state: "Configured", value: current.timeZone },
    businessDayStartLocalTime: { state: "Configured", value: current.businessDayStartLocalTime },
    taxConfigurationReference: { state: "Configured", value: liveStoreTaxReference(live) },
    brandBaseVersionReference: { state: "Configured", value: current.brandBaseVersionReference },
    exceptions:
      content.exceptions.state === "Configured"
        ? content.exceptions
        : { state: "Configured", value: current.exceptions },
    // A start already saved still means "as soon as it is published": pressing again after a stop
    // writes no new revision for it.
    effectiveFrom:
      content.effectiveFrom.state === "Configured" &&
      content.effectiveFrom.value >= current.effectiveFrom &&
      content.effectiveFrom.value <= live.observedAt
        ? content.effectiveFrom
        : { state: "Configured", value: live.observedAt },
    effectiveUntil: { state: "Configured", value: null },
  };
}
type WeeklySchedule = StoreConfigurationSnapshot["weeklySchedule"];
type ScheduleInterval = WeeklySchedule[number]["intervals"][number];
const clock = (value: string) => value.slice(0, 5);
function intervalText(interval: ScheduleInterval, detailed: boolean): string {
  const times = `${clock(interval.startLocalTime)}\u2013${clock(interval.endLocalTime)}${
    interval.endsNextDay ? t(" (next day)") : ""
  }`;
  if (!detailed) return times;
  const services = interval.serviceModes.map(serviceModeText).join(", ");
  return t(
    "{times} ({services}; last orders {orderCutoffSeconds} min before closing; preparation {leadTimeSeconds} min)",
    {
      times: times,
      services: services,
      orderCutoffSeconds: waitMinutesText(interval.orderCutoffSeconds),
      leadTimeSeconds: waitMinutesText(interval.leadTimeSeconds),
    },
  );
}
function dayText(intervals: readonly ScheduleInterval[] | undefined, detailed: boolean): string {
  return intervals === undefined || intervals.length === 0
    ? t("closed")
    : intervals.map((interval) => intervalText(interval, detailed)).join(", ");
}
/**
 * WP-2423 (v15): how publishing this setup changes the live Store's opening hours, one line per
 * day that changes ("Sunday: 10:00–20:00 becomes 10:00–15:00"); times alone when they differ,
 * otherwise the service modes and wait times that do. Empty when the hours are the same.
 */
export function openingHoursChanges(
  live: WeeklySchedule,
  setup: WeeklySchedule,
): readonly string[] {
  const byDay = (schedule: WeeklySchedule) =>
    new Map(schedule.map((day) => [day.isoWeekday, day.intervals] as const));
  const from = byDay(live),
    to = byDay(setup);
  return days.flatMap((name, i) => {
    const before = from.get(i + 1),
      after = to.get(i + 1);
    if (JSON.stringify(before ?? []) === JSON.stringify(after ?? [])) return [];
    const detailed = dayText(before, false) === dayText(after, false);
    return [
      t("{name}: {before} becomes {after}", {
        name: name,
        before: dayText(before, detailed),
        after: dayText(after, detailed),
      }),
    ];
  });
}
/** The live (published) Store configuration as the publication panel read it. */
export interface StoreSetupLiveConfiguration {
  readonly current: StoreConfigurationSnapshot | null;
  readonly observedAt: string;
  /** WP-2423 (v15 `8bd902e3` D1): the tax configuration that governs the Store now (the one its
   * quotes use and the publication check expects), when read. */
  readonly storeTaxConfigurationReference?: string | null;
}
/** v15 D1: the Store's tax settings in force: its tax configuration record (an installed
 * configuration may still name the installer's reference), else the live configuration's. */
export function liveStoreTaxReference(
  live: StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot },
): string {
  return live.storeTaxConfigurationReference ?? live.current.taxConfigurationReference;
}
/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: settings Store setup does not edit itself — the Store's tax
 * settings (Tax review), its Brand settings, holidays and special hours (Hours & ordering) and when
 * it takes effect — are carried from the live Store, so a saved setup can be created and published.
 */
export function StoreSetupLiveSettings({
  content,
  live,
  disabled,
  onUse,
}: {
  readonly layout?: StoreSetupLayout;
  readonly content: StoreSetupContent;
  readonly live: StoreSetupLiveConfiguration | null;
  readonly disabled: boolean;
  onUse(change: Partial<StoreSetupContent>): void;
}) {
  if (live === null || live.current === null) return null;
  const current = live.current;
  const known = { ...live, current };
  const same = <T,>(value: StoreSetupContent[keyof StoreSetupContent] | undefined, expected: T) =>
    value?.state === "Configured" && JSON.stringify(value.value) === JSON.stringify(expected);
  const tax = same(content.taxConfigurationReference, liveStoreTaxReference(known)),
    brand = same(content.brandBaseVersionReference, current.brandBaseVersionReference),
    closures = content.exceptions.state === "Configured",
    start =
      content.effectiveFrom.state === "Configured" &&
      content.effectiveFrom.value <= live.observedAt &&
      content.effectiveFrom.value >= current.effectiveFrom &&
      content.effectiveUntil.state === "Configured" &&
      content.effectiveUntil.value === null;
  const hours = same(content.weeklySchedule, current.weeklySchedule);
  // The live operating settings the setup has none of yet (filled in by the button below).
  const missingOperating = liveOperatingFields.filter(
    (field) => content[field].state !== "Configured",
  );
  // b19: only what still has to come from the live Store is named, in plain words; when nothing
  // does, this says nothing (the summary above already shows what publishing changes).
  const needed = [
    ...(tax ? [] : [t("tax settings (see Tax review)")]),
    ...(brand ? [] : [t("brand settings")]),
    ...(closures ? [] : [t("holidays and special hours")]),
    ...(start ? [] : [t("when it takes effect")]),
    ...missingOperating.flatMap((field) => liveFieldWords()[field] ?? []),
  ];
  const hoursConfigured = content.weeklySchedule.state === "Configured";
  if (needed.length === 0 && (hours || !hoursConfigured)) return null;
  return (
    <section className="store-setup-carry" aria-label={t("Settings from the live Store")}>
      {needed.length > 0 && (
        <>
          <p>
            {t(
              "Still to take from the Store as it runs today: {list}. These are not changed in Store setup. Use them, then save as draft.",
              { list: needed.join(listSeparator()) },
            )}
            {!hours && hoursConfigured
              ? t(" This also replaces the opening hours in this setup with the live Store’s.")
              : ""}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onUse(liveStoreSettingsChange(content, known))}
          >
            {t("Use the live Store’s settings")}
          </button>
        </>
      )}
      {!hours && hoursConfigured && (
        <>
          <p>
            {t(
              "Publishing changes the opening hours as shown above. To keep the hours the Store opens with today, use them and save as draft.",
            )}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onUse({ weeklySchedule: { state: "Configured", value: current.weeklySchedule } })
            }
          >
            {t("Use the live Store’s opening hours")}
          </button>
        </>
      )}
    </section>
  );
}
/** b19: the live operating settings in plain words (`source` is not one staff see). */
const liveFieldWords = (): Readonly<
  Partial<Record<(typeof liveOperatingFields)[number], string>>
> => ({
  timeZone: t("time zone"),
  businessDayStartLocalTime: t("business day start"),
  enabledServiceModes: t("services"),
  weeklySchedule: t("opening hours"),
  capacityConfigurationReference: t("order limits"),
  receiptReference: t("receipt layout"),
});
