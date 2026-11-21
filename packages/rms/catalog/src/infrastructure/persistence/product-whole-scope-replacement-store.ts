import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  parseProductPublicationApproval,
} from "../../contracts/product-publication.js";
import { holdProductEditorContent } from "../../application/product-editor-content-authority.js";
import {
  createPostgresProductPublicationStore,
  productPublicationWriteFields,
  type ProductPublicationStoreOptions,
  type ProductPublicationWriteResult,
} from "./product-publication-store.js";
type Owner = Omit<ProductPublicationStoreOptions, "transactions" | "clock" | "actorKind">;
export interface ProductWholeScopeReplacementOptions {
  readonly publish: Owner;
  readonly supersede: Owner;
  readonly clock: { now(): string };
  readonly transactions: ProductPublicationStoreOptions["transactions"];
}
function fail(
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never {
  throw new CatalogError(code);
}
function pair(value: unknown) {
  const copied = copyCategoryPersistenceValue(value);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== 2 ||
    !Object.hasOwn(copied, "publish") ||
    !Object.hasOwn(copied, "supersede")
  )
    return fail("CATALOG_INPUT_INVALID");
  const r = copied as Record<string, unknown>,
    publish = parseProductPublicationCommand(r.publish),
    supersede = parseProductPublicationCommand(r.supersede);
  if (
    publish.action !== "Publish" ||
    publish.actorKind !== "User" ||
    supersede.action !== "Supersede" ||
    supersede.actorKind !== "System" ||
    publish.tenantReference !== supersede.tenantReference ||
    publish.brandReference !== supersede.brandReference ||
    publish.productReference !== supersede.productReference ||
    publish.versionReference === supersede.versionReference ||
    publish.operationReference === supersede.operationReference ||
    publish.successorDraftVersionReference === supersede.versionReference ||
    publish.expectedProductAggregateVersion > 2147483645 ||
    supersede.expectedProductAggregateVersion !== publish.expectedProductAggregateVersion + 1 ||
    supersede.expectedPublicationVersion < 1 ||
    supersede.replacementVersionReference !== publish.versionReference ||
    publish.replacementVersionReference !== null ||
    supersede.successorDraftVersionReference !== null ||
    publish.scheduleReference !== null ||
    supersede.scheduleReference !== null ||
    supersede.occurredAt !== publish.occurredAt ||
    canonicalizeRfc8785(publish.scopeSet) !== canonicalizeRfc8785(supersede.scopeSet)
  )
    return fail("CATALOG_INPUT_INVALID");
  return Object.freeze({ publish, supersede });
}
function capture(owner: Owner): Owner {
  return Object.freeze({
    tenantReference: parseCatalogReference(owner.tenantReference),
    brandReference: parseCatalogReference(owner.brandReference),
    actorReference: parseCatalogReference(owner.actorReference),
    ...(owner.editorContentAuthority === undefined
      ? {}
      : {
          editorContentAuthority: {
            holdUntilTransactionCompletes:
              owner.editorContentAuthority.holdUntilTransactionCompletes.bind(
                owner.editorContentAuthority,
              ),
          },
        }),
    authority: {
      holdUntilTransactionCompletes: owner.authority.holdUntilTransactionCompletes.bind(
        owner.authority,
      ),
    },
    sources: {
      withHeldCurrentFacts: owner.sources.withHeldCurrentFacts.bind(owner.sources),
      ...(owner.sources.withHeldScopePolicy === undefined
        ? {}
        : { withHeldScopePolicy: owner.sources.withHeldScopePolicy.bind(owner.sources) }),
    },
    audit: { create: owner.audit.create.bind(owner.audit) },
  });
}
/** Existing owning operations, one caller transaction. This factory creates no
 * validation, permission, policy, System capability or durable paired receipt. */
