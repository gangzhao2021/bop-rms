export type CommunicationClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class CommunicationClientError extends Error {
  constructor(readonly code: CommunicationClientErrorCode) {
    super("Communication unavailable");
    this.name = "CommunicationClientError";
  }
}
type Freshness = "Current" | "Stale" | "Rebuilding";
export interface CommunicationHistoryView {
  readonly projectionName: "notification_communication_history_v1";
  readonly projectionVersion: 1;
  readonly screenId: "COMMS-HISTORY";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: Freshness;
  readonly partial: boolean;
  readonly permissions: {
    readonly mayResendOperational: boolean;
    readonly mayManageSuppression: boolean;
  };
  readonly rows: readonly {
    readonly requestReference: string;
    readonly sourceReference: string;
    readonly classification: "Operational" | "Marketing";
    readonly recipientMasked: string;
    readonly templateReference: string;
    readonly templateVersion: number;
    readonly channel: "Email" | "SMS" | "Push";
    readonly providerState: "NotAttempted" | "Delivered" | "Unknown" | "Rejected" | "DeadLettered";
    readonly suppressed: boolean;
    readonly attemptedAt: string | null;
  }[];
}
export interface CommunicationTemplateView {
  readonly projectionName: "notification_template_admin_v1";
  readonly projectionVersion: 1;
  readonly screenId: "COMMS-TEMPLATE-LIST" | "COMMS-TEMPLATE-EDITOR";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: Freshness;
  readonly partial: boolean;
  readonly permissions: {
    readonly mayEdit: boolean;
    readonly mayApprove: boolean;
    readonly mayTest: boolean;
  };
  readonly templates: readonly {
    readonly templateReference: string;
    readonly templateKey: string;
    readonly displayName: string;
    readonly aggregateVersion: number;
    readonly current: null | {
      readonly versionReference: string;
      readonly sequence: number;
      readonly purpose: "Operational" | "Marketing";
      readonly locale: string;
      readonly channel: "Email" | "SMS" | "Push";
      readonly requiredVariables: readonly string[];
      readonly previewFixtureReference: string;
      readonly previewEscaped: true;
      readonly trackingProhibited: true;
      readonly status: "Draft" | "InReview" | "Published" | "Archived";
    };
  }[];
}
export interface CommunicationClient {
  load(
    screenId: "COMMS-HISTORY" | "COMMS-TEMPLATE-LIST" | "COMMS-TEMPLATE-EDITOR",
    reference?: string,
  ): Promise<unknown>;
}
const fail = (): never => {
  throw new CommunicationClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (v: unknown, fields: readonly string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== fields.length ||
    Reflect.ownKeys(v).some((k) => typeof k !== "string" || !fields.includes(k))
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
const integer = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) >= 1 ? (v as number) : fail();
const fresh = (v: unknown) =>
  typeof v === "string" && ["Current", "Stale", "Rebuilding"].includes(v)
    ? (v as Freshness)
    : fail();
const base = (value: unknown, screenIds: readonly string[], extra: string[]) => {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    ...extra,
  ]);
  if (!screenIds.includes(raw.screenId as string) || typeof raw.partial !== "boolean") fail();
  return raw;
};
export function parseCommunicationHistoryView(value: unknown): CommunicationHistoryView {
  const raw = base(value, ["COMMS-HISTORY"], ["rows"]);
  if (
    raw.projectionName !== "notification_communication_history_v1" ||
    raw.projectionVersion !== 1 ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 500
  )
    fail();
  const p = object(raw.permissions, ["mayResendOperational", "mayManageSuppression"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((v) => {
      const r = object(v, [
        "requestReference",
        "sourceReference",
        "classification",
        "recipientMasked",
        "templateReference",
        "templateVersion",
        "channel",
        "providerState",
        "suppressed",
        "attemptedAt",
      ]);
      if (
        !["Operational", "Marketing"].includes(r.classification as string) ||
        !["Email", "SMS", "Push"].includes(r.channel as string) ||
        !["NotAttempted", "Delivered", "Unknown", "Rejected", "DeadLettered"].includes(
          r.providerState as string,
        ) ||
        typeof r.suppressed !== "boolean"
      )
        fail();
      return Object.freeze({
        requestReference: ref(r.requestReference),
        sourceReference: ref(r.sourceReference),
        classification: r.classification as "Operational" | "Marketing",
        recipientMasked: text(r.recipientMasked),
        templateReference: ref(r.templateReference),
        templateVersion: integer(r.templateVersion),
        channel: r.channel as "Email" | "SMS" | "Push",
        providerState: r.providerState as CommunicationHistoryView["rows"][number]["providerState"],
        suppressed: r.suppressed as boolean,
        attemptedAt: r.attemptedAt === null ? null : instant(r.attemptedAt),
      });
    }),
  );
  return Object.freeze({
    projectionName: "notification_communication_history_v1",
    projectionVersion: 1,
    screenId: "COMMS-HISTORY",
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: fresh(raw.freshness),
    partial: raw.partial as boolean,
    permissions: p as unknown as CommunicationHistoryView["permissions"],
    rows,
  });
}
export function parseCommunicationTemplateView(value: unknown): CommunicationTemplateView {
  const raw = base(value, ["COMMS-TEMPLATE-LIST", "COMMS-TEMPLATE-EDITOR"], ["templates"]);
  if (
    raw.projectionName !== "notification_template_admin_v1" ||
    raw.projectionVersion !== 1 ||
    !Array.isArray(raw.templates) ||
    raw.templates.length > 200
  )
    fail();
  const p = object(raw.permissions, ["mayEdit", "mayApprove", "mayTest"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const templates = Object.freeze(
    (raw.templates as unknown[]).map((v) => {
      const t = object(v, [
        "templateReference",
        "templateKey",
        "displayName",
        "aggregateVersion",
        "current",
      ]);
      let current: CommunicationTemplateView["templates"][number]["current"] = null;
      if (t.current !== null) {
        const c = object(t.current, [
          "versionReference",
          "sequence",
          "purpose",
          "locale",
          "channel",
          "requiredVariables",
          "previewFixtureReference",
          "previewEscaped",
          "trackingProhibited",
          "status",
        ]);
        if (
          !["Operational", "Marketing"].includes(c.purpose as string) ||
          !["Email", "SMS", "Push"].includes(c.channel as string) ||
          !["Draft", "InReview", "Published", "Archived"].includes(c.status as string) ||
          c.previewEscaped !== true ||
          c.trackingProhibited !== true ||
          !Array.isArray(c.requiredVariables) ||
          c.requiredVariables.length > 40
        )
          fail();
        current = Object.freeze({
          versionReference: ref(c.versionReference),
          sequence: integer(c.sequence),
          purpose: c.purpose as "Operational" | "Marketing",
          locale: text(c.locale),
          channel: c.channel as "Email" | "SMS" | "Push",
          requiredVariables: Object.freeze((c.requiredVariables as unknown[]).map(text)),
          previewFixtureReference: ref(c.previewFixtureReference),
          previewEscaped: true,
          trackingProhibited: true,
          status: c.status as "Draft" | "InReview" | "Published" | "Archived",
        });
      }
      return Object.freeze({
        templateReference: ref(t.templateReference),
        templateKey: text(t.templateKey),
        displayName: text(t.displayName),
        aggregateVersion: integer(t.aggregateVersion),
        current,
      });
    }),
  );
  return Object.freeze({
    projectionName: "notification_template_admin_v1",
    projectionVersion: 1,
    screenId: raw.screenId as CommunicationTemplateView["screenId"],
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: fresh(raw.freshness),
    partial: raw.partial as boolean,
    permissions: p as unknown as CommunicationTemplateView["permissions"],
    templates,
  });
}
export const unavailableCommunicationClient: CommunicationClient = Object.freeze({
  async load() {
    throw new CommunicationClientError("FeatureDisabled");
  },
});
