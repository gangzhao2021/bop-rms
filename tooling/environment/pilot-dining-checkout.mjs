import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { CheckoutSessionServiceError } from "../../packages/rms/ordering/src/index.ts";
import { storeTakesOrder } from "../../apps/api/dist/customer-store-open-gate.js";
import { createInternalAdditionalCheckout } from "./pilot-additional-checkout.mjs";
import { createHash } from "node:crypto";
import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createPostgresDiningGuestBindingStore,
  createPostgresDiningCheckoutCommitmentStore,
} from "../../packages/rms/dining/src/index.ts";
import { createCustomerConfiguredDiningSessionValidation } from "../../apps/api/dist/customer-dining-session-validation.js";
export function createInternalDiningCheckout(resources, entry, pickup) {
  const scope = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    },
    now = resources.now;
  const repository = createPostgresDiningCheckoutCommitmentStore(resources.transactions, scope, {
    now,
  });
  const session = {
    credentials: resources.credentials.sessions,
    binding: entry.binding(resources.transactions),
    store: createPostgresGuestSessionEntryStore(resources.transactions, resources.scope),
  };
  const preparation = {
    scope: resources.scope,
    session,
    contexts: entry.dining.binding(resources.transactions),
    now,
    submissions: repository,
    references: { generate: resources.credentials.reference },
    dining: {
      current: createPostgresDiningGuestBindingStore(resources.transactions, scope),
      repository,
      hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
      audit: {
        create: async ({ record, observedAt }) => ({
          auditId: resources.credentials.reference(),
          brandId: resources.scope.brandReference,
          storeId: resources.scope.storeReference,
          actor: { type: "System" },
          actionCode: "DINING_CHECKOUT_PREPARE",
          targetType: "DiningCheckoutCommitment",
          targetId: record.commitmentReference,
          reasonCode: "AUTHORIZED_DINING_CHECKOUT",
          correlationId: record.submissionReference,
          occurredAt: observedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
  };
  const identity = new GuestSessionService({
    ...session,
    admission: { consume: async () => null },
    now,
  });
  const additional = createInternalAdditionalCheckout(resources, entry, preparation);
  // WP-2423 Q4: the Store's current operating status, read fresh for every checkout and payment.
  const operatingNow = () =>
    resources.transactions.run((tx) =>
      createPostgresPublishedStoreOperatingStatusReader(resources.operating)(tx, now()),
    );
  /** Whether the Store takes this guest's order now; throws only when the guest is unknown. */
  const takesOrder = async (input) => {
    const guest = await identity.authorize({
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
    });
    return storeTakesOrder(
      await operatingNow(),
      guest.channel === "Pickup" ? "Pickup" : "SeatedDineIn",
    );
  };
  const options = {
    ...pickup.checkoutSessions,
    validate: async (input) => {
      if (!(await takesOrder(input))) throw new CheckoutSessionServiceError("STORE_CLOSED");
      const guest = await identity.authorize({
        sessionCredential: input.sessionCredential,
        csrfCredential: input.csrfCredential,
      });
      if (guest.channel === "Pickup") return pickup.checkoutSessions.validate(input);
      if (guest.channel !== "DineIn" || guest.diningState !== "DiningBound")
        throw new Error("INTERNAL_CHECKOUT_CHANNEL_UNAVAILABLE");
      const checkout = pickup.checkoutPorts({
        ...input,
        guestSessionReference: input.allocation.guestSessionReference,
        orderType: "DineIn",
      });
      await additional.prepare(input, checkout);
      return createCustomerConfiguredDiningSessionValidation({ preparation, checkout })(input);
    },
  };
  return {
    checkoutSessions: options,
    takesOrder,
    preparation,
    repository,
    identity: (tx) => {
      const bound = { run: (work) => work(tx) };
      return {
        ...preparation,
        session: {
          ...preparation.session,
          binding: entry.binding(bound),
          store: createPostgresGuestSessionEntryStore(bound, resources.scope),
        },
        contexts: entry.dining.binding(bound),
        dining: {
          ...preparation.dining,
          current: createPostgresDiningGuestBindingStore(bound, scope),
          repository: createPostgresDiningCheckoutCommitmentStore(bound, scope, { now }),
        },
      };
    },
  };
}
