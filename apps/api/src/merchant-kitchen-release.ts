import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresKdsOperatorShiftStore, KitchenQueueProjectionError } from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const denied = (): never => {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
};

/** IDR-0039 handover: the current named KDS Operator releases the board before signing out.
 * Kitchen records the Release fact; the next operator's Start derives the handover. */
export function createMerchantKitchenRelease(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown }): Promise<void> => {
    const session = await options.authentication.authorize(input);
    if (session.policy.code !== "NamedKdsOperator") denied();
    await options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        "kitchen.operate",
        session.sessionReference,
      );
      if (!(await scope.allowed())) denied();
      const releasedAt = options.persistence.now();
      const validUntil =
        Date.parse(session.idleExpiresAt) < Date.parse(session.absoluteExpiresAt)
          ? session.idleExpiresAt
          : session.absoluteExpiresAt;
      const shifts = createPostgresKdsOperatorShiftStore({
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        references: options.references,
      });
      await shifts.release({
        transaction: transaction as unknown as ConsumerTransaction,
        session: {
          sessionReference: session.sessionReference,
          actorReference: scope.actorReference,
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.store.storeReference,
          sessionVersion: session.version,
          sessionKind: "NamedKdsOperator",
          state: "Active",
          observedAt: releasedAt,
          validUntil,
          // Kitchen re-parses every reference and instant at runtime before writing.
        } as unknown as Parameters<typeof shifts.release>[0]["session"],
        releasedAt,
      });
    });
  };
}
