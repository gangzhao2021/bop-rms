import type {
  MenuAllergenValidationCommand,
  MenuAllergenValidationResult,
} from "../contracts/allergen-provenance.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "../contracts/product.js";
import { validateMenuAllergenProvenance } from "../domain/allergen-provenance.js";
import type { MenuAllergenValidationPorts } from "./ports/allergen-provenance-ports.js";
import { parsePublishingDigest } from "@bop/publishing";

function dependency(): never {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}

export function createMenuAllergenValidationService(ports: MenuAllergenValidationPorts) {
  return Object.freeze({
    async validate(value: MenuAllergenValidationCommand): Promise<MenuAllergenValidationResult> {
      const command = Object.freeze({
        brandReference: parseCatalogReference(value.brandReference),
        menuVersionReference: parseCatalogReference(value.menuVersionReference),
        snapshotDigest: parsePublishingDigest(value.snapshotDigest),
        requestedAt: parseCatalogInstant(value.requestedAt),
      });
      const snapshot = await ports.facts.load(command).catch(dependency);
      if (
        snapshot === null ||
        snapshot.brandReference !== command.brandReference ||
        snapshot.menuVersionReference !== command.menuVersionReference ||
        snapshot.snapshotDigest !== command.snapshotDigest
      )
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      return validateMenuAllergenProvenance({
        snapshot,
        evidenceReference: ports.references.generate("AllergenValidationEvidence"),
        checkedAt: command.requestedAt,
      });
    },
  });
}
