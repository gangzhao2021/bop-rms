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
  const binding = (runner) => {
    const p = pickup.binding(runner),
      d = dining.binding(runner);
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
  };
}
