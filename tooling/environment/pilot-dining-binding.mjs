import {
  createCustomerDiningBindingComposition,
  createCustomerDiningSessionBinding,
} from "../../apps/api/dist/customer-dining-binding-composition.js";
import {
  createPostgresGuestSessionEntryStore,
  createPostgresGuestDiningBindingStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createPostgresDiningAdmissionConsumptionStore,
  createPostgresDiningGuestBindingStore,
} from "../../packages/rms/dining/src/index.ts";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
export function createInternalDiningBinding(resources, entry, runtime) {
  const runner = resources.transactions,
    scope = resources.scope,
    credentials = runtime.credentials;
  const contexts = entry.binding(runner);
  const audit = (descriptor, action, targetType, targetId, reasonCode) => ({
    auditId: resources.credentials.reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: action,
    targetType,
    targetId,
    reasonCode,
    correlationId: descriptor.operationReference,
    occurredAt: descriptor.occurredAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const owner = createPostgresDiningGuestBindingStore(runner, runtime.scope);
  const sessionBinding = createCustomerDiningSessionBinding({
    scope,
    binding: contexts,
    repository: owner,
    contexts,
    now: resources.now,
  });
  const bindings = createPostgresGuestDiningBindingStore(
    runner,
    scope,
    {
      append: (tx, descriptor) =>
        appendAuditRecordInTransaction(
          tx,
          audit(
            descriptor,
            "IDENTITY_GUEST_DINING_BINDING_" + descriptor.action.toUpperCase(),
            "GuestDiningBindingPreparation",
            descriptor.operationReference,
            "AUTHORIZED_DINING_BINDING",
          ),
        ),
    },
    resources.credentials.sessions.equals,
  );
  const dining = {
    binding: owner,
    credentials,
    store: createPostgresDiningAdmissionConsumptionStore(
      runner,
      runtime.scope,
      credentials,
      (descriptor) =>
        audit(
          descriptor,
          "DINING_IDENTITY_ADMISSION_CONSUME",
          "DiningIdentityAdmission",
          descriptor.admissionReference,
          "AUTHORIZED_DINING_ADMISSION_CONSUMPTION",
        ),
    ),
  };
  const options = {
    scope,
    session: {
      credentials: resources.credentials.sessions,
      store: createPostgresGuestSessionEntryStore(runner, scope),
      binding: sessionBinding,
    },
    bindings,
    dining,
    contexts,
    recovery: credentials.bindingRecovery,
    preparationLifetimeSeconds: 300,
    now: resources.now,
  };
  return {
    options,
    binding: sessionBinding,
    port: createCustomerDiningBindingComposition(options),
  };
}
