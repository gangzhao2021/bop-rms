import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetHistoryRequest,
  parseCatalogOptionSetHistoricalDraftRequest,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoricalDraftResult,
  parseCatalogOptionSetHistoricalFrozenRequest,
  parseCatalogOptionSetHistoricalFrozenResult,
  optionSetHistoryFields,
  optionSetHistoricalDraftFields,
  optionSetHistoricalFrozenFields,
  type OptionSetHistoryStoreOptions,
} from "@rms/catalog";
import {
  parseOptionSetPublicationHistoryRequest,
  optionSetPublicationHistoryFields,
  type OptionSetPublicationHistoryStoreOptions,
} from "@bop/publishing";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
export function parseMerchantOptionSetHistorySelector(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), ["kind", "command"]);
  if (r.kind === "Draft")
    return Object.freeze({
      kind: "Draft" as const,
      command: parseCatalogOptionSetHistoricalDraftRequest(r.command),
    });
  if (r.kind === "Frozen")
    return Object.freeze({
      kind: "Frozen" as const,
      command: parseCatalogOptionSetHistoricalFrozenRequest(r.command),
    });
  return fail();
}
export function parseMerchantOptionSetHistoryPacket(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), ["action", "command"]);
  if (r.action === "List")
    return Object.freeze({
      action: "List" as const,
      command: parseCatalogOptionSetHistoryRequest(r.command),
    });
  if (r.action === "Draft")
    return Object.freeze({
      action: "Draft" as const,
      command: parseCatalogOptionSetHistoricalDraftRequest(r.command),
    });
  if (r.action === "Frozen")
    return Object.freeze({
      action: "Frozen" as const,
      command: parseCatalogOptionSetHistoricalFrozenRequest(r.command),
    });
  if (r.action === "Publishing") {
    const c = readClosedRecord(r.command, ["optionSetReference", "before", "limit"]),
      set = parseCatalogReference(c.optionSetReference),
      parsed = parseOptionSetPublicationHistoryRequest({
        familyReference: set,
        before: c.before,
        limit: c.limit,
      });
    return Object.freeze({
      action: "Publishing" as const,
      command: Object.freeze({
        optionSetReference: set,
        before: parsed.before,
        limit: parsed.limit,
      }),
    });
  }
  if (r.action === "Compare") {
    const c = readClosedRecord(r.command, ["left", "right"]),
      left = parseMerchantOptionSetHistorySelector(c.left),
      right = parseMerchantOptionSetHistorySelector(c.right);
    if (left.command.optionSetReference !== right.command.optionSetReference) return fail();
    return Object.freeze({ action: "Compare" as const, command: Object.freeze({ left, right }) });
  }
  return fail();
}
export function merchantOptionSetHistoryTarget(
  packet: ReturnType<typeof parseMerchantOptionSetHistoryPacket>,
) {
  return packet.action === "Compare"
    ? packet.command.left.command.optionSetReference
    : packet.command.optionSetReference;
}
export function merchantOptionSetCatalogHistoryReads(
  packet: ReturnType<typeof parseMerchantOptionSetHistoryPacket>,
) {
  if (packet.action === "Compare")
    return equal(packet.command.left, packet.command.right)
      ? Object.freeze([packet.command.left])
      : Object.freeze([packet.command.left, packet.command.right]);
  if (packet.action === "Publishing")
    return Object.freeze([
      {
        kind: "List" as const,
        command: parseCatalogOptionSetHistoryRequest({
          optionSetReference: packet.command.optionSetReference,
          expectedAggregateVersion: null,
          before: null,
          limit: 1,
        }),
      },
    ]);
  return Object.freeze([{ kind: packet.action, command: packet.command }]);
}
/** Current field-level history admission only. Historical facts carry no
 * publication qualification or write permission. */
