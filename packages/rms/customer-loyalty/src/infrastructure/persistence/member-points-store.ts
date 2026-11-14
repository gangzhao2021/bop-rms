import {
  applyPointsOperation,
  transitionLoyaltyAccount,
  type LoyaltyAccount,
  type PointsTransactionType,
} from "../../domain/loyalty-account.js";
import { CustomerProfileError } from "../../domain/customer-profile.js";
import {
  memberCodeLifetimeMs,
  memberCodeMaxAttempts,
  memberPointsDefaultRule,
  memberSessionLifetimeMs,
  parseMemberPointsRuleChange,
  pointsForPaidDishes,
  type MemberPointsRule,
} from "../../domain/member-points.js";
import type { MemberPhoneProtector } from "./member-phone-protector.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: one Brand's members and points, in the caller's transaction.
 * The account row is locked for every change, so two redemptions of one balance run one after the
 * other and the second sees what is left. The ledger is append-only and holds no phone number.
 */
export interface MemberPointsTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}
export type MemberPointsErrorCode =
  | "MEMBER_NOT_FOUND"
  | "MEMBER_NOT_ENOUGH_POINTS"
  | "MEMBER_ALREADY_EARNED"
  | "MEMBER_RULE_CHANGED"
  | "MEMBER_INVALID";
export class MemberPointsError extends Error {
  constructor(readonly code: MemberPointsErrorCode) {
    super(code);
    this.name = "MemberPointsError";
  }
}
export const memberMarketingWordingVersion = 1;
const memberSystemActor = "01902423-0000-7000-8000-000000000018";
const minor = (value: unknown) => Number(value);
const instant = (value: unknown) => new Date(value as string | Date).toISOString();
const later = (first: string, second: string) => (first > second ? first : second);
const databaseCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

export interface MemberHistoryEntry {
  readonly type: PointsTransactionType;
  readonly points: number;
  readonly reasonCode: string;
  readonly occurredAt: string;
}
export interface MemberListRow {
  readonly accountReference: string;
  readonly phoneLast4: string | null;
  readonly status: "Active" | "Closed";
  readonly availablePoints: number;
  readonly pointsDebt: number;
  readonly lifetimeEarnedPoints: number;
  readonly joinedAt: string;
  readonly lastActivityAt: string;
  readonly marketingConsent: boolean;
}
export interface MemberPointsReport {
  readonly members: number;
  readonly issuedPoints: number;
  readonly usedPoints: number;
  readonly returnedPoints: number;
  readonly reversedPoints: number;
  readonly expiredPoints: number;
  readonly forfeitedPoints: number;
  readonly outstandingPoints: number;
  readonly owedPoints: number;
  readonly usedValueMinor: string;
}

