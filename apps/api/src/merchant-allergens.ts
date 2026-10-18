import {
  AllergenDeclarationError,
  allergenDeclarationSources,
  createAllergenRegistryVersion,
  currentAllergenRegistry,
  pendingAllergenRegistryProposal,
  recordAllergenRegistryProposal,
  listCurrentIngredientDeclarations,
  listIngredientDeclarationHistory,
  recordIngredientAllergenDeclaration,
} from "@rms/catalog";
import { listInventoryRecipeIngredientFacts, storeDayEndExpiryCutoff } from "@rms/inventory";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import {
  merchantBrandSoleOperatorGate,
  MerchantSoleOperatorGateError,
  requireMerchantBrandSoleOperator,
} from "./merchant-sole-operator.js";

/**
 * WP-2423 / DEC-ALLERGEN-DECLARATIONS: CMP-ALLERGEN-REVIEW for the selected Store's Brand. Reading needs
 * catalog.allergen.read; approving the Brand allergen registry catalog.allergen_registry.manage;
 * recording an ingredient's declaration catalog.allergen.declare. A declaration decides every
 * registry allergen for the ingredient's current version (contains, may contain, or absent) and
 * cites where that comes from; a new declaration replaces the previous one. Recipes saved after it
 * carry it, and a recipe's food safety review approves those allergens.
 */
export class MerchantAllergenError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "RegistryMissing"
      | "Invalid"
      /** WP-2423 Q19: the person who recorded the roster cannot approve it. */
      | "ApprovalRequired"
      | "SoleOperatorNotInEffect"
      | "NeedsReverification",
  ) {
    super(code);
    this.name = "MerchantAllergenError";
  }
}
const fail = (code: MerchantAllergenError["code"]): never => {
  throw new MerchantAllergenError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const dateOnly = (value: unknown): string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value
    ? value
    : fail("Invalid");

/**
 * TEST-ONLY internal-pilot registry: the Health Canada priority food allergens and gluten sources.
 * Verify against current Health Canada guidance before commercial use.
 */
export const canadaPriorityAllergensTest = Object.freeze({
  jurisdictionCode: "CA",
  policyDocument:
    "TEST-ONLY internal pilot list based on the Health Canada priority food allergens and gluten sources. Verify against current Health Canada guidance before commercial use.",
  entries: Object.freeze([
    ["PEANUT", "Peanuts", "Arachides"],
    ["TREE_NUT", "Tree nuts", "Noix"],
    ["SESAME", "Sesame seeds", "Graines de sésame"],
    ["MILK", "Milk", "Lait"],
    ["EGG", "Eggs", "Œufs"],
    ["FISH", "Fish", "Poisson"],
    ["CRUSTACEAN_MOLLUSC", "Crustaceans and molluscs", "Crustacés et mollusques"],
    ["SOY", "Soy", "Soja"],
    ["WHEAT_TRITICALE", "Wheat and triticale", "Blé et triticale"],
    ["GLUTEN", "Gluten sources (barley, oats, rye)", "Sources de gluten (orge, avoine, seigle)"],
    ["MUSTARD", "Mustard", "Moutarde"],
    ["SULPHITES", "Sulphites", "Sulfites"],
  ] as const),
});

export type AllergenCommandBody =
  | {
      /** WP-2423 Q19: one person records the roster to approve. */
      readonly action: "RecordRegistry";
      readonly operationReference: string;
      readonly template: "CA_PRIORITY_TEST";
    }
  | {
      /** Another person approves the recorded roster (or its recorder alone as sole operator). */
      readonly action: "ApproveRegistry";
      readonly operationReference: string;
      readonly proposalReference: string;
      readonly approvalMode?: "SoleOperator";
    }
  | {
      readonly action: "Declare";
      readonly operationReference: string;
      readonly itemReference: string;
      readonly expectedItemVersion: string;
      readonly allergens: readonly {
        readonly allergenReference: string;
        readonly classification: "Contains" | "CrossContactPossible";
      }[];
      readonly sourceKind: (typeof allergenDeclarationSources)[number];
      readonly documentReference: string;
      readonly note: string | null;
      readonly validUntilDate: string;
    };
export function parseAllergenCommandBody(value: unknown): AllergenCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "RecordRegistry" &&
    keys === "action,operationReference,template" &&
    r.template === "CA_PRIORITY_TEST"
  )
    return {
      action: "RecordRegistry",
      operationReference: ref(r.operationReference),
      template: "CA_PRIORITY_TEST",
    };
  if (r.action === "ApproveRegistry" && keys === "action,operationReference,proposalReference")
    return {
      action: "ApproveRegistry",
      operationReference: ref(r.operationReference),
      proposalReference: ref(r.proposalReference),
    };
  if (
    r.action === "ApproveRegistry" &&
    keys === "action,approvalMode,operationReference,proposalReference" &&
    r.approvalMode === "SoleOperator"
  )
    return {
      action: "ApproveRegistry",
      operationReference: ref(r.operationReference),
      proposalReference: ref(r.proposalReference),
      approvalMode: "SoleOperator",
    };
  if (
    r.action === "Declare" &&
    keys ===
      "action,allergens,documentReference,expectedItemVersion,itemReference,note,operationReference,sourceKind,validUntilDate"
  ) {
    if (!Array.isArray(r.allergens) || r.allergens.length > 64) return fail("Invalid");
    const allergens = r.allergens.map((candidate: unknown) => {
      const a = candidate as Record<string, unknown> | null;
      if (
        a === null ||
        typeof a !== "object" ||
        Object.keys(a).sort().join(",") !== "allergenReference,classification" ||
        (a.classification !== "Contains" && a.classification !== "CrossContactPossible")
      )
        return fail("Invalid");
      return {
        allergenReference: ref(a.allergenReference),
        classification: a.classification as "Contains" | "CrossContactPossible",
      };
    });
    if (
      new Set(allergens.map((a) => a.allergenReference)).size !== allergens.length ||
      !(allergenDeclarationSources as readonly unknown[]).includes(r.sourceKind) ||
      typeof r.documentReference !== "string" ||
      r.documentReference.trim().length < 1 ||
      r.documentReference.length > 200 ||
      (r.note !== null && (typeof r.note !== "string" || r.note.length > 500))
    )
      return fail("Invalid");
    return {
      action: "Declare",
      operationReference: ref(r.operationReference),
      itemReference: ref(r.itemReference),
      expectedItemVersion: ref(r.expectedItemVersion),
      allergens,
      sourceKind: r.sourceKind as (typeof allergenDeclarationSources)[number],
      documentReference: r.documentReference.trim(),
      note: r.note === null ? null : (r.note as string).trim() || null,
      validUntilDate: dateOnly(r.validUntilDate),
    };
  }
  return fail("Invalid");
}

