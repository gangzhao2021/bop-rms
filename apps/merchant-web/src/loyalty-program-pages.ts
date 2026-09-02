export type LoyaltyProgramClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class LoyaltyProgramClientError extends Error {
  constructor(readonly code: LoyaltyProgramClientErrorCode) {
    super("Loyalty Program unavailable");
    this.name = "LoyaltyProgramClientError";
  }
}
export interface LoyaltyProgramView {
  readonly projectionName: "loyalty_program_v1";
  readonly projectionVersion: 1;
  readonly screenId: "LOY-PROGRAM-LIST" | "LOY-PROGRAM-EDITOR";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewRules: boolean;
    readonly mayEdit: boolean;
    readonly mayApprove: boolean;
  };
  readonly rows: readonly {
    readonly programReference: string;
    readonly programCode: string;
    readonly name: string;
    readonly lifecycle: "Draft" | "Validated" | "Scheduled" | "Published" | "Suspended";
    readonly currentVersion: number;
    readonly memberCount: number | null;
    readonly earnSummary: string | null;
    readonly redeemSummary: string | null;
    readonly scopeSummary: string;
    readonly effectiveFromUtc: string;
    readonly effectiveToUtc: string | null;
  }[];
  readonly detail: null | {
    readonly programReference: string;
    readonly aggregateVersion: number;
    readonly programCode: string;
    readonly versionNumber: number;
    readonly lifecycle: "Draft" | "Validated" | "Scheduled" | "Published" | "Suspended";
    readonly eligibility: string;
    readonly earnActivation: string;
    readonly redemption: string;
    readonly expiry: string;
    readonly tiers: readonly string[] | null;
    readonly rewards: readonly string[] | null;
    readonly refundReversal: string;
    readonly effectivePeriod: string;
    readonly customerCopy: string | null;
    readonly validationIssues: readonly string[];
    readonly simulation: null | {
      readonly earnedPending: number;
      readonly activatedAvailable: number;
      readonly reserved: number;
      readonly redeemed: number;
      readonly released: number;
      readonly reversedEarned: number;
      readonly returnedRedeemed: number;
      readonly expired: number;
      readonly endingAvailable: number;
      readonly pointsDebt: number;
      readonly tierCode: string | null;
      readonly rewardCodes: readonly string[];
      readonly pointsConserved: true;
      readonly monetaryBenefitCalculated: false;
      readonly paymentTenderUsed: false;
    };
  };
}
export interface LoyaltyProgramClient {
  load(screenId: LoyaltyProgramView["screenId"], programReference?: string): Promise<unknown>;
}
const fail = (): never => {
  throw new LoyaltyProgramClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (v: unknown) => (typeof v === "string" && uuid.test(v) ? v : fail());
const instant = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  new Date(Date.parse(v)).toISOString() === v
    ? v
    : fail();
const text = (v: unknown) =>
  typeof v === "string" && v.trim() === v && /^[^\p{Cc}\p{Cf}<>{}$]{1,500}$/u.test(v) ? v : fail();
const integer = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail();
const lifecycle = (v: unknown) =>
  typeof v === "string" && ["Draft", "Validated", "Scheduled", "Published", "Suspended"].includes(v)
    ? (v as LoyaltyProgramView["rows"][number]["lifecycle"])
    : fail();
const texts = (v: unknown, max = 100) =>
  !Array.isArray(v) || v.length > max ? fail() : Object.freeze(v.map(text));
export function parseLoyaltyProgramView(value: unknown): LoyaltyProgramView {
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
    "detail",
  ]);
  if (
    raw.projectionName !== "loyalty_program_v1" ||
    raw.projectionVersion !== 1 ||
    !["LOY-PROGRAM-LIST", "LOY-PROGRAM-EDITOR"].includes(raw.screenId as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200
  )
    fail();
  const p = object(raw.permissions, ["mayViewRules", "mayEdit", "mayApprove"]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const permissions = p as unknown as LoyaltyProgramView["permissions"];
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((entry) => {
      const row = object(entry, [
        "programReference",
        "programCode",
        "name",
        "lifecycle",
        "currentVersion",
        "memberCount",
        "earnSummary",
        "redeemSummary",
        "scopeSummary",
        "effectiveFromUtc",
        "effectiveToUtc",
      ]);
      if (!permissions.mayViewRules && (row.earnSummary !== null || row.redeemSummary !== null))
        fail();
      return Object.freeze({
        programReference: ref(row.programReference),
        programCode: text(row.programCode),
        name: text(row.name),
        lifecycle: lifecycle(row.lifecycle),
        currentVersion: integer(row.currentVersion),
        memberCount: row.memberCount === null ? null : integer(row.memberCount),
        earnSummary: row.earnSummary === null ? null : text(row.earnSummary),
        redeemSummary: row.redeemSummary === null ? null : text(row.redeemSummary),
        scopeSummary: text(row.scopeSummary),
        effectiveFromUtc: instant(row.effectiveFromUtc),
        effectiveToUtc: row.effectiveToUtc === null ? null : instant(row.effectiveToUtc),
      });
    }),
  );
  let detail: LoyaltyProgramView["detail"] = null;
  if (raw.detail !== null) {
    const d = object(raw.detail, [
      "programReference",
      "aggregateVersion",
      "programCode",
      "versionNumber",
      "lifecycle",
      "eligibility",
      "earnActivation",
      "redemption",
      "expiry",
      "tiers",
      "rewards",
      "refundReversal",
      "effectivePeriod",
      "customerCopy",
      "validationIssues",
      "simulation",
    ]);
    if (
      !permissions.mayViewRules &&
      (d.tiers !== null || d.rewards !== null || d.customerCopy !== null || d.simulation !== null)
    )
      fail();
    let simulation: NonNullable<LoyaltyProgramView["detail"]>["simulation"] = null;
    if (d.simulation !== null) {
      const s = object(d.simulation, [
        "earnedPending",
        "activatedAvailable",
        "reserved",
        "redeemed",
        "released",
        "reversedEarned",
        "returnedRedeemed",
        "expired",
        "endingAvailable",
        "pointsDebt",
        "tierCode",
        "rewardCodes",
        "pointsConserved",
        "monetaryBenefitCalculated",
        "paymentTenderUsed",
      ]);
      if (
        s.pointsConserved !== true ||
        s.monetaryBenefitCalculated !== false ||
        s.paymentTenderUsed !== false
      )
        fail();
      simulation = Object.freeze({
        earnedPending: integer(s.earnedPending),
        activatedAvailable: integer(s.activatedAvailable),
        reserved: integer(s.reserved),
        redeemed: integer(s.redeemed),
        released: integer(s.released),
        reversedEarned: integer(s.reversedEarned),
        returnedRedeemed: integer(s.returnedRedeemed),
        expired: integer(s.expired),
        endingAvailable: integer(s.endingAvailable),
        pointsDebt: integer(s.pointsDebt),
        tierCode: s.tierCode === null ? null : text(s.tierCode),
        rewardCodes: texts(s.rewardCodes),
        pointsConserved: true,
        monetaryBenefitCalculated: false,
        paymentTenderUsed: false,
      });
    }
    detail = Object.freeze({
      programReference: ref(d.programReference),
      aggregateVersion: integer(d.aggregateVersion),
      programCode: text(d.programCode),
      versionNumber: integer(d.versionNumber),
      lifecycle: lifecycle(d.lifecycle),
      eligibility: text(d.eligibility),
      earnActivation: text(d.earnActivation),
      redemption: text(d.redemption),
      expiry: text(d.expiry),
      tiers: d.tiers === null ? null : texts(d.tiers, 20),
      rewards: d.rewards === null ? null : texts(d.rewards),
      refundReversal: text(d.refundReversal),
      effectivePeriod: text(d.effectivePeriod),
      customerCopy: d.customerCopy === null ? null : text(d.customerCopy),
      validationIssues: texts(d.validationIssues),
      simulation,
    });
  }
  return Object.freeze({
    projectionName: "loyalty_program_v1",
    projectionVersion: 1,
    screenId: raw.screenId as LoyaltyProgramView["screenId"],
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness:
      typeof raw.freshness === "string" &&
      ["Current", "Stale", "Rebuilding"].includes(raw.freshness)
        ? (raw.freshness as LoyaltyProgramView["freshness"])
        : fail(),
    partial: raw.partial as boolean,
    permissions,
    rows,
    detail,
  });
}
export const unavailableLoyaltyProgramClient: LoyaltyProgramClient = {
  load: async () => {
    throw new LoyaltyProgramClientError("FeatureDisabled");
  },
};
