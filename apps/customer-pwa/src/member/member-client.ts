import { boundedJsonFetch } from "../network/bounded-fetch.js";
import {
  getCustomerCsrfCredential,
  getSettledTableReceiptCsrf,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the guest's side of the Brand's points. The phone number and
 * code only ever travel in a request body.
 */
export type MemberErrorCode =
  | "member_not_offered"
  | "member_phone_invalid"
  | "member_code_unavailable"
  | "member_rate_limited"
  | "member_code_wrong"
  | "member_code_ended"
  | "member_sign_in_required"
  | "member_not_found"
  | "member_nothing_to_claim"
  | "member_already_earned"
  | "member_not_enough_points"
  | "member_redeem_invalid"
  | "member_redeem_not_this_table"
  | "member_redeem_split"
  | "member_redeem_paid"
  | "member_redeem_guest_paying"
  | "member_unavailable";
export class MemberClientError extends Error {
  constructor(
    readonly code: MemberErrorCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "MemberClientError";
  }
}
export interface MemberReward {
  readonly productReference: string;
  readonly displayName: string;
  readonly pointsCost: number;
}
export interface MemberRule {
  readonly earnPointsPerDollar: number;
  readonly redeemPointsPerDollar: number;
  readonly minimumRedemptionPoints: number;
  readonly redemptionIncrementPoints: number;
  readonly rewards: readonly MemberReward[];
}
export interface MemberState {
  readonly offered: boolean;
  readonly signedIn: boolean;
  readonly messagesAvailable?: boolean;
  readonly rule?: MemberRule;
  readonly claim?: null | {
    readonly until: string;
    readonly parts: readonly {
      readonly partNumber: number | null;
      readonly points: number;
      /** This phone certainly paid it: a signed-in member's points are added without asking. */
      readonly certain?: boolean;
    }[];
  };
}
export interface MemberHistoryEntry {
  readonly type: "Earn" | "Redeem" | "Reverse" | "Return" | "Expire";
  readonly points: number;
  readonly reasonCode: string;
  readonly occurredAt: string;
}
export interface MemberHome {
  readonly offeredHere: boolean;
  readonly availablePoints: number;
  readonly pointsOwed: number;
  readonly phoneLast4: string;
  readonly marketingConsent: boolean;
  readonly expiresAt: string | null;
  readonly expiresSoon: boolean;
  readonly history: readonly MemberHistoryEntry[];
  readonly rule: MemberRule;
}
export interface MemberRedemptionOptions {
  readonly available: boolean;
  readonly availablePoints?: number;
  readonly blockedBySplit?: boolean;
  readonly largestPoints?: number;
  readonly rule?: MemberRule;
  readonly rewards?: readonly MemberReward[];
}
async function post<T>(body: Record<string, unknown>): Promise<T> {
  const csrf = getCustomerCsrfCredential() ?? getSettledTableReceiptCsrf();
  if (csrf === null) throw new MemberClientError("member_not_found");
  let received: Awaited<ReturnType<typeof boundedJsonFetch>>;
  try {
    received = await boundedJsonFetch(globalThis.fetch, "/bff/customer/member", {
      method: "POST",
      mode: "cors",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MemberClientError("member_unavailable");
  }
  const { response } = received;
  const answer = received.payload as {
    error?: { code?: MemberErrorCode; retryAfterSeconds?: number };
  } | null;
  if (!response.ok)
    throw new MemberClientError(
      answer?.error?.code ?? "member_unavailable",
      answer?.error?.retryAfterSeconds ?? null,
    );
  return answer as T;
}
const withOrder = (orderReference: string | null) =>
  orderReference === null ? {} : { orderReference };
export const memberClient = Object.freeze({
  state: (orderReference: string | null) =>
    post<MemberState>({ action: "State", ...withOrder(orderReference) }),
  sendCode: (phone: string) => post<{ sent: boolean }>({ action: "SendCode", phone }),
  verify: (input: {
    readonly phone: string;
    readonly code: string;
    readonly marketingConsent: boolean;
    readonly claim: boolean;
    readonly partNumber: number | null;
    readonly orderReference: string | null;
  }) =>
    post<{ joined: boolean; earnedPoints: number }>({
      action: "Verify",
      phone: input.phone,
      code: input.code,
      marketingConsent: input.marketingConsent,
      claim: input.claim,
      ...(input.partNumber === null ? {} : { partNumber: input.partNumber }),
      ...withOrder(input.orderReference),
    }),
  claim: (partNumber: number | null, orderReference: string | null) =>
    post<{ earnedPoints: number }>({
      action: "Claim",
      ...(partNumber === null ? {} : { partNumber }),
      ...withOrder(orderReference),
    }),
  home: () => post<MemberHome>({ action: "Home" }),
  redemptionOptions: () => post<MemberRedemptionOptions>({ action: "RedemptionOptions" }),
  redeem: (input: {
    readonly operationReference: string;
    readonly points?: number;
    readonly rewardProductReference?: string;
  }) => post<{ status: string; points: number }>({ action: "Redeem", ...input }),
  setMarketingConsent: (given: boolean) =>
    post<{ marketingConsent: boolean }>({ action: "SetMarketingConsent", given }),
  signOut: () => post<{ signedOut: boolean }>({ action: "SignOut" }),
  leave: () => post<{ left: boolean }>({ action: "Leave" }),
});
export type MemberClient = typeof memberClient;
