/**
 * The cancellation of an unpaid dine-in round: after a failed payment on a round the kitchen never
 * accepted or started, the round is cancelled and the Order phase is recomputed from the rounds that
 * remain. The six pairs describe the Order after removing that round; none cancels accepted work.
 */
const unpaidRoundPairs = Object.freeze([
  ["Submitted", "Submitted"],
  ["Submitted", "Cancelled"],
  ["Accepted", "Accepted"],
  ["InProgress", "InProgress"],
  ["InProgress", "Ready"],
  ["InProgress", "Fulfilled"],
]);
/**
 * DEC-PILOT-INSTALLATION: the order fulfilment rules referenced by the order Workflows. A rule
 * reference names rule semantics evaluated by the owning composition (never stored rows), so it is
 * a fixed repository constant shared by every installation and every release of these Workflows.
 */
export const orderWorkflowRules = Object.freeze({
  /** SubmitOrder: the submission's inventory is reserved by the transition's effect. */
  submissionInventory: "01a1f6c0-0000-7000-8000-0000000000a1",
  /** CreatePaymentIntent / ReleasePaidOrder: the order's stock reservations are intact. */
  intactReservation: "01a1f6c0-0000-7000-8000-0000000000a2",
});
const transition = (currentState, action, nextState, permissionCode, rules = [], effects = []) =>
  Object.freeze({
    currentState,
    action,
    nextState,
    permissionCode,
    ruleReferences: Object.freeze(rules),
    effects: Object.freeze(effects.map((effect) => Object.freeze(effect))),
  });
const payment = (phase) =>
  transition(
    phase,
    "CreatePaymentIntent",
    phase,
    "payment.intent.create",
    [orderWorkflowRules.intactReservation],
    [{ ownerModule: "payment", commandCode: "CreatePaymentIntent" }],
  );
/**
 * The order lifecycle the pilot runtime drives (customer submission and payment, acceptance, paid
 * release, Pickup fulfilment). Action and permission strings are the ones the owning compositions
 * check (`order.accept`, `order.release`, `order.fulfill`, `CreatePaymentIntent`); a later round
 * may pay while earlier items progress (Accepted/InProgress/Ready keep their phase).
 */
const orderTransitions = Object.freeze([
  transition(
    "CartReady",
    "SubmitOrder",
    "Submitted",
    "order.submit",
    [orderWorkflowRules.submissionInventory],
    [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
  ),
  payment("Submitted"),
  ...["Accepted", "InProgress", "Ready"].map(payment),
  transition("Submitted", "Accept", "Accepted", "order.accept"),
  ...["Accepted", "InProgress", "Ready"].map((phase) =>
    transition(phase, "Accept", "Accepted", "order.accept"),
  ),
  transition("Accepted", "ReleasePaidOrder", "Accepted", "order.release", [
    orderWorkflowRules.intactReservation,
  ]),
  transition("Accepted", "FulfillOrder", "Fulfilled", "order.fulfill"),
]);
/**
 * Releases of the repository Platform Workflows, by release name (`--workflow`). Pickup and DineIn
 * share the purpose `OrderFulfillment` (one Brand-wide family per purpose and order type); a paid
 * additional dine-in round is released by its own family, whose release keeps the phase the table
 * order already reached (InProgress/Ready stay as they are). `binding` names the runtime file
 * (`internal-test-workflow-<binding>.json`) an order release writes.
 */
export const platformWorkflows = Object.freeze({
  UnpaidDineInBatchCancellation: Object.freeze({
    purposeCode: "UnpaidDineInBatchCancellation",
    applicabilityCode: "DineIn",
    transitions: Object.freeze(
      unpaidRoundPairs.map(([currentState, nextState]) =>
        Object.freeze({
          currentState,
          action: "CancelUnpaidBatchTo" + nextState,
          nextState,
          permissionCode: "order.batch.cancel.expired",
          ruleReferences: Object.freeze([]),
          effects: Object.freeze([]),
        }),
      ),
    ),
  }),
  OrderFulfillmentPickup: Object.freeze({
    purposeCode: "OrderFulfillment",
    applicabilityCode: "Pickup",
    binding: "Pickup",
    transitions: orderTransitions,
  }),
  OrderFulfillmentDineIn: Object.freeze({
    purposeCode: "OrderFulfillment",
    applicabilityCode: "DineIn",
    binding: "DineIn",
    transitions: orderTransitions,
  }),
  OrderFulfillmentAdditionalRound: Object.freeze({
    purposeCode: "OrderFulfillmentAdditionalRound",
    applicabilityCode: "DineIn",
    binding: "AdditionalRelease",
    transitions: Object.freeze([
      ...orderTransitions,
      ...["InProgress", "Ready"].map((phase) =>
        transition(phase, "ReleasePaidOrder", phase, "order.release", [
          orderWorkflowRules.intactReservation,
        ]),
      ),
    ]),
  }),
});
/** The order Workflow releases (each writes its runtime binding file). */
export const orderWorkflowReleases = Object.freeze(
  Object.entries(platformWorkflows)
    .filter(([, workflow]) => workflow.binding !== undefined)
    .map(([name]) => name),
);

const transitionContent = (transitions) =>
  JSON.stringify(
    transitions.map(
      ({ currentState, action, nextState, permissionCode, ruleReferences, effects }) => ({
        currentState,
        action,
        nextState,
        permissionCode,
        ruleReferences,
        effects,
      }),
    ),
  );

/** True only for an unchanged, Brand-wide, non-expiring version of a repository Platform Workflow. */
export function matchesPlatformWorkflow(definition) {
  const expected =
    Object.values(platformWorkflows).find(
      (workflow) =>
        workflow.purposeCode === definition?.purposeCode &&
        workflow.applicabilityCode === definition?.applicabilityCode,
    ) ?? null;
  return (
    expected !== null &&
    definition.storeReference === null &&
    definition.effectiveUntil === null &&
    Array.isArray(definition.transitions) &&
    transitionContent(definition.transitions) === transitionContent(expected.transitions)
  );
}
