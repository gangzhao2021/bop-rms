import { createPostgresWorkflowDefinitionStore } from "@bop/workflow";
import {
  parseInventoryInstant,
  parseInventoryReference,
  parseSubmissionInventoryFinalValidation,
  type InventoryItemTransaction,
} from "@rms/inventory";
import { CustomerInventorySourceError } from "./customer-submission-inventory-source.js";

type CurrentWorkflow = Awaited<
  ReturnType<ReturnType<typeof createPostgresWorkflowDefinitionStore>["resolveCurrent"]>
>;

/** Current configuration provenance only; does not execute a transition or grant Payment permission. */
export function createCustomerPaymentInventoryWorkflowSource(
  transaction: InventoryItemTransaction,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{
    purposeCode: string;
    applicabilityCode: string;
    authorizeOverride: (
      transaction: InventoryItemTransaction,
      current: CurrentWorkflow,
    ) => Promise<boolean>;
  }>,
) {
  const scope = Object.freeze({
    tenantReference: parseInventoryReference(scopeInput.tenantReference),
    brandReference: parseInventoryReference(scopeInput.brandReference),
    storeReference: parseInventoryReference(scopeInput.storeReference),
  });
  const { purposeCode, applicabilityCode, authorizeOverride } = options;
  const workflow = createPostgresWorkflowDefinitionStore(
    { run: async (work) => work(transaction) },
    scope,
  );
  return Object.freeze({
    async resolve(recordValue: unknown, observedAtValue: unknown) {
      try {
        const record = parseSubmissionInventoryFinalValidation(recordValue);
        const observedAt = parseInventoryInstant(observedAtValue);
        if (record.observedAt > observedAt) throw new CustomerInventorySourceError();
        for (const field of ["tenantReference", "brandReference", "storeReference"] as const) {
          if (record[field] !== scope[field]) throw new CustomerInventorySourceError();
        }
        const current = await workflow.resolveCurrent({
          purposeCode,
          applicabilityCode,
          observedAt,
        });
        const { definition, brandDefinition } = current;
        const transition = definition.transitions.find(
          (candidate) => candidate.transitionReference === record.transitionReference,
        );
        if (
          definition.workflowReference !== record.workflowReference ||
          definition.versionReference !== record.workflowVersionReference ||
          definition.versionNumber !== record.workflowVersion ||
          !transition
        )
          throw new CustomerInventorySourceError();
        await workflow.validatePublication(brandDefinition.versionReference, observedAt);
        if (definition.versionReference !== brandDefinition.versionReference) {
          await workflow.validatePublication(definition.versionReference, observedAt);
          if ((await authorizeOverride(transaction, current)) !== true)
            throw new CustomerInventorySourceError();
        }
        return Object.freeze({ definition, transition, observedAt });
      } catch {
        throw new CustomerInventorySourceError();
      }
    },
  });
}
