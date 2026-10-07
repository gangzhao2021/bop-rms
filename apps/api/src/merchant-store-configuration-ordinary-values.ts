import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  parseCanonicalInstant,
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
} from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  parseStoreConfigurationOrdinaryReceipt,
  StoreConfigurationOriginalError,
  type StoreConfigurationOriginalScope,
  type StoreConfigurationOrdinaryHead,
  type StoreConfigurationOrdinaryReceipt,
  type StoreConfigurationVersion,
  type StoreConfigurationHistoryPage,
  type StoreConfigurationHistoryEntry,
} from "@rms/store";

export interface MerchantStoreConfigurationOrdinaryWorkspace {
  readonly profile: "StoreConfigurationOrdinaryWorkspaceV1";
  readonly scope: StoreConfigurationOriginalScope;
  readonly latest: StoreConfigurationVersion | null;
  readonly current: StoreConfigurationVersion | null;
  readonly expectedHead: StoreConfigurationOrdinaryHead;
  readonly original: StoreConfigurationOrdinaryReceipt | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly businessReferenceValidation: "NotEvaluated";
}

export function parseMerchantStoreConfigurationHistoryPage(
  value: unknown,
  expectedScope: StoreConfigurationOriginalScope,
  beforeSequence: number | null,
): StoreConfigurationHistoryPage {
  try {
    if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))
      return invalid();
    const r = readClosedRecord(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "readerActorReference",
      "beforeSequence",
      "entries",
      "nextBeforeSequence",
      "observedAt",
      "validUntil",
    ]);
    if (
      r.tenantReference !== expectedScope.tenantReference ||
      r.brandReference !== expectedScope.brandReference ||
      r.storeReference !== expectedScope.storeReference ||
      r.readerActorReference !== expectedScope.actorReference ||
      r.beforeSequence !== beforeSequence
    )
      return invalid();
    const observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return invalid();
    const raw = r.entries;
    if (
      !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length > 2 ||
      Reflect.ownKeys(raw).length !== raw.length + 1
    )
      return invalid();
    let previous = beforeSequence ?? Number.MAX_SAFE_INTEGER + 1;
    const entries: StoreConfigurationHistoryEntry[] = Array.from(
      { length: raw.length },
      (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        const e = readClosedRecord(descriptor.value, [
          "sequenceNumber",
          "operationReference",
          "command",
          "configuration",
          "intentDigest",
          "actorReference",
          "purposeCode",
          "auditReference",
          "occurredAt",
          "expectedVersion",
        ]);
        if (
          typeof e.sequenceNumber !== "number" ||
          !Number.isSafeInteger(e.sequenceNumber) ||
          e.sequenceNumber < 1 ||
          e.sequenceNumber >= previous
        )
          return invalid();
        previous = e.sequenceNumber;
        const command = e.command;
        if (
          command !== "SaveDraft" &&
          command !== "Validate" &&
          command !== "Submit" &&
          command !== "Approve" &&
          command !== "Publish"
        )
          return invalid();
        const configuration = createStoreConfigurationVersion(e.configuration),
          occurredAt = parseCanonicalInstant(e.occurredAt);
        const lifecycle =
          command === "SaveDraft" || command === "Validate"
            ? "Draft"
            : command === "Submit"
              ? "PendingApproval"
              : command === "Approve"
                ? "Approved"
                : "Published";
        if (
          configuration.brandReference !== expectedScope.brandReference ||
          configuration.storeReference !== expectedScope.storeReference ||
          (configuration.setupBasis &&
            configuration.setupBasis.tenantReference !== expectedScope.tenantReference) ||
          configuration.lifecycle !== lifecycle ||
          configuration.updatedAt > occurredAt ||
          occurredAt > observedAt ||
          e.expectedVersion !==
            configuration.configurationVersion - (command === "SaveDraft" ? 1 : 0) ||
          typeof e.intentDigest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(e.intentDigest) ||
          typeof e.purposeCode !== "string" ||
          !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(e.purposeCode)
        )
          return invalid();
        return Object.freeze({
          sequenceNumber: e.sequenceNumber,
          operationReference: parseStoreAdministrationReference(e.operationReference),
          command,
          configuration,
          intentDigest: e.intentDigest,
          actorReference: parseStoreAdministrationReference(e.actorReference),
          purposeCode: e.purposeCode,
          auditReference: parseStoreAdministrationReference(e.auditReference),
          occurredAt,
          expectedVersion: configuration.configurationVersion - (command === "SaveDraft" ? 1 : 0),
        });
      },
    );
    const next = r.nextBeforeSequence;
    if (next !== null && (entries.length !== 2 || next !== entries[1]?.sequenceNumber))
      return invalid();
    return Object.freeze({
      tenantReference: expectedScope.tenantReference,
      brandReference: expectedScope.brandReference,
      storeReference: expectedScope.storeReference,
      readerActorReference: expectedScope.actorReference,
      beforeSequence,
      entries: Object.freeze(entries),
      nextBeforeSequence: next === null ? null : (entries[1]?.sequenceNumber ?? invalid()),
      observedAt,
      validUntil,
    });
  } catch {
    return invalid();
  }
}
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
const invalid = (): never => {
  throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE");
};

