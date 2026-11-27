import { parseCatalogReference, parseLocalizedNames } from "./product.js";
import type {
  CatalogProductTaxClassificationDefinition,
  CatalogProductTaxClassificationRegistry,
} from "../domain/product-tax-classification-registry.js";

/**
 * WP-2423 Store setup in product: the Brand Owner's everyday changes to the Brand's tax
 * classification list, as the definitions of the next registry version. Classifications are the
 * Brand's own labels; nothing here states a rate, a legal treatment or what is taxable.
 */
export type CatalogTaxClassificationChange =
  | {
      readonly kind: "Add";
      readonly entries: readonly {
        readonly classificationReference: string;
        readonly localizedNames: Readonly<Record<string, string>>;
      }[];
    }
  | {
      readonly kind: "Rename";
      readonly classificationReference: string;
      readonly localizedNames: Readonly<Record<string, string>>;
    }
  | { readonly kind: "SetDefault"; readonly classificationReference: string | null }
  | { readonly kind: "Retire"; readonly classificationReference: string };
export type CatalogTaxClassificationChangeResult =
  | {
      readonly ok: true;
      readonly definitions: readonly CatalogProductTaxClassificationDefinition[];
      readonly defaultClassificationReference: string | null;
    }
  | { readonly ok: false; readonly reason: "Invalid" | "NotFound" | "NameTaken" | "Retired" };

/**
 * The permanent code of a new classification: an uppercase slug of its default-language name, made
 * unique against every code the Brand ever used (retired ones included). Codes are never shown.
 */
export function catalogTaxClassificationCode(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48)
    .replace(/_+$/u, "");
  const stem = /^[A-Z]/u.test(slug) ? slug : ("CLASSIFICATION_" + slug).replace(/_+$/u, "");
  let code = stem;
  for (let n = 2; taken.has(code); n++) code = stem + "_" + n;
  return code;
}

const sameName = (a: string, b: string) =>
  a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;

/**
 * Applies one change to the current registry (null before the first version). Names must include
 * the default language and may not repeat (ignoring case) a classification still in use; retired
 * classifications cannot be renamed, chosen as default or retired again; retiring the Brand
 * default leaves the Brand without one (only an Active classification can be the default).
 */
export function applyCatalogTaxClassificationChange(
  current: CatalogProductTaxClassificationRegistry | null,
  defaultLocale: string,
  change: CatalogTaxClassificationChange,
): CatalogTaxClassificationChangeResult {
  const definitions = [...(current?.definitions ?? [])];
  let defaultReference = current?.defaultClassificationReference ?? null;
  const refuse = (reason: "Invalid" | "NotFound" | "NameTaken" | "Retired") =>
    Object.freeze({ ok: false as const, reason });
  const valid = (names: Readonly<Record<string, string>>) => {
    try {
      return parseLocalizedNames(names, defaultLocale);
    } catch {
      return null;
    }
  };
  const taken = (names: Readonly<Record<string, string>>, except: string | null) =>
    definitions.some(
      (d) =>
        d.lifecycle !== "Retired" &&
        d.classificationReference !== except &&
        Object.entries(names).some(
          ([locale, name]) =>
            d.localizedNames[locale] !== undefined && sameName(d.localizedNames[locale], name),
        ),
    );
  const find = (reference: string) =>
    definitions.findIndex((d) => d.classificationReference === reference);
  switch (change.kind) {
    case "Add": {
      if (change.entries.length < 1) return refuse("Invalid");
      const codes = new Set(definitions.map((d) => d.code));
      for (const entry of change.entries) {
        const localizedNames = valid(entry.localizedNames);
        if (localizedNames === null) return refuse("Invalid");
        if (taken(localizedNames, null)) return refuse("NameTaken");
        const code = catalogTaxClassificationCode(localizedNames[defaultLocale] ?? "", codes);
        codes.add(code);
        definitions.push(
          Object.freeze({
            classificationReference: parseCatalogReference(entry.classificationReference),
            code,
            localizedNames,
            lifecycle: "Active" as const,
          }),
        );
      }
      break;
    }
    case "Rename": {
      const at = find(change.classificationReference),
        before = definitions[at];
      if (before === undefined) return refuse("NotFound");
      if (before.lifecycle === "Retired") return refuse("Retired");
      const localizedNames = valid(change.localizedNames);
      if (localizedNames === null) return refuse("Invalid");
      if (taken(localizedNames, before.classificationReference)) return refuse("NameTaken");
      definitions[at] = Object.freeze({ ...before, localizedNames });
      break;
    }
    case "SetDefault":
      if (change.classificationReference !== null) {
        const target = definitions[find(change.classificationReference)];
        if (target === undefined) return refuse("NotFound");
        if (target.lifecycle !== "Active") return refuse("Retired");
      }
      defaultReference = change.classificationReference;
      break;
    case "Retire": {
      const at = find(change.classificationReference),
        before = definitions[at];
      if (before === undefined) return refuse("NotFound");
      if (before.lifecycle === "Retired") return refuse("Retired");
      definitions[at] = Object.freeze({ ...before, lifecycle: "Retired" as const });
      if (defaultReference === before.classificationReference) defaultReference = null;
      break;
    }
    default:
      return refuse("Invalid");
  }
  return Object.freeze({
    ok: true as const,
    definitions: Object.freeze(definitions),
    defaultClassificationReference: defaultReference,
  });
}
