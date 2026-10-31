import { createAuthenticationSession } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { createMerchantOrderExceptionAuthorization } from "./merchant-order-exception-authorization.js";

const id = (n: number) => "0190fac9-0000-7000-8000-" + String(n).padStart(12, "0");
const from = "2026-09-20T10:00:00.000Z",
  at = "2026-09-20T10:10:00.000Z";
const session = (kitchenDisplay: boolean) =>
  createAuthenticationSession({
    sessionReference: id(1),
    actor: {
      actorType: "User",
      actorReference: id(2),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: from,
      recentMfaAt: null,
    },
    status: "Active",
    policyCode: kitchenDisplay ? "NamedKdsOperator" : "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: kitchenDisplay ? 60 : 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: from,
    createdAt: from,
    lastSeenAt: from,
    idleExpiresAt: kitchenDisplay ? "2026-09-20T11:00:00.000Z" : "2026-09-20T10:30:00.000Z",
    absoluteExpiresAt: "2026-09-20T22:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });

it.each([
  [true, 0],
  [false, 1],
])(
  "a kitchen display sign-in (%s) gets no order exception authority before any selection or policy read",
  async (kitchenDisplay, contextReads) => {
    const context = vi.fn(async () => {
      throw new Error("SYNTHETIC_STOP");
    });
    const authorize = createMerchantOrderExceptionAuthorization({
      now: () => at,
      session: async () => session(kitchenDisplay),
      context,
      membership: () => {
        throw new Error("UNEXPECTED_MEMBERSHIP_READ");
      },
    });
    expect(
      await authorize({} as never, {
        sessionCookie: "synthetic-cookie",
        permission: "operations.order-exception.manage",
      }),
    ).toBeNull();
    expect(context).toHaveBeenCalledTimes(contextReads);
  },
);
