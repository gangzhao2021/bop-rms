import type {
  MenuAllergenProvenanceSnapshot,
  MenuAllergenValidationCommand,
} from "../../contracts/allergen-provenance.js";
import type { CatalogReference } from "../../contracts/product.js";

export interface MenuAllergenValidationPorts {
  readonly facts: {
    load(command: MenuAllergenValidationCommand): Promise<MenuAllergenProvenanceSnapshot | null>;
  };
  readonly references: {
    generate(purpose: "AllergenValidationEvidence"): CatalogReference;
  };
}
