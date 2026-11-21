import type { ConsumerTransaction } from "@bop/eventing";
import { GuestSessionService, createPostgresGuestSessionEntryStore } from "@bop/identity";
import {
  createMemberPointsStore,
  largestRedemptionPoints,
  memberCodeBudgets,
  memberPointsExpireAt,
  memberPointsPageWarningDays,
  MemberPointsError,
  parseMemberPhone,
  pointsForPaidDishes,
  redemptionValueMinor,
  type MemberPhoneProtector,
  type MemberPointsRule,
} from "@rms/customer-loyalty";
import { listDiningParticipantGuestSessions, listDiningSessionMergedInto } from "@rms/dining";
import { loadDiningGuestPhones } from "./dining-guest-phones.js";
import {
  createPostgresOrderPriceReductionStore,
  listOrderRoundDishes,
  loadOrderGuestSession,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  createPostgresStoreSalesPaymentLedger,
} from "@rms/payment";
import type { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import { billReductionTaxShares, readDiningTableBill } from "./merchant-dining-table-checkout.js";
import { storeOffersPoints } from "./merchant-store-features.js";
import {
  createMemberPointsOrderSettler,
  ledgerOrderPaidMinor,
  refundedPointsTargets,
} from "./member-points-refund-share.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: a guest's side of the Brand's points. Ordering never needs any
 * of this: nothing here runs unless the guest chooses to join, sign in or use points. A guest's
 * Session says which Store and table they are at; the member's own session says who they are. The
 * browser names only its own Order, checked against its Session, and never an amount.
 */
export type CustomerMemberErrorCode =
  | "MEMBER_NOT_OFFERED"
  | "MEMBER_PHONE_INVALID"
  | "MEMBER_CODE_UNAVAILABLE"
  | "MEMBER_RATE_LIMITED"
  | "MEMBER_CODE_WRONG"
  | "MEMBER_CODE_ENDED"
  | "MEMBER_SIGN_IN_REQUIRED"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_NOTHING_TO_CLAIM"
  | "MEMBER_ALREADY_EARNED"
  | "MEMBER_NOT_ENOUGH_POINTS"
  | "MEMBER_REDEEM_INVALID"
  | "MEMBER_REDEEM_NOT_THIS_TABLE"
  | "MEMBER_REDEEM_SPLIT"
  | "MEMBER_REDEEM_PAID"
  | "MEMBER_REDEEM_GUEST_PAYING"
  | "MEMBER_UNAVAILABLE";
export class CustomerMemberError extends Error {
  constructor(
    readonly code: CustomerMemberErrorCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "CustomerMemberError";
  }
}
const fail = (code: CustomerMemberErrorCode): never => {
  throw new CustomerMemberError(code);
};

/** Text messages to a member. Absent or failing, joining says so; nothing pretends it was sent. */
export interface MemberMessagePort {
  send(message: {
    readonly phone: string;
    readonly kind: "Code" | "ExpiryNotice";
    readonly text: string;
  }): Promise<void>;
}
export function memberCodeText(code: string): string {
  return `Your member code is ${code}. It works for 10 minutes. 您的会员验证码是 ${code}，10 分钟内有效。`;
}
export function memberExpiryText(points: number, date: string): string {
  return `Your ${String(points)} points expire on ${date} if you don't earn or use any by then. 您的 ${String(points)} 积分将于 ${date} 过期，在此之前积分或使用即可保留。`;
}
export interface MemberBudget {
  consume(
    bucket: "MEMBER_CODE_SEND" | "MEMBER_CODE_CHECK",
    key: Uint8Array,
    policy: { readonly windowSeconds: number; readonly limit: number },
  ): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }>;
}
export interface MemberCredentials {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  /** The member's own cookie, when this browser has one. */
  readonly memberToken: string | null;
}
type StatusReadOptions = Parameters<typeof createCustomerOrderStatusRead>[0];
interface ClaimSource {
  readonly sourceReference: string;
  readonly orderReference: string;
  readonly partNumber: number | null;
  readonly paidDishesMinor: bigint;
  /** This phone certainly paid it: a signed-in member's points are added without asking. */
  readonly certain: boolean;
}
/** A source with what its refunds already take back of what it earns (M60). */
interface OfferedSource extends ClaimSource {
  readonly points: number;
  readonly refundedPoints: number;
}

