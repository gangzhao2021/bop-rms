import { CartError } from "@rms/ordering";
import {
  GuestSessionService,
  createPostgresFencedGuestSessionEntryStore,
  parseGuestRawCredential,
  assertGuestSessionUsable,
  parseCanonicalInstant,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  createPostgresDiningHostParticipationFence,
  parseDiningReference,
  parseDiningInstant,
} from "@rms/dining";
import type { DiningCartReplacementOptions, CartQueryTransaction } from "@rms/ordering";

/** Guest -> Dining -> Cart lock order. Current binding must be supplied through
 * owner ports on this same transaction. No client references establish authority.
 */
export function createDiningCartReplacementAuthorization(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: CartQueryTransaction): GuestSessionServiceOptions["binding"];
  now(): string;
}): DiningCartReplacementOptions["authorizeAndFence"] {
  const scope = Object.freeze({
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  });
  const sessionCredential = parseGuestRawCredential(options.sessionCredential),
    csrfCredential = parseGuestRawCredential(options.csrfCredential);
  const { credentials, binding, now } = options;
  return async (transaction, command) => {
    try {
      if (
        command.brandReference !== scope.brandReference ||
        command.storeReference !== scope.storeReference
      )
        return false;
      const started = parseCanonicalInstant(now());
      if (command.observedAt > started) return false;
      const runner = {
        run: <T>(work: (tx: CartQueryTransaction) => Promise<T>) => work(transaction),
      };
      const currentBinding = binding(transaction);
      const identity = new GuestSessionService({
        credentials,
        binding: currentBinding,
        store: createPostgresFencedGuestSessionEntryStore(runner, {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        }),
        admission: { consume: async () => null },
        now,
      });
      const session = await identity.authorize({
        sessionCredential,
        csrfCredential,
        observedAt: started,
      });
      if (
        String(session.sessionReference) !== command.guestSessionReference ||
        String(session.brandReference) !== command.brandReference ||
        String(session.storeReference) !== command.storeReference ||
        session.channel !== "DineIn" ||
        session.diningState !== "DiningBound" ||
        String(session.diningSessionReference) !== command.diningSessionReference ||
        String(session.diningParticipantReference) !== command.participantReference
      )
        return false;
      const observedAt = parseDiningInstant(now());
      if (String(observedAt) < String(started)) return false;
      const host = await createPostgresDiningHostParticipationFence(runner, scope).readCurrent({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningSessionReference: parseDiningReference(command.diningSessionReference),
        participantReference: parseDiningReference(command.participantReference),
        observedAt,
      });
      if (host === null) throw new CartError("CART_REPLACEMENT_FORBIDDEN");
      const finished = parseCanonicalInstant(now());
      if (String(finished) < String(observedAt)) return false;
      assertGuestSessionUsable(session, finished);
      if ((await currentBinding.validate(session, finished)) !== "Current") return false;
      const checked = parseCanonicalInstant(now());
      if (checked < finished) return false;
      assertGuestSessionUsable(session, checked);
      return true;
    } catch (error) {
      if (error instanceof CartError && error.code === "CART_REPLACEMENT_FORBIDDEN") throw error;
      return false;
    }
  };
}
