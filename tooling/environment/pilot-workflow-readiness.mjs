import { createPostgresWorkflowDefinitionStore } from "../../packages/bop/workflow/src/index.ts";

/** The order bindings a Store runs on, and the order type each is resolved for. */
const ORDER_BINDINGS = Object.freeze({
  Pickup: "Pickup",
  DineIn: "DineIn",
  AdditionalRelease: "DineIn",
});

/**
 * WP-2423 item 9: can this Store's orders still move through its Workflows? The resolver fails
 * closed on a money path, and the first sign used to be a guest stuck on "preparing payment", with
 * nothing on any staff screen. The monitor asks the same owner once a minute (read only, api role),
 * so staff hear first. A rule refusing, or a binding naming another version than the one that
 * resolves, is `ready: false` with that rule. A read that could not run throws, so the monitor says
 * it could not check, never a false alarm. A binding that does not load is not asked about: the
 * Store's own start names it.
 */
export async function readInternalWorkflowReadiness(
  resources,
  installation,
  transactions = resources.transactions,
) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    brandReference: resources.scope.brandReference,
    storeReference: resources.scope.storeReference,
  };
  const observedAt = new Date(resources.now()).toISOString();
  const loaded = (read) => read().catch(() => null);
  const checks = [];
  for (const [kind, applicabilityCode] of Object.entries(ORDER_BINDINGS)) {
    const saved = await loaded(() => installation.loadWorkflow(kind));
    if (typeof saved?.workflow?.purposeCode === "string")
      checks.push({
        reason: "Orders",
        purposeCode: saved.workflow.purposeCode,
        applicabilityCode,
        version: saved.workflow.payment?.workflowVersionReference,
      });
  }
  const cancellation = await loaded(() => installation.loadCancellationWorkflow());
  if (typeof cancellation?.definition?.purposeCode === "string")
    checks.push({
      reason: "Cancellation",
      purposeCode: cancellation.definition.purposeCode,
      applicabilityCode: "DineIn",
      // Its worker follows the family, not one version (pilot-batch-cancellation loadPublished).
      family: cancellation.definition.workflowReference,
    });
  return transactions.run(async (tx) => {
    const owner = createPostgresWorkflowDefinitionStore({ run: (work) => work(tx) }, scope);
    const refused = [];
    for (const check of checks) {
      try {
        const { definition } = await owner.resolveCurrent({
          purposeCode: check.purposeCode,
          applicabilityCode: check.applicabilityCode,
          observedAt,
        });
        if (
          (check.version !== undefined && definition.versionReference !== check.version) ||
          (check.family !== undefined && definition.workflowReference !== check.family)
        )
          refused.push({ reason: check.reason, rule: "ExpectedVersionChanged" });
      } catch (error) {
        // A failed dependency aborted this transaction and says nothing about the Workflow.
        if (error?.code !== "WORKFLOW_DEFINITION_UNAVAILABLE" || error.rule === "Dependency")
          throw error;
        refused.push({ reason: check.reason, rule: error.rule });
      }
    }
    const first = refused.find(({ reason }) => reason === "Orders") ?? refused[0];
    return first === undefined
      ? Object.freeze({ ready: true })
      : Object.freeze({ ready: false, ...first });
  });
}
