import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createGuestSession, GuestSessionError } from "../../packages/bop/identity/src/index.ts";
import {
  CartError,
  createPostgresPickupCartBindingReader,
} from "../../packages/rms/ordering/src/index.ts";
import { createCustomerCartReadPort } from "../../apps/api/dist/customer-cart-read-composition.js";
import { logGuestFailure } from "../../apps/api/dist/guest-failure-log.js";
import {
  requestShedFor,
  withRequestAcquireBudget,
} from "../../apps/api/dist/request-acquire-budget.js";
import {
  acquireTenantConnection,
  noteTenantDatabaseAnswered,
  watchTenantConnectionPool,
} from "../../packages/database/dist/connection-acquire.js";

/**
 * WP-2423 (rush-logging-and-entry), v15 2026-11-13: in three bursts all 103
 * CUSTOMER_CART_READ_UNAVAILABLE lines were level 50 and their completion lines 503
 * HTTP_SERVER_ERROR. The API's pool had no answer for ten seconds (its slots opening again) while
 * the database answered the staff entry throughout, so every wait that ran out was taken for a
 * database that hangs. The two cause chains seen live are rebuilt here over the real connection
 * acquire and cart read port; with the heartbeat answered both are the rush (level 40,
 * HTTP_RETRY_LATER), without it a fault (level 50, HTTP_SERVER_ERROR).
 */
const ref = (n) => `018f5500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ownerScope = { brandReference: ref(2), storeReference: ref(3) };
const pickupAt = "2026-09-08T12:00:00.000Z";
const pickupSession = createGuestSession({
  ...ownerScope,
  sessionReference: ref(14),
  status: "Active",
  version: 1,
  publicStoreReference: ref(4),
  publicTableReference: null,
  channel: "Pickup",
  locale: "en-CA",
  qrReference: ref(5),
  qrRevocationVersion: 1,
  diningState: "ContextOnly",
  diningSessionReference: null,
  diningParticipantReference: null,
  createdAt: pickupAt,
  lastSeenAt: pickupAt,
  idleExpiresAt: "2026-09-08T16:00:00.000Z",
  absoluteExpiresAt: "2026-09-09T12:00:00.000Z",
  orderClosedAt: null,
  closureExpiresAt: null,
  rotatedFromGuestSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
const chains = {
  // [CART_DEPENDENCY_UNAVAILABLE, GUEST_SESSION_UNAVAILABLE, GUEST_BINDING_SOURCE_UNAVAILABLE,
  //  TENANT_DATABASE_ACQUIRE_FAILED] (54 lines, with GUEST_SESSION_UNAVAILABLE twice as well).
  binding: (acquireFailure) =>
    Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
      cause: Object.assign(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"), {
        dependencyFailure: true,
        cause: Object.assign(new Error("GUEST_BINDING_SOURCE_UNAVAILABLE"), {
          dependencyFailure: true,
          cause: acquireFailure,
        }),
      }),
    }),
  // [CART_DEPENDENCY_UNAVAILABLE] alone (41 lines): an owner read answered "unavailable" over
  // what it met, so nothing is left under it.
  bare: () => new CartError("CART_DEPENDENCY_UNAVAILABLE"),
  // Review: the same read now, through the real Pickup binding reader, which keeps what it met.
  owner: async (acquireFailure) => {
    const failed = await createPostgresPickupCartBindingReader(
      {
        async run() {
          throw acquireFailure;
        },
      },
      ownerScope,
    )
      .current(pickupSession, pickupAt)
      .catch((error) => error);
    // As the Pickup cart read wraps it.
    return Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: failed });
  },
};

/** A pool whose last answer was 10 s ago and whose slots are opening again (handshakes run out). */
function silentPool(clock) {
  const pool = Object.assign(new EventEmitter(), {
    options: { max: 2, connectionTimeoutMillis: 2000 },
    totalCount: 2,
    async connect() {
      clock.at += 2000;
      clock.beat?.();
      throw new Error("Connection terminated due to connection timeout");
    },
  });
  watchTenantConnectionPool(pool);
  pool.emit("acquire");
  pool.emit("release", undefined);
  pool.emit("acquire");
  clock.at += 10_000;
  return pool;
}

async function burstRead(chain, heartbeat) {
  const clock = { at: Date.now() };
  const pool = silentPool(clock);
  if (heartbeat) clock.beat = () => noteTenantDatabaseAnswered(pool);
  const lines = [];
  const causes = [];
  const port = createCustomerCartReadPort(
    {
      async read() {
        const failure = await acquireTenantConnection(pool, {
          budgetMs: 10_000,
          now: () => clock.at,
          sleep: async (ms) => {
            clock.at += ms;
          },
        }).then(
          () => null,
          (error) => error,
        );
        throw await chains[chain](failure);
      },
    },
    {
      log: (event, error, write, level) => {
        lines.push({ event, level });
        logGuestFailure(
          event,
          error,
          (line) => causes.push(...(JSON.parse(line).causes ?? [])),
          level,
        );
      },
    },
  );
  const response = Object.assign(new EventEmitter(), {});
  const answer = await withRequestAcquireBudget(
    () => port.getCurrentCart({ guestCredential: "g".repeat(43) }),
    { response, answerWithinMs: 12_000 },
  );
  return {
    answer: answer.status,
    lines,
    ...(chain === "owner" ? { causes } : {}),
    completion: requestShedFor(response) ? "HTTP_RETRY_LATER" : "HTTP_SERVER_ERROR",
  };
}

describe("WP-2423 (rush-logging-and-entry): guest cart reads the rush turned away", () => {
  it("WP-2423 (rush-logging-and-entry review): the owner read keeps what it met, so the line says no connection was had and the read is not repeated", async () => {
    const owned = ["CART_DEPENDENCY_UNAVAILABLE", "TENANT_DATABASE_ACQUIRE_FAILED"];
    expect(await burstRead("owner", true)).toEqual({
      answer: "Unavailable",
      lines: [{ event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 40 }],
      causes: owned,
      completion: "HTTP_RETRY_LATER",
    });
    // Without the heartbeat: a fault, and still not read again (no connection could be had).
    expect(await burstRead("owner", false)).toEqual({
      answer: "Unavailable",
      lines: [{ event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 50 }],
      causes: owned,
      completion: "HTTP_SERVER_ERROR",
    });
  });
  for (const chain of ["binding", "bare"])
    it(`log the live ${chain} cause chain as a wait while the database answers the heartbeat, a fault when it does not`, async () => {
      expect(await burstRead(chain, true)).toEqual({
        answer: "Unavailable",
        lines: [{ event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 40 }],
        completion: "HTTP_RETRY_LATER",
      });
      // A fault: a chain with nothing under it is read once more first (as live, level 40).
      expect(await burstRead(chain, false)).toEqual({
        answer: "Unavailable",
        lines: [
          ...(chain === "bare" ? [{ event: "CUSTOMER_CART_READ_RETRIED", level: 40 }] : []),
          { event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 50 },
        ],
        completion: "HTTP_SERVER_ERROR",
      });
    });
});