/** Validates recorded state, not current business eligibility. The caller must
 * retain the real Session/permission transaction and verify lease freshness. */
export function parseMerchantStoreConfigurationOrdinaryWorkspace(
  value: unknown,
  expectedScope: StoreConfigurationOriginalScope,
): MerchantStoreConfigurationOrdinaryWorkspace {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "scope",
      "latest",
      "current",
      "expectedHead",
      "original",
      "observedAt",
      "validUntil",
      "businessReferenceValidation",
    ]);
    if (
      r.profile !== "StoreConfigurationOrdinaryWorkspaceV1" ||
      r.businessReferenceValidation !== "NotEvaluated"
    )
      return invalid();
    const rawScope = readClosedRecord(r.scope, scopeKeys);
    const scope = Object.freeze({
      tenantReference: parsePlatformTenantReference(rawScope.tenantReference),
      brandReference: parseBrandReference(rawScope.brandReference),
      storeReference: parseStoreReference(rawScope.storeReference),
      actorReference: parseStoreAdministrationReference(rawScope.actorReference),
    });
    if (scopeKeys.some((key) => scope[key] !== expectedScope[key])) return invalid();
    const observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    const duration = Date.parse(validUntil) - Date.parse(observedAt);
    if (duration <= 0 || duration > 5000) return invalid();
    const configuration = (input: unknown) => {
      if (input === null) return null;
      const result = createStoreConfigurationVersion(input);
      if (
        result.brandReference !== scope.brandReference ||
        result.storeReference !== scope.storeReference ||
        result.updatedAt > observedAt ||
        (result.setupBasis && result.setupBasis.tenantReference !== scope.tenantReference)
      )
        return invalid();
      return result;
    };
    const latest = configuration(r.latest),
      current = configuration(r.current);
    if (current !== null && current.lifecycle !== "Published") return invalid();
    if (
      latest !== null &&
      current !== null &&
      latest.configurationVersion < current.configurationVersion
    )
      return invalid();
    const selected = latest ?? current;
    const h = readClosedRecord(r.expectedHead, [
      "configurationReference",
      "configurationVersion",
      "contentDigest",
    ]);
    const expectedHead = Object.freeze({
      configurationReference: selected?.configurationReference ?? null,
      configurationVersion: selected?.configurationVersion ?? 0,
      contentDigest:
        selected === null ? null : `sha256:${sha256Hex(canonicalizeRfc8785(selected))}`,
    });
    if (
      h.configurationReference !== expectedHead.configurationReference ||
      h.configurationVersion !== expectedHead.configurationVersion ||
      h.contentDigest !== expectedHead.contentDigest
    )
      return invalid();
    const original =
      r.original === null ? null : parseStoreConfigurationOrdinaryReceipt(r.original);
    if (
      original !== null &&
      (scopeKeys.some((key) => original[key] !== scope[key]) ||
        original.occurredAt > observedAt ||
        (original.operation?.configuration.setupBasis &&
          original.operation.configuration.setupBasis.tenantReference !== scope.tenantReference))
    )
      return invalid();
    return Object.freeze({
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest,
      current,
      expectedHead,
      original,
      observedAt,
      validUntil,
      businessReferenceValidation: "NotEvaluated",
    });
  } catch {
    return invalid();
  }
}
