import { Buffer } from "node:buffer";
import { createInternalDiningBinding } from "./pilot-dining-binding.mjs";
import { createInternalDiningJoinRequestContext } from "./pilot-dining-join.mjs";
import { createCustomerDiningSessionBinding } from "../../apps/api/dist/customer-dining-binding-composition.js";
import { createPostgresDiningGuestBindingStore } from "../../packages/rms/dining/src/index.ts";
export async function createInternalCustomerEntry(
  resources,
  {
    createInternalPickupEntry,
    createInternalDiningEntries,
    createInternalDiningSession,
    createInternalMerchantSession,
  },
) {
  const pickup = await createInternalPickupEntry(resources),
    dining = await createInternalDiningEntries(resources);
  const owner = await createInternalDiningSession(
    resources,
    await createInternalMerchantSession(resources),
  );
  const bound = createInternalDiningBinding(resources, dining, owner);
  const compose = (runner) => {
    const p = pickup.binding(runner),
      d = dining.binding(runner, { oneTransaction: true });
    return createCustomerDiningSessionBinding({
      scope: resources.scope,
      binding: {
        validate: (session, at) =>
          session.channel === "Pickup" ? p.validate(session, at) : d.validate(session, at),
      },
      repository: createPostgresDiningGuestBindingStore(runner, owner.scope),
      contexts: d,
      now: resources.now,
    });
  };
  /**
   * WP-2423 item 4: every read of one Guest Session binding check (the table code issue, the
   * QR/table context for each purpose, the Dining participation) runs in one transaction instead
   * of one each (five for a seated guest). The same owner reads and checks run in the same order;
   * they now see one consistent set of facts. Any failure still answers "Unavailable".
   */
  const binding = (runner) =>
    Object.freeze({
      async validate(session, at) {
        try {
          return await runner.run((tx) =>
            compose({ run: (work) => work(tx) }).validate(session, at),
          );
        } catch {
          return "Unavailable";
        }
      },
    });
  const session = {
    credentials: resources.credentials.sessions,
    binding: binding(resources.transactions),
  };
  const persistent = {
    ...pickup.entry.persistent,
    sources: async (tx, input) => {
      // A hint selects a verifier, never authority. The selected owner verifies the complete signed QR.
      if (typeof input.qrToken !== "string" || input.qrToken.length > 4096)
        throw new Error("ENTRY_UNAVAILABLE");
      const parts = input.qrToken.split(".");
      if (parts.length !== 3) throw new Error("ENTRY_UNAVAILABLE");
      const hint = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const selected =
        hint?.channel === "Pickup" ? pickup : hint?.channel === "DineIn" ? dining : null;
      if (!selected) throw new Error("ENTRY_UNAVAILABLE");
      return selected.entry.persistent.sources(tx, input);
    },
  };
  const bindingOptions = { ...bound.options };
  delete bindingOptions.scope;
  delete bindingOptions.session;
  delete bindingOptions.now;
  return {
    entry: { session, persistent },
    binding,
    pickup,
    dining,
    diningOwner: owner,
    diningAdmission: {
      join: {
        dining: { store: owner.stores.join, credentials: owner.credentials, pepperVersion: 1 },
        contexts: dining.binding(resources.transactions),
      },
      binding: bindingOptions,
      resolveRequestContext: async () => createInternalDiningJoinRequestContext(resources, owner),
    },
    // WP-2423 DEC-DINING-GUEST-INVITATION: the table's Host issues the next one-time table code
    // with the same Dining credentials, pepper and owner scope as staff issuance and Join.
    diningInvitation: {
      tenantReference: owner.scope.tenantReference,
      transactions: resources.transactions,
      binding: (tx) => binding({ run: (work) => work(tx) }),
      dining: { credentials: owner.credentials, pepperVersion: 1 },
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
      newReference: resources.credentials.reference,
    },
  };
}
