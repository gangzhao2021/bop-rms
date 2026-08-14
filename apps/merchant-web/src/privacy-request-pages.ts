export type PrivacyRequestClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class PrivacyRequestClientError extends Error {
  constructor(readonly code: PrivacyRequestClientErrorCode) {
    super("Privacy Request unavailable");
    this.name = "PrivacyRequestClientError";
  }
}
type Status =
  | "Intake"
  | "Verified"
  | "Assigned"
  | "Collecting"
  | "InReview"
  | "Fulfilled"
  | "Denied"
  | "Closed";
export interface PrivacyRequestView {
  readonly projectionName: "privacy_request_v1";
  readonly projectionVersion: 1;
  readonly screenId: "PRIVACY-REQUEST";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayIntake: boolean;
    readonly mayVerify: boolean;
    readonly mayFulfill: boolean;
    readonly mayViewVerification: boolean;
  };
  readonly rows: readonly {
    readonly requestReference: string;
    readonly subjectReference: string;
    readonly right:
      "AccessPortability" | "Correction" | "ConsentWithdrawal" | "DeletionAnonymization";
    readonly status: Status;
    readonly verificationReference: string | null;
    readonly ownerReference: string | null;
    readonly dueAt: string;
    readonly holdCount: number;
    readonly pendingOwnerCount: number;
    readonly completedOwnerCount: number;
    readonly exportExpiresAt: string | null;
    readonly aggregateVersion: number;
  }[];
}
export interface PrivacyRequestClient {
  load(): Promise<unknown>;
}
const fail = (): never => {
  throw new PrivacyRequestClientError("Unavailable");
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
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail();
export function parsePrivacyRequestView(value: unknown): PrivacyRequestView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
  ]);
  if (
    raw.projectionName !== "privacy_request_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "PRIVACY-REQUEST" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 500
  )
    fail();
  const p = object(raw.permissions, [
    "mayIntake",
    "mayVerify",
    "mayFulfill",
    "mayViewVerification",
  ]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const permissions = p as unknown as PrivacyRequestView["permissions"];
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((v) => {
      const r = object(v, [
        "requestReference",
        "subjectReference",
        "right",
        "status",
        "verificationReference",
        "ownerReference",
        "dueAt",
        "holdCount",
        "pendingOwnerCount",
        "completedOwnerCount",
        "exportExpiresAt",
        "aggregateVersion",
      ]);
      if (
        !["AccessPortability", "Correction", "ConsentWithdrawal", "DeletionAnonymization"].includes(
          r.right as string,
        ) ||
        ![
          "Intake",
          "Verified",
          "Assigned",
          "Collecting",
          "InReview",
          "Fulfilled",
          "Denied",
          "Closed",
        ].includes(r.status as string) ||
        (!permissions.mayViewVerification && r.verificationReference !== null)
      )
        fail();
      return Object.freeze({
        requestReference: ref(r.requestReference),
        subjectReference: ref(r.subjectReference),
        right: r.right as PrivacyRequestView["rows"][number]["right"],
        status: r.status as Status,
        verificationReference:
          r.verificationReference === null ? null : ref(r.verificationReference),
        ownerReference: r.ownerReference === null ? null : ref(r.ownerReference),
        dueAt: instant(r.dueAt),
        holdCount: integer(r.holdCount),
        pendingOwnerCount: integer(r.pendingOwnerCount),
        completedOwnerCount: integer(r.completedOwnerCount),
        exportExpiresAt: r.exportExpiresAt === null ? null : instant(r.exportExpiresAt),
        aggregateVersion: integer(r.aggregateVersion),
      });
    }),
  );
  return Object.freeze({
    projectionName: "privacy_request_v1",
    projectionVersion: 1,
    screenId: "PRIVACY-REQUEST",
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as PrivacyRequestView["freshness"],
    partial: raw.partial as boolean,
    permissions,
    rows,
  });
}
export const unavailablePrivacyRequestClient: PrivacyRequestClient = Object.freeze({
  async load() {
    throw new PrivacyRequestClientError("FeatureDisabled");
  },
});
