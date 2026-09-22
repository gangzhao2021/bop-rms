import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import {
  createConfiguredCartQuoteService,
  type ConfiguredCartQuotePorts,
} from "./configured-cart-quote-service.js";
import {
  createDiningCartAuthority,
  type DiningCartAuthorityPorts,
  type DiningCartAuthoritySnapshot,
} from "./dining-cart-authority.js";
import type { PickupCartQuoteOptions } from "./pickup-cart-quote-service.js";

export type ConfiguredCustomerQuoteOptions = Omit<ConfiguredCartQuotePorts, "authorization"> & {
  readonly scope: PickupCartQuoteOptions["scope"];
  readonly sessions: PickupCartQuoteOptions["sessions"];
  readonly audit: PickupCartQuoteOptions["audit"];
} & (
    | { readonly orderType: "Pickup"; readonly binding: PickupCartQuoteOptions["binding"] }
    | {
        readonly orderType: "DineIn";
        readonly participation: DiningCartAuthorityPorts["participation"];
      }
  );
function denied(): never {
  throw new CartError("CART_PERMISSION_DENIED");
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function sameSession(a: GuestSession, b: GuestSession) {
  return (Object.keys(a) as (keyof GuestSession)[]).every(
    (key) => key === "lastSeenAt" || key === "idleExpiresAt" || a[key] === b[key],
  );
}

/** Current credential-bound entry; repeated observations are not a Dining Closing lease. */
export function createConfiguredCustomerQuoteService(options: ConfiguredCustomerQuoteOptions) {
  const scope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async attach(value: unknown) {
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "cartReference",
          "expectedCartVersion",
          "operationReference",
        ]);
        const credential = parseGuestRawCredential(raw.sessionCredential);
        const csrf = parseGuestRawCredential(raw.csrfCredential);
        const cartReference = parseOrderingReference(raw.cartReference);
        const operationReference = parseOrderingReference(raw.operationReference);
        let last: string | undefined;
        const now = () => {
          const next = parseOrderingInstant(options.now());
          if (last !== undefined && next < last) return unavailable();
          last = next;
          return next;
        };
        const requestedAt = now();
        const sessions = {
          async authorize(observedAt: unknown) {
            try {
              return createGuestSession(
                await options.sessions.authorize({
                  sessionCredential: credential,
                  csrfCredential: csrf,
                  observedAt,
                }),
              );
            } catch {
              return denied();
            }
          },
        };
        const dining =
          options.orderType === "DineIn"
            ? createDiningCartAuthority({
                scope: { brandReference: brand, storeReference: store },
                now,
                participation: options.participation,
                sessions: { resolve: ({ observedAt }) => sessions.authorize(observedAt) },
              })
            : null;
        let firstDining: DiningCartAuthoritySnapshot | undefined;
        async function currentGuest() {
          if (dining !== null) {
            const { authority } = await dining.run(credential, async (current) => current);
            if (firstDining !== undefined) {
              if (!sameSession(firstDining.session, authority.session)) return denied();
              for (const key of [
                "brandReference",
                "storeReference",
                "diningSessionReference",
                "participantReference",
                "tableReference",
                "tableAssignmentVersion",
                "diningSessionVersion",
                "participantVersion",
              ] as const) {
                if (firstDining.participation[key] !== authority.participation[key])
                  return denied();
              }
            }
            firstDining ??= authority;
            return authority.session;
          }
          if (options.orderType !== "Pickup") return unavailable();
          const before = await sessions.authorize(now());
          if (
            String(before.brandReference) !== brand ||
            String(before.storeReference) !== store ||
            before.channel !== "Pickup" ||
            before.diningState !== "ContextOnly" ||
            before.diningSessionReference !== null ||
            before.diningParticipantReference !== null
          )
            return denied();
          const found = await options.binding.current(before, now());
          if (found === null) throw new CartError("CART_UNAVAILABLE");
          const bound = parseCartAggregate(found);
          const current = await sessions.authorize(now());
          const checkedAt = now();
          try {
            assertGuestSessionUsable(current, checkedAt);
          } catch {
            return denied();
          }
          if (!sameSession(before, current)) return denied();
          if (
            bound.cartReference !== cartReference ||
            bound.brandReference !== brand ||
            bound.storeReference !== store ||
            bound.orderType !== "Pickup" ||
            bound.createdByActorReference !== String(current.sessionReference) ||
            bound.diningSessionReference !== null ||
            !["Qr", "Web"].includes(bound.sourceChannel)
          )
            throw new CartError("CART_UNAVAILABLE");
          if (bound.updatedAt > checkedAt) return unavailable();
          return current;
        }
        return await createConfiguredCartQuoteService({
          repository: options.repository,
          pricing: options.pricing,
          catalog: options.catalog,
          pricingChannelCode: options.pricingChannelCode,
          references: options.references,
          now,
          authorization: {
            async authorize(input) {
              const guestSession = await currentGuest();
              return {
                guestSession,
                audit: options.audit({
                  action: "AttachQuote",
                  brandReference: brand,
                  storeReference: store,
                  sessionReference: parseOrderingReference(guestSession.sessionReference),
                  cartReference,
                  operationReference,
                  observedAt: input.observedAt,
                }),
              };
            },
          },
        }).attach({
          cartReference,
          operationReference,
          expectedCartVersion: raw.expectedCartVersion,
          requestedAt,
        });
      } catch (error) {
        if (error instanceof CartError) throw error;
        return unavailable();
      }
    },
  });
}
