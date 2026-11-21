import type { AppendAuditRecordInput } from "@bop/audit";
import type { RecipeSnapshot } from "../../domain/recipe.js";
import type { RecipeModifierRule } from "../../domain/recipe-modifier.js";
import type { RecipeModifierPublicationEvidence } from "../../domain/publication-review.js";
import type { RecipeAuthorizationEvidence, RecipePorts } from "./recipe-ports.js";
export interface RecipeModifierWrite {
  readonly base: RecipeSnapshot;
  readonly rule: RecipeModifierRule;
  readonly version: number;
  readonly lifecycle: "Draft" | "Published" | "Invalidated" | "Archived";
  readonly operationReference: string;
  readonly actorReference: string;
  readonly occurredAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly publicationEvidence: RecipeModifierPublicationEvidence | null;
  readonly audit: AppendAuditRecordInput;
}
export type RecipeModifierCommand = Omit<
  RecipeModifierWrite,
  "actorReference" | "publicationEvidence" | "audit"
>;
export interface RecipeModifierPorts {
  readonly authorization: {
    authorize(input: RecipeModifierCommand): Promise<RecipeAuthorizationEvidence | null>;
  };
  readonly facts: RecipePorts["facts"];
  readonly repository: {
    append(
      input: RecipeModifierWrite,
      validateNewWrite: () => Promise<void>,
    ): Promise<
      Readonly<{
        status: "Applied" | "AlreadyApplied";
        rule: RecipeModifierRule;
        version: number;
        auditReference: string;
      }>
    >;
  };
}
