/**
 * Batch 65 (v15 b64 live, guest-split-own-payment): the real guest Cart read on a local server,
 * for the customer browser spec. Dining's own participation query decides whether the table is
 * checking out (its session phase), Ordering's own read and view compose the table's Cart, and the
 * API's read bridge and HTTP handler write the reply. Only the owners' stored facts are in memory:
 * one TEST table whose two phones each added one Beef noodles (TEST) and sent neither, as G64 B
 * had on v15 when staff pressed Start checkout. Nothing between the read and the page is a
 * hand-written body.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guestSessionAbsoluteLifetimeMs, guestSessionIdleLifetimeMs } from "@bop/identity";
import { createDiningCartParticipationQuery } from "@rms/dining";
import {
  createCustomerDiningCartViewQuery,
  createDiningCartReadService,
  parseCartAggregate,
} from "@rms/ordering";
import { createApp } from "../src/app.js";
import { CustomerCartHandler } from "../src/customer-cart.js";
import { createCustomerCartReadPort } from "../src/customer-cart-read-composition.js";
import { cartParticipation } from "../src/customer-dining-cart-composition.js";

const id = (n: number) => "0198b065-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const brand = id(2);
const store = id(3);
const diningSession = id(30);
const table = id(32);
const participantA = id(31);
const participantB = id(41);
/** The guest Cookie value the spec sends (phone A). */
export const guestCartAtCheckoutCookie = "s".repeat(43);

export type GuestCartTablePhase = "Active" | "Closing";

const dishName = (locale: string) => (locale.startsWith("zh") ? "牛肉面" : "Beef noodles (TEST)");

export async function startGuestCartAtCheckoutHttp(
  allowedOrigin: string,
  phase: () => GuestCartTablePhase,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const startedAt = new Date(Date.now() - 1_800_000).toISOString();
  const addedAt = new Date(Date.now() - 600_000).toISOString();
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  const line = (n: number, participant: string, actor: string) => ({
    cartItemReference: id(n),
    cartReference: id(4),
    sellableReference: id(9),
    quantity: 1,
    optionSelections: [],
    customerNote: null,
    catalogSelectionEvidence: {
      menuVersionReference: id(11),
      productVersionReference: id(10),
      catalogChannelCode: "WEB",
      catalogOrderTypeCode: "DINE_IN",
      ruleEvidence: [],
      validatedAt: addedAt,
    },
    addedByActorReference: actor,
    addedByParticipantReference: participant,
    addedAt,
  });
  const cart = parseCartAggregate({
    cartReference: id(4),
    brandReference: brand,
    storeReference: store,
    orderType: "DineIn",
    sourceChannel: "Qr",
    diningSessionReference: diningSession,
    createdByActorReference: id(5),
    aggregateVersion: 3,
    createdAt: startedAt,
    updatedAt: addedAt,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(15),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 7200,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: later(3_600_000),
      absoluteExpiresAt: later(80_000_000),
      terminalAt: null,
      terminalReason: null,
    },
    items: [line(8, participantA, id(5)), line(18, participantB, id(6))],
  });
  const now = () => new Date().toISOString();
  // Dining's own query, over its stored facts: the session's phase is the table's.
  const dining = createDiningCartParticipationQuery({
    scope: { brandReference: brand, storeReference: store },
    now,
    repository: {
      readCurrent: async (input) =>
        ({
          session: {
            brandReference: brand,
            storeReference: store,
            diningSessionReference: diningSession,
            tableReference: table,
            tableAssignmentVersion: 1,
            phase: phase(),
            version: phase() === "Closing" ? 4 : 3,
            startedByActorReference: id(7),
            startedAt,
            hostParticipantReference: participantA,
          },
          participant: {
            participantReference: input.participantReference,
            diningSessionReference: diningSession,
            status: "Active",
            version: 1,
            joinedAt: startedAt,
            leftAt: null,
          },
          table: {
            brandReference: brand,
            storeReference: store,
            tableReference: table,
            assignmentVersion: 1,
            tableState: "Eligible",
            activeDiningSessionReference: diningSession,
            observedAt: input.observedAt,
          },
        }) as never,
    },
  });
  const reads = createDiningCartReadService({
    scope: { brandReference: brand, storeReference: store },
    now,
    sessions: {
      resolve: async () =>
        ({
          sessionReference: id(5),
          status: "Active",
          version: 1,
          brandReference: brand,
          storeReference: store,
          publicStoreReference: id(16),
          publicTableReference: id(33),
          channel: "DineIn",
          locale: "en-CA",
          qrReference: id(34),
          qrRevocationVersion: 1,
          diningState: "DiningBound",
          diningSessionReference: diningSession,
          diningParticipantReference: participantA,
          createdAt: startedAt,
          lastSeenAt: addedAt,
          idleExpiresAt: new Date(Date.parse(addedAt) + guestSessionIdleLifetimeMs).toISOString(),
          absoluteExpiresAt: new Date(
            Date.parse(startedAt) + guestSessionAbsoluteLifetimeMs,
          ).toISOString(),
          orderClosedAt: null,
          closureExpiresAt: null,
          rotatedFromGuestSessionReference: null,
          revocationReason: null,
          revokedAt: null,
        }) as never,
    },
    participation: cartParticipation(dining as never),
    carts: { current: async () => cart },
  });
  const query = createCustomerDiningCartViewQuery({
    reads,
    stores: {
      getPublicStore: async () =>
        ({
          status: "Available",
          profile: {
            profileReference: id(20),
            profileVersion: 1,
            releaseReference: id(21),
            contentDigest: `sha256:${"c".repeat(64)}`,
            defaultLocale: "en-CA",
            selectedLocale: "en-CA",
            currencyCode: "CAD",
            timeZone: "America/Toronto",
            brandDisplayName: "Test Merchant 2 - not production",
            storeDisplayName: "Test Merchant 2 Main - not production",
            address: {
              countryCode: "CA",
              regionCode: "ON",
              locality: "Exampleville",
              postalCode: "A1A 1A1",
              addressLines: ["100 Example Street (TEST)"],
            },
            businessPhone: null,
            website: null,
            logoAssetVersionReference: null,
          },
        }) as never,
    },
    catalog: {
      describeMany: async (requests) =>
        requests.map(
          (request) =>
            ({
              status: "Found",
              menuVersionReference: request.menuVersionReference,
              productVersionReference: request.productVersionReference,
              sellableReference: request.sellableReference,
              displayName: dishName(String(request.locale)),
              options: [],
            }) as never,
        ),
    },
  });
  const handler = new CustomerCartHandler({
    allowedOrigin,
    port: createCustomerCartReadPort(query),
  });
  const server: Server = createServer(createApp({ customerCart: handler }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