export function createMerchantOptionSetHistoryRuntimeAuthority(options: {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly packet: ReturnType<typeof parseMerchantOptionSetHistoryPacket>;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly capability: ReturnType<typeof createMerchantProductStoreCapabilityGuard>;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}) {
  const tx = options.transaction,
    queryDescriptor = Object.getOwnPropertyDescriptor(tx, "query");
  if (
    !queryDescriptor ||
    !("value" in queryDescriptor) ||
    typeof queryDescriptor.value !== "function"
  )
    return fail();
  const query: Transaction["query"] = queryDescriptor.value;
  const clockPort = options.clock.now,
    registerPort = options.registerBeforeCommit,
    current = options.currentAuthorization,
    capability = options.capability,
    assertPort = current.assertCurrent,
    authorizationLeasePort = current.leaseDeadline,
    capabilityLeasePort = capability.leaseDeadline,
    combinedPort = capability.holdUntilCommitWithDecisions;
  if (
    typeof clockPort !== "function" ||
    typeof registerPort !== "function" ||
    typeof assertPort !== "function" ||
    typeof authorizationLeasePort !== "function" ||
    typeof capabilityLeasePort !== "function" ||
    typeof combinedPort !== "function"
  )
    return fail();
  const now = clockPort.bind(options.clock),
    register = registerPort.bind(options),
    assertAuthorization = assertPort.bind(current),
    authorizationLease = authorizationLeasePort.bind(current),
    capabilityLease = capabilityLeasePort.bind(capability),
    combined = combinedPort.bind(capability),
    intent = parseMerchantOptionSetHistoryPacket(options.packet),
    origin = parseCatalogInstant(options.originalObservedAt),
    originalDeadline = parseCatalogInstant(options.originalValidUntil),
    identity = Object.freeze({
      tenantReference: parseCatalogReference(options.tenantReference),
      brandReference: parseCatalogReference(options.brandReference),
      storeReference: parseCatalogReference(options.storeReference),
      actorReference: parseCatalogReference(options.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
    }),
    actions = Object.freeze(["catalog.manage", "catalog.option_set.history.read"]),
    reads = merchantOptionSetCatalogHistoryReads(intent),
    expected = reads.map((read) => {
      const observed: unknown = undefined;
      return {
        read,
        fields:
          read.kind === "List"
            ? optionSetHistoryFields
            : read.kind === "Draft"
              ? optionSetHistoricalDraftFields
              : optionSetHistoricalFrozenFields,
        initial: false,
        terminal: false,
        observed,
      };
    });
  if (originalDeadline <= origin || Date.parse(originalDeadline) - Date.parse(origin) > 5000)
    return fail();
  let latest = origin,
    deadline = originalDeadline,
    failed = false,
    active = false,
    registered = false,
    publishingObserved = false,
    guardStarted = false,
    guardCompleted = false,
    finalized = false;
  let knownFailure: CatalogError | undefined;
  const terminal = () =>
    expected.every((item) => item.terminal) &&
    (intent.action !== "Publishing" || publishingObserved);
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (
      error instanceof MerchantProductWriteFeatureDisabled ||
      (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
    ) {
      knownFailure ??= error;
      throw knownFailure;
    }
    return fail();
  };
  const check = () => {
    try {
      if (failed && knownFailure) throw knownFailure;
      const at = parseCatalogInstant(now()),
        descriptor = Object.getOwnPropertyDescriptor(tx, "query");
      if (
        failed ||
        options.transaction !== tx ||
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.value !== query ||
        options.clock.now !== clockPort ||
        options.registerBeforeCommit !== registerPort ||
        options.currentAuthorization !== current ||
        options.capability !== capability ||
        current.assertCurrent !== assertPort ||
        current.leaseDeadline !== authorizationLeasePort ||
        capability.leaseDeadline !== capabilityLeasePort ||
        capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalDeadline ||
        Object.entries(identity).some(([key, value]) => Reflect.get(options, key) !== value) ||
        !equal(parseMerchantOptionSetHistoryPacket(options.packet), intent) ||
        at < latest ||
        at >= deadline
      )
        return poison();
      assertAuthorization();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const tighten = () => {
    try {
      for (const value of [authorizationLease(), capabilityLease()]) {
        const until = parseCatalogInstant(value);
        if (until < deadline) deadline = until;
      }
      check();
    } catch (error) {
      return reject(error);
    }
  };
  const fresh = async () => {
    check();
    const decisions = await combined(actions);
    check();
    if (
      !Array.isArray(decisions) ||
      Object.getPrototypeOf(decisions) !== Array.prototype ||
      decisions.length !== actions.length ||
      Reflect.ownKeys(decisions).length !== actions.length + 1
    )
      return poison();
    const descriptors = Object.getOwnPropertyDescriptors(decisions);
    for (let i = 0; i < actions.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !d.enumerable || !("value" in d)) return poison();
      const row = readClosedRecord(d.value, [
          "effect",
          "reason",
          "source",
          "action",
          "scopeKind",
          "policySnapshotReference",
          "policyVersion",
          "audit",
        ]),
        audit = readClosedRecord(row.audit, ["effect", "reason", "source"]);
      if (row.effect !== "Allow" || row.scopeKind !== "Brand")
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (
        row.action !== actions[i] ||
        (row.reason !== "EXPLICIT_ALLOW" && row.reason !== "ROLE_PERMISSION") ||
        (row.source !== "ExplicitAllow" && row.source !== "RolePermission") ||
        (row.reason === "EXPLICIT_ALLOW") !== (row.source === "ExplicitAllow") ||
        audit.effect !== row.effect ||
        audit.reason !== row.reason ||
        audit.source !== row.source
      )
        return poison();
      parseBusinessAction(row.action);
      parsePolicyReference(row.policySnapshotReference);
      parsePolicyVersion(row.policyVersion);
    }
    tighten();
  };
  const registerGuard = async () => {
    if (
      !registered &&
      ((intent.action !== "Compare" && intent.action !== "Publishing") || terminal())
    ) {
      registered = true;
      if (
        (await register(
          tx,
          async () => {
            if (guardStarted || active || finalized || !terminal()) return poison();
            guardStarted = true;
            active = true;
            try {
              await fresh();
              guardCompleted = true;
            } catch (error) {
              return reject(error);
            } finally {
              active = false;
            }
          },
          () => {
            if (!guardCompleted || active || finalized || !terminal()) return poison();
            check();
            tighten();
            finalized = true;
          },
        )) !== undefined
      )
        return poison();
      check();
    }
  };
  const authority: OptionSetHistoryStoreOptions["authority"] = {
    async holdUntilTransactionCompletes(actual, value) {
      try {
        check();
        if (actual !== tx || active || guardStarted || finalized) return poison();
        active = true;
        const r = readClosedRecord(copyCategoryPersistenceValue(value), [
            "tenantReference",
            "brandReference",
            "actorReference",
            "actorKind",
            "permission",
            "action",
            "purposeCode",
            "requiredFields",
            "request",
            "content",
            "observedAt",
          ]),
          at = parseCatalogInstant(r.observedAt);
        const selected = expected.find(
          (item) => equal(r.request, item.read.command) && equal(r.requiredFields, item.fields),
        );
        if (
          !selected ||
          r.tenantReference !== identity.tenantReference ||
          r.brandReference !== identity.brandReference ||
          r.actorReference !== identity.actorReference ||
          r.actorKind !== "User" ||
          r.permission !== "catalog.manage" ||
          r.action !== "catalog.option_set.history.read" ||
          r.purposeCode !== "CATALOG_OPTION_SET_HISTORY" ||
          at < origin ||
          at > check()
        )
          return poison();
        if (r.content === null) {
          if (selected.initial || selected.terminal) return poison();
          selected.initial = true;
        } else {
          if (!selected.initial) return poison();
          const content =
            selected.read.kind === "List"
              ? parseCatalogOptionSetHistoryResult(r.content, selected.read.command)
              : selected.read.kind === "Draft"
                ? parseCatalogOptionSetHistoricalDraftResult(r.content, selected.read.command)
                : parseCatalogOptionSetHistoricalFrozenResult(r.content, selected.read.command);
          if (
            content.tenantReference !== identity.tenantReference ||
            content.brandReference !== identity.brandReference ||
            content.optionSetReference !== merchantOptionSetHistoryTarget(intent) ||
            content.observedAt < origin ||
            content.observedAt > check() ||
            content.validUntil > originalDeadline ||
            (selected.terminal &&
              (!selected.observed ||
                !equal(
                  { ...content, validUntil: originalDeadline },
                  {
                    ...readClosedRecord(selected.observed, Object.keys(content)),
                    validUntil: originalDeadline,
                  },
                )))
          )
            return poison();
          selected.observed = content;
          selected.terminal = true;
        }
        await fresh();
        await registerGuard();
        return Object.freeze({ observedAt: at, validUntil: deadline });
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  };
  const publishingAuthority: OptionSetPublicationHistoryStoreOptions["authority"] = {
    async holdUntilTransactionCompletes(actual, value) {
      try {
        check();
        if (
          intent.action !== "Publishing" ||
          actual !== tx ||
          active ||
          guardStarted ||
          finalized ||
          !expected.every((item) => item.terminal)
        )
          return poison();
        active = true;
        const r = readClosedRecord(copyCategoryPersistenceValue(value), [
            "tenantReference",
            "brandReference",
            "selectedStoreReference",
            "actorReference",
            "actorKind",
            "familyReference",
            "permission",
            "requiredPermissions",
            "purposeCode",
            "requiredFields",
            "observedAt",
            "validUntil",
          ]),
          at = parseCatalogInstant(r.observedAt),
          until = parseCatalogInstant(r.validUntil);
        if (
          r.tenantReference !== identity.tenantReference ||
          r.brandReference !== identity.brandReference ||
          r.selectedStoreReference !== identity.storeReference ||
          r.actorReference !== identity.actorReference ||
          r.actorKind !== "User" ||
          r.familyReference !== merchantOptionSetHistoryTarget(intent) ||
          r.permission !== "catalog.manage" ||
          !equal(r.requiredPermissions, actions) ||
          r.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION_HISTORY" ||
          !equal(r.requiredFields, optionSetPublicationHistoryFields) ||
          at < origin ||
          at > check() ||
          until <= at ||
          until > originalDeadline
        )
          return poison();
        await fresh();
        publishingObserved = true;
        await registerGuard();
        return Object.freeze({ validUntil: deadline < until ? deadline : until });
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  };
  return Object.freeze({
    authority: Object.freeze(authority),
    publishingAuthority: Object.freeze(publishingAuthority),
    assertCurrent: () => {
      check();
    },
    leaseDeadline: () => {
      if (!terminal() || active) return poison();
      tighten();
      return deadline;
    },
  });
}
