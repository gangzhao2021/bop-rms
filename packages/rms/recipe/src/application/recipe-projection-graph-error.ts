export class RecipeProjectionGraphError extends Error {
  constructor(
    readonly code:
      | "RECIPE_PROJECTION_GRAPH_INPUT_INVALID"
      | "RECIPE_PROJECTION_GRAPH_INCOMPLETE"
      | "RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT"
      | "RECIPE_PROJECTION_GRAPH_UNRESOLVED"
      | "RECIPE_PROJECTION_GRAPH_CYCLE",
  ) {
    super("Recipe projection graph is unavailable");
    this.name = "RecipeProjectionGraphError";
  }
}