const declarationErrors: Record<AllergenDeclarationError["code"], MerchantAllergenError["code"]> = {
  ALLERGEN_REGISTRY_INVALID: "Invalid",
  ALLERGEN_REGISTRY_UNAVAILABLE: "RegistryMissing",
  ALLERGEN_DECLARATION_INVALID: "Invalid",
  ALLERGEN_IDEMPOTENCY_CONFLICT: "Conflict",
  ALLERGEN_INDEPENDENT_APPROVAL_REQUIRED: "ApprovalRequired",
};

/** The last local date a declaration is valid on (its validity ends at the next local midnight). */
export function validThroughDate(validUntil: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.parse(validUntil) - 1));
}

export function createMerchantAllergens(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const reads = (tx: unknown) => tx as never;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    const permissions = {
      mayRead: await may("catalog.allergen.read"),
      mayDeclare: await may("catalog.allergen.declare"),
      mayManageRegistry: await may("catalog.allergen_registry.manage"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      owner: {
        tenantReference: String(scope.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.selectedStoreReference),
      },
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions,
    };
  }
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    itemReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const at = options.persistence.now();
          const items = (await listInventoryRecipeIngredientFacts(reads(tx), s.owner)).filter(
            (item) => item.active,
          );
          const registry = await currentAllergenRegistry(reads(tx), s.owner);
          const declarations = new Map(
            (await listCurrentIngredientDeclarations(reads(tx), s.owner, at)).map((d) => [
              d.itemReference,
              d,
            ]),
          );
          const soon = Date.parse(at) + 30 * 86_400_000;
          const local = <T extends { readonly validUntil: string }>(d: T) => ({
            ...d,
            validThrough: validThroughDate(d.validUntil, s.timeZone),
          });
          const rows = items.map((item) => {
            const found = declarations.get(item.itemReference);
            const d = found === undefined ? null : local(found);
            const status =
              d === null
                ? "Missing"
                : d.registryVersionReference !== registry?.registryVersionReference
                  ? "RegistryChanged"
                  : d.itemVersionReference !== item.configurationOperationReference
                    ? "ItemChanged"
                    : Date.parse(d.validUntil) < soon
                      ? "ExpiringSoon"
                      : "Current";
            return {
              itemReference: item.itemReference,
              itemVersionReference: item.configurationOperationReference,
              internalCode: item.internalCode,
              name: name(item.localizedNames, item.internalCode),
              unitCode: item.unitCode,
              status,
              declaration: d,
            };
          });
          // WP-2423 Q19: a roster recorded and waiting for another person's approval; its recorder
          // sees whether they may approve it alone as sole operator, and why not.
          const proposal = await pendingAllergenRegistryProposal(reads(tx), s.owner);
          const gate =
            proposal !== null &&
            proposal.recorderReference === s.actor &&
            s.permissions.mayManageRegistry
              ? await merchantBrandSoleOperatorGate(tx as never, {
                  ...s.owner,
                  actorReference: s.actor,
                  permissionCode: "catalog.allergen_registry.manage",
                  observedAt: at,
                  allowed: async () => s.permissions.mayManageRegistry,
                })
              : null;
          const base = {
            sourceAsOf: at,
            viewer: s.actor,
            permissions: s.permissions,
            locale: options.locale,
            registryProposal:
              proposal === null
                ? null
                : {
                    proposalReference: proposal.proposalReference,
                    recordedAt: proposal.recordedAt,
                    recordedByYou: proposal.recorderReference === s.actor,
                  },
            soleOperator:
              gate === null
                ? null
                : {
                    status: gate.status,
                    otherApprovers: gate.otherApprovers,
                    verifiedUntil: gate.verifiedUntil,
                  },
            registry,
            registryTemplate: {
              template: "CA_PRIORITY_TEST" as const,
              jurisdictionCode: canadaPriorityAllergensTest.jurisdictionCode,
              policyDocument: canadaPriorityAllergensTest.policyDocument,
              allergens: canadaPriorityAllergensTest.entries.map(([code, en]) => ({
                code,
                name: en,
              })),
            },
            sources: allergenDeclarationSources,
          };
          if (input.itemReference !== null) {
            const row = rows.find((candidate) => candidate.itemReference === input.itemReference);
            if (row === undefined) return fail("NotFound");
            return {
              screenId: "CMP-ALLERGEN-ITEM" as const,
              ...base,
              item: row,
              history: (
                await listIngredientDeclarationHistory(reads(tx), s.owner, input.itemReference)
              ).map(local),
            };
          }
          return { screenId: "CMP-ALLERGEN-REVIEW" as const, ...base, items: rows };
        }),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseAllergenCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const at = options.persistence.now();
          try {
            // The roster content for a target registry version: allergens keep their identity
            // across registry versions; new ones derive from the target version.
            const rosterFor = async (registryVersionReference: string) => {
              const existing = await currentAllergenRegistry(reads(tx), s.owner);
              const idOf = (code: string) =>
                existing?.entries.find((entry) => entry.code === code)?.allergenReference ??
                derivedReference(registryVersionReference, "allergen:" + code);
              return {
                registryVersionReference,
                jurisdictionCode: canadaPriorityAllergensTest.jurisdictionCode,
                policyDocument: canadaPriorityAllergensTest.policyDocument,
                entries: canadaPriorityAllergensTest.entries.map(([code, en, fr]) => ({
                  allergenReference: idOf(code),
                  code,
                  localizedNames: { "en-CA": en, "fr-CA": fr },
                })),
              };
            };
            if (body.action === "RecordRegistry") {
              if (!s.permissions.mayManageRegistry) fail("PermissionDenied");
              const result = await recordAllergenRegistryProposal(reads(tx), s.owner, {
                ...(await rosterFor(derivedReference(body.operationReference, "registry"))),
                proposalReference: derivedReference(body.operationReference, "proposal"),
                actorReference: s.actor,
                at,
                auditReference: derivedReference(body.operationReference, "audit"),
              });
              return { status: result.status, proposalReference: result.proposalReference };
            }
            if (body.action === "ApproveRegistry") {
              if (!s.permissions.mayManageRegistry) fail("PermissionDenied");
              const pending = await pendingAllergenRegistryProposal(reads(tx), s.owner);
              const replayed = (
                await (
                  tx as unknown as {
                    query(sql: string, values: readonly unknown[]): Promise<{ rows: unknown[] }>;
                  }
                ).query(
                  "SELECT registry_version_id::text version FROM rms_catalog.allergen_registry_proposal WHERE brand_id=$1 AND proposal_id=$2",
                  [s.owner.brandReference, body.proposalReference],
                )
              ).rows[0] as { version: string } | undefined;
              if (replayed === undefined) return fail("NotFound");
              if (pending !== null && pending.proposalReference !== body.proposalReference)
                return fail("Conflict");
              // WP-2423 Q19: the recorder approves alone only as an in-effect, re-verified sole operator.
              const soleOperator =
                body.approvalMode === "SoleOperator" && pending !== null
                  ? {
                      approverMfaAt: (
                        await requireMerchantBrandSoleOperator(tx as never, {
                          ...s.owner,
                          actorReference: s.actor,
                          permissionCode: "catalog.allergen_registry.manage",
                          observedAt: at,
                          allowed: async () => s.permissions.mayManageRegistry,
                        })
                      ).actorMfaAt,
                    }
                  : undefined;
              const result = await createAllergenRegistryVersion(reads(tx), s.owner, {
                ...(await rosterFor(replayed.version)),
                actorReference: s.actor,
                at,
                auditReference: derivedReference(body.operationReference, "audit"),
                proposal: {
                  proposalReference: body.proposalReference,
                  ...(soleOperator === undefined ? {} : { soleOperator }),
                },
              });
              return {
                status: result.status,
                registryVersionReference: result.registry.registryVersionReference,
              };
            }
            if (!s.permissions.mayDeclare) fail("PermissionDenied");
            const item = (await listInventoryRecipeIngredientFacts(reads(tx), s.owner)).find(
              (candidate) => candidate.itemReference === body.itemReference && candidate.active,
            );
            if (item === undefined) return fail("NotFound");
            const registry = await currentAllergenRegistry(reads(tx), s.owner);
            if (registry === null) return fail("RegistryMissing");
            const evidence = derivedReference(body.operationReference, "declaration");
            // A retry after the item changed still replays the recorded declaration.
            const replay = (
              await listIngredientDeclarationHistory(reads(tx), s.owner, item.itemReference)
            ).find((d) => d.evidenceReference === evidence);
            if (
              replay === undefined &&
              item.configurationOperationReference !== body.expectedItemVersion
            )
              return fail("Conflict");
            const result = await recordIngredientAllergenDeclaration(reads(tx), s.owner, {
              evidenceReference: evidence,
              itemReference: item.itemReference,
              itemVersionReference: replay?.itemVersionReference ?? body.expectedItemVersion,
              registryVersionReference:
                replay?.registryVersionReference ?? registry.registryVersionReference,
              allergens: body.allergens,
              sourceKind: body.sourceKind,
              documentReference: body.documentReference,
              note: body.note,
              validUntil: storeDayEndExpiryCutoff(body.validUntilDate, s.timeZone),
              actorReference: s.actor,
              at: replay?.reviewedAt ?? at,
              auditReference: derivedReference(body.operationReference, "audit"),
            });
            return { status: result.status, declaration: result.declaration };
          } catch (error) {
            if (error instanceof AllergenDeclarationError)
              return fail(declarationErrors[error.code]);
            if (error instanceof MerchantSoleOperatorGateError)
              return fail(
                error.code === "NotInEffect" ? "SoleOperatorNotInEffect" : "NeedsReverification",
              );
            throw error;
          }
        }),
      ),
    );
  };
  return { query, command };
}
