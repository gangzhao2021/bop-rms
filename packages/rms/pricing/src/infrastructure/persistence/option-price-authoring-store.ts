import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  appendEventInTransaction,
  loadOutboxEnvelope,
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  assertOptionPricePublicationUnambiguous,
  type OptionPriceRuleSnapshot,
} from "../../domain/option-price.js";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingDigest,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import {
  OptionPriceAuthoringError,
  optionPriceClosed,
  optionPricePositive,
  optionPriceAuthoringFields,
  optionPriceAuthoringEventTypes,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  parseOptionPriceWireSnapshot,
  optionPriceWireState,
  optionPriceWireSnapshot,
  optionPriceIntentDigest,
  materializeOptionPriceVersion,
  type OptionPriceAuthoringCommand,
  type OptionPriceAuthoringState,
  type OptionPriceAuthoringOperation,
  type OptionPriceAuthoringEvent,
} from "../../contracts/option-price-authoring.js";

export interface OptionPriceAuthoringTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
}
/** Server producer must acquire actual current public policy/approval sources.
 * Parsing this packet alone never certifies source acquisition. */
export interface OptionPricePublicationAuthorization {
  readonly policy: {
    readonly profile: "PublishingOptionPricePublicationPolicyV1";
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly familyReference: string;
    readonly policyReference: string;
    readonly policyVersion: number;
    readonly approvalPolicy: "Required" | "NotRequired";
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
  };
  readonly currentPolicyPublicationReference: string;
  readonly draftVersionReference: string;
  readonly draftSnapshotDigest: string;
  readonly draftAuthorActorReference: string;
  readonly approvalEvidenceReference: string | null;
  readonly approvedActorReference: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface OptionPriceAuthoringStoreOptions {
  readonly transaction: OptionPriceAuthoringTransaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly selectedStoreReference: string;
  readonly actorReference: string;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly authority: {
    /** Current full IAM and actual Catalog Binding/Choice/SKU/scope sources for
     * new qualification; original receipt Read never requalifies old choices. */
    holdUntilTransactionCompletes(
      tx: OptionPriceAuthoringTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly selectedStoreReference: string;
        readonly actorReference: string;
        readonly permission: "pricing.price-book.manage";
        readonly purposeCode: "PRICING_OPTION_PRICE_AUTHORING";
        readonly requiredFields: typeof optionPriceAuthoringFields;
        readonly mode: "Read" | "Write" | "Resolve";
        readonly command: OptionPriceAuthoringCommand | null;
        readonly state: OptionPriceAuthoringState | null;
        readonly observedAt: string;
        readonly originalObservedAt: string;
        readonly originalValidUntil: string;
      },
    ): Promise<string>;
  };
  readonly publicationPolicyFamilyReference?: string;
  readonly publicationSource?: {
    /** This callback must retain its actual owner locks and COMMIT guards.
     * Acquire Publishing before the Pricing writer lock to preserve lock order. */
    withCurrentAuthorization<T>(
      tx: OptionPriceAuthoringTransaction,
      input: {
        readonly command: OptionPriceAuthoringCommand;
        readonly originalIntentDigest: string;
        readonly state: OptionPriceAuthoringState;
        readonly originalObservedAt: string;
        readonly validUntil: string;
      },
      work: (source: OptionPricePublicationAuthorization) => Promise<T>,
    ): Promise<T>;
  };
  readonly references: { generate(kind: "OptionPriceVersion" | "Audit" | "Event"): string };
  readonly audit: {
    create(input: {
      readonly auditReference: string;
      readonly command: OptionPriceAuthoringCommand;
      readonly actorReference: string;
      readonly brandReference: string;
      readonly occurredAt: string;
      readonly mode: "Write" | "Abandon";
    }): AppendAuditRecordInput;
  };
  readonly registerBeforeCommit: (
    tx: OptionPriceAuthoringTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const snapshot = `jsonb_build_object('ruleReference',v.option_price_rule_id,'versionReference',v.option_price_rule_version_id,'snapshotDigest',v.snapshot_digest,'brandReference',v.brand_id,'bindingReference',v.binding_id,'optionReference',v.option_id,'skuReference',v.sku_id,'scopeKind',v.scope_kind,'scopeReference',v.scope_id,'channelCode',v.channel_code,'orderType',v.order_type,'lifecycle',v.lifecycle,'currencyMetadata',jsonb_build_object('currencyCode',v.currency_code,'minorUnitExponent',v.currency_minor_unit_exponent,'metadataVersion',v.currency_metadata_version,'metadataVersionReference',v.currency_metadata_version_id,'metadataDigest',v.currency_metadata_digest),'unitAmount',jsonb_build_object('amountMinor',v.unit_amount_minor::text,'currencyCode',v.currency_code),'includedQuantity',v.included_quantity,'quantityBasis',v.quantity_basis,'effectivePeriod',jsonb_build_object('timeZone',v.effective_time_zone,'effectiveFrom',jsonb_build_object('instant',${utc("v.effective_from")},'localDateTime',to_char(v.effective_from AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((v.effective_from AT TIME ZONE v.effective_time_zone)-(v.effective_from AT TIME ZONE 'UTC')))/60),'effectiveUntil',CASE WHEN v.effective_until IS NULL THEN NULL ELSE jsonb_build_object('instant',${utc("v.effective_until")},'localDateTime',to_char(v.effective_until AT TIME ZONE v.effective_time_zone,'YYYY-MM-DD"T"HH24:MI:SS.MS'),'utcOffsetMinutes',extract(epoch FROM ((v.effective_until AT TIME ZONE v.effective_time_zone)-(v.effective_until AT TIME ZONE 'UTC')))/60) END),'createdAt',${utc("v.created_at")})`;
const selectState = `SELECT r.option_price_rule_id::text rule_id,r.brand_id::text brand_id,r.binding_id::text binding_id,r.option_id::text option_id,r.aggregate_version::text aggregate_version,r.current_version_id::text current_version_id,r.draft_version_id::text draft_version_id,r.draft_author_actor_id::text draft_author_actor_id,${utc("r.created_at")} created_at,r.created_by_actor_id::text created_by_actor_id,${utc("r.updated_at")} updated_at,v.version_number::text version_number,${snapshot} snapshot,(date_trunc('milliseconds',r.created_at)=r.created_at AND date_trunc('milliseconds',r.updated_at)=r.updated_at AND date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.effective_from)=v.effective_from AND (v.effective_until IS NULL OR date_trunc('milliseconds',v.effective_until)=v.effective_until)) precise FROM rms_pricing.option_price_rule r JOIN rms_pricing.option_price_rule_version v ON v.option_price_rule_id=r.option_price_rule_id AND v.brand_id=r.brand_id AND v.binding_id=r.binding_id AND v.option_id=r.option_id WHERE r.brand_id=$1 AND r.option_price_rule_id=$2 ORDER BY v.version_number DESC LIMIT 1001`;

/** Borrowed actual transaction only. Results remain tentative until its owning
 * host executes both hooks and COMMIT; the API then calls assertFinalized. */
export function createPostgresOptionPriceAuthoringStore(options: OptionPriceAuthoringStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    clockOwner = options.clock,
    clockPort = clockOwner.now,
    authorityOwner = options.authority,
    authorityPort = authorityOwner.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit,
    referencesOwner = options.references,
    referencePort = referencesOwner.generate,
    auditOwner = options.audit,
    auditPort = auditOwner.create,
    publicationOwner = options.publicationSource,
    publicationPort = publicationOwner?.withCurrentAuthorization;
  const policyFamily = options.publicationSource
    ? parsePricingReference(options.publicationPolicyFamilyReference)
    : null;
  const tenant = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    store = parsePricingReference(options.selectedStoreReference),
    actor = parsePricingReference(options.actorReference),
    currency = createCurrencyMetadataSnapshot(options.currencyMetadata),
    startedAt = parseCanonicalInstant(options.originalObservedAt);
  const originalUntil = parseCanonicalInstant(options.originalValidUntil);
  let deadline = originalUntil,
    latest = startedAt,
    failed = false,
    active = false,
    registration: Promise<void> | undefined,
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0,
    appendedOriginal = false,
    ready = false;
  const records: {
    mode: "Read" | "Write" | "Resolve";
    command: OptionPriceAuthoringCommand | null;
    state: OptionPriceAuthoringState | null;
  }[] = [];
  const fail = (
    code: ConstructorParameters<
      typeof OptionPriceAuthoringError
    >[0] = "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new OptionPriceAuthoringError(code);
  };
  const closed = (value: unknown, keys: readonly string[]) => {
    try {
      return optionPriceClosed(value, keys);
    } catch {
      return fail();
    }
  };
  if (
    deadline <= startedAt ||
    Date.parse(deadline) - Date.parse(startedAt) > 5000 ||
    typeof queryPort !== "function" ||
    typeof authorityPort !== "function" ||
    typeof referencePort !== "function" ||
    typeof auditPort !== "function" ||
    typeof registerPort !== "function" ||
    (publicationPort !== undefined && typeof publicationPort !== "function")
  )
    return fail();
  const check = () => {
    if (
      failed ||
      tx.query !== queryPort ||
      options.transaction !== tx ||
      options.clock !== clockOwner ||
      clockOwner.now !== clockPort ||
      options.authority !== authorityOwner ||
      authorityOwner.holdUntilTransactionCompletes !== authorityPort ||
      options.references !== referencesOwner ||
      referencesOwner.generate !== referencePort ||
      options.audit !== auditOwner ||
      auditOwner.create !== auditPort ||
      options.registerBeforeCommit !== registerPort ||
      options.publicationSource !== publicationOwner ||
      (options.publicationPolicyFamilyReference !== policyFamily &&
        !(policyFamily === null && options.publicationPolicyFamilyReference === undefined)) ||
      publicationOwner?.withCurrentAuthorization !== publicationPort ||
      finalCalls
    )
      return fail();
    const at = parseCanonicalInstant(clockPort.call(clockOwner));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const tighten = (value: unknown) => {
    const until = parseCanonicalInstant(value);
    if (until <= check() || until > originalUntil) return fail();
    if (until < deadline) deadline = until;
  };
  const query = async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
    check();
    const remaining = Math.floor(Date.parse(deadline) - Date.parse(latest));
    if (remaining < 1) return fail();
    await queryPort.call(
      tx,
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
      [String(remaining)],
    );
    check();
    const result = await tx.query<Row>(sql, values);
    check();
    return result;
  };
  const hold = async (
    mode: "Read" | "Write" | "Resolve",
    command: OptionPriceAuthoringCommand | null,
    state: OptionPriceAuthoringState | null,
  ) => {
    const observedAt = check();
    tighten(
      await authorityPort.call(
        authorityOwner,
        tx,
        Object.freeze({
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: store,
          actorReference: actor,
          permission: "pricing.price-book.manage",
          purposeCode: "PRICING_OPTION_PRICE_AUTHORING",
          requiredFields: optionPriceAuthoringFields,
          mode,
          command,
          state,
          observedAt,
          originalObservedAt: startedAt,
          originalValidUntil: originalUntil,
        }),
      ),
    );
    await query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true),set_config('bop.tenant_id',$3,true)",
      [brand, store, tenant],
    );
  };
  const register = () =>
    (registration ??= (async () => {
      if (
        (await registerPort(
          tx,
          async () => {
            if (active || !ready || ++guardCalls !== 1) return fail();
            for (const record of records) await hold(record.mode, record.command, record.state);
            // These triggers validate the selected-Store original through RLS.
            // Check them while this owner's scope is held, before later Catalog
            // guards restore Brand-only scope. Their failure still rolls back
            // the same outer transaction.
            if (appendedOriginal)
              await query(
                "SET CONSTRAINTS rms_pricing.option_price_version_original_check, rms_pricing.option_price_authoring_terminal_coherence IMMEDIATE",
                [],
              );
            check();
            guardComplete = true;
          },
          () => {
            if (active || !ready || guardCalls !== 1 || !guardComplete || finalCalls !== 0)
              return fail();
            check();
            finalCalls = 1;
          },
        )) !== undefined
      )
        return fail();
    })().catch((error) => {
      failed = true;
      throw error;
    }));
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active || finalCalls || guardCalls) return fail();
    active = true;
    try {
      await register();
      const result = await work();
      check();
      ready = true;
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof OptionPriceAuthoringError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  const loadState = async (rule: string): Promise<OptionPriceAuthoringState | null> => {
    const rows = (await query(selectState, [brand, rule])).rows;
    if (rows.length === 0) return null;
    if (rows.length > 1000) return fail();
    const first = rows[0];
    if (!first) return fail();
    const numbers = new Set<number>(),
      versions = new Map<string, OptionPriceRuleSnapshot>();
    for (const row of rows) {
      const number =
        typeof row.version_number === "string" && /^[1-9][0-9]*$/.test(row.version_number)
          ? optionPricePositive(Number(row.version_number))
          : fail();
      if (
        row.precise !== true ||
        row.rule_id !== rule ||
        row.brand_id !== brand ||
        row.aggregate_version !== first.aggregate_version ||
        row.binding_id !== first.binding_id ||
        row.option_id !== first.option_id ||
        row.current_version_id !== first.current_version_id ||
        row.draft_version_id !== first.draft_version_id ||
        row.draft_author_actor_id !== first.draft_author_actor_id ||
        row.created_at !== first.created_at ||
        row.created_by_actor_id !== first.created_by_actor_id ||
        row.updated_at !== first.updated_at ||
        numbers.has(number)
      )
        return fail();
      const parsed = parseOptionPriceWireSnapshot(row.snapshot);
      if (versions.has(parsed.versionReference)) return fail();
      versions.set(parsed.versionReference, parsed);
      numbers.add(number);
    }
    const revision =
      typeof first.aggregate_version === "string" && /^[1-9][0-9]*$/.test(first.aggregate_version)
        ? optionPricePositive(Number(first.aggregate_version))
        : fail();
    if (Math.max(...numbers) !== revision || first.version_number !== String(revision))
      return fail();
    const latestVersion = parseOptionPriceWireSnapshot(first.snapshot),
      draft =
        first.draft_version_id === null
          ? null
          : (versions.get(parsePricingReference(first.draft_version_id)) ?? fail()),
      currentPublished =
        first.current_version_id === null
          ? null
          : (versions.get(parsePricingReference(first.current_version_id)) ?? fail());
    return parseOptionPriceAuthoringState({
      profile: "OptionPriceAuthoringStateV1",
      ruleReference: rule,
      brandReference: brand,
      bindingReference: first.binding_id,
      optionReference: first.option_id,
      aggregateVersion: revision,
      createdAt: first.created_at,
      createdByActorReference: first.created_by_actor_id,
      updatedAt: first.updated_at,
      draftAuthorActorReference: first.draft_author_actor_id,
      draft: draft === null ? null : optionPriceWireSnapshot(draft),
      currentPublished:
        currentPublished === null ? null : optionPriceWireSnapshot(currentPublished),
      latestVersion: optionPriceWireSnapshot(latestVersion),
    });
  };
  const brandOnly = async <T>(work: () => Promise<T>): Promise<T> => {
    await query("SELECT set_config('bop.store_id','',true)", []);
    const result = await work();
    await query("SELECT set_config('bop.store_id',$1,true)", [store]);
    return result;
  };
  const validateAudit = (
    raw: unknown,
    command: OptionPriceAuthoringCommand,
    occurredAt: string,
    mode: "Write" | "Abandon",
  ) => {
    const audit = validateAuditRecord(raw, Date.parse(occurredAt));
    if (
      audit.brandId !== brand ||
      audit.storeId !== undefined ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== actor ||
      audit.actionCode !==
        (mode === "Abandon"
          ? "PRICING_OPTION_PRICE_RESOLVE"
          : "PRICING_OPTION_PRICE_" + command.action.toUpperCase()) ||
      audit.targetType !== "PricingOptionPriceRule" ||
      audit.targetId !== command.ruleReference ||
      audit.correlationId !== command.operationReference ||
      audit.occurredAt !== occurredAt ||
      audit.reasonCode !== "AUTHORIZED_OPERATION"
    )
      return fail();
    return audit;
  };
  const eventPayload = (state: OptionPriceAuthoringState): OptionPriceAuthoringEvent => ({
    ruleReference: state.ruleReference,
    versionReference: state.latestVersion.versionReference,
    brandReference: brand,
    bindingReference: state.bindingReference,
    optionReference: state.optionReference,
    aggregateVersion: state.aggregateVersion,
    lifecycle: state.latestVersion.lifecycle,
    currencyCode: state.latestVersion.currencyMetadata.currencyCode,
    snapshotDigest: state.latestVersion.snapshotDigest,
    occurredAt: state.updatedAt,
  });
  const parsePublication = (
    raw: unknown,
    at: string,
    draftVersion: string,
    draftDigest: string,
    draftAuthor: string,
    expectedPolicyFamily: string | null = policyFamily,
  ): OptionPricePublicationAuthorization => {
    const r = closed(raw, [
      "policy",
      "currentPolicyPublicationReference",
      "draftVersionReference",
      "draftSnapshotDigest",
      "draftAuthorActorReference",
      "approvalEvidenceReference",
      "approvedActorReference",
      "observedAt",
      "validUntil",
    ]);
    const p = closed(r.policy, [
      "profile",
      "tenantReference",
      "brandReference",
      "familyReference",
      "policyReference",
      "policyVersion",
      "approvalPolicy",
      "effectiveFrom",
      "effectiveUntil",
    ]);
    const effectiveFrom = parseCanonicalInstant(p.effectiveFrom),
      effectiveUntil = p.effectiveUntil === null ? null : parseCanonicalInstant(p.effectiveUntil),
      observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (
      p.profile !== "PublishingOptionPricePublicationPolicyV1" ||
      p.tenantReference !== tenant ||
      p.brandReference !== brand ||
      p.familyReference !== expectedPolicyFamily ||
      effectiveFrom > at ||
      (effectiveUntil !== null && effectiveUntil <= at) ||
      (p.approvalPolicy !== "Required" && p.approvalPolicy !== "NotRequired") ||
      r.draftVersionReference !== draftVersion ||
      r.draftSnapshotDigest !== draftDigest ||
      r.draftAuthorActorReference !== draftAuthor ||
      observedAt > at ||
      validUntil <= at ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const approvalEvidenceReference =
        r.approvalEvidenceReference === null
          ? null
          : parsePricingReference(r.approvalEvidenceReference),
      approvedActorReference =
        r.approvedActorReference === null ? null : parsePricingReference(r.approvedActorReference);
    if ((approvalEvidenceReference === null) !== (approvedActorReference === null)) return fail();
    if (
      approvedActorReference === draftAuthor ||
      (p.approvalPolicy === "Required" &&
        (approvalEvidenceReference === null || approvedActorReference === null))
    )
      return fail("OPTION_PRICE_APPROVAL_REQUIRED");
    return Object.freeze({
      policy: Object.freeze({
        profile: "PublishingOptionPricePublicationPolicyV1",
        tenantReference: tenant,
        brandReference: brand,
        familyReference: parsePricingReference(p.familyReference),
        policyReference: parsePricingReference(p.policyReference),
        policyVersion: optionPricePositive(p.policyVersion),
        approvalPolicy: p.approvalPolicy,
        effectiveFrom,
        effectiveUntil,
      }),
      currentPolicyPublicationReference: parsePricingReference(r.currentPolicyPublicationReference),
      draftVersionReference: parsePricingReference(draftVersion),
      draftSnapshotDigest: parsePricingDigest(draftDigest),
      draftAuthorActorReference: parsePricingReference(draftAuthor),
      approvalEvidenceReference,
      approvedActorReference,
      observedAt,
      validUntil,
    });
  };
  const original = async (
    command: OptionPriceAuthoringCommand,
  ): Promise<OptionPriceAuthoringOperation | null> => {
    const rows = (
      await query(
        "SELECT receipt_json,audit_json,event_id::text,record_digest FROM rms_pricing.option_price_authoring_operation WHERE brand_id=$1 AND operation_id=$2 LIMIT 2",
        [brand, command.operationReference],
      )
    ).rows;
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !rows[0]) return fail();
    const row = rows[0],
      r = closed(row.receipt_json, [
        "profile",
        "tenantReference",
        "brandReference",
        "selectedStoreReference",
        "actorReference",
        "command",
        "intentDigest",
        "outcome",
        "state",
        "auditReference",
        "eventReference",
        "occurredAt",
        "publicationAuthorization",
      ]);
    if (
      r.profile !== "OptionPriceAuthoringOperationV1" ||
      r.tenantReference !== tenant ||
      r.brandReference !== brand ||
      r.selectedStoreReference !== store ||
      r.actorReference !== actor ||
      r.intentDigest !== optionPriceIntentDigest(command) ||
      canonicalizeRfc8785(parseOptionPriceAuthoringCommand(r.command)) !==
        canonicalizeRfc8785(command)
    )
      return fail("OPTION_PRICE_IDEMPOTENCY_CONFLICT");
    if (row.record_digest !== hash(row.receipt_json)) return fail();
    const occurredAt = parseCanonicalInstant(r.occurredAt),
      auditReference = parsePricingReference(r.auditReference),
      eventReference = r.eventReference === null ? null : parsePricingReference(r.eventReference),
      state = r.state === null ? null : parseOptionPriceAuthoringState(r.state);
    if (
      occurredAt > check() ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
      (r.outcome === "Abandoned") !== (state === null) ||
      (state === null) !== (eventReference === null) ||
      (state !== null &&
        (state.brandReference !== brand ||
          state.ruleReference !== command.ruleReference ||
          state.updatedAt !== occurredAt ||
          state.aggregateVersion !== (command.expectedAggregateVersion ?? 0) + 1 ||
          (command.action === "CreateDraft" &&
            (state.bindingReference !== command.bindingReference ||
              state.optionReference !== command.optionReference))))
    )
      return fail();
    if (state !== null) {
      const versions = (
        await query(
          `SELECT v.version_number::text version_number,${snapshot} snapshot FROM rms_pricing.option_price_rule_version v WHERE v.brand_id=$1 AND v.option_price_rule_id=$2 AND v.option_price_rule_version_id=$3 LIMIT 2`,
          [brand, command.ruleReference, state.latestVersion.versionReference],
        )
      ).rows;
      if (
        versions.length !== 1 ||
        versions[0]?.version_number !== String(state.aggregateVersion) ||
        encode(optionPriceWireSnapshot(parseOptionPriceWireSnapshot(versions[0]?.snapshot))) !==
          encode(optionPriceWireSnapshot(state.latestVersion))
      )
        return fail();
      if (command.action === "Publish") {
        const rawProof = closed(r.publicationAuthorization, [
          "policy",
          "currentPolicyPublicationReference",
          "draftVersionReference",
          "draftSnapshotDigest",
          "draftAuthorActorReference",
          "approvalEvidenceReference",
          "approvedActorReference",
          "observedAt",
          "validUntil",
        ]);
        const draftRows = (
          await query(
            `SELECT ${snapshot} snapshot FROM rms_pricing.option_price_rule_version v WHERE v.brand_id=$1 AND v.option_price_rule_id=$2 AND v.option_price_rule_version_id=$3 LIMIT 2`,
            [brand, command.ruleReference, parsePricingReference(rawProof.draftVersionReference)],
          )
        ).rows;
        if (draftRows.length !== 1) return fail();
        const originalDraft = parseOptionPriceWireSnapshot(draftRows[0]?.snapshot);
        if (
          originalDraft.lifecycle !== "Draft" ||
          originalDraft.snapshotDigest !== rawProof.draftSnapshotDigest ||
          originalDraft.brandReference !== state.brandReference ||
          originalDraft.bindingReference !== state.bindingReference ||
          originalDraft.optionReference !== state.optionReference
        )
          return fail();
        parsePublication(
          r.publicationAuthorization,
          occurredAt,
          originalDraft.versionReference,
          originalDraft.snapshotDigest,
          parsePricingReference(rawProof.draftAuthorActorReference),
          parsePricingReference(
            closed(rawProof.policy, [
              "profile",
              "tenantReference",
              "brandReference",
              "familyReference",
              "policyReference",
              "policyVersion",
              "approvalPolicy",
              "effectiveFrom",
              "effectiveUntil",
            ]).familyReference,
          ),
        );
      } else if (r.publicationAuthorization !== null) return fail();
    } else if (r.publicationAuthorization !== null) return fail();
    const audit = validateAudit(
      row.audit_json,
      command,
      occurredAt,
      state === null ? "Abandon" : "Write",
    );
    if (audit.auditId !== auditReference || row.event_id !== eventReference) return fail();
    if (state !== null && eventReference !== null) {
      await brandOnly(async () => {
        const envelope = await loadOutboxEnvelope(
          {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await query<Row>(sql, values);
              if (
                result.rowCount === undefined ||
                (result.rowCount !== null &&
                  (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0))
              )
                return fail();
              return { rows: result.rows, rowCount: result.rowCount };
            },
          },
          eventReference,
        );
        if (!envelope) return fail();
        validateDomainEventEnvelope(envelope);
        if (
          envelope.eventId !== eventReference ||
          envelope.eventType !== optionPriceAuthoringEventTypes[command.action] ||
          envelope.schemaVersion !== 1 ||
          envelope.redactionClassification !== "indirect_identifier" ||
          envelope.producerModule !== "@rms/pricing" ||
          envelope.tenantId !== brand ||
          envelope.storeId !== undefined ||
          envelope.aggregateType !== "OptionPriceRule" ||
          envelope.aggregateId !== command.ruleReference ||
          envelope.aggregateVersion !== BigInt(state.aggregateVersion) ||
          envelope.correlationId !== command.operationReference ||
          envelope.causationId !== command.operationReference ||
          envelope.actor.type !== "Actor" ||
          envelope.actor.actorId !== actor ||
          envelope.occurredAt !== occurredAt ||
          canonicalizeRfc8785(envelope.payload) !== canonicalizeRfc8785(eventPayload(state)) ||
          canonicalizeRfc8785(envelope.replayMetadata) !==
            canonicalizeRfc8785({ auditReference, originalIntentDigest: r.intentDigest })
        )
          return fail();
      });
    }
    return Object.freeze({
      profile: "OptionPriceAuthoringOperationV1",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      command,
      intentDigest: parsePricingDigest(r.intentDigest),
      outcome: r.outcome,
      state,
      auditReference,
      eventReference,
      occurredAt,
    });
  };
  const lockOriginal = async (command: OptionPriceAuthoringCommand) => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PricingOptionPriceOperation:" + command.operationReference,
    ]);
    const record = await original(command);
    if (record) return record;
    const rows = (
      await query(
        "SELECT rms_pricing.option_price_authoring_operation_available($1,$2) available",
        [brand, command.operationReference],
      )
    ).rows;
    if (rows.length !== 1 || rows[0]?.available !== true)
      return fail("OPTION_PRICE_IDEMPOTENCY_CONFLICT");
    return null;
  };
  const appendOriginal = async (
    command: OptionPriceAuthoringCommand,
    state: OptionPriceAuthoringState | null,
    occurredAt: string,
    publicationAuthorization: OptionPricePublicationAuthorization | null,
  ) => {
    const auditReference = parsePricingReference(referencePort.call(referencesOwner, "Audit")),
      audit = validateAudit(
        auditPort.call(auditOwner, {
          auditReference,
          command,
          actorReference: actor,
          brandReference: brand,
          occurredAt,
          mode: state === null ? "Abandon" : "Write",
        }),
        command,
        occurredAt,
        state === null ? "Abandon" : "Write",
      );
    if (audit.auditId !== auditReference) return fail();
    const eventReference =
      state === null ? null : parsePricingReference(referencePort.call(referencesOwner, "Event"));
    await brandOnly(async () => {
      await appendAuditRecordInTransaction({ query }, audit);
      check();
      if (state !== null && eventReference !== null) {
        const event: DomainEventEnvelope = {
          eventId: eventReference,
          eventType: optionPriceAuthoringEventTypes[command.action],
          schemaVersion: 1,
          producerModule: "@rms/pricing",
          tenantId: brand,
          aggregateType: "OptionPriceRule",
          aggregateId: command.ruleReference,
          aggregateVersion: BigInt(state.aggregateVersion),
          correlationId: command.operationReference,
          causationId: command.operationReference,
          actor: { type: "Actor", actorId: actor },
          payload: { ...eventPayload(state) },
          redactionClassification: "indirect_identifier",
          occurredAt,
          replayMetadata: {
            auditReference,
            originalIntentDigest: optionPriceIntentDigest(command),
          },
        };
        await appendEventInTransaction(
          {
            query: async (sql, values) => {
              const result = await query(sql, values);
              if (result.rowCount !== 1) return fail();
              return { rowCount: result.rowCount };
            },
          },
          event,
        );
        check();
      }
    });
    const record = {
      profile: "OptionPriceAuthoringOperationV1" as const,
      tenantReference: tenant,
      brandReference: brand,
      selectedStoreReference: store,
      actorReference: actor,
      command,
      intentDigest: optionPriceIntentDigest(command),
      outcome: state === null ? ("Abandoned" as const) : ("Committed" as const),
      state: state === null ? null : optionPriceWireState(state),
      auditReference,
      eventReference,
      occurredAt,
      publicationAuthorization,
    };
    const result = await query(
      "INSERT INTO rms_pricing.option_price_authoring_operation(operation_id,tenant_id,brand_id,selected_store_id,actor_id,option_price_rule_id,action_code,intent_digest,outcome,result_version_id,result_aggregate_version,receipt_json,record_digest,audit_id,audit_json,event_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16,$17)",
      [
        command.operationReference,
        tenant,
        brand,
        store,
        actor,
        command.ruleReference,
        command.action,
        record.intentDigest,
        record.outcome,
        state?.latestVersion.versionReference ?? null,
        state?.aggregateVersion ?? null,
        encode(record),
        hash(record),
        auditReference,
        encode(audit),
        eventReference,
        occurredAt,
      ],
    );
    if (result.rowCount !== 1) return fail();
    appendedOriginal = true;
    return Object.freeze({
      profile: record.profile,
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      command,
      intentDigest: record.intentDigest,
      outcome: record.outcome,
      state,
      auditReference,
      eventReference,
      occurredAt,
    });
  };
  const serializedWrite = async (
    command: OptionPriceAuthoringCommand,
    current: OptionPriceAuthoringState | null,
    publicationAuthorization: OptionPricePublicationAuthorization | null,
  ) => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PricingOptionPriceRule:" + brand + ":" + command.ruleReference,
    ]);
    await query(
      "LOCK TABLE rms_pricing.option_price_rule,rms_pricing.option_price_rule_version IN SHARE ROW EXCLUSIVE MODE",
      [],
    );
    const fresh = await loadState(command.ruleReference);
    if (
      encode(fresh === null ? null : optionPriceWireState(fresh)) !==
      encode(current === null ? null : optionPriceWireState(current))
    )
      return fail("OPTION_PRICE_VERSION_CONFLICT");
    const occurredAt = check(),
      revision = (current?.aggregateVersion ?? 0) + 1;
    if (revision > 2147483647) return fail("OPTION_PRICE_VERSION_CONFLICT");
    const version = materializeOptionPriceVersion({
      command,
      current,
      brandReference: brand,
      versionReference: parsePricingReference(
        referencePort.call(referencesOwner, "OptionPriceVersion"),
      ),
      occurredAt,
      currencyMetadata: currency,
    });
    if (command.action === "Publish") {
      if (!publicationAuthorization || !current?.draft) return fail();
      const rows = (
        await query(
          `SELECT ${snapshot} snapshot FROM rms_pricing.option_price_rule r JOIN rms_pricing.option_price_rule_version v ON v.option_price_rule_version_id=r.current_version_id AND v.option_price_rule_id=r.option_price_rule_id AND v.brand_id=r.brand_id AND v.binding_id=r.binding_id AND v.option_id=r.option_id WHERE r.brand_id=$1 AND r.binding_id=$2 AND r.option_id=$3 ORDER BY r.option_price_rule_id LIMIT 1001`,
          [brand, current.bindingReference, current.optionReference],
        )
      ).rows;
      if (rows.length > 1000) return fail();
      try {
        assertOptionPricePublicationUnambiguous(
          version,
          rows.map((row) => parseOptionPriceWireSnapshot(row.snapshot)),
        );
      } catch {
        return fail("OPTION_PRICE_CONFLICT");
      }
    }
    await hold("Write", command, current);
    if (current === null) {
      const inserted = await query(
        "INSERT INTO rms_pricing.option_price_rule(option_price_rule_id,brand_id,binding_id,option_id,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at,draft_version_id,draft_author_actor_id) VALUES($1,$2,$3,$4,1,NULL,$5,$6,$5,NULL,NULL)",
        [
          command.ruleReference,
          brand,
          version.bindingReference,
          version.optionReference,
          occurredAt,
          actor,
        ],
      );
      if (inserted.rowCount !== 1) return fail();
    }
    const inserted = await query(
      "INSERT INTO rms_pricing.option_price_rule_version(option_price_rule_version_id,option_price_rule_id,brand_id,binding_id,option_id,version_number,snapshot_digest,lifecycle,sku_id,scope_kind,scope_id,channel_code,order_type,currency_code,currency_minor_unit_exponent,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,unit_amount_minor,included_quantity,quantity_basis,effective_from,effective_until,effective_time_zone,created_at,authoring_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)",
      [
        version.versionReference,
        command.ruleReference,
        brand,
        version.bindingReference,
        version.optionReference,
        revision,
        version.snapshotDigest,
        version.lifecycle,
        version.skuReference,
        version.scopeKind,
        version.scopeReference,
        version.channelCode,
        version.orderType,
        version.currencyMetadata.currencyCode,
        version.currencyMetadata.minorUnitExponent,
        version.currencyMetadata.metadataVersion,
        version.currencyMetadata.metadataVersionReference,
        version.currencyMetadata.metadataDigest,
        version.unitAmount.amountMinor.toString(),
        version.includedQuantity,
        version.quantityBasis,
        version.effectivePeriod.effectiveFrom.instant,
        version.effectivePeriod.effectiveUntil?.instant ?? null,
        version.effectivePeriod.timeZone,
        occurredAt,
        command.operationReference,
      ],
    );
    if (inserted.rowCount !== 1) return fail();
    const draft =
        version.lifecycle === "Draft"
          ? version
          : command.action === "Publish"
            ? null
            : (current?.draft ?? null),
      currentPublished =
        command.action === "Publish"
          ? version
          : command.action === "Archive"
            ? null
            : (current?.currentPublished ?? null),
      draftAuthor =
        version.lifecycle === "Draft"
          ? actor
          : command.action === "Publish"
            ? null
            : (current?.draftAuthorActorReference ?? null);
    const updated = await query(
      "UPDATE rms_pricing.option_price_rule SET aggregate_version=$1,current_version_id=$2,draft_version_id=$3,draft_author_actor_id=$4,updated_at=$5 WHERE brand_id=$6 AND option_price_rule_id=$7 AND aggregate_version=$8",
      [
        revision,
        currentPublished?.versionReference ?? null,
        draft?.versionReference ?? null,
        draftAuthor,
        occurredAt,
        brand,
        command.ruleReference,
        current?.aggregateVersion ?? 1,
      ],
    );
    if (updated.rowCount !== 1) return fail("OPTION_PRICE_VERSION_CONFLICT");
    const state = parseOptionPriceAuthoringState({
      profile: "OptionPriceAuthoringStateV1",
      brandReference: brand,
      ruleReference: command.ruleReference,
      bindingReference: version.bindingReference,
      optionReference: version.optionReference,
      aggregateVersion: revision,
      createdAt: current?.createdAt ?? occurredAt,
      createdByActorReference: current?.createdByActorReference ?? actor,
      updatedAt: occurredAt,
      draftAuthorActorReference: draftAuthor,
      draft: draft === null ? null : optionPriceWireSnapshot(draft),
      currentPublished:
        currentPublished === null ? null : optionPriceWireSnapshot(currentPublished),
      latestVersion: optionPriceWireSnapshot(version),
    });
    const result = await appendOriginal(command, state, occurredAt, publicationAuthorization);
    await hold("Read", command, state);
    records.push({ mode: "Write", command, state: current }, { mode: "Read", command, state });
    return result;
  };
  return Object.freeze({
    listForBinding(value: unknown) {
      return run(async () => {
        const input = optionPriceClosed(value, ["bindingReference", "optionReference"]);
        const binding = parsePricingReference(input.bindingReference),
          option = parsePricingReference(input.optionReference);
        await hold("Read", null, null);
        await query(
          "LOCK TABLE rms_pricing.option_price_rule,rms_pricing.option_price_rule_version IN SHARE MODE",
          [],
        );
        const roots = (
          await query(
            "SELECT option_price_rule_id::text rule_reference FROM rms_pricing.option_price_rule WHERE brand_id=$1 AND binding_id=$2 AND option_id=$3 ORDER BY option_price_rule_id LIMIT 1001",
            [brand, binding, option],
          )
        ).rows;
        if (roots.length > 1000) return fail();
        const seen = new Set<string>(),
          states: OptionPriceAuthoringState[] = [];
        for (const row of roots) {
          const root = closed(row, ["rule_reference"]);
          const reference = parsePricingReference(root.rule_reference);
          if (seen.has(reference)) return fail();
          seen.add(reference);
          const state = await loadState(reference);
          if (!state || state.bindingReference !== binding || state.optionReference !== option)
            return fail();
          await hold("Read", null, state);
          records.push({ mode: "Read", command: null, state });
          states.push(state);
        }
        if (states.length === 0) records.push({ mode: "Read", command: null, state: null });
        return Object.freeze(states);
      });
    },
    readCurrent(ruleReference: unknown) {
      return run(async () => {
        const rule = parsePricingReference(ruleReference);
        await hold("Read", null, null);
        await query(
          "LOCK TABLE rms_pricing.option_price_rule,rms_pricing.option_price_rule_version IN SHARE MODE",
          [],
        );
        const state = await loadState(rule);
        await hold("Read", null, state);
        records.push({ mode: "Read", command: null, state });
        return state;
      });
    },
    execute(value: unknown) {
      return run(async () => {
        const command = parseOptionPriceAuthoringCommand(value);
        await hold("Read", command, null);
        const replay = await lockOriginal(command);
        if (replay !== null) {
          records.push({ mode: "Read", command, state: replay.state });
          return replay;
        }
        const current = await loadState(command.ruleReference);
        if (
          (current?.aggregateVersion ?? null) !== command.expectedAggregateVersion ||
          (command.action !== "CreateDraft" && current === null)
        )
          return fail("OPTION_PRICE_VERSION_CONFLICT");
        // Acquire actual Catalog Binding/Choice/scope sources before Publishing
        // and Pricing locks. Replays returned above need only current Read rights.
        await hold("Write", command, current);
        if (command.action !== "Publish") return serializedWrite(command, current, null);
        if (!current?.draft || !publicationPort || !publicationOwner) return fail();
        let calls = 0,
          completed: OptionPriceAuthoringOperation | undefined;
        const result = await publicationPort.call(
          publicationOwner,
          tx,
          {
            command,
            originalIntentDigest: optionPriceIntentDigest(command),
            state: current,
            originalObservedAt: startedAt,
            validUntil: deadline,
          },
          async (source) => {
            if (++calls !== 1) return fail();
            const now = check();
            if (!current.draft || !current.draftAuthorActorReference) return fail();
            const proof = parsePublication(
              source,
              now,
              current.draft.versionReference,
              current.draft.snapshotDigest,
              current.draftAuthorActorReference,
            );
            if (proof.observedAt < startedAt) return fail();
            tighten(proof.validUntil);
            if (proof.policy.effectiveUntil !== null && proof.policy.effectiveUntil < deadline)
              tighten(proof.policy.effectiveUntil);
            completed = await serializedWrite(command, current, proof);
            check();
            return completed;
          },
        );
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed;
      });
    },
    resolve(value: unknown) {
      return run(async () => {
        const command = parseOptionPriceAuthoringCommand(value);
        await hold("Resolve", command, null);
        const replay = await lockOriginal(command);
        if (replay !== null) {
          records.push({ mode: "Read", command, state: replay.state });
          return replay;
        }
        const result = await appendOriginal(command, null, check(), null);
        await hold("Resolve", command, null);
        records.push({ mode: "Resolve", command, state: null });
        return result;
      });
    },
    assertFinalized() {
      if (
        failed ||
        active ||
        !ready ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1 ||
        tx.query !== queryPort ||
        options.clock !== clockOwner ||
        clockOwner.now !== clockPort ||
        options.authority !== authorityOwner ||
        authorityOwner.holdUntilTransactionCompletes !== authorityPort ||
        options.references !== referencesOwner ||
        referencesOwner.generate !== referencePort ||
        options.audit !== auditOwner ||
        auditOwner.create !== auditPort ||
        options.registerBeforeCommit !== registerPort ||
        options.publicationSource !== publicationOwner ||
        (options.publicationPolicyFamilyReference !== policyFamily &&
          !(policyFamily === null && options.publicationPolicyFamilyReference === undefined)) ||
        publicationOwner?.withCurrentAuthorization !== publicationPort
      )
        return fail();
      const at = parseCanonicalInstant(clockPort.call(clockOwner));
      if (at < latest || at >= deadline) return fail();
      return deadline;
    },
  });
}
