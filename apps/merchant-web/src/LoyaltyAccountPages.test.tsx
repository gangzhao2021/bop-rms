import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LoyaltyAccountDetail, LoyaltyAccountState, PointsReview } from "./LoyaltyAccountPages.js";
import {
  LoyaltyAccountClientError,
  parseLoyaltyAccountView,
  parsePointsReviewView,
} from "./loyalty-account-pages.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const account = (ledger = true) => ({
  projectionName: "loyalty_account_v1",
  projectionVersion: 1,
  screenId: "LOY-ACCOUNT-DETAIL",
  brandLabel: "Synthetic Brand",
  asOfUtc: "2026-08-14T11:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayViewLedger: ledger, mayOperate: true, mayCorrect: true },
  account: {
    accountReference: id(1),
    aggregateVersion: 4,
    status: "Active",
    programReference: id(2),
    tierCode: "GOLD",
    pendingPoints: 20,
    availablePoints: 80,
    reservedPoints: 10,
    lifetimeEarnedPoints: 100,
    pointsDebt: 5,
    expiringPoints: 15,
    ledger: ledger
      ? [
          {
            transactionReference: id(3),
            type: "Earn",
            points: 100,
            sourceReference: id(4),
            occurredAt: "2026-08-14T10:00:00.000Z",
            originalTransactionReference: null,
          },
        ]
      : null,
    rewardReferences: [id(5)],
    reservations: [
      {
        reservationReference: id(6),
        targetReference: id(7),
        points: 10,
        expiresAt: "2026-08-14T12:00:00.000Z",
        status: "Reserved",
      },
    ],
    linkedAllocationReferences: [id(8)],
  },
});
const review = () => ({
  projectionName: "loyalty_points_exception_v1",
  projectionVersion: 1,
  screenId: "LOY-POINTS-REVIEW",
  brandLabel: "Synthetic Brand",
  asOfUtc: "2026-08-14T11:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayReview: true, mayCorrect: true },
  rows: [
    {
      exceptionReference: id(10),
      accountReference: id(1),
      sourceReference: id(4),
      type: "NegativeMismatch",
      status: "Acknowledged",
      ownerReference: id(9),
      dueAt: "2026-08-15T10:00:00.000Z",
      correctionTransactionReference: null,
    },
  ],
});
describe("Loyalty Account pages", () => {
  it("strictly parses both projections and rejects editable balance fields", () => {
    expect(parseLoyaltyAccountView(account())).toMatchObject({ account: { availablePoints: 80 } });
    expect(parsePointsReviewView(review())).toMatchObject({ rows: [{ type: "NegativeMismatch" }] });
    expect(() => parseLoyaltyAccountView({ ...account(), setBalance: 999 })).toThrow(
      LoyaltyAccountClientError,
    );
  });
  it("renders balances, ledger, reservations and immutable correction boundary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LoyaltyAccountDetail view={parseLoyaltyAccountView(account())} />
      </MemoryRouter>,
    );
    for (const v of [
      "LOY-ACCOUNT-DETAIL",
      "Derived balances",
      "Points Debt 5",
      "Append-only ledger",
      "Release invalid reservation",
      "Authorized correction from linked transaction",
      "cannot be edited",
      "not Payment tender",
      "never rewrite source transactions",
    ])
      expect(html).toContain(v);
  });
  it("renders canonical exception filters and source-based actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PointsReview view={parsePointsReviewView(review())} />
      </MemoryRouter>,
    );
    for (const v of [
      "LOY-POINTS-REVIEW",
      "Account / Order ref",
      "Type / status / program / owner / overdue",
      "Recalculate from source",
      "Append authorized correction",
      "Resolve",
    ])
      expect(html).toContain(v);
  });
  it("trims ledger and covers all failure states", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LoyaltyAccountDetail
          view={parseLoyaltyAccountView({ ...account(false), freshness: "Stale" })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Append-only ledger");
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "Validation",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<LoyaltyAccountState state={state} />)).toContain("status");
  });
});
