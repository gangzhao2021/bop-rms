import { createPostgresWorkflowDefinitionStore, parseWorkflowActionRequest } from "@bop/workflow";
import {
  parseSubmissionInventoryFinalValidation,
  type InventoryItemTransaction,
} from "@rms/inventory";
import { parseOrderingReference } from "@rms/ordering";
import {
  createCustomerSubmissionFinalInventoryRecipeSource,
  CustomerInventorySourceError,
} from "./customer-submission-inventory-source.js";

type WorkflowStore = ReturnType<typeof createPostgresWorkflowDefinitionStore>;
export type CustomerInventoryWorkflowGates = Parameters<
  WorkflowStore["evaluatePublishedAction"]
>[1];
function fail(): never {
  throw new CustomerInventorySourceError();
}

/**
 * Current publication is checked by Workflow/Publishing, not by a supplied boolean.
 * Gates must authorize the actual customer Cart/actor, not substitute workforce Membership.
 * The explicit command binding is technical configuration; no Store timing default is supplied.
 */
export function createCustomerSubmissionInventoryWorkflowSource(
  transaction: InventoryItemTransaction,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{ reserveCommandCode: string; gates: CustomerInventoryWorkflowGates }>,
) {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(scopeInput.tenantReference)),
    brandReference: String(parseOrderingReference(scopeInput.brandReference)),
    storeReference: String(parseOrderingReference(scopeInput.storeReference)),
  });
  const command = options.reserveCommandCode;
  if (typeof command !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(command))
    return fail();
  const workflow = createPostgresWorkflowDefinitionStore(
    { run: async (work) => work(transaction) },
    scope,
  );
  return Object.freeze({
    async resolve(recordValue: unknown, requestValue: unknown) {
      try {
        const record = parseSubmissionInventoryFinalValidation(recordValue);
        const request = parseWorkflowActionRequest(requestValue);
        for (const field of ["tenantReference", "brandReference", "storeReference"] as const) {
          if (record[field] !== scope[field] || request[field] !== scope[field]) return fail();
        }
        if (
          request.actorReference !== record.actorReference ||
          request.resourceReference !== record.cartReference ||
          request.resourceVersion !== record.cartVersion ||
          request.expectedVersionReference !== record.workflowVersionReference ||
          String(request.observedAt) !== String(record.observedAt)
        )
          return fail();
        const resolved = await workflow.evaluatePublishedAction(request, options.gates);
        if (
          resolved.definition.workflowReference !== record.workflowReference ||
          resolved.definition.versionReference !== record.workflowVersionReference ||
          resolved.definition.versionNumber !== record.workflowVersion ||
          resolved.transition.transitionReference !== record.transitionReference
        )
          return fail();
        const reserves = (transition: typeof resolved.transition) =>
          transition.effects.some(
            (effect) => effect.ownerModule === "inventory" && effect.commandCode === command,
          );
        const reserveNow = reserves(resolved.transition);
        // Reachability only locates an explicitly recorded outstanding action; it never authorizes it.
        const reachable = new Set<string>([resolved.transition.nextState]);
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const transition of resolved.definition.transitions) {
            if (reachable.has(transition.currentState) && !reachable.has(transition.nextState)) {
              reachable.add(transition.nextState);
              expanded = true;
            }
          }
        }
        for (const item of record.items) {
          if (item.disposition === "Reserved" && !reserveNow) return fail();
          if (
            item.disposition === "Deferred" &&
            (reserveNow ||
              !resolved.definition.transitions.some(
                (transition) =>
                  transition.action === item.deferredActionCode &&
                  reachable.has(transition.currentState) &&
                  reserves(transition),
              ))
          )
            return fail();
        }
        return record;
      } catch {
        return fail();
      }
    },
  });
}

/**
 * Same-transaction source for the final Inventory writer: actual published Workflow followed by
 * actual Recipe contributions. Inventory independently verifies current Item facts and quantities.
 * Caller retains all transaction locks and supplies the real locked Cart/lines and current request.
 */
export function createCustomerSubmissionFinalInventorySource(
  transaction: InventoryItemTransaction,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{
    reserveCommandCode: string;
    gates: CustomerInventoryWorkflowGates;
    actionRequest: unknown;
    ordering: Readonly<{ cart: unknown; lines: readonly unknown[] }>;
  }>,
) {
  const request = parseWorkflowActionRequest(options.actionRequest);
  const workflow = createCustomerSubmissionInventoryWorkflowSource(transaction, scope, options);
  const recipe = createCustomerSubmissionFinalInventoryRecipeSource(
    transaction,
    scope,
    options.ordering,
  );
  return Object.freeze({
    async resolve(proposal: unknown) {
      const checked = await workflow.resolve(proposal, request);
      return recipe.resolve(checked);
    },
  });
}
