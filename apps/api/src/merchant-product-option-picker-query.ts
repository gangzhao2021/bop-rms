import { v7 as uuidV7 } from "uuid";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresFrozenFullOptionSetContentStore,
  frozenFullOptionSetContentFields,
  parseCatalogFullOptionSetPublicationContent,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import { createCurrentPublishedOptionSetGraphSource } from "./current-published-option-set-graph.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Content = ReturnType<typeof parseCatalogOptionSetEditorContent>["content"];
type Draft = Content["sourceAggregate"]["draft"];
export interface MerchantProductOptionBindingPickerView {
  readonly profile: "CatalogProductOptionBindingPickerV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly bindingReference: string;
  readonly internalCode: string;
  readonly defaultLocale: string;
  readonly localizedNames: Draft["localizedNames"];
  readonly rootSelectionRule: Pick<
    Draft,
    | "minimumSelection"
    | "maximumSelection"
    | "allowRepeatedOption"
    | "perOptionMaximumQuantity"
    | "maximumTotalQuantity"
    | "displayStyle"
  >;
  readonly options: readonly Readonly<
    Pick<
      Draft["options"][number],
      | "optionReference"
      | "stableCode"
      | "lifecycle"
      | "localizedNames"
      | "sortOrder"
      | "defaultEligible"
    > & {
      quantityRule: Content["optionDetails"][number]["quantityRule"];
      selectionDisabled: boolean;
      disabledReason: "OptionArchived" | null;
    }
  >[];
  readonly selectionDisabled: boolean;
  readonly disabledReason: "OptionSetArchived" | null;
  readonly originalRecordDigest: string;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly sourceAuthority: "CurrentPublishingReleaseAndFrozenContent" | "RecordedFrozen";
  readonly publicationReference: string | null;
  readonly referenceEligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantProductOptionPickerQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
};

/** Selected-item projection only. The generated Binding ID is an unpersisted
 * server preparation; Product Draft Save independently rechecks its exact source. */