/**
 * v15 batch 8: which phone paid a table's payment — this one, another one (its own card on its
 * own phone), or unknown (cash or the card machine at the counter: any phone at the table may say
 * it was theirs). `thisPhone` is every Guest Session this phone has used at the table: a phone
 * that lost its cookie and came back as the same guest still owns what it paid before.
 */
export function paymentPhone(
  settlement: { readonly onlinePaymentReference: string | null },
  online: readonly {
    readonly onlinePaymentReference: string;
    readonly guestSessionReference: unknown;
  }[],
  thisPhone: readonly unknown[],
): "ThisPhone" | "OtherPhone" | "Unknown" {
  if (settlement.onlinePaymentReference === null) return "Unknown";
  const attempt = online.find(
    (entry) => entry.onlinePaymentReference === settlement.onlinePaymentReference,
  );
  if (attempt === undefined) return "Unknown";
  return thisPhone.some((session) => String(session) === String(attempt.guestSessionReference))
    ? "ThisPhone"
    : "OtherPhone";
}

/**
 * v15 batch 8 (Owner default: one phone, its own part): a table paid in parts, where this phone
 * certainly paid some part (on its own card, or it is the table's one phone), offers this phone
 * only the parts it certainly paid — never also a part paid at the counter that another guest may
 * have paid. Applied to every part, claimed or not, so a phone that already claimed its own part
 * is not then offered someone else's. A phone that certainly paid nothing is still asked which
 * part was theirs, among the parts paid at the counter.
 */
export function partsThisPhoneMayClaim<T extends { readonly certain: boolean }>(
  sources: readonly T[],
): readonly T[] {
  return sources.some((source) => source.certain)
    ? sources.filter((source) => source.certain)
    : sources;
}

