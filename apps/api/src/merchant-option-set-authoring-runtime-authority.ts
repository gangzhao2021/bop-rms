import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseFullOptionSetCreateCommand,
  parseFullOptionSetEditCommand,
  parseCatalogOptionSetEditorContent,
  type FullOptionSetCreateAuthority,
  type FullOptionSetEditAuthority,
  type CurrentFullOptionSetDraftAuthority,
  type OptionSetEditorContent,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
export type MerchantOptionSetAuthoringPacket = Readonly<{
  action: "Create" | "Edit" | "Read";
  command: unknown;
}>;
const contentFields = Object.freeze([
  "optionSetReference",
  "versionReference",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
]);
const createFields = Object.freeze(["internalCode", ...contentFields]);
const editFields = Object.freeze([
  "internalCode",
  "aggregateVersion",
  "archiveOptionReferences",
  ...contentFields,
]);
const readFields = Object.freeze([
  "internalCode",
  "brandReference",
  "lifecycle",
  "aggregateVersion",
  "createdAt",
  "createdByActorReference",
  "updatedAt",
  ...contentFields,
]);
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function fullContent(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "sourceAggregate",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
  ]);
  const { sourceAggregate, ...additional } = r;
  return parseCatalogOptionSetEditorContent(sourceAggregate, additional).content;
}
function packet(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), ["action", "command"]);
  if (r.action === "Create")
    return immutable({
      action: "Create" as const,
      command: parseFullOptionSetCreateCommand(r.command),
    });
  if (r.action === "Edit")
    return immutable({
      action: "Edit" as const,
      command: parseFullOptionSetEditCommand(r.command),
    });
  if (r.action !== "Read") return fail();
  const command = readClosedRecord(r.command, ["optionSetReference", "expectedAggregateVersion"]);
  if (
    command.expectedAggregateVersion !== null &&
    (!Number.isSafeInteger(command.expectedAggregateVersion) ||
      (command.expectedAggregateVersion as number) < 1 ||
      (command.expectedAggregateVersion as number) > 2147483647)
  )
    return fail();
  return immutable({
    action: "Read" as const,
    command: {
      optionSetReference: parseCatalogReference(command.optionSetReference),
      expectedAggregateVersion: command.expectedAggregateVersion as number | null,
    },
  });
}

/** Request-owned ordinary Create/Edit/Read admission. No reference eligibility,
 * publication proof, browser recovery or content/source validation is supplied. */
