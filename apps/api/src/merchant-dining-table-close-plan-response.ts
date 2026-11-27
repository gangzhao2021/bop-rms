/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT (WP-2423, v15 2026-11-06): the close plan reply, field by field.
 * The route never forwards an internal field by accident, and a field added to the plan without
 * being listed here fails the typecheck instead of silently vanishing on the wire (the round's
 * kitchenReceivedAt did, and the Tables panel could not read any open round).
 * Type-only imports: the browser spec builds its mocked reply with this same function.
 */
import type { TableClosePlan, TableCloseRound } from "./merchant-dining-table-close-plan.js";

type Wire<T> = { readonly [K in keyof T]-?: T[K] };

export function tableCloseRoundResponse(round: TableCloseRound): Wire<TableCloseRound> {
  return {
    orderBatchReference: round.orderBatchReference,
    sequence: round.sequence,
    state: round.state,
    openItemCount: round.openItemCount,
    startedItemCount: round.startedItemCount,
    readyItemCount: round.readyItemCount,
    cancellableItemReferences: round.cancellableItemReferences,
    refund: round.refund,
    cancelsAt: round.cancelsAt,
    kitchenReceivedAt: round.kitchenReceivedAt,
  };
}

export function tableClosePlanResponse(plan: TableClosePlan): Wire<TableClosePlan> {
  return {
    orderReference: plan.orderReference,
    diningSessionReference: plan.diningSessionReference,
    orderVersion: plan.orderVersion,
    observedAt: plan.observedAt,
    rounds: plan.rounds.map(tableCloseRoundResponse),
    totals: {
      onlineMinor: plan.totals.onlineMinor,
      cardMachineMinor: plan.totals.cardMachineMinor,
    },
    closeBlockers: plan.closeBlockers,
  };
}