export function createMemberPointsStore(options: {
  readonly brandReference: string;
  /** The Store this happens at, recorded on the ledger. */
  readonly storeReference: string;
  nextReference(): string;
  now(): string;
  readonly protector: MemberPhoneProtector;
}) {
  const brand = options.brandReference;
  const store = options.storeReference;
  const scoped = (tx: MemberPointsTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const ruleFrom = (row: Record<string, unknown>): MemberPointsRule =>
    Object.freeze({
      version: Number(row.version),
      earnPointsPerDollar: Number(row.earn_points_per_dollar),
      redeemPointsPerDollar: Number(row.redeem_points_per_dollar),
      minimumRedemptionPoints: Number(row.minimum_redemption_points),
      redemptionIncrementPoints: Number(row.redemption_increment_points),
      inactivityExpiryDays: Number(row.inactivity_expiry_days),
      expiryNoticeDays: Number(row.expiry_notice_days),
      rewards: Object.freeze(row.rewards as MemberPointsRule["rewards"]),
    });
  const currentRule = async (tx: MemberPointsTransaction): Promise<MemberPointsRule> => {
    await scoped(tx);
    const row = (
      await tx.query(
        "SELECT * FROM rms_loyalty.loyalty_rule_version WHERE brand_id=$1 ORDER BY loyalty_rule_version.version DESC LIMIT 1",
        [brand],
      )
    ).rows[0];
    return row === undefined ? memberPointsDefaultRule : ruleFrom(row);
  };
  const accountFrom = (row: Record<string, unknown>): LoyaltyAccount =>
    Object.freeze({
      accountReference: String(row.account_id),
      tenantReference: brand,
      brandReference: brand,
      customerProfileReference: String(row.account_id),
      programReference: brand,
      programVersionReference: brand,
      // The domain has no separate "left": a Closed account simply takes no more operations.
      status: row.status === "Closed" ? "Closed" : "Active",
      tierCode: null,
      pendingPoints: 0,
      availablePoints: minor(row.available_points),
      reservedPoints: 0,
      lifetimeEarnedPoints: minor(row.lifetime_earned_points),
      pointsDebt: minor(row.points_debt),
      expiringPoints: 0,
      reservations: Object.freeze([]),
      aggregateVersion: Number(row.aggregate_version),
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
    }) as unknown as LoyaltyAccount;
  /** The account, locked until commit. */
  const lockAccount = async (tx: MemberPointsTransaction, account: string) => {
    await scoped(tx);
    const row = (
      await tx.query(
        "SELECT * FROM rms_loyalty.loyalty_account WHERE brand_id=$1 AND account_id=$2 FOR UPDATE",
        [brand, account],
      )
    ).rows[0];
    if (row === undefined) throw new MemberPointsError("MEMBER_NOT_FOUND");
    return { account: accountFrom(row), lastActivityAt: instant(row.last_activity_at) };
  };

  /** One ledger entry and the balance it leaves, through the account's own state machine. */
  const post = async (
    tx: MemberPointsTransaction,
    held: { account: LoyaltyAccount },
    entry: {
      readonly type: PointsTransactionType;
      readonly points: number;
      readonly sourceType:
        "Order" | "Payment" | "Refund" | "Reservation" | "ExpiryJob" | "AuthorizedCorrection";
      readonly sourceReference: string;
      readonly orderReference: string | null;
      readonly originalReference: string | null;
      readonly reservation?: { reservationReference: string; requestReference: string };
      readonly ruleVersion: number;
      readonly reasonCode: string;
      readonly idempotencyReference: string;
      readonly activity: boolean;
    },
  ) => {
    const transactionReference = options.nextReference();
    // The account's clock only moves forward, whatever order two servers read theirs in.
    const occurredAt = later(options.now(), held.account.updatedAt);
    const applied = applyPointsOperation(held.account, {
      expectedVersion: held.account.aggregateVersion,
      transactionReference,
      type: entry.type,
      points: entry.points,
      sourceType: entry.sourceType,
      sourceReference: entry.sourceReference,
      ruleVersionReference: brand,
      occurredAt,
      effectiveAt: occurredAt,
      expiryAt:
        entry.type === "Reserve" ? new Date(Date.parse(occurredAt) + 60_000).toISOString() : null,
      idempotencyReference: entry.idempotencyReference,
      originalTransactionReference: entry.originalReference,
      reservationReference: entry.reservation?.reservationReference ?? null,
      redemptionRequestReference: entry.reservation?.requestReference ?? null,
      targetReference: entry.reservation === undefined ? null : entry.sourceReference,
      actorReference: memberSystemActor,
      reasonCode: entry.reasonCode,
    });
    await tx.query(
      "INSERT INTO rms_loyalty.loyalty_points_transaction (transaction_id,brand_id,account_id,type,points,source_type," +
        "source_reference,source_store_id,order_id,original_transaction_id,rule_version,reason_code,idempotency_reference,occurred_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        transactionReference,
        brand,
        held.account.accountReference,
        entry.type,
        entry.points,
        entry.sourceType,
        entry.sourceReference,
        store,
        entry.orderReference,
        entry.originalReference,
        entry.ruleVersion,
        entry.reasonCode,
        entry.idempotencyReference,
        occurredAt,
      ],
    );
    const after = applied.account;
    const updated = await tx.query(
      "UPDATE rms_loyalty.loyalty_account SET available_points=$3,points_debt=$4,lifetime_earned_points=$5," +
        "aggregate_version=$6,updated_at=$7,last_activity_at=CASE WHEN $8 THEN $7::timestamptz ELSE last_activity_at END " +
        "WHERE brand_id=$1 AND account_id=$2 AND aggregate_version=$9",
      [
        brand,
        held.account.accountReference,
        // A reservation is taken and spent in one transaction, so it never shows on the row.
        after.availablePoints,
        after.pointsDebt,
        after.lifetimeEarnedPoints,
        after.aggregateVersion,
        occurredAt,
        entry.activity,
        held.account.aggregateVersion,
      ],
    );
    if (updated.rowCount !== 1) throw new MemberPointsError("MEMBER_RULE_CHANGED");
    held.account = after;
    return transactionReference;
  };

  return Object.freeze({
    currentRule,
    /** The next version of the Brand's rule; a change based on an older version is refused. */
    async recordRule(
      tx: MemberPointsTransaction,
      input: {
        readonly expectedVersion: number;
        readonly operationReference: string;
        readonly actorReference: string;
        readonly change: unknown;
      },
    ): Promise<MemberPointsRule> {
      const change = parseMemberPointsRuleChange(input.change);
      await scoped(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "LoyaltyRule:" + brand,
      ]);
      const prior = (
        await tx.query(
          "SELECT * FROM rms_loyalty.loyalty_rule_version WHERE brand_id=$1 AND operation_id=$2",
          [brand, input.operationReference],
        )
      ).rows[0];
      if (prior !== undefined) return ruleFrom(prior);
      const current = await currentRule(tx);
      if (current.version !== input.expectedVersion)
        throw new MemberPointsError("MEMBER_RULE_CHANGED");
      const row = (
        await tx.query(
          "INSERT INTO rms_loyalty.loyalty_rule_version (brand_id,version,earn_points_per_dollar,redeem_points_per_dollar," +
            "minimum_redemption_points,redemption_increment_points,inactivity_expiry_days,expiry_notice_days,rewards,operation_id,actor_id,recorded_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) RETURNING *",
          [
            brand,
            current.version + 1,
            change.earnPointsPerDollar,
            change.redeemPointsPerDollar,
            change.minimumRedemptionPoints,
            change.redemptionIncrementPoints,
            change.inactivityExpiryDays,
            change.expiryNoticeDays,
            JSON.stringify(change.rewards),
            input.operationReference,
            input.actorReference,
            options.now(),
          ],
        )
      ).rows[0] as Record<string, unknown>;
      return ruleFrom(row);
    },

    /** A new code for this phone, replacing any earlier one; the code itself isn't kept. */
    async createChallenge(tx: MemberPointsTransaction, phone: string) {
      await scoped(tx);
      const hash = options.protector.lookupHash(brand, phone);
      await tx.query(
        "DELETE FROM rms_loyalty.loyalty_phone_challenge WHERE brand_id=$1 AND (phone_lookup_hash=$2 OR expires_at<$3)",
        [brand, hash, options.now()],
      );
      const reference = options.nextReference();
      const code = options.protector.newCode();
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_phone_challenge (challenge_id,brand_id,phone_lookup_hash,code_hash,attempts,expires_at,created_at) " +
          "VALUES ($1,$2,$3,$4,0,$5,$6)",
        [
          reference,
          brand,
          hash,
          options.protector.codeHash(reference, code),
          new Date(Date.parse(options.now()) + memberCodeLifetimeMs).toISOString(),
          options.now(),
        ],
      );
      return Object.freeze({ code });
    },

    /** Whether this code is right. A wrong one counts; the last wrong one ends the code. */
    async checkChallenge(
      tx: MemberPointsTransaction,
      phone: string,
      code: string,
    ): Promise<"Right" | "Wrong" | "NoCode"> {
      await scoped(tx);
      const hash = options.protector.lookupHash(brand, phone);
      const row = (
        await tx.query(
          "SELECT challenge_id,code_hash,attempts,expires_at FROM rms_loyalty.loyalty_phone_challenge " +
            "WHERE brand_id=$1 AND phone_lookup_hash=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [brand, hash],
        )
      ).rows[0];
      if (row === undefined || instant(row.expires_at) <= options.now()) return "NoCode";
      const reference = String(row.challenge_id);
      const expected = row.code_hash as Uint8Array;
      const given = options.protector.codeHash(reference, code);
      const right = expected.length === given.length && given.every((b, i) => b === expected[i]);
      if (right || Number(row.attempts) + 1 >= memberCodeMaxAttempts) {
        await tx.query(
          "DELETE FROM rms_loyalty.loyalty_phone_challenge WHERE brand_id=$1 AND challenge_id=$2",
          [brand, reference],
        );
        return right ? "Right" : "NoCode";
      }
      await tx.query(
        "UPDATE rms_loyalty.loyalty_phone_challenge SET attempts=attempts+1 WHERE brand_id=$1 AND challenge_id=$2",
        [brand, reference],
      );
      return "Wrong";
    },

    /** The member with this phone, or null. A person who left has no row here any more. */
    async findByPhone(tx: MemberPointsTransaction, phone: string): Promise<string | null> {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT account_id::text AS account FROM rms_loyalty.loyalty_member_contact WHERE brand_id=$1 AND phone_lookup_hash=$2",
          [brand, options.protector.lookupHash(brand, phone)],
        )
      ).rows[0];
      return row === undefined ? null : String(row.account);
    },

    async join(
      tx: MemberPointsTransaction,
      input: { readonly phone: string; readonly marketingConsent: boolean },
    ): Promise<string> {
      await scoped(tx);
      const account = options.nextReference();
      const now = options.now();
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_account (account_id,brand_id,status,available_points,points_debt,lifetime_earned_points," +
          "aggregate_version,created_at,updated_at,last_activity_at) VALUES ($1,$2,'Active',0,0,0,1,$3,$3,$3)",
        [account, brand, now],
      );
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_member_contact (account_id,brand_id,phone_lookup_hash,phone_ciphertext,phone_last4,joined_at,data_classification) " +
          "VALUES ($1,$2,$3,$4,$5,$6,'PersonalData')",
        [
          account,
          brand,
          options.protector.lookupHash(brand, input.phone),
          options.protector.seal(input.phone),
          input.phone.slice(-4),
          now,
        ],
      );
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_marketing_consent (consent_id,brand_id,account_id,given,wording_version,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          options.nextReference(),
          brand,
          account,
          input.marketingConsent,
          memberMarketingWordingVersion,
          now,
        ],
      );
      return account;
    },

    async setMarketingConsent(tx: MemberPointsTransaction, account: string, given: boolean) {
      await lockAccount(tx, account);
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_marketing_consent (consent_id,brand_id,account_id,given,wording_version,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          options.nextReference(),
          brand,
          account,
          given,
          memberMarketingWordingVersion,
          options.now(),
        ],
      );
    },

    /** A new session; only the token's keyed hash is kept. */
    async openSession(tx: MemberPointsTransaction, account: string) {
      await scoped(tx);
      const token = options.protector.newSessionToken();
      const expiresAt = new Date(Date.parse(options.now()) + memberSessionLifetimeMs).toISOString();
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_member_session (session_id,brand_id,account_id,selector_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          options.nextReference(),
          brand,
          account,
          options.protector.sessionHash(token),
          expiresAt,
          options.now(),
        ],
      );
      return Object.freeze({ token, expiresAt });
    },

    /** The session's Active member, or null. */
    async memberOfSession(tx: MemberPointsTransaction, token: string): Promise<string | null> {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT s.account_id::text AS account FROM rms_loyalty.loyalty_member_session s " +
            "JOIN rms_loyalty.loyalty_account a ON a.brand_id=s.brand_id AND a.account_id=s.account_id " +
            "WHERE s.brand_id=$1 AND s.selector_hash=$2 AND s.expires_at>$3 AND a.status='Active'",
          [brand, options.protector.sessionHash(token), options.now()],
        )
      ).rows[0];
      return row === undefined ? null : String(row.account);
    },

    async endSession(tx: MemberPointsTransaction, token: string) {
      await scoped(tx);
      await tx.query(
        "DELETE FROM rms_loyalty.loyalty_member_session WHERE brand_id=$1 AND selector_hash=$2",
        [brand, options.protector.sessionHash(token)],
      );
    },

    /** Whether this payment already earned, whoever claimed it. */
    async earnedSources(tx: MemberPointsTransaction, sources: readonly string[]) {
      await scoped(tx);
      if (sources.length === 0) return new Set<string>();
      const rows = (
        await tx.query(
          "SELECT source_reference::text AS source FROM rms_loyalty.loyalty_points_transaction " +
            "WHERE brand_id=$1 AND type='Earn' AND source_reference=ANY($2::uuid[])",
          [brand, sources],
        )
      ).rows;
      return new Set(rows.map((row) => String(row.source)));
    },

    /**
     * Points for what these dishes cost. A payment earns once: a second claim, by anyone, is
     * refused. Points pay off any debt first, by the account's own rule.
     */
    async earn(
      tx: MemberPointsTransaction,
      input: {
        readonly accountReference: string;
        readonly sourceReference: string;
        readonly orderReference: string;
        readonly paidDishesMinor: bigint;
        readonly rule: MemberPointsRule;
      },
    ): Promise<{ readonly points: number }> {
      const held = await lockAccount(tx, input.accountReference);
      const points = pointsForPaidDishes(input.paidDishesMinor, input.rule);
      if (points === 0) return Object.freeze({ points: 0 });
      await tx.query("SAVEPOINT loyalty_earn", []);
      let earn: string;
      const idempotency = options.nextReference();
      try {
        earn = await post(tx, held, {
          type: "Earn",
          points,
          sourceType: "Payment",
          sourceReference: input.sourceReference,
          orderReference: input.orderReference,
          originalReference: null,
          ruleVersion: input.rule.version,
          reasonCode: "PAID_DISHES",
          idempotencyReference: idempotency,
          activity: true,
        });
      } catch (error) {
        if (databaseCode(error) !== "23505") throw error;
        await tx.query("ROLLBACK TO SAVEPOINT loyalty_earn", []);
        throw new MemberPointsError("MEMBER_ALREADY_EARNED");
      }
      await post(tx, held, {
        type: "Activate",
        points,
        sourceType: "Payment",
        sourceReference: input.sourceReference,
        orderReference: input.orderReference,
        originalReference: earn,
        ruleVersion: input.rule.version,
        reasonCode: "PAID_DISHES",
        idempotencyReference: idempotency,
        activity: true,
      });
      return Object.freeze({ points });
    },

    /**
     * Spend points on a bill, in the same transaction as the bill's reduction. The balance is
     * checked under the account's lock, so a second redemption of one balance is refused.
     */
    async redeem(
      tx: MemberPointsTransaction,
      input: {
        readonly accountReference: string;
        readonly operationReference: string;
        readonly orderReference: string;
        readonly points: number;
        readonly netMinor: bigint;
        readonly totalMinor: bigint;
        readonly rewardProductReference: string | null;
        readonly rule: MemberPointsRule;
      },
    ) {
      const held = await lockAccount(tx, input.accountReference);
      if (held.account.availablePoints < input.points)
        throw new MemberPointsError("MEMBER_NOT_ENOUGH_POINTS");
      const redemption = options.nextReference();
      const reservation = options.nextReference();
      const common = {
        points: input.points,
        sourceType: "Reservation" as const,
        sourceReference: redemption,
        orderReference: input.orderReference,
        originalReference: null,
        reservation: { reservationReference: reservation, requestReference: redemption },
        ruleVersion: input.rule.version,
        reasonCode: "BILL_REDEMPTION",
        idempotencyReference: input.operationReference,
        activity: true,
      };
      await post(tx, held, { ...common, type: "Reserve" });
      await post(tx, held, { ...common, type: "Redeem" });
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_redemption (redemption_id,brand_id,source_store_id,account_id,order_id,operation_id,points,net_minor,total_minor,reward_product_id,recorded_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          redemption,
          brand,
          store,
          input.accountReference,
          input.orderReference,
          input.operationReference,
          input.points,
          input.netMinor.toString(),
          input.totalMinor.toString(),
          input.rewardProductReference,
          options.now(),
        ],
      );
      return Object.freeze({ redemptionReference: redemption, points: input.points });
    },

    async redemptionByOperation(tx: MemberPointsTransaction, operation: string) {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT account_id::text AS account,points,order_id::text AS order_reference FROM rms_loyalty.loyalty_redemption WHERE brand_id=$1 AND operation_id=$2",
          [brand, operation],
        )
      ).rows[0];
      return row === undefined
        ? null
        : Object.freeze({
            accountReference: String(row.account),
            points: minor(row.points),
            orderReference: String(row.order_reference),
          });
    },

    /** What this Store's Orders earned and spent, for the refund sweep. */
    async orderActivity(tx: MemberPointsTransaction, orderReference: string) {
      await scoped(tx);
      const earned = (
        await tx.query(
          "SELECT t.transaction_id::text AS transaction,t.account_id::text AS account,t.points,t.source_reference::text AS source," +
            "COALESCE((SELECT sum(r.points) FROM rms_loyalty.loyalty_points_transaction r WHERE r.brand_id=t.brand_id AND r.type='Reverse' AND r.original_transaction_id=t.transaction_id),0) AS reversed," +
            "a.status FROM rms_loyalty.loyalty_points_transaction t " +
            "JOIN rms_loyalty.loyalty_account a ON a.brand_id=t.brand_id AND a.account_id=t.account_id " +
            "WHERE t.brand_id=$1 AND t.order_id=$2 AND t.type='Earn' ORDER BY t.transaction_id",
          [brand, orderReference],
        )
      ).rows;
      const spent = (
        await tx.query(
          "SELECT r.redemption_id::text AS redemption,r.account_id::text AS account,r.points," +
            "COALESCE((SELECT sum(t.points) FROM rms_loyalty.loyalty_points_transaction t WHERE t.brand_id=r.brand_id AND t.type='Return' AND t.original_transaction_id=r.redemption_id),0) AS returned," +
            "a.status FROM rms_loyalty.loyalty_redemption r " +
            "JOIN rms_loyalty.loyalty_account a ON a.brand_id=r.brand_id AND a.account_id=r.account_id " +
            "WHERE r.brand_id=$1 AND r.order_id=$2 ORDER BY r.redemption_id",
          [brand, orderReference],
        )
      ).rows;
      return Object.freeze({
        earned: earned.map((row) =>
          Object.freeze({
            transactionReference: String(row.transaction),
            accountReference: String(row.account),
            sourceReference: String(row.source),
            points: minor(row.points),
            reversedPoints: minor(row.reversed),
            open: row.status === "Active",
          }),
        ),
        spent: spent.map((row) =>
          Object.freeze({
            redemptionReference: String(row.redemption),
            accountReference: String(row.account),
            points: minor(row.points),
            returnedPoints: minor(row.returned),
            open: row.status === "Active",
          }),
        ),
      });
    },

    /** Take earned points back after a refund; what was already spent becomes a debt. */
    async reverseEarned(
      tx: MemberPointsTransaction,
      input: {
        readonly accountReference: string;
        readonly earnReference: string;
        readonly orderReference: string;
        readonly points: number;
        /**
         * What the caller saw already taken back. Given, the reversal posts only what is still
         * missing once the account is held, so two runs reading at once never take points twice.
         */
        readonly seenReversedPoints?: number;
      },
    ): Promise<number> {
      const held = await lockAccount(tx, input.accountReference);
      const points =
        input.seenReversedPoints === undefined
          ? input.points
          : input.points -
            (minor(
              (
                await tx.query(
                  "SELECT COALESCE(sum(points),0) AS n FROM rms_loyalty.loyalty_points_transaction WHERE brand_id=$1 AND type='Reverse' AND original_transaction_id=$2",
                  [brand, input.earnReference],
                )
              ).rows[0]?.n ?? 0,
            ) -
              input.seenReversedPoints);
      if (points <= 0) return 0;
      const rule = await currentRule(tx);
      await post(tx, held, {
        type: "Reverse",
        points,
        sourceType: "Refund",
        sourceReference: input.earnReference,
        orderReference: input.orderReference,
        originalReference: input.earnReference,
        ruleVersion: rule.version,
        reasonCode: "ORDER_REFUNDED",
        idempotencyReference: options.nextReference(),
        activity: false,
      });
      return points;
    },

    /** Give back points spent on a bill that was refunded or never paid. */
    async returnRedeemed(
      tx: MemberPointsTransaction,
      input: {
        readonly accountReference: string;
        readonly redemptionReference: string;
        readonly orderReference: string;
        readonly points: number;
        readonly reasonCode: "ORDER_REFUNDED" | "BILL_WRITTEN_OFF";
        /** As for `reverseEarned`: what the caller saw already given back. */
        readonly seenReturnedPoints?: number;
      },
    ): Promise<number> {
      const held = await lockAccount(tx, input.accountReference);
      const points =
        input.seenReturnedPoints === undefined
          ? input.points
          : input.points -
            (minor(
              (
                await tx.query(
                  "SELECT COALESCE(sum(points),0) AS n FROM rms_loyalty.loyalty_points_transaction WHERE brand_id=$1 AND type='Return' AND original_transaction_id=$2",
                  [brand, input.redemptionReference],
                )
              ).rows[0]?.n ?? 0,
            ) -
              input.seenReturnedPoints);
      if (points <= 0) return 0;
      const rule = await currentRule(tx);
      await post(tx, held, {
        type: "Return",
        points,
        sourceType: "Refund",
        sourceReference: input.redemptionReference,
        orderReference: input.orderReference,
        originalReference: input.redemptionReference,
        ruleVersion: rule.version,
        reasonCode: input.reasonCode,
        idempotencyReference: options.nextReference(),
        activity: false,
      });
      return points;
    },

    /** Orders of this Store with redemptions or earnings since this time, for the sweep. */
    async ordersWithPoints(tx: MemberPointsTransaction, since: string, limit: number) {
      await scoped(tx);
      const rows = (
        await tx.query(
          "SELECT DISTINCT t.order_id::text AS order_reference FROM rms_loyalty.loyalty_points_transaction t " +
            "WHERE t.brand_id=$1 AND t.source_store_id=$2 AND t.order_id IS NOT NULL AND t.occurred_at>=$3 LIMIT $4",
          [brand, store, since, limit],
        )
      ).rows;
      return rows.map((row) => String(row.order_reference));
    },

    /** Members whose points could be near expiry, oldest activity first. */
    async expiryCandidates(tx: MemberPointsTransaction, rule: MemberPointsRule, limit: number) {
      await scoped(tx);
      const cutoff = new Date(
        Date.parse(options.now()) -
          (rule.inactivityExpiryDays - rule.expiryNoticeDays) * 86_400_000,
      ).toISOString();
      const rows = (
        await tx.query(
          "SELECT a.account_id::text AS account,a.available_points,a.last_activity_at," +
            "(SELECT n.sent_at FROM rms_loyalty.loyalty_expiry_notice n WHERE n.brand_id=a.brand_id AND n.account_id=a.account_id AND n.activity_at=a.last_activity_at) AS notice " +
            "FROM rms_loyalty.loyalty_account a WHERE a.brand_id=$1 AND a.status='Active' AND a.available_points>0 " +
            "AND a.last_activity_at<=$2 ORDER BY a.last_activity_at LIMIT $3",
          [brand, cutoff, limit],
        )
      ).rows;
      return rows.map((row) =>
        Object.freeze({
          accountReference: String(row.account),
          availablePoints: minor(row.available_points),
          lastActivityAt: instant(row.last_activity_at),
          noticeSentAt: row.notice === null ? null : instant(row.notice),
        }),
      );
    },

    /** The number to text about this member's points. Never returned to any screen. */
    async phoneForMessage(tx: MemberPointsTransaction, account: string): Promise<string | null> {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT phone_ciphertext FROM rms_loyalty.loyalty_member_contact WHERE brand_id=$1 AND account_id=$2",
          [brand, account],
        )
      ).rows[0];
      return row === undefined ? null : options.protector.open(row.phone_ciphertext as Uint8Array);
    },

    /**
     * The number to tell, holding the account until commit, or null when this stretch of inactivity
     * was already told, or has ended. Each of the Brand's Stores runs this sweep: one text, not many.
     */
    async claimExpiryNotice(
      tx: MemberPointsTransaction,
      input: { readonly accountReference: string; readonly lastActivityAt: string },
    ): Promise<string | null> {
      const held = await lockAccount(tx, input.accountReference);
      if (held.account.status !== "Active" || held.lastActivityAt !== input.lastActivityAt)
        return null;
      const told = (
        await tx.query(
          "SELECT 1 FROM rms_loyalty.loyalty_expiry_notice WHERE brand_id=$1 AND account_id=$2 AND activity_at=$3",
          [brand, input.accountReference, input.lastActivityAt],
        )
      ).rows[0];
      if (told !== undefined) return null;
      const row = (
        await tx.query(
          "SELECT phone_ciphertext FROM rms_loyalty.loyalty_member_contact WHERE brand_id=$1 AND account_id=$2",
          [brand, input.accountReference],
        )
      ).rows[0];
      return row === undefined ? null : options.protector.open(row.phone_ciphertext as Uint8Array);
    },

    async recordExpiryNotice(
      tx: MemberPointsTransaction,
      input: {
        readonly accountReference: string;
        readonly lastActivityAt: string;
        readonly expiresAt: string;
      },
    ) {
      await scoped(tx);
      await tx.query(
        "INSERT INTO rms_loyalty.loyalty_expiry_notice (notice_id,brand_id,account_id,activity_at,expires_at,sent_at) VALUES ($1,$2,$3,$4,$5,$6) " +
          "ON CONFLICT (brand_id,account_id,activity_at) DO NOTHING",
        [
          options.nextReference(),
          brand,
          input.accountReference,
          input.lastActivityAt,
          input.expiresAt,
          options.now(),
        ],
      );
    },

    /** Inactive points expire, re-checked under the lock: activity since the sweep read wins. */
    async expire(
      tx: MemberPointsTransaction,
      input: { readonly accountReference: string; readonly lastActivityAt: string },
    ): Promise<{ readonly points: number }> {
      const held = await lockAccount(tx, input.accountReference);
      if (
        held.account.status !== "Active" ||
        held.lastActivityAt !== input.lastActivityAt ||
        held.account.availablePoints === 0
      )
        return Object.freeze({ points: 0 });
      const rule = await currentRule(tx);
      const points = held.account.availablePoints;
      const sourceReference = options.nextReference();
      await post(tx, held, {
        type: "Expire",
        points,
        sourceType: "ExpiryJob",
        sourceReference,
        orderReference: null,
        originalReference: sourceReference,
        ruleVersion: rule.version,
        reasonCode: "INACTIVE",
        idempotencyReference: sourceReference,
        activity: false,
      });
      return Object.freeze({ points });
    },

    /**
     * Leave and delete: the phone, its sessions and codes are gone; the balance is forfeited on the
     * ledger, which stays (no phone on it) so what was issued and used still adds up.
     */
    async leave(tx: MemberPointsTransaction, account: string) {
      const held = await lockAccount(tx, account);
      if (held.account.status === "Closed") return;
      const contact = (
        await tx.query(
          "SELECT phone_lookup_hash FROM rms_loyalty.loyalty_member_contact WHERE brand_id=$1 AND account_id=$2",
          [brand, account],
        )
      ).rows[0];
      if (held.account.availablePoints > 0) {
        const rule = await currentRule(tx);
        const sourceReference = options.nextReference();
        await post(tx, held, {
          type: "Expire",
          points: held.account.availablePoints,
          sourceType: "ExpiryJob",
          sourceReference,
          orderReference: null,
          originalReference: sourceReference,
          ruleVersion: rule.version,
          reasonCode: "LEFT_PROGRAM",
          idempotencyReference: sourceReference,
          activity: false,
        });
      }
      await tx.query(
        "DELETE FROM rms_loyalty.loyalty_member_session WHERE brand_id=$1 AND account_id=$2",
        [brand, account],
      );
      if (contact !== undefined)
        await tx.query(
          "DELETE FROM rms_loyalty.loyalty_phone_challenge WHERE brand_id=$1 AND phone_lookup_hash=$2",
          [brand, contact.phone_lookup_hash],
        );
      await tx.query(
        "DELETE FROM rms_loyalty.loyalty_member_contact WHERE brand_id=$1 AND account_id=$2",
        [brand, account],
      );
      const closed = transitionLoyaltyAccount(held.account, {
        expectedVersion: held.account.aggregateVersion,
        targetStatus: "Closed",
        actorReference: memberSystemActor,
        reasonCode: "LEFT_PROGRAM",
        occurredAt: later(options.now(), held.account.updatedAt),
      });
      await tx.query(
        "UPDATE rms_loyalty.loyalty_account SET status='Closed',aggregate_version=$3,updated_at=$4 WHERE brand_id=$1 AND account_id=$2",
        [brand, account, closed.aggregateVersion, closed.updatedAt],
      );
    },

    /** What a member sees of themselves. */
    async memberHome(tx: MemberPointsTransaction, account: string) {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT a.available_points,a.points_debt,a.last_activity_at,c.phone_last4," +
            "(SELECT given FROM rms_loyalty.loyalty_marketing_consent m WHERE m.brand_id=a.brand_id AND m.account_id=a.account_id ORDER BY m.consent_id DESC LIMIT 1) AS consent " +
            "FROM rms_loyalty.loyalty_account a JOIN rms_loyalty.loyalty_member_contact c ON c.brand_id=a.brand_id AND c.account_id=a.account_id " +
            "WHERE a.brand_id=$1 AND a.account_id=$2 AND a.status='Active'",
          [brand, account],
        )
      ).rows[0];
      if (row === undefined) throw new MemberPointsError("MEMBER_NOT_FOUND");
      const history = (
        await tx.query(
          "SELECT type,points,reason_code,occurred_at FROM rms_loyalty.loyalty_points_transaction " +
            "WHERE brand_id=$1 AND account_id=$2 AND type IN ('Earn','Redeem','Reverse','Return','Expire') " +
            "ORDER BY occurred_at DESC,transaction_id DESC LIMIT 100",
          [brand, account],
        )
      ).rows;
      return Object.freeze({
        availablePoints: minor(row.available_points),
        pointsDebt: minor(row.points_debt),
        lastActivityAt: instant(row.last_activity_at),
        phoneLast4: String(row.phone_last4),
        marketingConsent: row.consent === true,
        history: Object.freeze(
          history.map((entry): MemberHistoryEntry =>
            Object.freeze({
              type: entry.type as PointsTransactionType,
              points: minor(entry.points),
              reasonCode: String(entry.reason_code),
              occurredAt: instant(entry.occurred_at),
            }),
          ),
        ),
      });
    },

    /** The back office's list: never more of a phone number than its last four digits. */
    async listMembers(
      tx: MemberPointsTransaction,
      limit: number,
    ): Promise<readonly MemberListRow[]> {
      await scoped(tx);
      const rows = (
        await tx.query(
          "SELECT a.account_id::text AS account,c.phone_last4,a.status,a.available_points,a.points_debt,a.lifetime_earned_points,a.created_at,a.last_activity_at," +
            "COALESCE((SELECT given FROM rms_loyalty.loyalty_marketing_consent m WHERE m.brand_id=a.brand_id AND m.account_id=a.account_id ORDER BY m.consent_id DESC LIMIT 1),false) AS consent " +
            "FROM rms_loyalty.loyalty_account a LEFT JOIN rms_loyalty.loyalty_member_contact c ON c.brand_id=a.brand_id AND c.account_id=a.account_id " +
            "WHERE a.brand_id=$1 AND a.status='Active' ORDER BY a.last_activity_at DESC,a.account_id LIMIT $2",
          [brand, limit],
        )
      ).rows;
      return rows.map((row) =>
        Object.freeze({
          accountReference: String(row.account),
          phoneLast4: row.phone_last4 === null ? null : String(row.phone_last4),
          status: row.status === "Closed" ? ("Closed" as const) : ("Active" as const),
          availablePoints: minor(row.available_points),
          pointsDebt: minor(row.points_debt),
          lifetimeEarnedPoints: minor(row.lifetime_earned_points),
          joinedAt: instant(row.created_at),
          lastActivityAt: instant(row.last_activity_at),
          marketingConsent: row.consent === true,
        }),
      );
    },

    /**
     * Issued, used and outstanding, from the ledger alone, so it still adds up after members leave:
     * issued + returned = used + reversed-from-balance + expired + forfeited + outstanding.
     */
    async report(tx: MemberPointsTransaction): Promise<MemberPointsReport> {
      await scoped(tx);
      const row = (
        await tx.query(
          "SELECT COALESCE(sum(points) FILTER (WHERE type='Earn'),0) AS issued," +
            "COALESCE(sum(points) FILTER (WHERE type='Redeem'),0) AS used," +
            "COALESCE(sum(points) FILTER (WHERE type='Return'),0) AS returned," +
            "COALESCE(sum(points) FILTER (WHERE type='Reverse'),0) AS reversed," +
            "COALESCE(sum(points) FILTER (WHERE type='Expire' AND reason_code='INACTIVE'),0) AS expired," +
            "COALESCE(sum(points) FILTER (WHERE type='Expire' AND reason_code='LEFT_PROGRAM'),0) AS forfeited " +
            "FROM rms_loyalty.loyalty_points_transaction WHERE brand_id=$1",
          [brand],
        )
      ).rows[0] as Record<string, unknown>;
      const accounts = (
        await tx.query(
          "SELECT count(*) FILTER (WHERE status='Active') AS members,COALESCE(sum(available_points),0) AS outstanding,COALESCE(sum(points_debt),0) AS owed " +
            "FROM rms_loyalty.loyalty_account WHERE brand_id=$1",
          [brand],
        )
      ).rows[0] as Record<string, unknown>;
      const value = (
        await tx.query(
          "SELECT COALESCE(sum(total_minor),0)::text AS total FROM rms_loyalty.loyalty_redemption WHERE brand_id=$1",
          [brand],
        )
      ).rows[0] as Record<string, unknown>;
      return Object.freeze({
        members: minor(accounts.members),
        issuedPoints: minor(row.issued),
        usedPoints: minor(row.used),
        returnedPoints: minor(row.returned),
        reversedPoints: minor(row.reversed),
        expiredPoints: minor(row.expired),
        forfeitedPoints: minor(row.forfeited),
        outstandingPoints: minor(accounts.outstanding),
        owedPoints: minor(accounts.owed),
        usedValueMinor: String(value.total),
      });
    },
  });
}
export type MemberPointsStore = ReturnType<typeof createMemberPointsStore>;
export { CustomerProfileError as MemberPointsDomainError };
