import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
} from "../../domain/brand-store.js";
import { parsePlatformTenantReference } from "../../contracts/platform-tenant-administration.js";
import {
  createBrandConfigurationVersion,
  parseBrandAdministrationReference,
  type BrandConfigurationVersion,
} from "../../contracts/brand-administration.js";
import {
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
} from "../../contracts/brand-configuration-content-source.js";
import {
  BrandConfigurationOperationError,
  brandConfigurationOperationRequiredFields,
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  parseBrandConfigurationRevision,
  parseBrandConfigurationReceipt,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  createBrandConfigurationRevision,
  assertBrandConfigurationRevisionDigests,
  type BrandConfigurationActorScope,
  type BrandConfigurationCommand,
  type BrandConfigurationResolve,
  type BrandConfigurationRevision,
  type BrandConfigurationReceipt,
  type BrandConfigurationPublishingBinding,
} from "../../contracts/brand-configuration-operation.js";
export interface BrandConfigurationAuthoringTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Original = BrandConfigurationCommand | BrandConfigurationResolve;
type Mode = "Read" | "Execute" | "Resolve";
export interface BrandConfigurationFreshPreparation {
  readonly configuration: BrandConfigurationVersion;
  readonly submittedByReference: string | null;
  readonly publishing: BrandConfigurationPublishingBinding | null;
  readonly occurredAt: string;
}
export interface BrandConfigurationAuthoringStoreOptions extends BrandConfigurationActorScope {
  readonly transaction: BrandConfigurationAuthoringTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: BrandConfigurationAuthoringTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: BrandConfigurationAuthoringTransaction,
      input: Readonly<
        BrandConfigurationActorScope & {
          permission: "organization.manage";
          purposeCode: "BRAND_CONFIGURATION";
          mode: Mode;
          requiredFields: typeof brandConfigurationOperationRequiredFields;
          command: Original | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly references: {
    canonicalize(value: unknown): string;
    hashIntent(canonical: string): string;
    nextReference(kind: "ConfigurationVersion" | "Audit"): string;
  };
  readonly appendAudit: (
    tx: BrandConfigurationAuthoringTransaction,
    input: Readonly<
      BrandConfigurationActorScope & {
        commandName: Original["command"];
        operationReference: string;
        intentDigest: string;
        configurationVersionReference: string | null;
        auditReference: string;
        occurredAt: string;
        purposeCode: "BRAND_CONFIGURATION";
        mode: "Execute" | "Abandon";
      }
    >,
  ) => Promise<void>;
  /** The ordinary host must use genuine public reference/Core owners in this
   * same transaction and retain their guards. This packet is not qualification. */
  readonly prepareFresh: (
    tx: BrandConfigurationAuthoringTransaction,
    input: Readonly<{
      command: BrandConfigurationCommand;
      current: BrandConfigurationRevision | null;
      configuration: BrandConfigurationVersion;
      observedAt: string;
      validUntil: string;
    }>,
  ) => Promise<BrandConfigurationFreshPreparation>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export function createPostgresBrandConfigurationAuthoringStore(
  options: BrandConfigurationAuthoringStoreOptions,
) {
  const fixed = Object.freeze({
    tenantReference: parsePlatformTenantReference(options.tenantReference),
    brandReference: parseBrandReference(options.brandReference),
    actorReference: parseBrandAdministrationReference(options.actorReference),
  });
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    refs = options.references,
    canonicalPort = refs.canonicalize,
    hashPort = refs.hashIntent,
    nextPort = refs.nextReference,
    registerPort = options.registerBeforeCommit,
    auditPort = options.appendAudit,
    preparePort = options.prepareFresh;
  const origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    failed = false,
    active = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    registered = false,
    guardCalls = 0,
    finalCalls = 0,
    done = false,
    wrote = false;
  let heldReviewUntil: string | undefined;
  let original: Original | null = null,
    heldHead: BrandConfigurationRevision | null | undefined,
    heldBrand: Record<string, unknown> | undefined;
  const modes = new Set<Mode>(),
    heldOperations = new Map<string, BrandConfigurationReceipt | null>(),
    heldPages = new Map<number | null, unknown>();
  const fail: (code?: BrandConfigurationOperationError["code"]) => never = (
    code = "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  ) => {
    failed = true;
    throw new BrandConfigurationOperationError(code);
  };
  if (
    [
      queryPort,
      nowPort,
      holdPort,
      canonicalPort,
      hashPort,
      nextPort,
      registerPort,
      auditPort,
      preparePort,
    ].some((p) => typeof p !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  function check() {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== nowPort ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== holdPort ||
      options.references !== refs ||
      refs.canonicalize !== canonicalPort ||
      refs.hashIntent !== hashPort ||
      refs.nextReference !== nextPort ||
      options.registerBeforeCommit !== registerPort ||
      options.appendAudit !== auditPort ||
      options.prepareFresh !== preparePort ||
      options.tenantReference !== fixed.tenantReference ||
      options.brandReference !== fixed.brandReference ||
      options.actorReference !== fixed.actorReference ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    const at = parseCanonicalInstant(nowPort.call(clock));
    if (at < latest || at >= deadline) return fail();
    if (heldReviewUntil !== undefined && at >= heldReviewUntil)
      return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
    latest = at;
    return at;
  }
  function canonical(value: unknown) {
    check();
    const text = canonicalPort.call(refs, value);
    check();
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 393216) return fail();
    return text;
  }
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  function hash(value: unknown) {
    const output = hashPort.call(refs, canonical(value));
    check();
    if (typeof output !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(output)) return fail();
    return output;
  }
  const digestRefs = {
    canonicalize: canonical,
    hashIntent: (text: string) => {
      check();
      const result = hashPort.call(refs, text);
      check();
      return result;
    },
  };
  function record(value: unknown, keys: readonly string[]) {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return fail();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      result[key] = d.value;
    }
    return result;
  }
  function rows(value: unknown, max = 1): readonly Record<string, unknown>[] {
    const d =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "rows")
        : undefined;
    if (
      !d ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > max ||
      Reflect.ownKeys(d.value).length !== d.value.length + 1
    )
      return fail();
    return Array.from({ length: d.value.length }, (_, i) => {
      const e = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (
        !e?.enumerable ||
        !("value" in e) ||
        !e.value ||
        typeof e.value !== "object" ||
        Object.getPrototypeOf(e.value) !== Object.prototype
      )
        return fail();
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(e.value)) {
        if (typeof key !== "string") return fail();
        const v = Object.getOwnPropertyDescriptor(e.value, key);
        if (!v?.enumerable || !("value" in v)) return fail();
        result[key] = v.value;
      }
      return result;
    });
  }
  async function query(sql: string, values: readonly unknown[]) {
    const at = check();
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [String(Math.max(1, Date.parse(deadline) - Date.parse(at)))],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  }
  async function insert(sql: string, values: readonly unknown[]) {
    const result = await query(sql, values),
      d =
        result && typeof result === "object"
          ? Object.getOwnPropertyDescriptor(result, "rowCount")
          : undefined;
    if (!d || !("value" in d) || d.value !== 1) return fail();
  }
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [fixed.tenantReference, fixed.brandReference],
    );
  async function hold(mode: Mode) {
    const answer = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        permission: "organization.manage" as const,
        purposeCode: "BRAND_CONFIGURATION" as const,
        mode,
        requiredFields: brandConfigurationOperationRequiredFields,
        command: original,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    const r = record(answer, ["validUntil"]),
      until = parseCanonicalInstant(r.validUntil);
    if (until < deadline) deadline = until;
    check();
    await restore();
  }
  async function brandLock(write: boolean) {
    await restore();
    const row = rows(
      await query(
        `SELECT brand_id,lifecycle,version::text version,${utc("updated_at")} updated_at,updated_at=date_trunc('milliseconds',updated_at) precise FROM bop_tenant.brand WHERE brand_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
        [fixed.brandReference],
      ),
    )[0];
    if (
      !row ||
      Object.keys(row).length !== 5 ||
      row.brand_id !== fixed.brandReference ||
      row.precise !== true ||
      !["Draft", "Active", "Suspended", "Archived"].includes(String(row.lifecycle)) ||
      typeof row.version !== "string" ||
      String(parseOrganizationVersion(Number(row.version))) !== row.version ||
      parseCanonicalInstant(row.updated_at) > check()
    )
      return fail();
    if (heldBrand && !same(heldBrand, row)) return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
    heldBrand ??= Object.freeze(row);
    return row;
  }
  const legacyKeys = [
    "configuration_version_id",
    "brand_id",
    "configuration_version",
    "lifecycle",
    "default_locale",
    "supported_locales",
    "media_theme_reference",
    "catalog_source_reference",
    "platform_template_reference",
    "override_allowed_field_codes",
    "hard_requirement_field_codes",
    "effective_from",
    "effective_until",
    "supersedes_version_reference",
    "reason_code",
    "authored_by_reference",
    "approved_by_reference",
    "approval_evidence_reference",
    "publication_reference",
    "created_at",
    "updated_at",
    "data_classification",
  ] as const;
  const legacyColumns = `configuration_version_id,brand_id,configuration_version::text configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,${utc("effective_from")} effective_from,CASE WHEN effective_until IS NULL THEN NULL ELSE ${utc("effective_until")} END effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,${utc("created_at")} created_at,${utc("updated_at")} updated_at,data_classification,effective_from=date_trunc('milliseconds',effective_from) AND (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until)) AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) precise`;
  function ownParsed<T>(work: () => T): T {
    try {
      return work();
    } catch {
      return fail();
    }
  }
  function decodeLegacy(row: Record<string, unknown>) {
    if (
      Object.keys(row).length !== 23 ||
      row.precise !== true ||
      typeof row.configuration_version !== "string"
    )
      return fail();
    const configuration = ownParsed(() =>
      parseTenantRecordedBrandConfiguration({
        configurationVersionReference: row.configuration_version_id,
        brandReference: row.brand_id,
        configurationVersion: Number(row.configuration_version),
        lifecycle: row.lifecycle,
        defaultLocale: row.default_locale,
        supportedLocales: row.supported_locales,
        mediaThemeReference: row.media_theme_reference,
        catalogSourceReference: row.catalog_source_reference,
        platformTemplateReference: row.platform_template_reference,
        overrideAllowedFieldCodes: row.override_allowed_field_codes,
        hardRequirementFieldCodes: row.hard_requirement_field_codes,
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
        supersedesVersionReference: row.supersedes_version_reference,
        reasonCode: row.reason_code,
        authoredByReference: row.authored_by_reference,
        approvedByReference: row.approved_by_reference,
        approvalEvidenceReference: row.approval_evidence_reference,
        publicationReference: row.publication_reference,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dataClassification: row.data_classification,
      }),
    );
    if (
      configuration.brandReference !== fixed.brandReference ||
      String(configuration.configurationVersion) !== row.configuration_version ||
      configuration.updatedAt > check()
    )
      return fail();
    return configuration;
  }
  let heldLegacy: BrandConfigurationVersion | null | undefined;
  async function latestLegacy() {
    await restore();
    const found = rows(
      await query(
        `SELECT ${legacyColumns} FROM bop_tenant.brand_configuration_version WHERE brand_id=$1 ORDER BY configuration_version DESC LIMIT 1`,
        [fixed.brandReference],
      ),
    );
    return found[0] ? decodeLegacy(found[0]) : null;
  }
  async function insertPublished(configuration: BrandConfigurationVersion) {
    await insert(
      `INSERT INTO bop_tenant.brand_configuration_version(${legacyKeys.join(",")}) VALUES(${legacyKeys.map((_, i) => `$${i + 1}`).join(",")})`,
      [
        configuration.configurationVersionReference,
        configuration.brandReference,
        configuration.configurationVersion,
        configuration.lifecycle,
        configuration.defaultLocale,
        configuration.supportedLocales,
        configuration.mediaThemeReference,
        configuration.catalogSourceReference,
        configuration.platformTemplateReference,
        configuration.overrideAllowedFieldCodes,
        configuration.hardRequirementFieldCodes,
        configuration.effectiveFrom,
        configuration.effectiveUntil,
        configuration.supersedesVersionReference,
        configuration.reasonCode,
        configuration.authoredByReference,
        configuration.approvedByReference,
        configuration.approvalEvidenceReference,
        configuration.publicationReference,
        configuration.createdAt,
        configuration.updatedAt,
        configuration.dataClassification,
      ],
    );
  }
  async function protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      check();
      const answer = await work();
      check();
      return answer;
    } catch (error) {
      failed = true;
      if (error instanceof BrandConfigurationOperationError) throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  function scoped(command: Original) {
    if (
      command.tenantReference !== fixed.tenantReference ||
      command.brandReference !== fixed.brandReference ||
      command.actorReference !== fixed.actorReference
    )
      return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
    if (original && !same(original, command)) return fail();
    original = command;
  }
  function preparation(
    raw: unknown,
    command: BrandConfigurationCommand,
    current: BrandConfigurationRevision | null,
    configuration: BrandConfigurationVersion,
    observedAt: string,
  ): BrandConfigurationFreshPreparation {
    const r = record(raw, ["configuration", "submittedByReference", "publishing", "occurredAt"]),
      prepared = parseTenantRecordedBrandConfiguration(r.configuration),
      at = parseCanonicalInstant(r.occurredAt);
    if (
      at < configuration.updatedAt ||
      at < observedAt ||
      at > check() ||
      prepared.updatedAt !== at
    )
      return fail();
    if (
      !same(
        tenantBrandConfigurationContent(configuration),
        tenantBrandConfigurationContent(prepared),
      )
    )
      return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
    const candidate = parseBrandConfigurationRevision({
      profile: "TenantBrandConfigurationRevisionV1",
      ...fixed,
      revision: (current?.revision ?? 0) + 1,
      brandVersion: command.expectedBrandVersion,
      command: command.command,
      operationReference: command.operationReference,
      configuration: prepared,
      submittedByReference: r.submittedByReference,
      publishing: r.publishing,
      contentDigest: "sha256:" + "0".repeat(64),
      sourceDigest: "sha256:" + "0".repeat(64),
      auditReference: command.operationReference,
      createdAt: current?.createdAt ?? at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    });
    if (
      command.command !== "SaveConfigurationDraft" &&
      candidate.publishing?.mutationOperationReference !== command.operationReference
    )
      return fail();
    if (command.command !== "SaveConfigurationDraft" && current) {
      if (
        command.command !== "SubmitConfiguration" &&
        candidate.submittedByReference !== current.submittedByReference
      )
        return fail();
      if (
        command.command !== "SubmitConfiguration" &&
        (!candidate.publishing ||
          !current.publishing ||
          candidate.publishing.familyReference !== current.publishing.familyReference ||
          candidate.publishing.lifecycleReference !== current.publishing.lifecycleReference ||
          candidate.publishing.lifecycleVersion !== current.publishing.lifecycleVersion + 1 ||
          candidate.publishing.validationEvidenceReference !==
            current.publishing.validationEvidenceReference)
      )
        return fail();
      if (
        command.command === "PublishConfiguration" &&
        (prepared.approvedByReference !== configuration.approvedByReference ||
          prepared.approvalEvidenceReference !== configuration.approvalEvidenceReference ||
          candidate.publishing?.approvalEvidenceReference !==
            current.publishing?.approvalEvidenceReference)
      )
        return fail();
    }
    return Object.freeze({
      configuration: prepared,
      submittedByReference: candidate.submittedByReference,
      publishing: candidate.publishing,
      occurredAt: at,
    });
  }
  const revisionColumns = `tenant_id,brand_id,revision::text revision,brand_version::text brand_version,configuration_version_id,configuration_version::text configuration_version,command_type,operation_id,actor_id,audit_id,content_digest,source_digest,snapshot_json,${utc("created_at")} created_at,${utc("recorded_at")} recorded_at,data_classification,created_at=date_trunc('milliseconds',created_at) AND recorded_at=date_trunc('milliseconds',recorded_at) precise`;
  const operationColumns = `operation_id,tenant_id,brand_id,actor_id,command_type,expected_brand_version::text expected_brand_version,expected_revision::text expected_revision,expected_configuration_version_id,expected_source_digest,intent_digest,outcome,result_revision::text result_revision,result_configuration_version_id,result_source_digest,command_json,receipt_json,audit_id,${utc("occurred_at")} occurred_at,data_classification,occurred_at=date_trunc('milliseconds',occurred_at) precise`;
  function decodeRevision(row: Record<string, unknown>) {
    const value = ownParsed(() =>
      assertBrandConfigurationRevisionDigests(row.snapshot_json, digestRefs),
    );
    if (
      Object.keys(row).length !== 17 ||
      row.precise !== true ||
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      value.tenantReference !== fixed.tenantReference ||
      value.brandReference !== fixed.brandReference ||
      row.revision !== String(value.revision) ||
      row.brand_version !== String(value.brandVersion) ||
      row.configuration_version_id !== value.configuration.configurationVersionReference ||
      row.configuration_version !== String(value.configuration.configurationVersion) ||
      row.command_type !== value.command ||
      row.operation_id !== value.operationReference ||
      row.actor_id !== value.actorReference ||
      row.audit_id !== value.auditReference ||
      row.content_digest !== value.contentDigest ||
      row.source_digest !== value.sourceDigest ||
      row.created_at !== value.createdAt ||
      row.recorded_at !== value.recordedAt ||
      row.data_classification !== value.dataClassification ||
      value.recordedAt > check() ||
      !same(value, row.snapshot_json)
    )
      return fail();
    return value;
  }
  async function latestHead() {
    await restore();
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM bop_tenant.brand_configuration_authoring_revision WHERE tenant_id=$1 AND brand_id=$2 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference],
      ),
    );
    if (!data[0]) return null;
    const snapshot = decodeRevision(data[0]);
    const receipt = await operation(snapshot.operationReference, false);
    if (!receipt?.snapshot || !same(receipt.snapshot, snapshot)) return fail();
    return snapshot;
  }
  async function loadPage(before: number | null) {
    await restore();
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM bop_tenant.brand_configuration_authoring_revision WHERE tenant_id=$1 AND brand_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT 3`,
        [fixed.tenantReference, fixed.brandReference, before],
      ),
      3,
    );
    const parsed = data.map(decodeRevision);
    for (const snapshot of parsed) {
      const receipt = await operation(snapshot.operationReference, false);
      if (!receipt?.snapshot || !same(receipt.snapshot, snapshot)) return fail();
    }
    const entries = parsed.slice(0, 2);
    return {
      entries,
      nextBeforeRevision: parsed.length === 3 ? (entries[1]?.revision ?? fail()) : null,
    };
  }
  async function operation(operationReference: string, requireOriginalActor = true) {
    await restore();
    const row = rows(
      await query(
        `SELECT ${operationColumns} FROM bop_tenant.brand_configuration_authoring_operation WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3`,
        [fixed.tenantReference, fixed.brandReference, operationReference],
      ),
    )[0];
    if (!row) return null;
    const receipt = ownParsed(() => parseBrandConfigurationReceipt(row.receipt_json));
    if (
      requireOriginalActor &&
      (row.actor_id !== fixed.actorReference || receipt.actorReference !== fixed.actorReference)
    )
      return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
    const head = receipt.expectedHead,
      snapshot = receipt.snapshot;
    if (
      Object.keys(row).length !== 20 ||
      row.precise !== true ||
      row.operation_id !== operationReference ||
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      receipt.tenantReference !== fixed.tenantReference ||
      receipt.brandReference !== fixed.brandReference ||
      receipt.operationReference !== operationReference ||
      row.actor_id !== receipt.actorReference ||
      row.command_type !== receipt.command ||
      row.expected_brand_version !== String(receipt.expectedBrandVersion) ||
      row.expected_revision !== (head ? String(head.revision) : null) ||
      row.expected_configuration_version_id !== (head?.configurationVersionReference ?? null) ||
      row.expected_source_digest !== (head?.sourceDigest ?? null) ||
      row.intent_digest !== receipt.intentDigest ||
      row.outcome !== receipt.outcome ||
      row.result_revision !== (snapshot ? String(snapshot.revision) : null) ||
      row.result_configuration_version_id !==
        (snapshot?.configuration.configurationVersionReference ?? null) ||
      row.result_source_digest !== (snapshot?.sourceDigest ?? null) ||
      row.audit_id !== receipt.auditReference ||
      row.occurred_at !== receipt.occurredAt ||
      row.data_classification !== receipt.dataClassification ||
      receipt.occurredAt > check() ||
      !same(receipt, row.receipt_json) ||
      !same(receipt.originalCommand, row.command_json)
    )
      return fail();
    if (receipt.originalCommand && hash(receipt.originalCommand) !== receipt.intentDigest)
      return fail();
    if (snapshot) {
      const actual = rows(
        await query(
          `SELECT ${revisionColumns} FROM bop_tenant.brand_configuration_authoring_revision WHERE tenant_id=$1 AND brand_id=$2 AND revision=$3 AND operation_id=$4`,
          [fixed.tenantReference, fixed.brandReference, snapshot.revision, operationReference],
        ),
      )[0];
      if (!actual || !same(decodeRevision(actual), snapshot)) return fail();
      if (snapshot.command === "PublishConfiguration") {
        const published = rows(
          await query(
            `SELECT ${legacyColumns} FROM bop_tenant.brand_configuration_version WHERE brand_id=$1 AND configuration_version_id=$2`,
            [fixed.brandReference, snapshot.configuration.configurationVersionReference],
          ),
        )[0];
        if (!published || !same(decodeLegacy(published), snapshot.configuration)) return fail();
      }
    }
    return receipt;
  }
  function intent(command: Original) {
    return command.profile === "TenantBrandConfigurationCommandV1"
      ? hash(command)
      : command.intentDigest;
  }
  async function lookup(command: Original) {
    const receipt = await operation(command.operationReference);
    if (!receipt) return null;
    if (
      receipt.command !== command.command ||
      receipt.expectedBrandVersion !== command.expectedBrandVersion ||
      !same(receipt.expectedHead, command.expectedHead) ||
      receipt.intentDigest !== intent(command)
    )
      return fail("BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT");
    return receipt;
  }
  async function admit(mode: Mode, command: Original | null) {
    if (active || phase !== "Work") return fail();
    active = true;
    if (command) scoped(command);
    modes.add(mode);
    if (!registered) {
      registered = true;
      const returned = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            for (const mode of modes) await hold(mode);
            await brandLock([...modes].some((mode) => mode !== "Read"));
            if (heldHead !== undefined && !same(await latestHead(), heldHead))
              return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
            if (heldLegacy !== undefined && !same(await latestLegacy(), heldLegacy))
              return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
            for (const [before, page] of heldPages)
              if (!same(await loadPage(before), page))
                return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
            for (const [op, receipt] of heldOperations)
              if (!same(await operation(op), receipt)) return fail();
            await restore();
            if (wrote)
              await query(
                "SET CONSTRAINTS bop_tenant.brand_configuration_revision_coherence,bop_tenant.brand_configuration_operation_coherence IMMEDIATE",
                [],
              );
            check();
            done = true;
          } catch (error) {
            failed = true;
            if (error instanceof BrandConfigurationOperationError) throw error;
            return fail();
          }
        },
        () => {
          if (++finalCalls !== 1 || !done || guardCalls !== 1 || active || phase !== "Checks")
            return fail();
          check();
          phase = "Final";
        },
      );
      if (returned !== undefined) return fail();
    }
    await hold(mode);
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
    if (command)
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `BrandConfigurationOriginal:${command.operationReference}`,
      ]);
    await query(
      `SELECT pg_advisory_xact_lock${mode === "Read" ? "_shared" : ""}(hashtextextended($1,0))`,
      [`BrandConfigurationSource:${fixed.tenantReference}:${fixed.brandReference}`],
    );
    return brandLock(mode !== "Read");
  }
  async function append(
    command: Original,
    snapshot: BrandConfigurationRevision | null,
    auditReference: string,
    occurredAt: string,
  ) {
    const digest = intent(command);
    const returned = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        commandName: command.command,
        operationReference: command.operationReference,
        intentDigest: digest,
        configurationVersionReference:
          snapshot?.configuration.configurationVersionReference ??
          command.expectedHead?.configurationVersionReference ??
          null,
        auditReference,
        occurredAt,
        purposeCode: "BRAND_CONFIGURATION" as const,
        mode: snapshot ? ("Execute" as const) : ("Abandon" as const),
      }),
    );
    check();
    if (returned !== undefined) return fail();
    await restore();
    const receipt = parseBrandConfigurationReceipt({
      profile: "TenantBrandConfigurationOperationV1",
      ...fixed,
      command: command.command,
      operationReference: command.operationReference,
      expectedBrandVersion: command.expectedBrandVersion,
      expectedHead: command.expectedHead,
      purposeCode: "BRAND_CONFIGURATION",
      intentDigest: digest,
      originalCommand:
        snapshot && command.profile === "TenantBrandConfigurationCommandV1" ? command : null,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt,
      dataClassification: "ConfigurationMetadata",
    });
    if (snapshot)
      await insert(
        "INSERT INTO bop_tenant.brand_configuration_authoring_revision(tenant_id,brand_id,revision,brand_version,configuration_version_id,configuration_version,command_type,operation_id,actor_id,audit_id,content_digest,source_digest,snapshot_json,created_at,recorded_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,'ConfigurationMetadata')",
        [
          fixed.tenantReference,
          fixed.brandReference,
          snapshot.revision,
          snapshot.brandVersion,
          snapshot.configuration.configurationVersionReference,
          snapshot.configuration.configurationVersion,
          snapshot.command,
          snapshot.operationReference,
          snapshot.actorReference,
          snapshot.auditReference,
          snapshot.contentDigest,
          snapshot.sourceDigest,
          canonical(snapshot),
          snapshot.createdAt,
          snapshot.recordedAt,
        ],
      );
    await insert(
      "INSERT INTO bop_tenant.brand_configuration_authoring_operation(operation_id,tenant_id,brand_id,actor_id,command_type,expected_brand_version,expected_revision,expected_configuration_version_id,expected_source_digest,intent_digest,outcome,result_revision,result_configuration_version_id,result_source_digest,command_json,receipt_json,audit_id,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,'ConfigurationMetadata')",
      [
        command.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.actorReference,
        command.command,
        command.expectedBrandVersion,
        command.expectedHead?.revision ?? null,
        command.expectedHead?.configurationVersionReference ?? null,
        command.expectedHead?.sourceDigest ?? null,
        digest,
        receipt.outcome,
        snapshot?.revision ?? null,
        snapshot?.configuration.configurationVersionReference ?? null,
        snapshot?.sourceDigest ?? null,
        receipt.originalCommand ? canonical(receipt.originalCommand) : null,
        canonical(receipt),
        auditReference,
        occurredAt,
      ],
    );
    wrote = true;
    const persisted = await lookup(command);
    if (!persisted || !same(persisted, receipt)) return fail();
    heldOperations.set(command.operationReference, persisted);
    return persisted;
  }
  return Object.freeze({
    readCurrent: () =>
      protect(async () => {
        await admit("Read", null);
        heldHead = await latestHead();
        await hold("Read");
        return parseBrandConfigurationCurrent({
          profile: "TenantBrandConfigurationCurrentV1",
          ...fixed,
          current: heldHead,
          observedAt: check(),
          validUntil: deadline,
          currentPublication: "NotEvaluated",
        });
      }),
    readHistory: (input: unknown) =>
      protect(async () => {
        const r = record(input, ["beforeRevision"]),
          before =
            r.beforeRevision === null
              ? null
              : typeof r.beforeRevision === "number" &&
                  Number.isInteger(r.beforeRevision) &&
                  r.beforeRevision >= 1 &&
                  r.beforeRevision <= 2147483647
                ? r.beforeRevision
                : fail("BRAND_CONFIGURATION_INPUT_INVALID");
        await admit("Read", null);
        const page = await loadPage(before);
        heldPages.set(before, page);
        await hold("Read");
        return parseBrandConfigurationHistory({
          profile: "TenantBrandConfigurationHistoryV1",
          ...fixed,
          beforeRevision: before,
          ...page,
          observedAt: check(),
          validUntil: deadline,
          currentPublication: "NotEvaluated",
        });
      }),
    readOriginal: (raw: unknown) =>
      protect(async () => {
        const command = parseBrandConfigurationResolve(raw);
        await admit("Resolve", command);
        const receipt = await lookup(command);
        heldOperations.set(command.operationReference, receipt);
        return receipt;
      }),
    resolve: (raw: unknown) =>
      protect(async () => {
        const command = parseBrandConfigurationResolve(raw);
        await admit("Resolve", command);
        const found = await lookup(command);
        if (found) {
          heldOperations.set(command.operationReference, found);
          return found;
        }
        const auditReference = parseBrandAdministrationReference(nextPort.call(refs, "Audit"));
        check();
        return append(command, null, auditReference, check());
      }),
    execute: (raw: unknown) =>
      protect(async () => {
        const command = parseBrandConfigurationCommand(raw),
          brand = await admit("Execute", command);
        const found = await lookup(command);
        if (found) {
          heldOperations.set(command.operationReference, found);
          return found;
        }
        if (
          (command.command === "SaveConfigurationDraft" && brand.lifecycle === "Archived") ||
          Number(brand.version) !== command.expectedBrandVersion
        )
          return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
        const current = await latestHead();
        if (
          command.expectedHead === null
            ? current !== null
            : !current ||
              current.revision !== command.expectedHead.revision ||
              current.configuration.configurationVersionReference !==
                command.expectedHead.configurationVersionReference ||
              current.sourceDigest !== command.expectedHead.sourceDigest
        )
          return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
        let configuration: BrandConfigurationVersion;
        if (command.command === "SaveConfigurationDraft") {
          heldLegacy = await latestLegacy();
          if (
            current &&
            heldLegacy &&
            (heldLegacy.configurationVersion > current.configuration.configurationVersion ||
              (heldLegacy.configurationVersion === current.configuration.configurationVersion &&
                (heldLegacy.configurationVersionReference !==
                  current.configuration.configurationVersionReference ||
                  !same(
                    tenantBrandConfigurationContent(heldLegacy),
                    tenantBrandConfigurationContent(current.configuration),
                  ))))
          )
            return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
          const prior = current?.configuration ?? heldLegacy;
          const configurationVersionReference = parseBrandAdministrationReference(
            nextPort.call(refs, "ConfigurationVersion"),
          );
          check();
          if (configurationVersionReference === prior?.configurationVersionReference) return fail();
          const occurredAt = check();
          configuration = createBrandConfigurationVersion({
            ...command.configuration,
            configurationVersionReference,
            brandReference: fixed.brandReference,
            configurationVersion: (prior?.configurationVersion ?? 0) + 1,
            lifecycle: "Draft",
            supersedesVersionReference: prior?.configurationVersionReference ?? null,
            authoredByReference: fixed.actorReference,
            approvedByReference: null,
            approvalEvidenceReference: null,
            publicationReference: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            dataClassification: "ConfigurationMetadata",
          });
        } else {
          if (!current) return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
          const expected = {
            SubmitConfiguration: "Draft",
            ApproveConfiguration: "PendingApproval",
            PublishConfiguration: "Approved",
          }[command.command];
          if (current.configuration.lifecycle !== expected)
            return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
          if (
            command.command === "ApproveConfiguration" &&
            (current.configuration.authoredByReference === fixed.actorReference ||
              current.submittedByReference === fixed.actorReference)
          )
            return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
          configuration = current.configuration;
          if (command.command === "SubmitConfiguration") {
            const until = command.reviewValidUntil;
            if (
              until === null ||
              until <= check() ||
              (configuration.effectiveUntil !== null && until > configuration.effectiveUntil)
            )
              return fail("BRAND_CONFIGURATION_VERSION_CONFLICT");
            heldReviewUntil = until;
          }
        }
        const prepareObservedAt = check();
        const rawPrepared = await preparePort.call(
          options,
          tx,
          Object.freeze({
            command,
            current,
            configuration,
            observedAt: prepareObservedAt,
            validUntil: deadline,
          }),
        );
        check();
        const prepared = preparation(
          rawPrepared,
          command,
          current,
          configuration,
          prepareObservedAt,
        );
        const auditReference = parseBrandAdministrationReference(nextPort.call(refs, "Audit"));
        check();
        const snapshot = createBrandConfigurationRevision(
          {
            profile: "TenantBrandConfigurationRevisionV1",
            ...fixed,
            revision: (current?.revision ?? 0) + 1,
            brandVersion: command.expectedBrandVersion,
            command: command.command,
            operationReference: command.operationReference,
            configuration: prepared.configuration,
            submittedByReference: prepared.submittedByReference,
            publishing: prepared.publishing,
            auditReference,
            createdAt: current?.createdAt ?? prepared.occurredAt,
            recordedAt: prepared.occurredAt,
            dataClassification: "ConfigurationMetadata",
          },
          digestRefs,
        );
        if (snapshot.command === "PublishConfiguration") {
          await restore();
          await insertPublished(snapshot.configuration);
          heldLegacy = await latestLegacy();
          if (!heldLegacy || !same(heldLegacy, snapshot.configuration)) return fail();
        }
        const receipt = await append(command, snapshot, auditReference, snapshot.recordedAt);
        heldHead = snapshot;
        return receipt;
      }),
    /** Post-COMMIT protocol assertion only. Current clock and authority were
     * synchronously sealed by the host's final callback before COMMIT. */
    assertFinalized: () => {
      if (
        failed ||
        !registered ||
        !done ||
        guardCalls !== 1 ||
        finalCalls !== 1 ||
        phase !== "Final" ||
        active
      )
        return fail();
      return deadline;
    },
  });
}
