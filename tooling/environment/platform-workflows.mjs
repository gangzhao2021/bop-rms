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
export const platformWorkflows = Object.freeze({
  UnpaidDineInBatchCancellation: Object.freeze({
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
});

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
  const expected = Object.hasOwn(platformWorkflows, definition?.purposeCode)
    ? platformWorkflows[definition.purposeCode]
    : null;
  return (
    expected !== null &&
    definition.applicabilityCode === expected.applicabilityCode &&
    definition.storeReference === null &&
    definition.effectiveUntil === null &&
    Array.isArray(definition.transitions) &&
    transitionContent(definition.transitions) === transitionContent(expected.transitions)
  );
}
