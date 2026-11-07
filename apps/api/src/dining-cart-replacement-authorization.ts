import { CartError, createPostgresCartQueryStore } from "@rms/ordering";
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
  createPostgresDiningParticipantFence,
  parseDiningReference,
  parseDiningInstant,
} from "@rms/dining";
import type { DiningCartReplacementOptions, CartQueryTransaction } from "@rms/ordering";

/** Guest -> Dining -> Cart lock order. Current binding must be supplied through
 * owner ports on this same transaction. No client references establish authority.
 * WP-2423 (coordinator decision 2026-10-11): any current active participant may replace a table
 * Cart whose expiry is recorded (Expired); an Abandoned Cart stays Host-only. The previous Cart's
 * lifecycle is read without a lock (terminal states never change) before the Dining fence.
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
      if (!(await fenceDiningCartReplacement(runner, scope, command, observedAt))) return false;
      const finished = parseCanonicalInstant(now());
      if (String(finished) < String(observedAt)) return false;
      assertGuestSessionUsable(session, finished);
      if ((await currentBinding.validate(session, finished)) !== "Current") return false;
      const checked = parseCanonicalInstant(now());
      if (checked < finished) return false;
      assertGuestSessionUsable(session, checked);
      return true;
    } catch (error) {
      if (
        error instanceof CartError &&
        (error.code === "CART_REPLACEMENT_FORBIDDEN" || error.code === "CART_LIFECYCLE_UNAVAILABLE")
      )
        throw error;
      return false;
    }
  };
}

/**
 * The Dining/Cart half of replacement authority (after current Guest identity is proven), on the
 * caller's write transaction: the previous Cart must belong to this Session; Expired (recorded)
 * needs a current active participant, Abandoned the current Host; anything else is not yet
 * replaceable (CART_LIFECYCLE_UNAVAILABLE). Refusal is CART_REPLACEMENT_FORBIDDEN.
 */
export async function fenceDiningCartReplacement(
  runner: { run<T>(work: (tx: CartQueryTransaction) => Promise<T>): Promise<T> },
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  command: {
    readonly diningSessionReference: string;
    readonly participantReference: string;
    readonly previousCartReference: string;
  },
  observedAt: string,
): Promise<boolean> {
  const previous = await createPostgresCartQueryStore(runner, {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  }).load(command.previousCartReference);
  if (previous === null || previous.diningSessionReference !== command.diningSessionReference)
    return false;
  const status = previous.lifecycle?.status ?? null;
  // An expiry not yet recorded by its owner command is not replaceable yet; callers retry.
  if (status !== "Expired" && status !== "Abandoned")
    throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
  const fence =
    status === "Expired"
      ? createPostgresDiningParticipantFence
      : createPostgresDiningHostParticipationFence;
  const current = await fence(runner, {
    tenantReference: parseDiningReference(scope.tenantReference),
    brandReference: parseDiningReference(scope.brandReference),
    storeReference: parseDiningReference(scope.storeReference),
  }).readCurrent({
    brandReference: parseDiningReference(scope.brandReference),
    storeReference: parseDiningReference(scope.storeReference),
    diningSessionReference: parseDiningReference(command.diningSessionReference),
    participantReference: parseDiningReference(command.participantReference),
    observedAt: parseDiningInstant(observedAt),
  });
  if (current === null) throw new CartError("CART_REPLACEMENT_FORBIDDEN");
  return true;
}
