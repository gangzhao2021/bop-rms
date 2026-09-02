export type ConsentPreferenceClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ConsentPreferenceClientError extends Error {
  constructor(readonly code: ConsentPreferenceClientErrorCode) {
    super("Consent and Preference unavailable");
    this.name = "ConsentPreferenceClientError";
  }
}
type Purpose = "Marketing" | "Loyalty" | "Personalization";
type Channel = "Email" | "SMS" | "Push" | "WeChat";
export interface ConsentPreferenceView {
  readonly projectionName: "customer_consent_preference_v1";
  readonly projectionVersion: 1;
  readonly screenId: "CONSENT-PREFERENCE";
  readonly brandLabel: string;
  readonly customerReference: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly aggregateVersion: number;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayExportProof: boolean;
    readonly mayViewEvidence: boolean;
  };
  readonly choices: readonly {
    readonly consentReference: string;
    readonly purpose: Purpose;
    readonly channel: Channel;
    readonly status: "Granted" | "Withdrawn";
    readonly contactMethodReference: string;
    readonly policyVersion: string;
    readonly jurisdictionCode: string;
    readonly sourceCode: string;
    readonly actorReference: string;
    readonly effectiveAt: string;
    readonly recordedAt: string;
    readonly evidenceReference: string | null;
  }[];
  readonly preference: null | {
    readonly preferredLanguage: string;
    readonly preferredChannel: Channel | null;
    readonly quietHours: null | { readonly startMinute: number; readonly endMinute: number };
    readonly frequencyCode: "TransactionalOnly" | "Standard" | "Reduced";
    readonly storeReference: string | null;
    readonly recordedAt: string;
  };
}
export interface ConsentPreferenceClient {
  load(customerReference: string): Promise<unknown>;
}
const fail = (): never => {
  throw new ConsentPreferenceClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (v: unknown, fields: readonly string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== fields.length ||
    Reflect.ownKeys(v).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return v as Record<string, unknown>;
};
const ref = (v: unknown) => (typeof v === "string" && uuid.test(v) ? v : fail());
const text = (v: unknown) =>
  typeof v === "string" && v.trim() === v && /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u.test(v) ? v : fail();
const instant = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  new Date(Date.parse(v)).toISOString() === v
    ? v
    : fail();
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : fail();
const channel = (v: unknown) =>
  typeof v === "string" && ["Email", "SMS", "Push", "WeChat"].includes(v) ? (v as Channel) : fail();
export function parseConsentPreferenceView(value: unknown): ConsentPreferenceView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "customerReference",
    "asOfUtc",
    "freshness",
    "partial",
    "aggregateVersion",
    "permissions",
    "choices",
    "preference",
  ]);
  if (
    raw.projectionName !== "customer_consent_preference_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "CONSENT-PREFERENCE" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.choices) ||
    raw.choices.length > 500
  )
    fail();
  const p = object(raw.permissions, ["mayManage", "mayExportProof", "mayViewEvidence"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const permissions = p as unknown as ConsentPreferenceView["permissions"];
  const choiceRows = raw.choices as unknown[];
  const choices = Object.freeze(
    choiceRows.map((item: unknown) => {
      const c = object(item, [
        "consentReference",
        "purpose",
        "channel",
        "status",
        "contactMethodReference",
        "policyVersion",
        "jurisdictionCode",
        "sourceCode",
        "actorReference",
        "effectiveAt",
        "recordedAt",
        "evidenceReference",
      ]);
      if (
        !["Marketing", "Loyalty", "Personalization"].includes(c.purpose as string) ||
        !["Granted", "Withdrawn"].includes(c.status as string) ||
        (!permissions.mayViewEvidence && c.evidenceReference !== null)
      )
        fail();
      return Object.freeze({
        consentReference: ref(c.consentReference),
        purpose: c.purpose as Purpose,
        channel: channel(c.channel),
        status: c.status as "Granted" | "Withdrawn",
        contactMethodReference: ref(c.contactMethodReference),
        policyVersion: text(c.policyVersion),
        jurisdictionCode: text(c.jurisdictionCode),
        sourceCode: text(c.sourceCode),
        actorReference: ref(c.actorReference),
        effectiveAt: instant(c.effectiveAt),
        recordedAt: instant(c.recordedAt),
        evidenceReference: c.evidenceReference === null ? null : ref(c.evidenceReference),
      });
    }),
  );
  let preference: ConsentPreferenceView["preference"] = null;
  if (raw.preference !== null) {
    const x = object(raw.preference, [
      "preferredLanguage",
      "preferredChannel",
      "quietHours",
      "frequencyCode",
      "storeReference",
      "recordedAt",
    ]);
    let quietHours: null | { readonly startMinute: number; readonly endMinute: number } = null;
    if (x.quietHours !== null) {
      const q = object(x.quietHours, ["startMinute", "endMinute"]);
      quietHours = Object.freeze({
        startMinute: integer(q.startMinute, 1439),
        endMinute: integer(q.endMinute, 1439),
      });
    }
    if (!["TransactionalOnly", "Standard", "Reduced"].includes(x.frequencyCode as string)) fail();
    preference = Object.freeze({
      preferredLanguage: text(x.preferredLanguage),
      preferredChannel: x.preferredChannel === null ? null : channel(x.preferredChannel),
      quietHours,
      frequencyCode: x.frequencyCode as "TransactionalOnly" | "Standard" | "Reduced",
      storeReference: x.storeReference === null ? null : ref(x.storeReference),
      recordedAt: instant(x.recordedAt),
    });
  }
  return Object.freeze({
    projectionName: "customer_consent_preference_v1",
    projectionVersion: 1,
    screenId: "CONSENT-PREFERENCE",
    brandLabel: text(raw.brandLabel),
    customerReference: ref(raw.customerReference),
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as ConsentPreferenceView["freshness"],
    partial: raw.partial as boolean,
    aggregateVersion: integer(raw.aggregateVersion),
    permissions,
    choices,
    preference,
  });
}
export const unavailableConsentPreferenceClient: ConsentPreferenceClient = Object.freeze({
  async load() {
    throw new ConsentPreferenceClientError("FeatureDisabled");
  },
});
