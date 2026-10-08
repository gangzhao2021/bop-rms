import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type { RecipeDraftFacts } from "../../domain/recipe-authoring.js";
import {
  applyRecipeIngredientModifiers,
  type RecipeIngredientChange,
} from "../../domain/recipe-modifier.js";
import { createRecipePreparationModifierContentBinding } from "../../domain/recipe-preparation-content.js";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  type IngredientRequirement,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import type { RecipeAuthoringScope, RecipeAuthoringTransaction } from "./recipe-authoring-store.js";
import { createPostgresRecipeModifierWriteStore } from "./recipe-modifier-write-store.js";
import { createPostgresRecipePreparationContentStore } from "./recipe-preparation-content-store.js";

/**
 * WP-2423 slice 4.4: what choosing an option does to a product's recipes. A change (no change,
 * replace an ingredient with another in the same amount, add an amount per unit chosen, remove an
 * ingredient) is expanded into explicit Recipe modifier rules for every published recipe bound to
 * the product's sizes and every quantity a customer may choose, written as Drafts by the author.
 * One Cost and one FoodSafety reviewer — two different people, neither the author — approve the
 * change with that expansion; a publisher then publishes every rule with that evidence, together
 * with its kitchen content (the recipe's steps unchanged). Caller authorizes (recipe.update,
 * recipe.approve, recipe.publish) and owns the transaction.
 */
export type OptionRecipeChangeErrorCode =
  | "OPTION_RECIPE_INVALID"
  | "OPTION_RECIPE_NO_RECIPE"
  | "OPTION_RECIPE_INGREDIENT_MISSING"
  | "OPTION_RECIPE_INGREDIENT_PRESENT"
  | "OPTION_RECIPE_UNIT_MISMATCH"
  | "OPTION_RECIPE_ITEM_UNAVAILABLE"
  | "OPTION_RECIPE_ALLERGEN_UNDECLARED"
  | "OPTION_RECIPE_CONFLICT"
  | "OPTION_RECIPE_NOT_FOUND"
  | "OPTION_RECIPE_REVIEW_REQUIRED"
  | "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT";
