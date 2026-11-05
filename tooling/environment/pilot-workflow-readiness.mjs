import { createPostgresWorkflowDefinitionStore } from "../../packages/bop/workflow/src/index.ts";
import { readPublishedStoreServiceModes } from "../../packages/rms/store/src/index.ts";
import { platformWorkflows } from "./platform-workflows.mjs";

/** The order bindings a Store runs on, and the order type each is resolved for. */
const ORDER_BINDINGS = Object.freeze({
  Pickup: "Pickup",
  DineIn: "DineIn",
  AdditionalRelease: "DineIn",
});
/** Every order type a Store can run these on, when its published configuration cannot say. */
const ALL_ORDER_TYPES = Object.freeze(["Pickup", "DineIn"]);

/** A Workflow's own refusal: a failed dependency says nothing about the Workflow, so it throws. */
function refusalRule(error) {
  if (error?.code !== "WORKFLOW_DEFINITION_UNAVAILABLE" || error.rule === "Dependency") throw error;
  return String(error.rule ?? "Refused");
}

/** Whether this Brand holds any of the released Workflows at all: none means not installed yet. */
async function brandHoldsAWorkflow(owner, observedAt) {
  for (const { purposeCode, applicabilityCode } of Object.values(platformWorkflows))
    try {
      await owner.resolveCurrent({ purposeCode, applicabilityCode, observedAt });
      return true;
    } catch (error) {
      if (refusalRule(error) !== "NoBrandVersion") return true;
    }
  return false;
}

/** The check one binding file gives, or null when it does not load or names nothing to ask about. */
async function loadOrderCheck(installation, binding, applicabilityCode) {
  const saved = await installation.loadWorkflow(binding).catch(() => null);
  const purposeCode = saved?.workflow?.purposeCode;
  const version = saved?.workflow?.payment?.workflowVersionReference;
  if (typeof purposeCode !== "string" || typeof version !== "string") return null;
  return {
    binding,
    purposeCode,
    applicabilityCode,
    matches: (definition) => definition.versionReference === version,
  };
}
async function loadCancellationCheck(installation) {
  const saved = await installation.loadCancellationWorkflow().catch(() => null);
  const purposeCode = saved?.definition?.purposeCode;
  if (typeof purposeCode !== "string" || typeof saved.definition.workflowReference !== "string")
    return null;
  return {
    binding: "Cancellation",
    purposeCode,
    applicabilityCode: "DineIn",
    // What its worker refuses (pilot-batch-cancellation loadPublished): it follows the family and
    // its transitions, not one version.
    matches: (definition) =>
      definition.workflowReference === saved.definition.workflowReference &&
      definition.storeReference === null &&
      JSON.stringify(definition.transitions) === JSON.stringify(saved.definition.transitions),
  };
}

/**
 * WP-2423 item 9: can this Store's orders still move through its Workflows? The resolver fails
 * closed on a money path, and the first sign used to be a guest stuck on "preparing payment", with
 * nothing on any staff screen. The monitor asks the same owner once a minute (read only, api role),
 * so staff hear first. Each binding the Store has is asked about:
 *
 * - `{ ready: true }`: every binding loads and resolves to the version it names.
 * - `{ ready: false, refusals, orderTypes }`: which binding refused and the rule, for BOP's log and
 *   for the words staff read; `ExpectedVersionChanged` when it names another version than the one
 *   that resolves (guests still pay, paid orders are refused later). `orderTypes` is what the Store
 *   offers, so a refusal of a type it does not sell is not called an emergency.
 * - null: not installed yet (no binding, and the Brand holds none of the Workflows): not checked.
 * - throws: the read could not run, or a binding does not load and nothing refused. Services keep
 *   the copy they loaded when they started, so nobody notices until the next restart, when that
 *   Store does not come back. The monitor says it could not check, never that all is well.
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
  const loaded = await Promise.all([
    ...Object.entries(ORDER_BINDINGS).map(([binding, applicabilityCode]) =>
      loadOrderCheck(installation, binding, applicabilityCode),
    ),
    loadCancellationCheck(installation),
  ]);
  const checks = loaded.filter((check) => check !== null);
  const refusals = await transactions.run(async (tx) => {
    const owner = createPostgresWorkflowDefinitionStore({ run: (work) => work(tx) }, scope);
    if (checks.length === 0) return (await brandHoldsAWorkflow(owner, observedAt)) ? [] : null;
    const found = [];
    for (const { binding, purposeCode, applicabilityCode, matches } of checks)
      try {
        const { definition } = await owner.resolveCurrent({
          purposeCode,
          applicabilityCode,
          observedAt,
        });
        if (!matches(definition)) found.push({ binding, rule: "ExpectedVersionChanged" });
      } catch (error) {
        found.push({ binding, rule: refusalRule(error) });
      }
    return found;
  });
  if (refusals === null) return null;
  if (refusals.length === 0) {
    if (checks.length < loaded.length) throw new Error("PILOT_WORKFLOW_BINDING_UNAVAILABLE");
    return Object.freeze({ ready: true });
  }
  // Apart from the read above, so a failure here cannot hide what the Workflows just answered.
  const modes = await transactions
    .run((tx) => readPublishedStoreServiceModes(tx, resources.scope, observedAt))
    .catch(() => null);
  return Object.freeze({
    ready: false,
    refusals: Object.freeze(refusals.map((refusal) => Object.freeze(refusal))),
    orderTypes: modes ?? ALL_ORDER_TYPES,
  });
}
