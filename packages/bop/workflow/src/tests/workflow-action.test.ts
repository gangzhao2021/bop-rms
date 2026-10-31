import { describe, expect, it, vi } from "vitest";
import { evaluateWorkflowAction, type WorkflowActionPorts } from "../index.js";
import { id, at, definition } from "./workflow-definition.fixture.js";
const request = () => ({
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(10),
  actorReference: id(11),
  resourceReference: id(12),
  resourceVersion: 1,
  purposeCode: "OrderFulfillment",
  applicabilityCode: "Pickup",
  expectedVersionReference: id(2),
  currentState: "CartReady",
  action: "SubmitOrder",
  observedAt: at,
});
function fixture() {
  const source = definition();
  const ports = {
    resolveVersions: vi.fn(async () => [source]),
    authorizeResource: vi.fn(async () => true),
    validatePublication: vi.fn(async () => true),
    authorizeAction: vi.fn(async () => true),
    evaluateRule: vi.fn(async () => true),
  } satisfies WorkflowActionPorts;
  return { source, ports };
}
describe("Workflow action evaluation with synthetic owner gates", () => {
  it("binds the resource and every gate to an immutable current transition", async () => {
    const { source, ports } = fixture();
    const input = request();
    const result = await evaluateWorkflowAction(input, ports);
    expect(result.transition.nextState).toBe("Submitted");
    expect(ports.evaluateRule).toHaveBeenCalledWith(
      expect.objectContaining({ ruleReference: id(9), request: input }),
    );
    expect(ports.authorizeAction).toHaveBeenCalledWith(
      expect.objectContaining({ transition: result.transition }),
    );
    input.currentState = "Changed";
    const effect = source.transitions[0]?.effects[0];
    if (!effect) throw new Error("missing synthetic effect");
    effect.commandCode = "Changed";
    expect(result.request.currentState).toBe("CartReady");
    expect(result.transition.effects[0]?.commandCode).toBe("ReserveInventory");
    expect(Object.isFrozen(result.transition.effects)).toBe(true);
  });
  it("reauthorizes repeated evaluations and stops on revoked resource access", async () => {
    const { ports } = fixture();
    await evaluateWorkflowAction(request(), ports);
    ports.authorizeResource.mockResolvedValue(false);
    await expect(evaluateWorkflowAction(request(), ports)).rejects.toThrow(
      "Workflow definition is unavailable",
    );
    expect(ports.resolveVersions).toHaveBeenCalledTimes(1);
    expect(ports.authorizeResource).toHaveBeenCalledTimes(2);
  });
  it.each(["validatePublication", "authorizeAction", "evaluateRule"] as const)(
    "rejects a denied %s gate",
    async (gate) => {
      const { ports } = fixture();
      ports[gate].mockResolvedValue(false);
      await expect(evaluateWorkflowAction(request(), ports)).rejects.toThrow();
      if (gate !== "evaluateRule") expect(ports.evaluateRule).not.toHaveBeenCalled();
    },
  );
  it.each([
    { expectedVersionReference: id(99) },
    { currentState: "Fulfilled" },
    { action: "ConsumeInventory" },
    { storeReference: id(99), extra: true },
    { resourceVersion: -1 },
    { tenantReference: id(99) },
  ])("rejects stale, foreign or malformed input %j", async (patch) => {
    const { ports } = fixture();
    await expect(evaluateWorkflowAction({ ...request(), ...patch }, ports)).rejects.toThrow();
    expect(ports.authorizeAction).not.toHaveBeenCalled();
  });
  it("evaluates all declared rules and sanitizes dependency failures", async () => {
    const { source, ports } = fixture();
    const transition = source.transitions[0];
    if (!transition) throw new Error("missing synthetic transition");
    transition.ruleReferences.push(id(13));
    ports.evaluateRule
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("private backend detail"));
    await expect(evaluateWorkflowAction(request(), ports)).rejects.toThrow(
      "Workflow definition is unavailable",
    );
    expect(ports.evaluateRule).toHaveBeenCalledTimes(2);
  });
  it("supplies both Brand and Store definitions for override authorization", async () => {
    const { source, ports } = fixture();
    const override = definition({
      workflowReference: id(20),
      versionReference: id(21),
      storeReference: id(10),
      baseVersionReference: id(2),
      overrideAuthorizationReference: id(22),
    });
    ports.resolveVersions.mockResolvedValue([source, override]);
    const result = await evaluateWorkflowAction(
      { ...request(), expectedVersionReference: id(21) },
      ports,
    );
    expect(ports.validatePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: result.definition,
        brandDefinition: result.brandDefinition,
      }),
    );
    expect(result.brandDefinition.versionReference).toBe(id(2));
  });
});
