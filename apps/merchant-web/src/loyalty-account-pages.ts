export type LoyaltyAccountClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class LoyaltyAccountClientError extends Error {
  constructor(readonly code: LoyaltyAccountClientErrorCode) {
    super("Loyalty Account unavailable");
    this.name = "LoyaltyAccountClientError";
  }
}
type TxType =
  "Earn" | "Activate" | "Reserve" | "Release" | "Redeem" | "Reverse" | "Adjust" | "Expire";
export interface LoyaltyAccountView {
  readonly projectionName: "loyalty_account_v1";
  readonly projectionVersion: 1;
  readonly screenId: "LOY-ACCOUNT-DETAIL";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewLedger: boolean;
    readonly mayOperate: boolean;
    readonly mayCorrect: boolean;
  };
  readonly account: null | {
    readonly accountReference: string;
    readonly aggregateVersion: number;
    readonly status: "Pending" | "Active" | "Suspended" | "Closed";
    readonly programReference: string;
    readonly tierCode: string | null;
    readonly pendingPoints: number;
    readonly availablePoints: number;
    readonly reservedPoints: number;
    readonly lifetimeEarnedPoints: number;
    readonly pointsDebt: number;
    readonly expiringPoints: number;
    readonly ledger:
      | readonly {
          readonly transactionReference: string;
          readonly type: TxType;
          readonly points: number;
          readonly sourceReference: string;
          readonly occurredAt: string;
          readonly originalTransactionReference: string | null;
        }[]
      | null;
    readonly rewardReferences: readonly string[];
    readonly reservations: readonly {
      readonly reservationReference: string;
      readonly targetReference: string;
      readonly points: number;
      readonly expiresAt: string;
      readonly status: "Reserved" | "Released" | "Redeemed";
    }[];
    readonly linkedAllocationReferences: readonly string[];
  };
}
export interface PointsReviewView {
  readonly projectionName: "loyalty_points_exception_v1";
  readonly projectionVersion: 1;
  readonly screenId: "LOY-POINTS-REVIEW";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: { readonly mayReview: boolean; readonly mayCorrect: boolean };
  readonly rows: readonly {
    readonly exceptionReference: string;
    readonly accountReference: string;
    readonly sourceReference: string;
    readonly type:
      "DuplicateEarn" | "FailedEarn" | "RefundReversal" | "ExpiredReservation" | "NegativeMismatch";
    readonly status: "Open" | "Acknowledged" | "Resolved";
    readonly ownerReference: string | null;
    readonly dueAt: string;
    readonly correctionTransactionReference: string | null;
  }[];
}
export interface LoyaltyAccountClient {
  load(screenId: "LOY-ACCOUNT-DETAIL" | "LOY-POINTS-REVIEW", reference?: string): Promise<unknown>;
}
const fail = (): never => {
  throw new LoyaltyAccountClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (v: unknown, f: readonly string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== f.length ||
    Reflect.ownKeys(v).some((k) => typeof k !== "string" || !f.includes(k))
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
const refs = (v: unknown) =>
  !Array.isArray(v) || v.length > 200 ? fail() : Object.freeze(v.map(ref));
const fresh = (v: unknown) =>
  typeof v === "string" && ["Current", "Stale", "Rebuilding"].includes(v)
    ? (v as "Current" | "Stale" | "Rebuilding")
    : fail();
export function parseLoyaltyAccountView(value: unknown): LoyaltyAccountView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "account",
  ]);
  if (
    raw.projectionName !== "loyalty_account_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "LOY-ACCOUNT-DETAIL" ||
    typeof raw.partial !== "boolean"
  )
    fail();
  const p = object(raw.permissions, ["mayViewLedger", "mayOperate", "mayCorrect"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const permissions = p as unknown as LoyaltyAccountView["permissions"];
  let account: LoyaltyAccountView["account"] = null;
  if (raw.account !== null) {
    const a = object(raw.account, [
      "accountReference",
      "aggregateVersion",
      "status",
      "programReference",
      "tierCode",
      "pendingPoints",
      "availablePoints",
      "reservedPoints",
      "lifetimeEarnedPoints",
      "pointsDebt",
      "expiringPoints",
      "ledger",
      "rewardReferences",
      "reservations",
      "linkedAllocationReferences",
    ]);
    if (!permissions.mayViewLedger && a.ledger !== null) fail();
    if (
      !["Pending", "Active", "Suspended", "Closed"].includes(a.status as string) ||
      !Array.isArray(a.reservations) ||
      (a.ledger !== null && !Array.isArray(a.ledger))
    )
      fail();
    const ledger =
      a.ledger === null
        ? null
        : Object.freeze(
            (a.ledger as unknown[]).map((v) => {
              const t = object(v, [
                "transactionReference",
                "type",
                "points",
                "sourceReference",
                "occurredAt",
                "originalTransactionReference",
              ]);
              if (
                ![
                  "Earn",
                  "Activate",
                  "Reserve",
                  "Release",
                  "Redeem",
                  "Reverse",
                  "Adjust",
                  "Expire",
                ].includes(t.type as string)
              )
                fail();
              return Object.freeze({
                transactionReference: ref(t.transactionReference),
                type: t.type as TxType,
                points: integer(t.points),
                sourceReference: ref(t.sourceReference),
                occurredAt: instant(t.occurredAt),
                originalTransactionReference:
                  t.originalTransactionReference === null
                    ? null
                    : ref(t.originalTransactionReference),
              });
            }),
          );
    const reservations = Object.freeze(
      (a.reservations as unknown[]).map((v) => {
        const x = object(v, [
          "reservationReference",
          "targetReference",
          "points",
          "expiresAt",
          "status",
        ]);
        if (!["Reserved", "Released", "Redeemed"].includes(x.status as string)) fail();
        return Object.freeze({
          reservationReference: ref(x.reservationReference),
          targetReference: ref(x.targetReference),
          points: integer(x.points),
          expiresAt: instant(x.expiresAt),
          status: x.status as "Reserved" | "Released" | "Redeemed",
        });
      }),
    );
    account = Object.freeze({
      accountReference: ref(a.accountReference),
      aggregateVersion: integer(a.aggregateVersion),
      status: a.status as NonNullable<LoyaltyAccountView["account"]>["status"],
      programReference: ref(a.programReference),
      tierCode: a.tierCode === null ? null : text(a.tierCode),
      pendingPoints: integer(a.pendingPoints),
      availablePoints: integer(a.availablePoints),
      reservedPoints: integer(a.reservedPoints),
      lifetimeEarnedPoints: integer(a.lifetimeEarnedPoints),
      pointsDebt: integer(a.pointsDebt),
      expiringPoints: integer(a.expiringPoints),
      ledger,
      rewardReferences: refs(a.rewardReferences),
      reservations,
      linkedAllocationReferences: refs(a.linkedAllocationReferences),
    });
  }
  return Object.freeze({
    projectionName: "loyalty_account_v1",
    projectionVersion: 1,
    screenId: "LOY-ACCOUNT-DETAIL",
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: fresh(raw.freshness),
    partial: raw.partial as boolean,
    permissions,
    account,
  });
}
export function parsePointsReviewView(value: unknown): PointsReviewView {
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
    raw.projectionName !== "loyalty_points_exception_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "LOY-POINTS-REVIEW" ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200
  )
    fail();
  const p = object(raw.permissions, ["mayReview", "mayCorrect"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((v) => {
      const x = object(v, [
        "exceptionReference",
        "accountReference",
        "sourceReference",
        "type",
        "status",
        "ownerReference",
        "dueAt",
        "correctionTransactionReference",
      ]);
      if (
        ![
          "DuplicateEarn",
          "FailedEarn",
          "RefundReversal",
          "ExpiredReservation",
          "NegativeMismatch",
        ].includes(x.type as string) ||
        !["Open", "Acknowledged", "Resolved"].includes(x.status as string)
      )
        fail();
      return Object.freeze({
        exceptionReference: ref(x.exceptionReference),
        accountReference: ref(x.accountReference),
        sourceReference: ref(x.sourceReference),
        type: x.type as PointsReviewView["rows"][number]["type"],
        status: x.status as PointsReviewView["rows"][number]["status"],
        ownerReference: x.ownerReference === null ? null : ref(x.ownerReference),
        dueAt: instant(x.dueAt),
        correctionTransactionReference:
          x.correctionTransactionReference === null ? null : ref(x.correctionTransactionReference),
      });
    }),
  );
  return Object.freeze({
    projectionName: "loyalty_points_exception_v1",
    projectionVersion: 1,
    screenId: "LOY-POINTS-REVIEW",
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: fresh(raw.freshness),
    partial: raw.partial as boolean,
    permissions: p as unknown as PointsReviewView["permissions"],
    rows,
  });
}
export const unavailableLoyaltyAccountClient: LoyaltyAccountClient = {
  load: async () => {
    throw new LoyaltyAccountClientError("FeatureDisabled");
  },
};