export function createMerchantProductOptionPickerQuery(
  options: MerchantProductOptionPickerQueryOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication);
  const merchant = Object.freeze({
    ...options.merchant,
    now: clock,
    transactions: { run },
    ...(options.merchant.validateAssociation
      ? { validateAssociation: options.merchant.validateAssociation.bind(options.merchant) }
      : {}),
    ...(options.merchant.currentActor
      ? { currentActor: options.merchant.currentActor.bind(options.merchant) }
      : {}),
  });
  const resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantProductOptionBindingPickerView> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let command: Readonly<{ optionSetReference: string; versionReference: string | null }>;
    try {
      const raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "optionSetReference",
        "versionReference",
      ]);
      command = Object.freeze({
        optionSetReference: parseCatalogReference(raw.optionSetReference),
        versionReference:
          raw.versionReference === null ? null : parseCatalogReference(raw.versionReference),
      });
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      deadline = new Date(Date.parse(latest) + 5000).toISOString(),
      failed = false;
    const startedAt = latest,
      originalDeadline = deadline;
    const poison = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return poison();
        latest = at;
        return at;
      } catch {
        return poison();
      }
    };
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      sourceCalls = 0,
      finalized = false,
      completed: MerchantProductOptionBindingPickerView | undefined;
    let finalizeGraph: (() => string) | undefined, finalLease: (() => string) | undefined;
    try {
      const result = await host.transactions.run(async (tx) => {
        if (++calls !== 1) return poison();
        const query = tx.query;
        let ready = false,
          guardCalls = 0,
          guardComplete = false,
          finalCalls = 0;
        const checkTransaction = () => {
          now();
          if (tx.query !== query) return poison();
        };
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        checkTransaction();
        const bound = bindMerchantProductCommandScope(
          {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.selectedStoreReference,
          },
          expected,
        );
        const tenant = parseCatalogReference(scope.tenantReference),
          actor = parseCatalogReference(scope.actorReference);
        const current = createMerchantProductCurrentAuthorization({
          merchant,
          transaction: tx,
          scope,
          sessionCookie,
          sessionReference: session.sessionReference,
          clock: { now },
          originalValidUntil: originalDeadline,
          capabilityKey: "catalog.cat_product_edit",
        });
        const capability = createMerchantProductStoreCapabilityGuard({
          transaction: tx,
          tenantReference: tenant,
          brandReference: bound.brandReference,
          storeReference: bound.storeReference,
          actorReference: actor,
          clock: { now },
          originalValidUntil: originalDeadline,
          currentAuthorization: current,
          registerBeforeCommit: host.registerBeforeCommit,
          capabilityKey: "catalog.cat_product_edit",
        });
        const assertPort = current.assertCurrent,
          leasePort = current.leaseDeadline,
          capabilityLeasePort = capability.leaseDeadline,
          holdPort = capability.holdUntilCommitWithDecisions,
          capabilityPort = capability.holdUntilCommit,
          authorizePort = current.authorizeActions;
        if (
          typeof assertPort !== "function" ||
          typeof leasePort !== "function" ||
          typeof capabilityLeasePort !== "function" ||
          typeof holdPort !== "function" ||
          typeof capabilityPort !== "function" ||
          typeof authorizePort !== "function"
        )
          return poison();
        const assert = assertPort.bind(current),
          lease = leasePort.bind(current),
          capabilityLease = capabilityLeasePort.bind(capability),
          combined = holdPort.bind(capability);
        const check = () => {
          checkTransaction();
          if (
            current.assertCurrent !== assertPort ||
            current.leaseDeadline !== leasePort ||
            current.authorizeActions !== authorizePort ||
            capability.holdUntilCommitWithDecisions !== holdPort ||
            capability.holdUntilCommit !== capabilityPort ||
            capability.leaseDeadline !== capabilityLeasePort
          )
            return poison();
          parseCatalogInstant(assert());
        };
        const tighten = () => {
          check();
          const a = parseCatalogInstant(lease()),
            b = parseCatalogInstant(capabilityLease());
          if (a < deadline) deadline = a;
          if (b < deadline) deadline = b;
          now();
          return deadline;
        };
        const actions = Object.freeze(["catalog.manage", "catalog.option_set.read"]);
        const hold = async () => {
          check();
          const packet = await combined(actions);
          check();
          if (
            !Array.isArray(packet) ||
            !Object.isFrozen(packet) ||
            Object.getPrototypeOf(packet) !== Array.prototype ||
            packet.length !== actions.length ||
            Reflect.ownKeys(packet).length !== packet.length + 1
          )
            return poison();
          const values = copyCategoryPersistenceValue(packet);
          if (!Array.isArray(values)) return poison();
          for (let i = 0; i < actions.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(packet, String(i));
            if (
              !descriptor?.enumerable ||
              !("value" in descriptor) ||
              !Object.isFrozen(descriptor.value)
            )
              return poison();
            const audit = Object.getOwnPropertyDescriptor(descriptor.value, "audit");
            if (!audit || !("value" in audit) || !Object.isFrozen(audit.value)) return poison();
            const d = readClosedRecord(values[i], [
                "effect",
                "reason",
                "source",
                "action",
                "scopeKind",
                "policySnapshotReference",
                "policyVersion",
                "audit",
              ]),
              a = readClosedRecord(d.audit, ["effect", "reason", "source"]);
            if (
              d.action !== actions[i] ||
              d.effect !== "Allow" ||
              d.scopeKind !== "Brand" ||
              !(
                (d.reason === "ROLE_PERMISSION" && d.source === "RolePermission") ||
                (d.reason === "EXPLICIT_ALLOW" && d.source === "ExplicitAllow")
              ) ||
              a.effect !== d.effect ||
              a.reason !== d.reason ||
              a.source !== d.source
            )
              return poison();
            parseBusinessAction(d.action);
            parsePolicyReference(d.policySnapshotReference);
            parsePolicyVersion(d.policyVersion);
          }
          tighten();
        };
        if (
          (await host.registerBeforeCommit(
            tx,
            async () => {
              if (!ready || ++guardCalls !== 1) return poison();
              await hold();
              check();
              guardComplete = true;
            },
            () => {
              if (!ready || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1)
                return poison();
              tighten();
              finalized = true;
            },
          )) !== undefined
        )
          return poison();
        await hold();
        let content: Content,
          originalRecordDigest: string,
          publicationReference: string | null = null,
          sourceAuthority: MerchantProductOptionBindingPickerView["sourceAuthority"],
          observedAt: string;
        if (command.versionReference === null) {
          const graph = createCurrentPublishedOptionSetGraphSource({
            transaction: tx,
            tenantReference: tenant,
            brandReference: bound.brandReference,
            storeReference: bound.storeReference,
            actorReference: actor,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            currentAuthorization: current,
            capability,
            registerBeforeCommit: host.registerBeforeCommit,
            events: { generateReference: () => poison() },
          });
          finalizeGraph = graph.assertFinalized.bind(graph);
          const source = await graph.withCurrentGraph(command, async (packet) => {
            if (++sourceCalls !== 1) return poison();
            check();
            return packet;
          });
          check();
          const root = source.graph.contents.find(
              (item) => item.sourceAggregate.optionSetReference === command.optionSetReference,
            ),
            record = source.sourceRecords.find(
              (item) => item.optionSetReference === command.optionSetReference,
            );
          if (
            source.profile !== "CurrentPublishedOptionSetGraphV1" ||
            source.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent" ||
            source.graph.brandReference !== bound.brandReference ||
            source.graph.rootOptionSetReference !== command.optionSetReference ||
            !root ||
            !record ||
            record.versionReference !== source.graph.rootVersionReference ||
            root.sourceAggregate.draft.versionReference !== record.versionReference ||
            source.referenceEligibility !== "NotEvaluated" ||
            source.eligibility !== "NotEvaluated" ||
            source.publishValidation !== "Incomplete"
          )
            return poison();
          const { sourceAggregate, ...additional } = root;
          content = parseCatalogOptionSetEditorContent(sourceAggregate, additional).content;
          originalRecordDigest = digest(record.sealRecordDigest);
          publicationReference = parseCatalogReference(record.publicationReference);
          sourceAuthority = source.sourceAuthority;
          observedAt = parseCatalogInstant(source.observedAt);
          const until = parseCatalogInstant(source.validUntil);
          if (until > originalDeadline || until <= observedAt) return poison();
          if (until < deadline) deadline = until;
        } else {
          const frozen = createPostgresFrozenFullOptionSetContentStore({
            tenantReference: tenant,
            brandReference: bound.brandReference,
            actorReference: actor,
            clock: { now },
            transactions: {
              async run(work) {
                if (++sourceCalls !== 1) return poison();
                check();
                const value = await work(tx);
                check();
                return value;
              },
            },
            authority: {
              async holdUntilTransactionCompletes(actual, input) {
                check();
                if (
                  actual !== tx ||
                  input.tenantReference !== tenant ||
                  input.brandReference !== bound.brandReference ||
                  input.actorReference !== actor ||
                  input.actorKind !== "User" ||
                  input.permission !== "catalog.manage" ||
                  input.action !== "catalog.option_set.read" ||
                  input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
                  !equal(input.requiredFields, frozenFullOptionSetContentFields) ||
                  input.optionSetReference !== command.optionSetReference ||
                  input.versionReference !== command.versionReference
                )
                  return poison();
                const at = parseCatalogInstant(input.observedAt);
                if (at < startedAt || at > now()) return poison();
                if (input.content !== null) {
                  const value = parseCatalogFullOptionSetPublicationContent(
                    copyCategoryPersistenceValue(input.content),
                  );
                  if (
                    value.supportedContent.tenantReference !== tenant ||
                    value.supportedContent.brandReference !== bound.brandReference ||
                    value.supportedContent.optionSetReference !== command.optionSetReference ||
                    value.supportedContent.versionReference !== command.versionReference ||
                    value.supportedContent.sealedAt > at
                  )
                    return poison();
                }
                await hold();
                return Object.freeze({ observedAt: at, validUntil: deadline });
              },
            },
          });
          const observation = await frozen.readPinned({
            optionSetReference: command.optionSetReference,
            versionReference: command.versionReference,
            expectedRecordDigest: null,
          });
          check();
          const raw = readClosedRecord(copyCategoryPersistenceValue(observation), [
              "content",
              "observedAt",
              "validUntil",
              "eligibility",
            ]),
            value = parseCatalogFullOptionSetPublicationContent(raw.content);
          if (
            raw.eligibility !== "NotEvaluated" ||
            value.supportedContent.tenantReference !== tenant ||
            value.supportedContent.brandReference !== bound.brandReference ||
            value.supportedContent.optionSetReference !== command.optionSetReference ||
            value.supportedContent.versionReference !== command.versionReference
          )
            return poison();
          content = value.editorContent;
          originalRecordDigest = digest(value.digest);
          sourceAuthority = "RecordedFrozen";
          observedAt = parseCatalogInstant(raw.observedAt);
          const until = parseCatalogInstant(raw.validUntil);
          if (until > originalDeadline || until <= observedAt) return poison();
          if (until < deadline) deadline = until;
        }
        check();
        const root = content.sourceAggregate,
          draft = root.draft,
          { sourceAggregate, ...additional } = content,
          parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
        if (
          root.brandReference !== bound.brandReference ||
          root.optionSetReference !== command.optionSetReference ||
          (command.versionReference !== null &&
            draft.versionReference !== command.versionReference) ||
          observedAt < startedAt ||
          observedAt > now() ||
          root.updatedAt > observedAt ||
          sourceCalls !== 1
        )
          return poison();
        const projected = draft.options.map((option) => {
          const detail = content.optionDetails.find(
            (item) => item.optionReference === option.optionReference,
          );
          if (!detail) return poison();
          return Object.freeze({
            optionReference: option.optionReference,
            stableCode: option.stableCode,
            lifecycle: option.lifecycle,
            localizedNames: option.localizedNames,
            sortOrder: option.sortOrder,
            defaultEligible: option.defaultEligible,
            quantityRule: detail.quantityRule,
            selectionDisabled: option.lifecycle === "Archived",
            disabledReason: option.lifecycle === "Archived" ? ("OptionArchived" as const) : null,
          });
        });
        ready = true;
        finalLease = tighten;
        check();
        completed = Object.freeze({
          profile: "CatalogProductOptionBindingPickerV1",
          tenantReference: tenant,
          brandReference: bound.brandReference,
          storeReference: bound.storeReference,
          actorReference: actor,
          optionSetReference: command.optionSetReference,
          versionReference: draft.versionReference,
          bindingReference: parseCatalogReference(uuidV7()),
          internalCode: root.internalCode,
          defaultLocale: draft.defaultLocale,
          localizedNames: draft.localizedNames,
          rootSelectionRule: Object.freeze({
            minimumSelection: draft.minimumSelection,
            maximumSelection: draft.maximumSelection,
            allowRepeatedOption: draft.allowRepeatedOption,
            perOptionMaximumQuantity: draft.perOptionMaximumQuantity,
            maximumTotalQuantity: draft.maximumTotalQuantity,
            displayStyle: draft.displayStyle,
          }),
          options: Object.freeze(projected),
          selectionDisabled: root.lifecycle === "Archived",
          disabledReason: root.lifecycle === "Archived" ? "OptionSetArchived" : null,
          originalRecordDigest,
          sourceDigest: parsed.sourceDigest,
          contentDigest: parsed.contentDigest,
          configurationDigest: parsed.configurationDigest,
          sourceAuthority,
          publicationReference,
          referenceEligibility: "NotEvaluated",
          publishValidation: "Incomplete",
          observedAt,
          validUntil: deadline,
        });
        return completed;
      });
      if (
        calls !== 1 ||
        sourceCalls !== 1 ||
        !finalized ||
        !completed ||
        result !== completed ||
        !finalLease
      )
        return poison();
      const lease = parseCatalogInstant(finalLease());
      if (lease < deadline) deadline = lease;
      if (finalizeGraph) {
        const graphDeadline = parseCatalogInstant(finalizeGraph());
        if (graphDeadline < deadline) deadline = graphDeadline;
      }
      now();
      return Object.freeze({ ...result, validUntil: deadline });
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID") throw error;
      if (error instanceof MerchantProductWriteFeatureDisabled) throw error;
      return fail();
    }
  };
}
