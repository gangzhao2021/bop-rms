export type RecipeCoveragePublicationErrorCode =
  | "RECIPE_PUBLICATION_INPUT_INVALID"
  | "RECIPE_PUBLICATION_UNAVAILABLE"
  | "RECIPE_PUBLICATION_VERSION_CONFLICT"
  | "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT";
export class RecipeCoveragePublicationError extends Error {
  constructor(readonly code: RecipeCoveragePublicationErrorCode) {
    super("Recipe coverage publication is unavailable");
    this.name = "RecipeCoveragePublicationError";
  }
}