export function createPostgresProductWholeScopeReplacementStore(
  options: ProductWholeScopeReplacementOptions,
) {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.publish?.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.supersede?.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.publish?.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.publish?.sources?.withHeldScopePolicy !== "function" ||
    typeof options.supersede?.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.publish?.audit?.create !== "function" ||
    typeof options.supersede?.audit?.create !== "function"
  )
    return fail();
  const publishOwner = capture(options.publish),
    supersedeOwner = capture(options.supersede),
    run = options.transactions.run.bind(options.transactions),
    clock = options.clock.now.bind(options.clock);
  if (
    publishOwner.tenantReference !== supersedeOwner.tenantReference ||
    publishOwner.brandReference !== supersedeOwner.brandReference
  )
    return fail("CATALOG_PERMISSION_DENIED");
  const now = () => parseCatalogInstant(clock());
  return Object.freeze({
    async execute(value: unknown) {
      const commands = pair(value);
      for (const [owner, c] of [
        [publishOwner, commands.publish],
        [supersedeOwner, commands.supersede],
      ] as const)
        if (
          c.tenantReference !== owner.tenantReference ||
          c.brandReference !== owner.brandReference ||
          c.actorReference !== owner.actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
      let calls = 0,
        completed:
          | {
              readonly status: "Applied" | "Replayed";
              readonly published: ProductPublicationWriteResult;
              readonly superseded: ProductPublicationWriteResult;
              readonly eligibility: "NotEvaluated";
            }
          | undefined;
      try {
        const result = await run(async (tx) => {
          if (++calls !== 1) return fail();
          const leases: { observedAt: string; validUntil: string }[] = [];
          const check = () => {
            const at = now();
            if (leases.some((lease) => at < lease.observedAt || at >= lease.validUntil))
              return fail();
          };
          const ownerStore = (owner: Owner, actorKind: "User" | "System") =>
            createPostgresProductPublicationStore({
              ...owner,
              actorKind,
              clock: { now },
              transactions: { run: (work) => work(tx) },
              sources: {
                ...owner.sources,
                async withHeldCurrentFacts(currentTx, input, work) {
                  if (currentTx !== tx) return fail();
                  return owner.sources.withHeldCurrentFacts(tx, input, async (value) => {
                    const facts = copyCategoryPersistenceValue(value) as typeof value,
                      validation = parseProductPublicationValidation(facts.validation),
                      observedAt = parseCatalogInstant(facts.now);
                    leases.push({ observedAt, validUntil: validation.validUntil });
                    if (facts.approval !== null) {
                      const approval = parseProductPublicationApproval(facts.approval);
                      leases.push({ observedAt, validUntil: approval.validUntil });
                    }
                    check();
                    const result = await work(facts);
                    check();
                    return result;
                  });
                },
              },
            });
          const published = await ownerStore(publishOwner, "User").execute(commands.publish);
          if (published.status === "Applied") {
            if (!published.scopeJournal || published.scopeJournalStatus !== "Recorded")
              return fail();
            leases.push({
              observedAt: published.scopeJournal.plan.observedAt,
              validUntil: published.scopeJournal.validUntil,
            });
          }
          check();
          const superseded = await ownerStore(supersedeOwner, "System").execute(commands.supersede);
          if (published.status !== superseded.status) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          if (
            published.publication.state !== "Published" ||
            superseded.publication.state !== "Superseded" ||
            superseded.publication.supersededByVersionReference !==
              published.publication.versionReference ||
            published.publication.versionReference !== commands.publish.versionReference ||
            superseded.publication.versionReference !== commands.supersede.versionReference ||
            published.aggregate.aggregateVersion !==
              commands.publish.expectedProductAggregateVersion + 1 ||
            superseded.aggregate.aggregateVersion !==
              commands.publish.expectedProductAggregateVersion + 2 ||
            published.aggregate.draft.versionReference !==
              superseded.aggregate.draft.versionReference
          )
            return fail();
          check();
          // Both original caller contexts are checked after both tentative writes,
          // inside the actual outer UoW; source barriers/leases remain owning.
          for (const [owner, command] of [
            [publishOwner, commands.publish],
            [supersedeOwner, commands.supersede],
          ] as const) {
            await holdProductEditorContent(
              tx,
              owner.editorContentAuthority,
              superseded.aggregate,
              "Read",
            );
            check();
            await owner.authority.holdUntilTransactionCompletes(tx, {
              command,
              requiredPermissions: Object.freeze([
                "catalog.product.read",
                "catalog.product.publish",
              ]),
              requiredFields: productPublicationWriteFields,
              requiredScope: "FullBrandScope",
              observedAt: now(),
            });
            check();
          }
          completed = Object.freeze({
            status: published.status,
            published,
            superseded,
            eligibility: "NotEvaluated" as const,
          });
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        // A runner must not substitute another transaction/result for this pair.
        return completed;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