export function createCustomerMember(options: {
  readonly access: StatusReadOptions;
  readonly tenantReference: string;
  /** The Provider account this Store settles: what says a paid round was paid. */
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly protector: MemberPhoneProtector;
  readonly messages: MemberMessagePort | null;
  readonly budget: MemberBudget;
  nextReference(): string;
}) {
  const scope = { ...options.access.scope, tenantReference: options.tenantReference };
  const now = () => String(options.access.now());
  const points = createMemberPointsStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    nextReference: options.nextReference,
    now,
    protector: options.protector,
  });
  const run = <T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> =>
    options.access.transactions.run(work as never) as Promise<T>;
  const settlementStore = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async () => true,
  });
  const settleOrder = createMemberPointsOrderSettler({ points, settlements: settlementStore });
  /** The Store's payments and refunds of the last two days: a guest's visit lives at most one. */
  const recentLedger = (tx: ConsumerTransaction) => {
    const endsAt = new Date(Date.parse(now()) + 1000).toISOString();
    return createPostgresStoreSalesPaymentLedger({
      scope: {
        ...scope,
        providerAccountReference: options.providerAccountReference,
        environment: options.environment,
      },
      authorize: async () => true,
    })(tx, {
      startsAt: new Date(Date.parse(now()) - 2 * 86_400_000).toISOString(),
      endsAt,
      observedAt: endsAt,
    });
  };
  type RecentLedger = Awaited<ReturnType<typeof recentLedger>>;

  /** This browser's guest visit, current or just ended (a receipt outlives the table). */
  const visit = async (tx: ConsumerTransaction, credentials: MemberCredentials) => {
    const runner: CartQueryTransactionRunner = { run: async (work) => work(tx) };
    const service = (validated: boolean) =>
      new GuestSessionService({
        store: createPostgresGuestSessionEntryStore(runner, scope),
        credentials: options.access.credentials,
        binding: validated
          ? options.access.binding(tx)
          : { validate: async () => "Current" as const },
        now: options.access.now,
        admission: { consume: async () => null },
      });
    const input = {
      sessionCredential: credentials.sessionCredential,
      csrfCredential: credentials.csrfCredential,
      observedAt: options.access.now(),
    };
    return await service(true)
      .authorize(input)
      .catch(() => service(false).authorizeEndedVisit(input));
  };
  const offered = (tx: ConsumerTransaction) => storeOffersPoints(tx as never, scope);
  const member = async (tx: ConsumerTransaction, credentials: MemberCredentials) =>
    credentials.memberToken === null
      ? null
      : points.memberOfSession(tx as never, credentials.memberToken);

  /** The table this guest's visit bills to, following a merge once it has closed. */
  const billSessionOf = async (
    tx: ConsumerTransaction,
    guest: { readonly diningSessionReference?: unknown },
  ): Promise<string | null> => {
    const own = guest.diningSessionReference;
    if (typeof own !== "string") return null;
    const merged = (await listDiningSessionMergedInto(tx as never, scope, [own])).get(own);
    return merged !== undefined ? merged.diningSessionReference : own;
  };
  const billOf = (tx: ConsumerTransaction, diningSessionReference: string) =>
    readDiningTableBill(tx, scope, {
      diningSessionReference,
      observedAt: now(),
      authorize: async () => true,
    });
  /**
   * What this table has paid that could earn: the whole bill once, or each paid part on its own.
   * Only the dishes' money counts: the rounds' subtotals, already less comps, discounts and points;
   * never tax, tip, service charge or cash rounding.
   */
  const claimSources = async (
    tx: ConsumerTransaction,
    diningSessionReference: string,
    guest: { readonly sessionReference?: unknown; readonly diningParticipantReference?: unknown },
  ): Promise<readonly ClaimSource[]> => {
    const bill = await billOf(tx, diningSessionReference);
    const order = bill.orderReference;
    if (order === null) return [];
    const online = await settlementStore.listOnlinePaymentsByOrders(tx as never, [order]);
    // The sessions this guest's phone used here: a lost cookie gives the same guest a new one.
    const thisPhone: readonly unknown[] =
      online.length === 0 || typeof guest.diningParticipantReference !== "string"
        ? [guest.sessionReference]
        : [
            guest.sessionReference,
            ...(await listDiningParticipantGuestSessions(
              tx as never,
              scope,
              guest.diningParticipantReference,
            )),
          ];
    const payer = (settlement: { readonly onlinePaymentReference: string | null }) =>
      paymentPhone(settlement, online, thisPhone);
    const paidOnThisPhone = (settlement: { readonly onlinePaymentReference: string | null }) =>
      payer(settlement) === "ThisPhone";
    // Paid at the counter or on the card machine: certain only when this is the table's one phone.
    const phones = await loadDiningGuestPhones(tx as never, scope, diningSessionReference);
    const onlyPhone =
      phones.length === 1 &&
      String(phones[0]?.participantReference) === String(guest.diningParticipantReference);
    // v15 batch 8: a payment another phone made on its own card earns for that phone only: this
    // phone is never asked "which part did you pay?" about it, nor can it claim it.
    if (bill.settlementRecord !== null && bill.settlementRecord.part === null)
      return payer(bill.settlementRecord) === "OtherPhone"
        ? []
        : [
            {
              sourceReference: bill.settlementRecord.settlementReference,
              orderReference: order,
              partNumber: null,
              paidDishesMinor: bill.rounds.reduce(
                (sum, round) => sum + BigInt(round.subtotalMinor),
                0n,
              ),
              certain: paidOnThisPhone(bill.settlementRecord) || onlyPhone,
            },
          ];
    if (bill.splitPlanRecord === null) return [];
    const settlements = await settlementStore.listByOrders(tx as never, [order]);
    const sources: ClaimSource[] = [];
    for (const settlement of settlements) {
      if (settlement.part?.splitPlanReference !== bill.splitPlanRecord.splitPlanReference) continue;
      const part = bill.splitPlanRecord.parts.find(
        (entry) => entry.partNumber === settlement.part?.partNumber,
      );
      if (part === undefined || payer(settlement) === "OtherPhone") continue;
      sources.push({
        sourceReference: settlement.settlementReference,
        orderReference: order,
        partNumber: part.partNumber,
        paidDishesMinor: part.subtotalMinor,
        certain: paidOnThisPhone(settlement) || onlyPhone,
      });
    }
    return partsThisPhoneMayClaim(
      sources.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0)),
    );
  };
  /**
   * Pickup, and a table that pays each round first: each paid round of the guest's own Order earns
   * on its own. The guest's Session lives at most a day, so two days of payments covers it.
   */
  const orderSources = async (
    tx: ConsumerTransaction,
    guest: { readonly sessionReference?: unknown },
    orderReference: string,
    ledger: RecentLedger,
  ): Promise<readonly ClaimSource[]> => {
    const owner = await loadOrderGuestSession(tx as never, scope, orderReference);
    if (owner === null || String(owner) !== String(guest.sessionReference)) return [];
    // A table that pays at the end earns on its settlement, once; the same dishes can't also earn
    // here through the Order's own receipt.
    const settled = await settlementStore.listByOrders(tx as never, [orderReference]);
    if (settled.length > 0) return [];
    const paid = new Set(
      ledger.payments
        .filter((payment) => payment.orderReference === orderReference && !payment.splitPart)
        .map((payment) => payment.orderBatchReference),
    );
    const dishes = await listOrderRoundDishes(tx, scope, orderReference);
    return [...paid].sort().map((batch) => ({
      sourceReference: batch,
      orderReference,
      partNumber: null,
      paidDishesMinor: dishes.get(batch) ?? 0n,
      // The guest's own Order, checked above.
      certain: true,
    }));
  };
  /**
   * What this guest could still claim, each with what its refunds already take back (v15 M60): the
   * same rule the background sweep applies, so a fully refunded receipt offers nothing and a partly
   * refunded one offers what is left.
   */
  const unclaimed = async (
    tx: ConsumerTransaction,
    guest: {
      readonly diningSessionReference?: unknown;
      readonly diningParticipantReference?: unknown;
      readonly sessionReference?: unknown;
    },
    rule: MemberPointsRule,
    orderReference: string | null = null,
  ): Promise<{
    readonly sources: readonly OfferedSource[];
    readonly ledger: RecentLedger | null;
  }> => {
    const session = orderReference === null ? await billSessionOf(tx, guest) : null;
    if (session === null && orderReference === null) return { sources: [], ledger: null };
    const ledger = await recentLedger(tx);
    const sources =
      orderReference !== null
        ? await orderSources(tx, guest, orderReference, ledger)
        : await claimSources(tx, session as string, guest);
    const earned = await points.earnedSources(
      tx as never,
      sources.map((source) => source.sourceReference),
    );
    const open = sources.filter(
      (source) =>
        !earned.has(source.sourceReference) &&
        pointsForPaidDishes(source.paidDishesMinor, rule) > 0,
    );
    const order = open[0]?.orderReference;
    if (order === undefined) return { sources: [], ledger };
    const already = await points.orderActivity(tx as never, order);
    const offered = open.map((source) => ({
      sourceReference: source.sourceReference,
      points: pointsForPaidDishes(source.paidDishesMinor, rule),
    }));
    const targets = refundedPointsTargets({
      earned: [...already.earned, ...offered],
      settlements: await settlementStore.listByOrders(tx as never, [order]),
      refunds: ledger.refunds.filter((refund) => refund.orderReference === order),
      paidMinor: ledgerOrderPaidMinor(ledger, order),
    }).slice(already.earned.length);
    return {
      ledger,
      sources: open
        .map((source, index) =>
          Object.freeze({
            ...source,
            points: offered[index]?.points ?? 0,
            refundedPoints: targets[index] ?? 0,
          }),
        )
        .filter((source) => source.points - source.refundedPoints > 0),
    };
  };
  const claimView = (sources: readonly OfferedSource[], until: string) =>
    sources.length === 0
      ? null
      : Object.freeze({
          until,
          parts: sources.map((source) =>
            Object.freeze({
              partNumber: source.partNumber,
              points: source.points - source.refundedPoints,
              certain: source.certain,
              // Said to the guest: these points are what is left after a refund.
              ...(source.refundedPoints > 0 ? { afterRefund: true } : {}),
            }),
          ),
        });
  const earn = async (
    tx: ConsumerTransaction,
    guest: { readonly diningSessionReference?: unknown },
    accountReference: string,
    rule: MemberPointsRule,
    partNumber: number | null,
    orderReference: string | null = null,
  ): Promise<number> => {
    const { sources, ledger } = await unclaimed(tx, guest, rule, orderReference);
    // A table's split parts are the guest's to name; an Order's paid rounds all belong to it.
    const chosen =
      orderReference !== null
        ? sources
        : partNumber === null
          ? sources.length === 1
            ? sources
            : []
          : sources.filter((entry) => entry.partNumber === partNumber);
    if (chosen.length === 0 || ledger === null) return fail("MEMBER_NOTHING_TO_CLAIM");
    let earned = 0;
    for (const source of chosen)
      earned += (
        await points.earn(tx as never, {
          accountReference,
          sourceReference: source.sourceReference,
          orderReference: source.orderReference,
          paidDishesMinor: source.paidDishesMinor,
          rule,
        })
      ).points;
    // Earned on what was paid, and the refunded share taken back at once in this transaction,
    // as the sweep would (append-only: "+35 paid dishes, -13 order refunded"). The sweep then
    // finds nothing owed.
    const order = (chosen[0] as OfferedSource).orderReference;
    if (chosen.some((source) => source.refundedPoints > 0))
      await settleOrder(
        tx,
        order,
        ledger.refunds.filter((refund) => refund.orderReference === order),
        ledgerOrderPaidMinor(ledger, order),
      );
    return earned - chosen.reduce((sum, source) => sum + source.refundedPoints, 0);
  };
  const translated = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CustomerMemberError) throw error;
      if (error instanceof MemberPointsError) {
        if (error.code === "MEMBER_ALREADY_EARNED") fail("MEMBER_ALREADY_EARNED");
        if (error.code === "MEMBER_NOT_ENOUGH_POINTS") fail("MEMBER_NOT_ENOUGH_POINTS");
        if (error.code === "MEMBER_NOT_FOUND") fail("MEMBER_NOT_FOUND");
      }
      if (/GUEST_SESSION/u.test(String((error as { code?: unknown } | null)?.code ?? "")))
        return fail("MEMBER_NOT_FOUND");
      return fail("MEMBER_UNAVAILABLE");
    }
  };
  const ruleView = (rule: MemberPointsRule) =>
    Object.freeze({
      earnPointsPerDollar: rule.earnPointsPerDollar,
      redeemPointsPerDollar: rule.redeemPointsPerDollar,
      minimumRedemptionPoints: rule.minimumRedemptionPoints,
      redemptionIncrementPoints: rule.redemptionIncrementPoints,
      rewards: rule.rewards,
    });

  return Object.freeze({
    /** What the receipt and checkout show. A guest who isn't a member gets the offer alone. */
    async state(credentials: MemberCredentials, orderReference: string | null = null) {
      return translated(() =>
        run(async (tx) => {
          const guest = await visit(tx, credentials);
          const on = await offered(tx);
          if (!on) return Object.freeze({ offered: false, signedIn: false });
          const rule = await points.currentRule(tx as never);
          const account = await member(tx, credentials);
          return Object.freeze({
            offered: true,
            signedIn: account !== null,
            rule: ruleView(rule),
            messagesAvailable: options.messages !== null,
            claim: claimView(
              (await unclaimed(tx, guest, rule, orderReference)).sources,
              String((guest as { absoluteExpiresAt: unknown }).absoluteExpiresAt),
            ),
          });
        }),
      );
    },

    /** Text a code. The limits are per phone and per address, counted even if sending fails. */
    async sendCode(credentials: MemberCredentials, phoneValue: unknown, address: string | null) {
      const phone = parseMemberPhone(phoneValue);
      if (phone === null) return fail("MEMBER_PHONE_INVALID");
      const check = async (
        purpose: string,
        value: string,
        windowSeconds: number,
        limit: number,
      ) => {
        const result = await options.budget.consume(
          "MEMBER_CODE_SEND",
          options.protector.budgetKey(purpose, value),
          { windowSeconds, limit },
        );
        if (!result.allowed)
          throw new CustomerMemberError("MEMBER_RATE_LIMITED", result.retryAfterSeconds);
      };
      return translated(async () => {
        await run((tx) => visit(tx, credentials));
        if (options.messages === null) return fail("MEMBER_CODE_UNAVAILABLE");
        await check(
          "phone-hour:" + scope.brandReference,
          phone,
          3600,
          memberCodeBudgets.sendPerPhoneHour,
        );
        await check(
          "phone-day:" + scope.brandReference,
          phone,
          86_400,
          memberCodeBudgets.sendPerPhoneDay,
        );
        // An address nobody can state is nobody's: never one budget shared by every guest.
        if (address !== null)
          await check("address-hour", address, 3600, memberCodeBudgets.sendPerAddressHour);
        const { code } = await run((tx) => points.createChallenge(tx as never, phone));
        try {
          await options.messages.send({ phone, kind: "Code", text: memberCodeText(code) });
        } catch {
          return fail("MEMBER_CODE_UNAVAILABLE");
        }
        return Object.freeze({ sent: true });
      });
    },

    /**
     * Check the code: signs in a member, or joins a new one where this Store offers it. The sign-in
     * commits on its own, so a trouble crediting this order never loses the membership.
     */
    async verify(
      credentials: MemberCredentials,
      input: {
        readonly phone: unknown;
        readonly code: unknown;
        readonly marketingConsent: boolean;
        readonly claim: boolean;
        readonly partNumber: number | null;
        readonly orderReference?: string | null;
      },
      address: string | null,
    ) {
      const phone = parseMemberPhone(input.phone);
      if (phone === null) return fail("MEMBER_PHONE_INVALID");
      if (typeof input.code !== "string" || !/^\d{6}$/u.test(input.code))
        return fail("MEMBER_CODE_WRONG");
      const code = input.code;
      return translated(async () => {
        if (address !== null) {
          const budget = await options.budget.consume(
            "MEMBER_CODE_CHECK",
            options.protector.budgetKey("check-address", address),
            { windowSeconds: 3600, limit: memberCodeBudgets.checkPerAddressHour },
          );
          if (!budget.allowed)
            throw new CustomerMemberError("MEMBER_RATE_LIMITED", budget.retryAfterSeconds);
        }
        // Its own transaction: a wrong try must count even though the answer is a refusal.
        const checked = await run(async (tx) => {
          await visit(tx, credentials);
          return points.checkChallenge(tx as never, phone, code);
        });
        if (checked === "Wrong") return fail("MEMBER_CODE_WRONG");
        if (checked === "NoCode") return fail("MEMBER_CODE_ENDED");
        const signedIn = await run(async (tx) => {
          const existing = await points.findByPhone(tx as never, phone);
          let account = existing;
          if (account === null) {
            if (!(await offered(tx))) return fail("MEMBER_NOT_OFFERED");
            account = await points.join(tx as never, {
              phone,
              marketingConsent: input.marketingConsent,
            });
          } else if (input.marketingConsent)
            await points.setMarketingConsent(tx as never, account, true);
          const session = await points.openSession(tx as never, account);
          return Object.freeze({ account, joined: existing === null, ...session });
        });
        let earned = 0;
        if (input.claim)
          earned = await run(async (tx) => {
            const guest = await visit(tx, credentials);
            if (!(await offered(tx))) return 0;
            const rule = await points.currentRule(tx as never);
            return earn(
              tx,
              guest,
              signedIn.account,
              rule,
              input.partNumber,
              input.orderReference ?? null,
            );
          }).catch(() => 0);
        return Object.freeze({
          joined: signedIn.joined,
          earnedPoints: earned,
          token: signedIn.token,
          expiresAt: signedIn.expiresAt,
        });
      });
    },

    /** Credit a paid order to the signed-in member. */
    async claim(
      credentials: MemberCredentials,
      partNumber: number | null,
      orderReference: string | null = null,
    ) {
      return translated(() =>
        run(async (tx) => {
          const guest = await visit(tx, credentials);
          if (!(await offered(tx))) return fail("MEMBER_NOT_OFFERED");
          const account = await member(tx, credentials);
          if (account === null) return fail("MEMBER_SIGN_IN_REQUIRED");
          const rule = await points.currentRule(tx as never);
          return Object.freeze({
            earnedPoints: await earn(
              tx,
              guest,
              account as string,
              rule,
              partNumber,
              orderReference,
            ),
          });
        }),
      );
    },

    /** The member page: works at a Store that has switched points off, so anyone can leave. */
    async home(credentials: MemberCredentials) {
      return translated(() =>
        run(async (tx) => {
          await visit(tx, credentials);
          const account = await member(tx, credentials);
          if (account === null) return fail("MEMBER_SIGN_IN_REQUIRED");
          const rule = await points.currentRule(tx as never);
          const home = await points.memberHome(tx as never, account as string);
          const expiresAt = memberPointsExpireAt(home.lastActivityAt, rule);
          return Object.freeze({
            offeredHere: await offered(tx),
            availablePoints: home.availablePoints,
            pointsOwed: home.pointsDebt,
            phoneLast4: home.phoneLast4,
            marketingConsent: home.marketingConsent,
            expiresAt: home.availablePoints > 0 ? expiresAt : null,
            expiresSoon:
              home.availablePoints > 0 &&
              Date.parse(expiresAt) - Date.parse(now()) <= memberPointsPageWarningDays * 86_400_000,
            history: home.history,
            rule: ruleView(rule),
          });
        }),
      );
    },

    /** What this table can take in points now, for the payment page. */
    async redemptionOptions(credentials: MemberCredentials) {
      return translated(() =>
        run(async (tx) => {
          const guest = await visit(tx, credentials);
          if (!(await offered(tx))) return Object.freeze({ available: false as const });
          const account = await member(tx, credentials);
          const session = await billSessionOf(tx, guest);
          if (account === null || session === null)
            return Object.freeze({ available: false as const });
          const bill = await billOf(tx, session);
          const rule = await points.currentRule(tx as never);
          const home = await points.memberHome(tx as never, account as string);
          const allowed =
            bill.paymentTiming === "PayLater" &&
            bill.settlement === null &&
            bill.writeOff === null &&
            bill.split === null &&
            bill.onlinePayment?.status !== "InProgress";
          const dishes = allowed ? await dishesOf(tx, bill) : [];
          const dishesMinor = dishes.reduce((sum, dish) => sum + dish.netMinor, 0n);
          return Object.freeze({
            available: true as const,
            availablePoints: home.availablePoints,
            blockedBySplit: bill.split !== null,
            largestPoints: largestRedemptionPoints(home.availablePoints, dishesMinor, rule),
            rule: ruleView(rule),
            rewards: rule.rewards.filter(
              (reward) =>
                reward.pointsCost <= home.availablePoints &&
                dishes.some((dish) => dish.productReference === reward.productReference),
            ),
          });
        }),
      );
    },

    /**
     * Use points on this table's bill, in one transaction with the bill's reductions: either the
     * bill went down and the points went, or neither. The sale stays recorded at its price.
     */
    async redeem(
      credentials: MemberCredentials,
      input: {
        readonly operationReference: string;
        readonly points: number | null;
        readonly rewardProductReference: string | null;
      },
    ) {
      return translated(() =>
        run(async (tx) => {
          const guest = await visit(tx, credentials);
          if (!(await offered(tx))) return fail("MEMBER_NOT_OFFERED");
          const account = await member(tx, credentials);
          if (account === null) return fail("MEMBER_SIGN_IN_REQUIRED");
          const prior = await points.redemptionByOperation(tx as never, input.operationReference);
          if (prior !== null) {
            // The same request again (a lost answer): its result, never a second redemption.
            if (prior.accountReference !== account) return fail("MEMBER_REDEEM_INVALID");
            return Object.freeze({ status: "AlreadyRecorded", points: prior.points });
          }
          const session = await billSessionOf(tx, guest);
          if (session === null) return fail("MEMBER_REDEEM_NOT_THIS_TABLE");
          const bill = await billOf(tx, session as string);
          if (bill.paymentTiming !== "PayLater" || bill.orderReference === null)
            return fail("MEMBER_REDEEM_NOT_THIS_TABLE");
          if (bill.split !== null) return fail("MEMBER_REDEEM_SPLIT");
          if (bill.settlement !== null || bill.writeOff !== null) return fail("MEMBER_REDEEM_PAID");
          if (bill.onlinePayment?.status === "InProgress")
            return fail("MEMBER_REDEEM_GUEST_PAYING");
          const rule = await points.currentRule(tx as never);
          const dishes = await dishesOf(tx, bill);
          let lines: { orderItemReference: string; orderReference: string; netMinor: bigint }[];
          let spend: number;
          let reward: string | null = null;
          if (input.rewardProductReference !== null) {
            const wanted = rule.rewards.find(
              (entry) => entry.productReference === input.rewardProductReference,
            );
            const dish = dishes.find(
              (entry) => entry.productReference === input.rewardProductReference,
            );
            if (wanted === undefined || dish === undefined) return fail("MEMBER_REDEEM_INVALID");
            lines = [
              {
                orderItemReference: (dish as (typeof dishes)[number]).orderItemReference,
                orderReference: (dish as (typeof dishes)[number]).orderReference,
                netMinor: (dish as (typeof dishes)[number]).netMinor,
              },
            ];
            spend = (wanted as MemberPointsRule["rewards"][number]).pointsCost;
            reward = input.rewardProductReference;
          } else {
            const value = redemptionValueMinor(input.points ?? 0, rule);
            if (value === null) return fail("MEMBER_REDEEM_INVALID");
            let left = value as bigint;
            lines = [];
            for (const dish of dishes) {
              if (left <= 0n) break;
              const take = dish.netMinor <= left ? dish.netMinor : left;
              lines.push({
                orderItemReference: dish.orderItemReference,
                orderReference: dish.orderReference,
                netMinor: take,
              });
              left -= take;
            }
            if (left > 0n) return fail("MEMBER_REDEEM_INVALID");
            spend = input.points as number;
          }
          const ordering = createPostgresOrderPriceReductionStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async () => true,
          });
          const decidedAt = now();
          const records = await ordering.commitPointsRedemption(tx, {
            lines,
            operationReference: input.operationReference,
            accountReference: account as string,
            decidedAt,
            nextReference: options.nextReference,
            // v15 b16 (DEC-COMP-BILL-CENT): the points take off exactly what the bill goes down by.
            billTaxRoundingShares: (planned) =>
              billReductionTaxShares(tx, scope, {
                orderReference: bill.orderReference as string,
                observedAt: decidedAt,
                authorize: async () => true,
                lines: planned,
              }),
          });
          await points.redeem(tx as never, {
            accountReference: account as string,
            operationReference: input.operationReference,
            orderReference: bill.orderReference,
            points: spend,
            netMinor: records.reduce((sum, record) => sum + record.netMinor, 0n),
            totalMinor: records.reduce((sum, record) => sum + record.totalMinor, 0n),
            rewardProductReference: reward,
            rule,
          });
          return Object.freeze({
            status: "Recorded",
            points: spend,
            takenOffMinor: records.reduce((sum, record) => sum + record.totalMinor, 0n).toString(),
          });
        }),
      );
    },

    async setMarketingConsent(credentials: MemberCredentials, given: boolean) {
      return translated(() =>
        run(async (tx) => {
          await visit(tx, credentials);
          const account = await member(tx, credentials);
          if (account === null) return fail("MEMBER_SIGN_IN_REQUIRED");
          await points.setMarketingConsent(tx as never, account as string, given);
          return Object.freeze({ marketingConsent: given });
        }),
      );
    },

    async signOut(credentials: MemberCredentials) {
      return translated(() =>
        run(async (tx) => {
          await visit(tx, credentials);
          if (credentials.memberToken !== null)
            await points.endSession(tx as never, credentials.memberToken);
          return Object.freeze({ signedOut: true });
        }),
      );
    },

    /** Leave and delete: the phone number goes now, and the balance with it. */
    async leave(credentials: MemberCredentials) {
      return translated(() =>
        run(async (tx) => {
          await visit(tx, credentials);
          const account = await member(tx, credentials);
          if (account === null) return fail("MEMBER_SIGN_IN_REQUIRED");
          await points.leave(tx as never, account as string);
          return Object.freeze({ left: true });
        }),
      );
    },
  });

  async function dishesOf(
    tx: ConsumerTransaction,
    bill: { readonly rounds: readonly { readonly orderReference: string }[] },
  ) {
    return createPostgresOrderPriceReductionStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async () => true,
    }).listRedeemableDishes(tx, [...new Set(bill.rounds.map((round) => round.orderReference))]);
  }
}
export type CustomerMemberPort = ReturnType<typeof createCustomerMember>;
