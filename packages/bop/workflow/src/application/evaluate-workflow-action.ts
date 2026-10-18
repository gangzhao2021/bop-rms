import {
  parseWorkflowActionRequest,
  workflowUnavailable,
  type WorkflowActionRequest,
  type WorkflowDefinitionVersion,
} from "../domain/workflow-definition.js";
import { resolveWorkflowDefinition } from "../domain/resolve-workflow-definition.js";

type Transition = WorkflowDefinitionVersion["transitions"][number];
export interface WorkflowActionPorts {
  /** Read current owner facts under fences held through the eventual domain commit. */
  resolveVersions(request: WorkflowActionRequest): Promise<readonly unknown[]>;
  /** Validate the resource's actual current state/version and actor scope on every call. */
  authorizeResource(request: WorkflowActionRequest): Promise<boolean>;
  /** Validate actual current publication, approval and any Brand-authorized Store override. */
  validatePublication(
    input: Readonly<{
      request: WorkflowActionRequest;
      definition: WorkflowDefinitionVersion;
      brandDefinition: WorkflowDefinitionVersion;
    }>,
  ): Promise<boolean>;
  authorizeAction(
    input: Readonly<{
      request: WorkflowActionRequest;
      definition: WorkflowDefinitionVersion;
      transition: Transition;
    }>,
  ): Promise<boolean>;
  evaluateRule(
    input: Readonly<{
      request: WorkflowActionRequest;
      definition: WorkflowDefinitionVersion;
      transition: Transition;
      ruleReference: string;
    }>,
  ): Promise<boolean>;
}

/** Internal owner service. This evaluates intent; it neither runs effects nor records a transition.
 * Ports must share the caller transaction and fence their current facts through domain commit.
 * Never expose ports to HTTP callers or treat this result as a reusable authorization token.
 */
export async function evaluateWorkflowAction(value: unknown, ports: WorkflowActionPorts) {
  try {
    const request = parseWorkflowActionRequest(value);
    if ((await ports.authorizeResource(request)) !== true) return workflowUnavailable();
    const resolved = resolveWorkflowDefinition({
      versions: await ports.resolveVersions(request),
      tenantReference: request.tenantReference,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
      purposeCode: request.purposeCode,
      applicabilityCode: request.applicabilityCode,
      observedAt: request.observedAt,
    });
    const { definition, brandDefinition } = resolved;
    if (definition.versionReference !== request.expectedVersionReference)
      return workflowUnavailable();
    const transition = definition.transitions.find(
      (candidate) =>
        candidate.currentState === request.currentState && candidate.action === request.action,
    );
    if (!transition) return workflowUnavailable();
    if (
      (await ports.validatePublication(Object.freeze({ request, definition, brandDefinition }))) !==
      true
    )
      return workflowUnavailable();
    const action = Object.freeze({ request, definition, transition });
    if ((await ports.authorizeAction(action)) !== true) return workflowUnavailable();
    for (const ruleReference of transition.ruleReferences) {
      if ((await ports.evaluateRule(Object.freeze({ ...action, ruleReference }))) !== true)
        return workflowUnavailable();
    }
    return Object.freeze({ request, definition, brandDefinition, transition });
  } catch {
    return workflowUnavailable();
  }
}
