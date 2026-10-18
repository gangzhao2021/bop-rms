import { describe, expect, it } from "vitest";
import { parseWorkflowDefinitionVersion, resolveWorkflowDefinition } from "../index.js";
import { id, at, definition } from "./workflow-definition.fixture.js";
const resolve = (versions: readonly unknown[]) =>
  resolveWorkflowDefinition({
    versions,
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(10),
    purposeCode: "OrderFulfillment",
    applicabilityCode: "Pickup",
    observedAt: at,
  });
describe("synthetic Workflow version selection", () => {
  it("returns detached immutable definitions without executing opaque domain effects", () => {
    const input = definition(),
      parsed = parseWorkflowDefinitionVersion(input);
    const effect = input.transitions[0]?.effects[0];
    if (!effect) throw new Error("missing synthetic effect");
    effect.commandCode = "Changed";
    expect(parsed.transitions[0]?.effects[0]?.commandCode).toBe("ReserveInventory");
    expect(Object.isFrozen(parsed.transitions[0]?.effects)).toBe(true);
    expect(resolve([definition()]).definition.versionReference).toBe(id(2));
  });
  it("selects an explicitly linked Store override", () => {
    const override = definition({
      workflowReference: id(20),
      versionReference: id(21),
      storeReference: id(10),
      baseVersionReference: id(2),
      overrideAuthorizationReference: id(22),
    });
    expect(resolve([definition(), override]).definition.versionReference).toBe(id(21));
    expect(() => resolve([definition(), { ...override, baseVersionReference: id(99) }])).toThrow();
    expect(() =>
      parseWorkflowDefinitionVersion({ ...override, overrideAuthorizationReference: null }),
    ).toThrow();
  });
  it("does not revive an old version after withdrawal or expiry", () => {
    const newer = definition({
      versionReference: id(30),
      versionNumber: 2,
      lifecycle: "Withdrawn",
    });
    expect(() => resolve([definition(), newer])).toThrow();
    expect(() =>
      resolve([
        definition(),
        {
          ...newer,
          lifecycle: "Published",
          effectiveFrom: "2026-09-11T09:00:00.000Z",
          effectiveUntil: at,
        },
      ]),
    ).toThrow();
  });
  it("ignores drafts and future-effective publications for current selection", () => {
    const future = definition({
      versionReference: id(30),
      versionNumber: 2,
      effectiveFrom: "2026-09-11T11:00:00.000Z",
    });
    const draft = definition({
      versionReference: id(31),
      versionNumber: 3,
      lifecycle: "Draft",
      publicationReference: null,
      approvalEvidenceReference: null,
    });
    expect(resolve([draft, future, definition()]).definition.versionReference).toBe(id(2));
  });
  it("does not fall back to Brand when an applicable Store override is withdrawn", () => {
    expect(() =>
      resolve([
        definition(),
        definition({
          workflowReference: id(20),
          versionReference: id(21),
          storeReference: id(10),
          baseVersionReference: id(2),
          overrideAuthorizationReference: id(22),
          lifecycle: "Withdrawn",
        }),
      ]),
    ).toThrow();
  });
  it("rejects ambiguous, duplicate and foreign-scope candidates", () => {
    expect(() =>
      resolve([definition(), definition({ workflowReference: id(40), versionReference: id(41) })]),
    ).toThrow();
    expect(() => resolve([definition(), definition()])).toThrow();
    expect(() => resolve([definition({ tenantReference: id(99) })])).toThrow();
    expect(() => resolve([])).toThrow();
  });
  it("requires publication evidence and unambiguous transition actions", () => {
    expect(() =>
      parseWorkflowDefinitionVersion(definition({ publicationReference: null })),
    ).toThrow();
    const input = definition();
    expect(() =>
      parseWorkflowDefinitionVersion({
        ...input,
        transitions: [...input.transitions, ...input.transitions],
      }),
    ).toThrow();
    expect(() => parseWorkflowDefinitionVersion({ ...input, unexpected: true })).toThrow();
  });
});
