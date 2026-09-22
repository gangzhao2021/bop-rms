import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionService,
  createPostgresFencedGuestSessionEntryStore,
  parseGuestRawCredential,
  readClosedRecord,
  parseCanonicalInstant,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  CartError,
  parseOrderingReference,
  createPostgresDiningCartReplacementStore,
  type DiningCartReplacementOptions,
} from "@rms/ordering";
import { createDiningCartReplacementAuthorization } from "./dining-cart-replacement-authorization.js";
import { createDiningCartReplacementSettlement } from "./dining-cart-replacement-settlement.js";
export interface CustomerDiningCartReplacementOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: ConsumerTransaction): GuestSessionServiceOptions["binding"];
  readonly policy: DiningCartReplacementOptions["policy"];
  readonly payment: {
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  readonly audit: DiningCartReplacementOptions["audit"];
  generateReference(): string;
  now(): string;
}
/** Authenticated composition for a persisted terminal Cart. The transport must
 * enforce same-origin/CSRF admission and return only its approved response DTO.
 * Never implicitly expires, copies items or releases a live Dining table.
 */
export function createCustomerDiningCartReplacement(options: CustomerDiningCartReplacementOptions) {
  const scope = Object.freeze({ ...options.scope }),
    policy = Object.freeze({ ...options.policy }),
    payment = Object.freeze({ ...options.payment });
  const { transactions, credentials, binding, audit, generateReference, now } = options;
  return Object.freeze({
    async replace(value: unknown) {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        operationReference: string;
        previousCartReference: string;
        expectedCartVersion: number;
      };
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "operationReference",
          "previousCartReference",
          "expectedCartVersion",
        ]);
        if (
          typeof raw.expectedCartVersion !== "number" ||
          !Number.isSafeInteger(raw.expectedCartVersion) ||
          raw.expectedCartVersion < 1 ||
          raw.expectedCartVersion > 2147483647
        )
          throw new Error("version");
        input = Object.freeze({
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          operationReference: parseOrderingReference(raw.operationReference),
          previousCartReference: parseOrderingReference(raw.previousCartReference),
          expectedCartVersion: raw.expectedCartVersion,
        });
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      try {
        return await transactions.run(async (transaction) => {
          const observedAt = parseCanonicalInstant(now());
          const runner = {
            run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
          };
          const ownerScope = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          };
          const identity = new GuestSessionService({
            credentials,
            binding: binding(transaction),
            store: createPostgresFencedGuestSessionEntryStore(runner, ownerScope),
            admission: { consume: async () => null },
            now,
          });
          const session = await identity.authorize({
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            observedAt,
          });
          if (
            String(session.brandReference) !== scope.brandReference ||
            String(session.storeReference) !== scope.storeReference ||
            session.channel !== "DineIn" ||
            session.diningState !== "DiningBound" ||
            session.diningSessionReference === null ||
            session.diningParticipantReference === null
          )
            throw new CartError("CART_PERMISSION_DENIED");
          const command = Object.freeze({
            ...ownerScope,
            operationReference: input.operationReference,
            previousCartReference: input.previousCartReference,
            expectedCartVersion: input.expectedCartVersion,
            guestSessionReference: String(session.sessionReference),
            diningSessionReference: String(session.diningSessionReference),
            participantReference: String(session.diningParticipantReference),
            observedAt,
          });
          const authorize = createDiningCartReplacementAuthorization({
            scope,
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            credentials,
            binding: () => binding(transaction),
            now,
          });
          const settlement = createDiningCartReplacementSettlement({
            scope: { ...ownerScope, ...payment },
            now,
            authorize: (tx) =>
              tx === transaction ? authorize(tx, command) : Promise.resolve(false),
          });
          const writer = createPostgresDiningCartReplacementStore(runner, {
            scope: ownerScope,
            policy,
            generateReference,
            now,
            audit,
            authorizeAndFence: (tx, candidate) =>
              tx === transaction ? authorize(tx, candidate) : Promise.resolve(false),
            settlementClear: (tx, cart, at) =>
              tx === transaction ? settlement.clear(transaction, cart, at) : Promise.resolve(false),
          });
          return writer.replace(command);
        });
      } catch (error) {
        if (
          error instanceof CartError &&
          [
            "CART_PERMISSION_DENIED",
            "CART_VERSION_CONFLICT",
            "CART_REPLACEMENT_FORBIDDEN",
            "CART_IDEMPOTENCY_CONFLICT",
            "CART_LIFECYCLE_UNAVAILABLE",
            "CART_EXPIRED",
          ].includes(error.code)
        )
          throw error;
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
