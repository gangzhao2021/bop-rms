import {
  createIdentityActor,
  parseOpaqueUuidV7,
  readClosedRecord,
  type IdentityActor,
} from "@bop/identity";
import {
  createPostgresStoreAssigneeCandidates,
  createPostgresStoreAssigneeEligibility,
} from "@bop/membership";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantReconciliationFollowUpTransactions } from "./merchant-reconciliation-follow-up-transactions.js";
import type { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
type Base = Parameters<typeof createMerchantReconciliationFollowUpCommand>[0];
export function createMerchantReconciliationAssigneeQuery(
  options: Pick<Base, "persistence" | "authentication"> & {
    /** Trusted Identity owner adapter must fence current target facts; labels are approved staff display names, never emails. */
    target?(
      tx: ConsumerTransaction,
      reference: string,
      observedAt: string,
    ): Promise<{ actor: IdentityActor; label: string } | null>;
  },
) {
  const unavailable = (): never => {
    throw Error("RECONCILIATION_ASSIGNEES_UNAVAILABLE");
  };
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["exceptionReference", "afterActorReference"]);
    const exceptionReference = String(
      parseOpaqueUuidV7(raw.exceptionReference, "ACTOR_REFERENCE_INVALID"),
    );
    const afterActorReference =
      raw.afterActorReference === null
        ? null
        : String(parseOpaqueUuidV7(raw.afterActorReference, "ACTOR_REFERENCE_INVALID"));
    const target = options.target;
    if (!target) return unavailable();
    const bridge = await createMerchantReconciliationFollowUpTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      exceptionReference,
      verifyAssignee: async () => false,
    });
    return bridge.transactions.run(async (tx) => {
      const authority = await bridge.resolveAuthority(tx);
      const authorize = async () => {
        if (!(await (await bridge.resolveAuthority(tx)).authorize())) return unavailable();
        return true;
      };
      await authorize();
      const page = await createPostgresStoreAssigneeCandidates({
        authorize: async (t, _context, purpose) =>
          t === tx && purpose === "DiscoverStoreAssignees" && (await authorize()),
      })(tx, { context: authority.context, afterActorReference, limit: 25 });
      const entries = [];
      for (const reference of page.actorReferences) {
        await authorize();
        const profile = await target(tx, reference, String(authority.context.resolvedAt));
        if (profile === null) continue;
        const actor = createIdentityActor(profile.actor);
        if (
          actor.actorReference !== reference ||
          actor.actorType !== "User" ||
          actor.accountKind !== "Workforce" ||
          typeof profile.label !== "string" ||
          !/^([^\p{Cc}\p{Cf}]){1,80}$/u.test(profile.label) ||
          profile.label.trim() !== profile.label ||
          profile.label.includes("@")
        )
          return unavailable();
        const eligible = await createPostgresStoreAssigneeEligibility({
          authorize: async (t, _context, purpose) =>
            t === tx && purpose === "AssignStoreWork" && (await authorize()),
          targetActor: async (t, ref) => {
            if (t !== tx || ref !== reference) return unavailable();
            const fresh = await target(tx, ref, String(authority.context.resolvedAt));
            if (!fresh) return unavailable();
            return fresh.actor;
          },
        })(tx, { context: authority.context, assigneeReference: reference });
        if (eligible)
          entries.push(Object.freeze({ actorReference: reference, label: profile.label }));
      }
      await authorize();
      return Object.freeze({
        items: Object.freeze(entries),
        nextAfterActorReference: page.nextAfterActorReference,
      });
    });
  };
}