export function createMerchantOptionSetAuthoringRuntimeAuthority(options: {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly packet: MerchantOptionSetAuthoringPacket;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly capability: ReturnType<typeof createMerchantProductStoreCapabilityGuard>;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}) {
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.currentAuthorization.authorizeActions.bind(options.currentAuthorization),
    assertAuthorization = options.currentAuthorization.assertCurrent.bind(
      options.currentAuthorization,
    ),
    authorizationLease = options.currentAuthorization.leaseDeadline?.bind(
      options.currentAuthorization,
    ),
    capabilityLease = options.capability.leaseDeadline?.bind(options.capability),
    holdCapability = options.capability.holdUntilCommit.bind(options.capability),
    register = options.registerBeforeCommit.bind(options),
    intent = packet(options.packet),
    startedAt = parseCatalogInstant(now()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil),
    identity = immutable({
      tenantReference: parseCatalogReference(options.tenantReference),
      brandReference: parseCatalogReference(options.brandReference),
      storeReference: parseCatalogReference(options.storeReference),
      actorReference: parseCatalogReference(options.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
    });
  if (
    !authorizationLease ||
    !capabilityLease ||
    originalDeadline <= startedAt ||
    Date.parse(originalDeadline) - Date.parse(startedAt) > 5000
  )
    return fail();
  const action =
    intent.action === "Create"
      ? "catalog.option_set.create"
      : intent.action === "Edit"
        ? "catalog.option_set.update"
        : "catalog.option_set.read";
  const requiredFields =
    intent.action === "Create" ? createFields : intent.action === "Edit" ? editFields : readFields;
  let deadline = originalDeadline,
    latest = startedAt,
    failed = false,
    active = false,
    registered = false,
    guardStarted = false,
    guardCompleted = false,
    finalized = false;
  let target: string | null = intent.action === "Create" ? null : intent.command.optionSetReference;
  let terminal = false,
    createIntentObserved = false;
  let editFacts: Readonly<{
    phase: "Apply" | "Replay";
    original: OptionSetEditorContent;
    proposed: OptionSetEditorContent;
  }> | null = null;
  let observedContent: OptionSetEditorContent | null = null;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (
      error instanceof MerchantProductWriteFeatureDisabled ||
      (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
    )
      throw error;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return poison();
      assertAuthorization();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const tighten = () => {
    try {
      const authorizationUntil = parseCatalogInstant(authorizationLease()),
        capabilityUntil = parseCatalogInstant(capabilityLease());
      deadline = authorizationUntil < deadline ? authorizationUntil : deadline;
      deadline = capabilityUntil < deadline ? capabilityUntil : deadline;
      check();
    } catch (error) {
      return reject(error);
    }
  };
  const revalidate = async () => {
    check();
    if ((await holdCapability()) !== undefined) return poison();
    check();
    // Restore actual Brand policy scope after the selected Store capability reads.
    if ((await authorize(Object.freeze(["catalog.manage", action]))) !== undefined) return poison();
    check();
    tighten();
  };
  const registerGuard = async () => {
    if (registered) return;
    registered = true;
    if (
      (await register(
        tx,
        async () => {
          if (guardStarted || active || finalized || !terminal) return poison();
          guardStarted = true;
          active = true;
          try {
            await revalidate();
            guardCompleted = true;
          } catch (error) {
            return reject(error);
          } finally {
            active = false;
          }
        },
        () => {
          if (!guardCompleted || active || finalized || !terminal) return poison();
          check();
          tighten();
          finalized = true;
        },
      )) !== undefined
    )
      return poison();
    check();
  };
  type CreateInput = Parameters<FullOptionSetCreateAuthority["holdUntilTransactionCompletes"]>[1];
  type EditInput = Parameters<FullOptionSetEditAuthority["holdUntilTransactionCompletes"]>[1];
  type ReadInput = Parameters<
    CurrentFullOptionSetDraftAuthority["holdUntilTransactionCompletes"]
  >[1];
  const hold = async (actual: Transaction, value: CreateInput | EditInput | ReadInput) => {
    try {
      check();
      if (actual !== tx || active || guardStarted || finalized) return poison();
      active = true;
      const variable =
        intent.action === "Create"
          ? ["optionSetReference", "proposedCommand"]
          : intent.action === "Edit"
            ? ["phase", "proposedCommand", "originalContent", "proposedContent"]
            : ["optionSetReference", "content"];
      const input = readClosedRecord(copyCategoryPersistenceValue(value), [
        "tenantReference",
        "brandReference",
        "actorReference",
        "actorKind",
        "permission",
        "action",
        "purposeCode",
        "requiredFields",
        "observedAt",
        ...variable,
      ]);
      const observation = parseCatalogInstant(input.observedAt);
      if (
        observation < startedAt ||
        observation > check() ||
        input.tenantReference !== identity.tenantReference ||
        input.brandReference !== identity.brandReference ||
        input.actorReference !== identity.actorReference ||
        input.actorKind !== "User" ||
        input.permission !== "catalog.manage" ||
        input.action !== action ||
        input.purposeCode !== "CATALOG_OPTION_SET_DRAFT" ||
        !equal(input.requiredFields, requiredFields)
      )
        return poison();
      if (intent.action === "Create") {
        if (!equal(parseFullOptionSetCreateCommand(input.proposedCommand), intent.command))
          return poison();
        const proposedTarget =
          input.optionSetReference === null
            ? null
            : parseCatalogReference(input.optionSetReference);
        if (target !== null && proposedTarget !== target) return poison();
        if (proposedTarget !== null && !createIntentObserved) return poison();
        if (proposedTarget === null) createIntentObserved = true;
        if (proposedTarget !== null) {
          target = proposedTarget;
          terminal = true;
        }
      } else if (intent.action === "Edit") {
        if (!equal(parseFullOptionSetEditCommand(input.proposedCommand), intent.command))
          return poison();
        if (input.phase === "Intent") {
          if (
            editFacts !== null ||
            input.originalContent !== null ||
            input.proposedContent !== null
          )
            return poison();
        } else {
          if (input.phase !== "Apply" && input.phase !== "Replay") return poison();
          const original = fullContent(input.originalContent),
            proposed = fullContent(input.proposedContent);
          if (
            original.sourceAggregate.optionSetReference !== target ||
            proposed.sourceAggregate.optionSetReference !== target ||
            original.sourceAggregate.brandReference !== identity.brandReference ||
            proposed.sourceAggregate.brandReference !== identity.brandReference ||
            original.sourceAggregate.aggregateVersion !== intent.command.expectedAggregateVersion ||
            proposed.sourceAggregate.aggregateVersion !==
              intent.command.expectedAggregateVersion + 1
          )
            return poison();
          const facts: NonNullable<typeof editFacts> = immutable({
            phase: input.phase,
            original,
            proposed,
          });
          if (editFacts !== null && !equal(editFacts, facts)) return poison();
          editFacts = facts;
          terminal = true;
        }
      } else {
        if (input.optionSetReference !== target) return poison();
        if (input.content !== null) {
          const content = fullContent(input.content);
          if (
            content.sourceAggregate.optionSetReference !== target ||
            content.sourceAggregate.brandReference !== identity.brandReference ||
            (intent.command.expectedAggregateVersion !== null &&
              content.sourceAggregate.aggregateVersion !==
                intent.command.expectedAggregateVersion) ||
            (observedContent !== null && !equal(observedContent, content))
          )
            return poison();
          observedContent = immutable(content);
          terminal = true;
        } else if (observedContent !== null) return poison();
      }
      await revalidate();
      active = false;
      await registerGuard();
      check();
      return Object.freeze({ observedAt: observation, validUntil: deadline });
    } catch (error) {
      return reject(error);
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    creation: Object.freeze({
      holdUntilTransactionCompletes: (actual: Transaction, input: CreateInput) =>
        hold(actual, input),
    }) satisfies FullOptionSetCreateAuthority,
    editing: Object.freeze({
      holdUntilTransactionCompletes: (actual: Transaction, input: EditInput) => hold(actual, input),
    }) satisfies FullOptionSetEditAuthority,
    reading: Object.freeze({
      holdUntilTransactionCompletes: (actual: Transaction, input: ReadInput) => hold(actual, input),
    }) satisfies CurrentFullOptionSetDraftAuthority,
    assertCurrent() {
      if (finalized) return poison();
      return check();
    },
  });
}