export class OptionRecipeChangeError extends Error {
  constructor(
    readonly code: OptionRecipeChangeErrorCode,
    /** The size whose recipe the change cannot apply to, when one. */
    readonly skuReference: string | null = null,
  ) {
    super(code);
    this.name = "OptionRecipeChangeError";
  }
}
const fail = (code: OptionRecipeChangeErrorCode, sku: string | null = null): never => {
  throw new OptionRecipeChangeError(code, sku);
};
const sha256 = (value: string) => "sha256:" + sha256Hex(value);
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
/** A stable UUIDv7-shaped reference derived from another one (keeps its timestamp). */
export function derivedRecipeReference(base: string, purpose: string): string {
  const digest = sha256Hex("bop-rms/option-recipe-change/v1:" + base + ":" + purpose);
  return (
    base.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}
const decimal = (value: string | null, scale: number): bigint | null => {
  if (value === null) return null;
  const match = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${scale}}))?$`, "u").exec(value);
  if (match === null) return fail("OPTION_RECIPE_INVALID");
  return BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(scale, "0"));
};
/** Base units the pilot's inventory items use, with their size in the dimension's smallest unit. */
const unitFactors: Readonly<Record<string, readonly [string, bigint]>> = {
  G: ["Mass", 1n],
  KG: ["Mass", 1000n],
  ML: ["Volume", 1n],
  L: ["Volume", 1000n],
  EACH: ["Count", 1n],
};

export type OptionRecipeChangeKind = "NoChange" | "Replace" | "Add" | "Remove";
export interface OptionRecipeChangeContent {
  readonly kind: OptionRecipeChangeKind;
  readonly fromItemReference: string | null;
  readonly toItemReference: string | null;
  /** "Add": the amount of the item per unit chosen, in the item's base unit (up to 6 decimals). */
  readonly quantity: string | null;
  /** "Replace"/"Add": cents per base unit of the new item (up to 4 decimals); null when unknown. */
  readonly unitCostCents: string | null;
  /** "Replace"/"Add": expected loss of the new item, percent (up to 2 decimals). */
  readonly lossPercent: string;
}
export function parseOptionRecipeChangeContent(value: unknown): OptionRecipeChangeContent {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "fromItemReference,kind,lossPercent,quantity,toItemReference,unitCostCents"
  )
    return fail("OPTION_RECIPE_INVALID");
  const ref = (v: unknown) => (v === null ? null : String(parseRecipeReference(v)));
  const text = (v: unknown) =>
    v === null ? null : typeof v === "string" ? v : fail("OPTION_RECIPE_INVALID");
  const content = {
    kind: r.kind as OptionRecipeChangeKind,
    fromItemReference: ref(r.fromItemReference),
    toItemReference: ref(r.toItemReference),
    quantity: text(r.quantity),
    unitCostCents: text(r.unitCostCents),
    lossPercent: typeof r.lossPercent === "string" ? r.lossPercent : fail("OPTION_RECIPE_INVALID"),
  };
  const loss = decimal(content.lossPercent, 2) ?? 0n;
  const quantity = decimal(content.quantity, 6);
  decimal(content.unitCostCents, 4);
  const shape: Record<OptionRecipeChangeKind, boolean> = {
    NoChange:
      content.fromItemReference === null &&
      content.toItemReference === null &&
      content.quantity === null &&
      content.unitCostCents === null &&
      loss === 0n,
    Replace:
      content.fromItemReference !== null &&
      content.toItemReference !== null &&
      content.fromItemReference !== content.toItemReference &&
      content.quantity === null,
    Add:
      content.fromItemReference === null &&
      content.toItemReference !== null &&
      quantity !== null &&
      quantity > 0n,
    Remove:
      content.fromItemReference !== null &&
      content.toItemReference === null &&
      content.quantity === null &&
      content.unitCostCents === null &&
      loss === 0n,
  };
  if (!(content.kind in shape) || !shape[content.kind] || loss > 10_000n)
    return fail("OPTION_RECIPE_INVALID");
  return Object.freeze(content);
}

/** The option of a product binding a change applies to: its sizes and choosable quantities. */
export interface OptionRecipeTarget {
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly skuReferences: readonly string[];
  readonly quantities: readonly number[];
}
export interface OptionRecipeExpansionEntry {
  readonly skuReference: string;
  readonly recipeReference: string;
  readonly recipeVersionReference: string;
  readonly quantity: number;
  readonly ruleReference: string;
  readonly ruleVersionReference: string;
  readonly ruleDigest: string;
  readonly rule: unknown;
  /** Each changed ingredient line, for review: what the item was and becomes (microunits). */
  readonly lines: readonly {
    readonly fromItemReference: string | null;
    readonly fromQuantityMicrounits: string | null;
    readonly toItemReference: string | null;
    readonly toQuantityMicrounits: string | null;
  }[];
}

/** Published recipes bound to the sizes (Brand-wide, and the selected Store's own). */
async function boundRecipes(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  skus: readonly string[],
  at: string,
) {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const rows = (
    await tx.query(
      `SELECT DISTINCT b.sku_id::text sku,b.recipe_id::text recipe,b.recipe_version_id::text version,v.snapshot_json snapshot
       FROM rms_recipe.recipe_scope_binding b
       JOIN rms_recipe.recipe_version v ON v.recipe_version_id=b.recipe_version_id AND v.recipe_id=b.recipe_id AND v.brand_id=b.brand_id
       WHERE b.brand_id=$1 AND b.option_binding_id IS NULL AND b.sku_id=ANY($2::uuid[])
         AND b.effective_from<=$3::timestamptz AND (b.effective_until IS NULL OR b.effective_until>$3::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e
           WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id AND e.ended_at<=$3::timestamptz)
       ORDER BY 1,2,3 LIMIT 500`,
      [scope.brandReference, [...skus], at],
    )
  ).rows;
  return rows.map((row) => ({
    skuReference: String(row.sku),
    snapshot: createRecipeSnapshot(row.snapshot as RecipeSnapshot),
  }));
}

/**
 * The explicit modifier rules a change means for each bound recipe and quantity. Refuses a change
 * that does not fit a recipe (no recipe for a size, the ingredient to replace or remove is absent,
 * units of different kinds, an unavailable or undeclared new ingredient).
 */
export async function expandOptionRecipeChange(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: {
    readonly changeReference: string;
    readonly target: OptionRecipeTarget;
    readonly content: OptionRecipeChangeContent;
    readonly items: RecipeDraftFacts["items"];
    readonly at: string;
    /** A fresh reference per call (the Draft rule versions this expansion would write). */
    readonly nextReference: () => string;
  },
): Promise<readonly OptionRecipeExpansionEntry[]> {
  const { target, content } = input;
  const bound = await boundRecipes(tx, scope, target.skuReferences, input.at);
  for (const sku of target.skuReferences)
    if (!bound.some((item) => item.skuReference === sku)) fail("OPTION_RECIPE_NO_RECIPE", sku);
  const item = content.toItemReference === null ? null : input.items.get(content.toItemReference);
  if (content.toItemReference !== null) {
    if (item === undefined || item === null || !item.active)
      return fail("OPTION_RECIPE_ITEM_UNAVAILABLE");
    if (
      !["Mass", "Volume", "Count"].includes(item.dimension) ||
      unitFactors[item.unitCode] === undefined
    )
      return fail("OPTION_RECIPE_UNIT_MISMATCH");
    if (!item.allergenDeclaration) return fail("OPTION_RECIPE_ALLERGEN_UNDECLARED");
  }
  const loss = Number(decimal(content.lossPercent, 2) ?? 0n);
  const cost = decimal(content.unitCostCents, 4) ?? 0n;
  const perUnit = decimal(content.quantity, 6);
  const newIngredient = (
    requirementReference: string,
    quantityMicrounits: bigint,
  ): IngredientRequirement => {
    if (item === undefined || item === null || content.toItemReference === null)
      return fail("OPTION_RECIPE_INVALID");
    const declaration = item.allergenDeclaration;
    if (!declaration) return fail("OPTION_RECIPE_ALLERGEN_UNDECLARED");
    const evidence = parseRecipeReference(declaration.evidenceReference);
    return {
      requirementReference: parseRecipeReference(requirementReference),
      sourceKind: "InventoryItem",
      sourceReference: parseRecipeReference(content.toItemReference),
      sourceVersionReference: parseRecipeReference(item.configurationOperationReference),
      quantityMicrounits: quantityMicrounits.toString(),
      unitDimension: item.dimension as IngredientRequirement["unitDimension"],
      conversionNumerator: "1",
      conversionDenominator: "1",
      lossBasisPoints: loss,
      unitCostMinorNumerator: cost.toString(),
      unitCostDenominator: "10000000000",
      allergens: [...new Set(declaration.allergenReferences)].sort().map((allergen) => ({
        allergenReference: parseRecipeReference(allergen),
        evidenceReference: evidence,
        verified: true,
      })),
      allergenDeclarationReference: evidence,
    };
  };
  const entries: OptionRecipeExpansionEntry[] = [];
  for (const { skuReference, snapshot } of bound) {
    if (snapshot.lifecycle !== "Published") fail("OPTION_RECIPE_NO_RECIPE", skuReference);
    const of = (reference: string | null) =>
      reference === null
        ? undefined
        : snapshot.ingredients.find(
            (requirement) =>
              requirement.sourceKind === "InventoryItem" &&
              requirement.sourceReference === reference,
          );
    for (const quantity of target.quantities) {
      if (quantity > 1 && content.kind !== "Add" && content.kind !== "NoChange")
        fail("OPTION_RECIPE_INVALID");
      const changes: RecipeIngredientChange[] = [];
      const lines: OptionRecipeExpansionEntry["lines"][number][] = [];
      const ruleReference = derivedRecipeReference(
        input.changeReference,
        "rule:" + snapshot.versionReference + ":" + quantity,
      );
      if (content.kind === "Replace" || content.kind === "Remove") {
        const existing = of(content.fromItemReference);
        if (existing === undefined) return fail("OPTION_RECIPE_INGREDIENT_MISSING", skuReference);
        if (content.kind === "Remove") {
          changes.push({ action: "Remove", requirementReference: existing.requirementReference });
          lines.push({
            fromItemReference: content.fromItemReference,
            fromQuantityMicrounits: existing.quantityMicrounits,
            toItemReference: null,
            toQuantityMicrounits: null,
          });
        } else {
          if (of(content.toItemReference) !== undefined)
            return fail("OPTION_RECIPE_INGREDIENT_PRESENT", skuReference);
          const fromFacts = input.items.get(String(content.fromItemReference));
          const from = unitFactors[fromFacts?.unitCode ?? ""];
          const to = unitFactors[item?.unitCode ?? ""];
          if (
            existing.unitDimension !== item?.dimension ||
            from === undefined ||
            to === undefined ||
            from[0] !== to[0]
          )
            return fail("OPTION_RECIPE_UNIT_MISMATCH", skuReference);
          // The same amount, expressed in the new item's base unit.
          const scaled = BigInt(existing.quantityMicrounits) * from[1];
          if (scaled % to[1] !== 0n) return fail("OPTION_RECIPE_UNIT_MISMATCH", skuReference);
          const amount = scaled / to[1];
          changes.push({
            action: "Replace",
            requirementReference: existing.requirementReference,
            ingredient: newIngredient(existing.requirementReference, amount),
          });
          lines.push({
            fromItemReference: content.fromItemReference,
            fromQuantityMicrounits: existing.quantityMicrounits,
            toItemReference: content.toItemReference,
            toQuantityMicrounits: amount.toString(),
          });
        }
      } else if (content.kind === "Add") {
        const added = (perUnit ?? 0n) * BigInt(quantity);
        const existing = of(content.toItemReference);
        if (existing !== undefined) {
          // More of an ingredient already in the recipe (e.g. an extra espresso shot).
          const amount = BigInt(existing.quantityMicrounits) + added;
          changes.push({
            action: "Replace",
            requirementReference: existing.requirementReference,
            ingredient: { ...existing, quantityMicrounits: amount.toString() },
          });
          lines.push({
            fromItemReference: content.toItemReference,
            fromQuantityMicrounits: existing.quantityMicrounits,
            toItemReference: content.toItemReference,
            toQuantityMicrounits: amount.toString(),
          });
        } else {
          changes.push({
            action: "Add",
            ingredient: newIngredient(derivedRecipeReference(ruleReference, "requirement"), added),
          });
          lines.push({
            fromItemReference: null,
            fromQuantityMicrounits: null,
            toItemReference: content.toItemReference,
            toQuantityMicrounits: added.toString(),
          });
        }
      }
      const selection = {
        bindingReference: parseRecipeReference(target.bindingReference),
        optionReference: parseRecipeReference(target.optionReference),
        quantity,
      };
      const core = {
        ruleReference: parseRecipeReference(ruleReference),
        brandReference: snapshot.brandReference,
        recipeVersionReference: snapshot.versionReference,
        selection,
        changes,
      };
      const rule = {
        ...core,
        ruleVersionReference: parseRecipeReference(input.nextReference()),
        ruleDigest: sha256(canonicalizeRfc8785(core)),
      };
      // The configured recipe must stay valid (no duplicate or missing ingredients).
      try {
        applyRecipeIngredientModifiers(snapshot, [selection], [rule as never]);
      } catch {
        return fail("OPTION_RECIPE_INVALID", skuReference);
      }
      entries.push({
        skuReference,
        recipeReference: snapshot.recipeReference,
        recipeVersionReference: snapshot.versionReference,
        quantity,
        ruleReference: rule.ruleReference,
        ruleVersionReference: rule.ruleVersionReference,
        ruleDigest: rule.ruleDigest,
        rule,
        lines,
      });
    }
  }
  return entries;
}

export interface OptionRecipeChangeView {
  readonly changeReference: string;
  readonly changeVersionReference: string;
  readonly version: number;
  readonly content: OptionRecipeChangeContent;
  readonly digest: string;
  readonly authorReference: string;
  readonly recordedAt: string;
  readonly expansion: readonly OptionRecipeExpansionEntry[];
  readonly reviews: readonly {
    readonly kind: "Cost" | "FoodSafety";
    readonly decision: "Approved" | "Rejected";
    readonly reviewerReference: string;
    readonly comment: string | null;
    readonly reviewedAt: string;
  }[];
  readonly publishedAt: string | null;
}
/** The latest change of each binding option, with its reviews and publication. */
export async function listOptionRecipeChanges(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  targets: readonly { readonly bindingReference: string; readonly optionReference: string }[],
): Promise<ReadonlyMap<string, OptionRecipeChangeView>> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const result = new Map<string, OptionRecipeChangeView>();
  if (targets.length === 0) return result;
  const rows = (
    await tx.query(
      `SELECT DISTINCT ON (c.binding_id,c.option_id) c.change_version_id::text id,c.change_id::text change,c.version,
         c.binding_id::text binding,c.option_id::text option,c.change_kind,c.from_item_id::text from_item,c.to_item_id::text to_item,
         c.quantity_microunits::text quantity,c.unit_cost_numerator::text cost,c.loss_basis_points,c.change_digest,c.expansion_json,
         c.author_actor_id::text author,c.recorded_at,p.published_at,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',r.review_kind,'decision',r.decision,'reviewer',r.reviewer_actor_id,
           'comment',r.comment,'at',to_char(r.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY r.review_kind)
           FROM rms_recipe.option_recipe_change_review r WHERE r.change_version_id=c.change_version_id AND r.brand_id=c.brand_id),'[]'::jsonb) reviews
       FROM rms_recipe.option_recipe_change c
       LEFT JOIN rms_recipe.option_recipe_change_publication p ON p.change_version_id=c.change_version_id AND p.brand_id=c.brand_id
       WHERE c.brand_id=$1 AND (c.binding_id,c.option_id) IN (SELECT * FROM unnest($2::uuid[],$3::uuid[]))
       ORDER BY c.binding_id,c.option_id,c.version DESC`,
      [
        scope.brandReference,
        targets.map((t) => t.bindingReference),
        targets.map((t) => t.optionReference),
      ],
    )
  ).rows;
  const decimalText = (micro: string | null, scale: number) => {
    if (micro === null) return null;
    const digits = micro.padStart(scale + 1, "0");
    const whole = digits.slice(0, -scale),
      fraction = digits.slice(-scale).replace(/0+$/u, "");
    return fraction ? whole + "." + fraction : whole;
  };
  for (const row of rows)
    result.set(String(row.binding) + ":" + String(row.option), {
      changeReference: String(row.change),
      changeVersionReference: String(row.id),
      version: Number(row.version),
      content: {
        kind: row.change_kind as OptionRecipeChangeKind,
        fromItemReference: row.from_item === null ? null : String(row.from_item),
        toItemReference: row.to_item === null ? null : String(row.to_item),
        quantity: decimalText(row.quantity === null ? null : String(row.quantity), 6),
        unitCostCents: decimalText(row.cost === null ? null : String(row.cost), 4),
        lossPercent: decimalText(String(row.loss_basis_points), 2) ?? "0",
      },
      digest: String(row.change_digest),
      authorReference: String(row.author),
      recordedAt: iso(row.recorded_at),
      expansion: row.expansion_json as OptionRecipeExpansionEntry[],
      reviews: (
        row.reviews as {
          kind: string;
          decision: string;
          reviewer: string;
          comment: string | null;
          at: string;
        }[]
      ).map((r) => ({
        kind: r.kind as "Cost" | "FoodSafety",
        decision: r.decision as "Approved" | "Rejected",
        reviewerReference: r.reviewer,
        comment: r.comment,
        reviewedAt: r.at,
      })),
      publishedAt: row.published_at === null ? null : iso(row.published_at),
    });
  return result;
}

function audit(input: {
  readonly brand: string;
  readonly actor: string;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly at: string;
  readonly auditReference: string;
  readonly afterSummary?: Record<string, string>;
  readonly dataClassification?: "Internal" | "Restricted";
}): AppendAuditRecordInput {
  return {
    auditId: input.auditReference,
    brandId: input.brand,
    actor: { type: "User", reference: input.actor },
    actionCode: input.actionCode,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.correlationId,
    reasonCode: "RECIPE_AUTHORING",
    occurredAt: input.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: input.dataClassification ?? "Internal",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
    ...(input.afterSummary === undefined ? {} : { afterSummary: input.afterSummary }),
  } as AppendAuditRecordInput;
}
const modifierVersionOf = async (tx: RecipeAuthoringTransaction, brand: string, rule: string) =>
  Number(
    (
      await tx.query(
        "SELECT COALESCE(max(version),0)::int v FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND rule_id=$2",
        [brand, rule],
      )
    ).rows[0]?.v ?? 0,
  );
const recipeSnapshotOf = async (tx: RecipeAuthoringTransaction, brand: string, version: string) => {
  const row = (
    await tx.query(
      "SELECT snapshot_json snapshot FROM rms_recipe.recipe_version WHERE brand_id=$1 AND recipe_version_id=$2",
      [brand, version],
    )
  ).rows[0];
  return row === undefined
    ? fail("OPTION_RECIPE_CONFLICT")
    : createRecipeSnapshot(row.snapshot as RecipeSnapshot);
};
const runnerOf = (tx: RecipeAuthoringTransaction) => ({
  run: <T>(work: (t: never) => Promise<T>) => work(tx as never),
});

/** Saves the change as the option's next version and writes its rules as the author's Drafts. */
export async function saveOptionRecipeChange(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: {
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly target: OptionRecipeTarget;
    readonly content: OptionRecipeChangeContent;
    readonly items: RecipeDraftFacts["items"];
    readonly expectedVersion: number | null;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly changeVersionReference: string;
}> {
  const brand = scope.brandReference;
  await tx.query(scopeSql, [brand, scope.storeReference]);
  const recorded = (
    await tx.query(
      "SELECT change_version_id::text id,binding_id::text binding,option_id::text option FROM rms_recipe.option_recipe_change WHERE brand_id=$1 AND operation_id=$2",
      [brand, input.operationReference],
    )
  ).rows[0];
  if (recorded !== undefined) {
    if (
      recorded.binding !== input.target.bindingReference ||
      recorded.option !== input.target.optionReference
    )
      fail("OPTION_RECIPE_CONFLICT");
    return { status: "AlreadyApplied", changeVersionReference: String(recorded.id) };
  }
  const changeReference = derivedRecipeReference(
    input.target.bindingReference,
    "option-recipe-change:" + input.target.optionReference,
  );
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OptionRecipeChange:" + brand + ":" + changeReference,
  ]);
  const latest = Number(
    (
      await tx.query(
        "SELECT COALESCE(max(version),0)::int v FROM rms_recipe.option_recipe_change WHERE brand_id=$1 AND change_id=$2",
        [brand, changeReference],
      )
    ).rows[0]?.v ?? 0,
  );
  if ((input.expectedVersion ?? 0) !== latest) fail("OPTION_RECIPE_CONFLICT");
  let sequence = 0;
  const next = () => derivedRecipeReference(input.operationReference, "reference:" + sequence++);
  const expansion = await expandOptionRecipeChange(tx, scope, {
    changeReference,
    target: input.target,
    content: input.content,
    items: input.items,
    at: input.at,
    nextReference: next,
  });
  const changeVersionReference = next();
  const digest = sha256(
    canonicalizeRfc8785({
      target: input.target,
      content: input.content,
      rules: expansion.map((entry) => entry.ruleDigest),
    }),
  );
  const loss = decimal(input.content.lossPercent, 2) ?? 0n;
  const auditReference = next();
  // Brand facts and their audit are written at Brand scope.
  await tx.query(scopeSql, [brand, ""]);
  await tx.query(
    `INSERT INTO rms_recipe.option_recipe_change(change_version_id,change_id,brand_id,version,binding_id,option_id,change_kind,from_item_id,to_item_id,
       quantity_microunits,unit_cost_numerator,loss_basis_points,change_digest,expansion_json,author_actor_id,recorded_at,operation_id,audit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)`,
    [
      changeVersionReference,
      changeReference,
      brand,
      latest + 1,
      input.target.bindingReference,
      input.target.optionReference,
      input.content.kind,
      input.content.fromItemReference,
      input.content.toItemReference,
      decimal(input.content.quantity, 6)?.toString() ?? null,
      decimal(input.content.unitCostCents, 4)?.toString() ?? null,
      Number(loss),
      digest,
      JSON.stringify(expansion),
      input.actorReference,
      input.at,
      input.operationReference,
      auditReference,
    ],
  );
  await appendAuditRecordInTransaction(
    tx as never,
    audit({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_OPTION_CHANGE_SAVED",
      targetType: "RecipeOptionChange",
      targetId: changeVersionReference,
      correlationId: input.operationReference,
      at: input.at,
      auditReference,
      afterSummary: { kind: input.content.kind },
    }),
  );
  const writer = createPostgresRecipeModifierWriteStore(runnerOf(tx), brand);
  for (const entry of expansion) {
    const base = await recipeSnapshotOf(tx, brand, entry.recipeVersionReference);
    const version = (await modifierVersionOf(tx, brand, entry.ruleReference)) + 1;
    const operation = derivedRecipeReference(
      input.operationReference,
      "draft:" + entry.ruleReference,
    );
    await writer.append({
      base,
      rule: entry.rule as never,
      version,
      lifecycle: "Draft",
      operationReference: operation,
      actorReference: input.actorReference,
      occurredAt: input.at,
      effectiveFrom: input.at,
      effectiveUntil: null,
      publicationEvidence: null,
      audit: audit({
        brand,
        actor: input.actorReference,
        actionCode: "RECIPE_MODIFIER_DRAFT",
        targetType: "RecipeModifier",
        targetId: entry.ruleReference,
        correlationId: input.operationReference,
        at: input.at,
        auditReference: derivedRecipeReference(operation, "audit"),
      }),
    });
  }
  return { status: "Applied", changeVersionReference };
}

async function latestChange(tx: RecipeAuthoringTransaction, brand: string, changeVersion: string) {
  const row = (
    await tx.query(
      `SELECT c.change_id::text change,c.version,c.change_digest,c.expansion_json,c.author_actor_id::text author,c.recorded_at,
         (SELECT max(o.version) FROM rms_recipe.option_recipe_change o WHERE o.brand_id=c.brand_id AND o.change_id=c.change_id) latest,
         (SELECT p.operation_id::text FROM rms_recipe.option_recipe_change_publication p WHERE p.change_version_id=c.change_version_id AND p.brand_id=c.brand_id) published_by_operation
       FROM rms_recipe.option_recipe_change c WHERE c.brand_id=$1 AND c.change_version_id=$2`,
      [brand, changeVersion],
    )
  ).rows[0];
  if (row === undefined) return fail("OPTION_RECIPE_NOT_FOUND");
  return {
    digest: String(row.change_digest),
    expansion: row.expansion_json as OptionRecipeExpansionEntry[],
    author: String(row.author),
    recordedAt: iso(row.recorded_at),
    isLatest: Number(row.version) === Number(row.latest),
    publishedByOperation:
      row.published_by_operation === null ? null : String(row.published_by_operation),
  };
}

/** One Cost or FoodSafety decision on the latest version, by someone other than its author. */
export async function reviewOptionRecipeChange(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: {
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly changeVersionReference: string;
    readonly kind: "Cost" | "FoodSafety";
    readonly decision: "Approved" | "Rejected";
    readonly comment: string | null;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied" }> {
  const brand = scope.brandReference;
  await tx.query(scopeSql, [brand, scope.storeReference]);
  const prior = (
    await tx.query(
      "SELECT change_version_id::text id,review_kind FROM rms_recipe.option_recipe_change_review WHERE brand_id=$1 AND operation_id=$2",
      [brand, input.operationReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (prior.id !== input.changeVersionReference || prior.review_kind !== input.kind)
      fail("OPTION_RECIPE_CONFLICT");
    return { status: "AlreadyApplied" };
  }
  const change = await latestChange(tx, brand, input.changeVersionReference);
  if (!change.isLatest || change.publishedByOperation !== null) fail("OPTION_RECIPE_CONFLICT");
  if (change.author === input.actorReference) fail("OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT");
  if (input.decision === "Rejected" && input.comment === null) fail("OPTION_RECIPE_INVALID");
  await tx.query(scopeSql, [brand, ""]);
  const reviewReference = derivedRecipeReference(input.operationReference, "review");
  const auditReference = derivedRecipeReference(input.operationReference, "audit");
  const saved = await tx.query(
    `INSERT INTO rms_recipe.option_recipe_change_review(review_id,change_version_id,brand_id,change_digest,review_kind,decision,reviewer_actor_id,author_actor_id,comment,reviewed_at,operation_id,audit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (change_version_id,review_kind) DO NOTHING`,
    [
      reviewReference,
      input.changeVersionReference,
      brand,
      change.digest,
      input.kind,
      input.decision,
      input.actorReference,
      change.author,
      input.comment,
      input.at,
      input.operationReference,
      auditReference,
    ],
  );
  // Each kind is decided once per version; a later version is reviewed afresh.
  if (saved.rowCount !== 1) fail("OPTION_RECIPE_CONFLICT");
  await appendAuditRecordInTransaction(
    tx as never,
    audit({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_OPTION_CHANGE_REVIEWED",
      targetType: "RecipeOptionChange",
      targetId: input.changeVersionReference,
      correlationId: input.operationReference,
      at: input.at,
      auditReference,
      afterSummary: { kind: input.kind, decision: input.decision },
    }),
  );
  return { status: "Applied" };
}

/**
 * Publishes every rule of the latest, independently approved version with its review evidence and
 * kitchen content (the recipe's steps unchanged). The reviewers must still hold their authority.
 */
export async function publishOptionRecipeChange(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: {
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly changeVersionReference: string;
    readonly reviewersAuthorized: (actors: readonly string[]) => Promise<boolean>;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied" }> {
  const brand = scope.brandReference;
  await tx.query(scopeSql, [brand, scope.storeReference]);
  const change = await latestChange(tx, brand, input.changeVersionReference);
  if (change.publishedByOperation !== null) {
    if (change.publishedByOperation !== input.operationReference) fail("OPTION_RECIPE_CONFLICT");
    return { status: "AlreadyApplied" };
  }
  if (!change.isLatest) fail("OPTION_RECIPE_CONFLICT");
  const reviews = (
    await tx.query(
      "SELECT review_id::text id,review_kind,decision,reviewer_actor_id::text reviewer,change_digest,reviewed_at FROM rms_recipe.option_recipe_change_review WHERE brand_id=$1 AND change_version_id=$2 ORDER BY review_kind",
      [brand, input.changeVersionReference],
    )
  ).rows;
  const cost = reviews.find((r) => r.review_kind === "Cost"),
    safety = reviews.find((r) => r.review_kind === "FoodSafety");
  if (
    !cost ||
    !safety ||
    cost.decision !== "Approved" ||
    safety.decision !== "Approved" ||
    cost.change_digest !== change.digest ||
    safety.change_digest !== change.digest ||
    cost.reviewer === safety.reviewer ||
    [cost.reviewer, safety.reviewer].includes(change.author) ||
    !(await input.reviewersAuthorized([String(cost.reviewer), String(safety.reviewer)]))
  )
    return fail("OPTION_RECIPE_REVIEW_REQUIRED");
  const evidenceReviews = [cost, safety].map((review) => ({
    reviewReference: String(review.id),
    reviewKind: String(review.review_kind) as "Cost" | "FoodSafety",
    reviewerActorReference: String(review.reviewer),
    evidenceDigest: change.digest,
    reviewedAt: iso(review.reviewed_at),
    decision: "Approved" as const,
  }));
  await tx.query(scopeSql, [brand, ""]);
  const writer = createPostgresRecipeModifierWriteStore(runnerOf(tx), brand);
  const content = createPostgresRecipePreparationContentStore({
    brandReference: brand,
    sha256,
    authorizeRead: async () => false,
    authorizeWrite: async () => true,
    validatePublication: async () => true,
    audit: async (published) =>
      audit({
        brand,
        actor: input.actorReference,
        actionCode: "RECIPE_PREPARATION_PUBLISHED",
        targetType: "RecipePreparationContent",
        targetId: published.content.contentReference,
        correlationId: published.operationReference,
        at: published.publishedAt,
        auditReference: derivedRecipeReference(published.operationReference, "audit"),
        dataClassification: "Restricted",
        afterSummary: { contentKind: "Modifier" },
      }),
  });
  for (const entry of change.expansion) {
    const base = await recipeSnapshotOf(tx, brand, entry.recipeVersionReference);
    const draft = entry.rule as { readonly ruleVersionReference: string };
    const version = await modifierVersionOf(tx, brand, entry.ruleReference);
    const current = (
      await tx.query(
        "SELECT lifecycle,rule_version_id::text id FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND rule_id=$2 AND version=$3",
        [brand, entry.ruleReference, version],
      )
    ).rows[0];
    // The rule's latest version must still be this change's Draft.
    if (current?.lifecycle !== "Draft" || current.id !== draft.ruleVersionReference)
      fail("OPTION_RECIPE_CONFLICT");
    const operation = derivedRecipeReference(
      input.operationReference,
      "publish:" + entry.ruleReference,
    );
    const published = {
      ...(entry.rule as object),
      ruleVersionReference: derivedRecipeReference(operation, "version"),
    } as { readonly ruleVersionReference: string; readonly selection: unknown };
    await writer.append({
      base,
      rule: published as never,
      version: version + 1,
      lifecycle: "Published",
      operationReference: operation,
      actorReference: input.actorReference,
      occurredAt: input.at,
      effectiveFrom: input.at,
      effectiveUntil: null,
      publicationEvidence: {
        ruleReference: entry.ruleReference,
        ruleVersionReference: published.ruleVersionReference,
        brandReference: brand,
        recipeVersionReference: entry.recipeVersionReference,
        ruleDigest: entry.ruleDigest,
        draftAuthorActorReference: change.author,
        reviews: evidenceReviews,
      } as never,
      audit: audit({
        brand,
        actor: input.actorReference,
        actionCode: "RECIPE_MODIFIER_PUBLISHED",
        targetType: "RecipeModifier",
        targetId: entry.ruleReference,
        correlationId: input.operationReference,
        at: input.at,
        auditReference: derivedRecipeReference(operation, "audit"),
      }),
    });
    // Kitchen content for the published rule: the recipe's steps unchanged.
    const body = {
      contentReference: derivedRecipeReference(operation, "content"),
      brandReference: brand,
      recipeVersionReference: entry.recipeVersionReference,
      ruleReference: entry.ruleReference,
      ruleVersionReference: published.ruleVersionReference,
      selection: published.selection,
      ruleDigest: entry.ruleDigest,
      contentDigest: "sha256:" + "0".repeat(64),
      changes: [],
    };
    const prepared = {
      ...body,
      contentDigest: sha256(
        createRecipePreparationModifierContentBinding(body, published as never, base),
      ),
    };
    const contentOperation = derivedRecipeReference(operation, "kitchen");
    await content.commit({
      transaction: tx as never,
      record: {
        operationReference: contentOperation,
        actorReference: input.actorReference,
        brandReference: brand,
        recipeReference: entry.recipeReference,
        recipeVersionReference: entry.recipeVersionReference,
        modifierRuleVersionReference: published.ruleVersionReference,
        authoredByReference: change.author,
        authoredAt: change.recordedAt,
        publishedAt: input.at,
        content: prepared,
        reviewEvidence: {
          contentReference: prepared.contentReference,
          contentDigest: prepared.contentDigest,
          draftAuthorActorReference: change.author,
          reviews: evidenceReviews,
        },
      },
    });
  }
  const auditReference = derivedRecipeReference(input.operationReference, "audit");
  await tx.query(scopeSql, [brand, ""]);
  await tx.query(
    "INSERT INTO rms_recipe.option_recipe_change_publication(change_version_id,brand_id,publisher_actor_id,published_at,operation_id,audit_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      input.changeVersionReference,
      brand,
      input.actorReference,
      input.at,
      input.operationReference,
      auditReference,
    ],
  );
  await appendAuditRecordInTransaction(
    tx as never,
    audit({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_OPTION_CHANGE_PUBLISHED",
      targetType: "RecipeOptionChange",
      targetId: input.changeVersionReference,
      correlationId: input.operationReference,
      at: input.at,
      auditReference,
    }),
  );
  return { status: "Applied" };
}

/**
 * Whether every recipe now bound to the target's sizes has a published rule for each quantity —
 * false after a recipe revision until the change is saved, reviewed and published again.
 */
export async function optionRecipeCovered(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  target: OptionRecipeTarget,
  at: string,
): Promise<boolean> {
  const bound = await boundRecipes(tx, scope, target.skuReferences, at);
  if (target.skuReferences.some((sku) => !bound.some((item) => item.skuReference === sku)))
    return false;
  for (const { snapshot } of bound)
    for (const quantity of target.quantities) {
      const row = (
        await tx.query(
          `SELECT lifecycle FROM (SELECT DISTINCT ON (rule_id) lifecycle,rule_id FROM rms_recipe.recipe_modifier_version
             WHERE brand_id=$1 AND recipe_version_id=$2 AND binding_id=$3 AND option_id=$4 AND selected_quantity=$5 AND lifecycle<>'Draft'
               AND occurred_at<=$6::timestamptz ORDER BY rule_id,version DESC) v WHERE lifecycle='Published' LIMIT 1`,
          [
            scope.brandReference,
            snapshot.versionReference,
            target.bindingReference,
            target.optionReference,
            quantity,
            at,
          ],
        )
      ).rows[0];
      if (row === undefined) return false;
    }
  return true;
}
