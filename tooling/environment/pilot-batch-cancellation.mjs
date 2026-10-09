import { createDiningBatchCancellationInventory } from "../../apps/api/dist/dining-batch-cancellation-inventory.js";
import { createPostgresWorkflowDefinitionStore } from "../../packages/bop/workflow/src/index.ts";
import {
  parseOrderBatchCheckoutExpiry,
  summarizeOrderItemProgress,
} from "../../packages/rms/ordering/src/index.ts";
import { createDiningBatchCancellation } from "../../apps/api/dist/dining-batch-cancellation.js";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
const unavailable = () => {
  throw new Error("INTERNAL_BATCH_CANCELLATION_UNAVAILABLE");
};
/** Trusted local System composition; source facts must be read by246 under retained fences. */
export async function createInternalBatchCancellation(
  resources,
  { loadWorkflow, expectedDatabaseName, systemActorReference },
) {
  const saved = await loadWorkflow(),
    scope = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    };
  const sameScope = (value) => Object.keys(scope).every((k) => value[k] === scope[k]);
  if (
    !isPilotRuntime() ||
    !matchesPilotEnvironment(saved.environment) ||
    saved.database !== expectedDatabaseName ||
    !sameScope(saved.scope) ||
    saved.definition.purposeCode !== "InternalTestBatchCancellation"
  )
    return unavailable();
  const active = () =>
    isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil;
  const principal = systemActorReference,
    purposeCode = saved.definition.purposeCode;
  async function loadPublished(tx, at) {
    if (!active() || at > resources.now()) return unavailable();
    const owner = createPostgresWorkflowDefinitionStore({ run: (work) => work(tx) }, scope);
    const current = await owner.resolveCurrent({
      purposeCode,
      applicabilityCode: "DineIn",
      observedAt: at,
    });
    const definition = current.definition;
    if (
      definition.lifecycle !== "Published" ||
      definition.workflowReference !== saved.definition.workflowReference ||
      definition.storeReference !== null ||
      JSON.stringify(definition.transitions) !== JSON.stringify(saved.definition.transitions)
    )
      return unavailable();
    await owner.validatePublication(definition.versionReference, at);
    if (!active()) return unavailable();
    return definition;
  }
  const inventory = createDiningBatchCancellationInventory({
    scope,
    systemActorReference: principal,
    now: resources.now,
    authorize: async (tx, record) => {
      if (!active() || !sameScope(record)) return false;
      const definition = await loadPublished(tx, resources.now());
      return (
        definition.versionReference === record.workflowVersionReference &&
        definition.transitions.some(
          (transition) => transition.transitionReference === record.transitionReference,
        ) &&
        active()
      );
    },
  });
  const service = createDiningBatchCancellation({
    inventory,
    scope,
    now: resources.now,
    transactions: resources.transactions,
    newReference: resources.credentials.reference,
    authorize: async (_tx, value) => active() && (!value.tenantReference || sameScope(value)),
    authorizeKitchen: async () => active(),
    authorizeDining: async () => active(),
    resolvePolicy: async (tx, evidence) => {
      const expiry = parseOrderBatchCheckoutExpiry(evidence.expiry);
      if (
        !active() ||
        !sameScope(expiry) ||
        expiry.status !== "PaymentFailed" ||
        !evidence.progress.kitchenEvidenceComplete
      )
        return unavailable();
      const target = evidence.items.filter(
        (item) => item.orderBatchReference === expiry.orderBatchReference,
      );
      if (
        !target.length ||
        target.some((item) => item.phase !== "Submitted" || item.everAccepted || item.everStarted)
      )
        return unavailable();
      const before = summarizeOrderItemProgress(evidence.items),
        after = summarizeOrderItemProgress(
          evidence.items.map((item) =>
            item.orderBatchReference === expiry.orderBatchReference
              ? { ...item, phase: "Cancelled" }
              : item,
          ),
        );
      if (before.phase !== evidence.progress.phase) return unavailable();
      const definition = await loadPublished(tx, evidence.observedAt),
        action = "CancelUnpaidBatchTo" + after.phase;
      const transitions = definition.transitions.filter(
        (t) =>
          t.currentState === before.phase &&
          t.action === action &&
          t.nextState === after.phase &&
          t.permissionCode === "order.batch.cancel.expired" &&
          t.effects.length === 0 &&
          t.ruleReferences.length === 0,
      );
      if (transitions.length !== 1) return unavailable();
      const transition = transitions[0];
      const matches = (transaction, request) =>
        transaction === tx &&
        active() &&
        sameScope(request) &&
        request.actorReference === principal &&
        request.resourceReference === expiry.orderReference &&
        request.resourceVersion === evidence.orderVersion &&
        request.observedAt === evidence.observedAt &&
        request.currentState === before.phase &&
        request.action === action &&
        request.purposeCode === purposeCode &&
        request.applicabilityCode === "DineIn" &&
        request.expectedVersionReference === definition.versionReference;
      return {
        systemActorReference: principal,
        workflowVersionReference: definition.versionReference,
        transitionReference: transition.transitionReference,
        policy: { action, purposeCode, permissionCode: transition.permissionCode },
        gates: {
          authorizeResource: async (transaction, request) => matches(transaction, request),
          authorizeAction: async (transaction, input) =>
            matches(transaction, input.request) &&
            input.definition.versionReference === definition.versionReference &&
            input.transition.transitionReference === transition.transitionReference,
          authorizeOverride: async () => false,
          evaluateRule: async () => false,
        },
      };
    },
  });
  return Object.freeze({ cancel: service.cancel, loadPublished });
}
