import { canonicalizeRfc8785 } from "@bop/audit";
import {
  BrandConfigurationOperationError,
  brandConfigurationEditableFields,
  createBrandConfigurationVersion,
  createTenantContext,
  parseBrandAdministrationContext,
  type BrandAdministrationContext,
  parseBrandConfigurationCommand,
  parseBrandConfigurationRevision,
  parseCanonicalInstant,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContentDigest,
  type BrandConfigurationActorScope,
  type BrandConfigurationCommand,
  type BrandConfigurationAuthoringStoreOptions,
  type BrandConfigurationAuthoringTransaction,
  type BrandConfigurationFreshPreparation,
  type BrandConfigurationVersion,
  type TenantContext,
} from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  createPublishingApprovalEvidence,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
  executePublishingMutation,
  executeBrandAdministrationPublishingMutation,
  type ExecuteBrandAdministrationPublishingMutationInput,
  type BrandAdministrationPublishingAuthorizationPort,
  parsePublishingDigest,
  parsePublishingCode,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingInstant,
  parseReleaseSequence,
  type ExecutePublishingMutationInput,
  type PublishingAuthorizationPort,
  type PublishingLifecycleRecord,
} from "@bop/publishing";
import {
  parseBrandCatalogSourceExact,
  parseCatalogReference,
  type BrandCatalogSourceExact,
} from "@rms/catalog";

type Prepare = BrandConfigurationAuthoringStoreOptions["prepareFresh"];
type PrepareInput = Parameters<Prepare>[1];
/** Actual owning material selected by the server. These fields never come from
 * browser qualification claims; their owning holders retain current guards. */
export interface BrandConfigurationTemplateMaterial {
  readonly reference: string;
  readonly digest: string;
  readonly supportedLocales: readonly string[];
  readonly overrideAllowedFieldCodes: readonly string[];
  readonly hardRequirementFieldCodes: readonly string[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export interface BrandConfigurationThemeMaterial {
  readonly reference: string;
  readonly digest: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export interface BrandConfigurationReferenceMaterials {
  readonly catalog: BrandCatalogSourceExact;
  readonly template: BrandConfigurationTemplateMaterial;
  readonly theme: BrandConfigurationThemeMaterial | null;
}
export interface MerchantBrandConfigurationPreparationOptions extends BrandConfigurationActorScope {
  readonly transaction: BrandConfigurationAuthoringTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: BrandConfigurationAuthoringStoreOptions["registerBeforeCommit"];
  readonly nextReference: (
    kind: "Lifecycle" | "Mutation" | "Validation" | "Approval" | "Release" | "Audit",
  ) => string;
  readonly authority: {
    /** Real Session/IAM/Tenant source, with current authorization retained through
     * the same outer COMMIT. Draft Brands cannot impersonate Active context. */
    withCurrentContext<T>(
      tx: BrandConfigurationAuthoringTransaction,
      input: PrepareInput,
      work: (
        context: TenantContext,
        actualTx: BrandConfigurationAuthoringTransaction,
      ) => Promise<T>,
    ): Promise<T>;
    readonly publishing: PublishingAuthorizationPort;
  };
  readonly references: {
    /** Mandatory public Catalog/Template/Media owner composition. No permissive
     * fallback exists when a real source has not been wired. */
    withCurrentReferences<T>(
      tx: BrandConfigurationAuthoringTransaction,
      input: PrepareInput,
      work: (
        material: BrandConfigurationReferenceMaterials,
        actualTx: BrandConfigurationAuthoringTransaction,
      ) => Promise<T>,
    ): Promise<T>;
  };
}
const unavailable = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const conflict = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_VERSION_CONFLICT");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return unavailable();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d?.enumerable || !("value" in d)) return unavailable();
    copy[key] = d.value;
  }
  return copy;
}
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function codes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) return unavailable();
  const result = value.map((v) => {
    if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(v))
      return unavailable();
    return v;
  });
  if (new Set(result).size !== result.length) return unavailable();
  return Object.freeze(result);
}
function period(r: Record<string, unknown>, c: BrandConfigurationVersion) {
  const from = parseCanonicalInstant(r.effectiveFrom),
    until = r.effectiveUntil === null ? null : parseCanonicalInstant(r.effectiveUntil);
  if (
    from > c.effectiveFrom ||
    (until !== null && (until <= from || c.effectiveUntil === null || c.effectiveUntil > until))
  )
    return conflict();
}

export type MerchantBrandAdministrationConfigurationPreparationOptions = Omit<
  MerchantBrandConfigurationPreparationOptions,
  "authority"
> & {
  readonly authority: {
    withCurrentContext<T>(
      tx: BrandConfigurationAuthoringTransaction,
      input: PrepareInput,
      work: (
        context: BrandAdministrationContext,
        actualTx: BrandConfigurationAuthoringTransaction,
      ) => Promise<T>,
    ): Promise<T>;
    readonly publishing: BrandAdministrationPublishingAuthorizationPort;
  };
};
type PreparationStrategy =
  | { readonly kind: "Operational"; readonly options: MerchantBrandConfigurationPreparationOptions }
  | {
      readonly kind: "Administration";
      readonly options: MerchantBrandAdministrationConfigurationPreparationOptions;
    };
export function createMerchantBrandAdministrationConfigurationPreparation(
  options: MerchantBrandAdministrationConfigurationPreparationOptions,
): Prepare {
  return createPreparation({ kind: "Administration", options });
}
/** Preparation is called only by the owning Tenant source after original
 * arbitration and CAS. It never performs a foreign private query or COMMIT. */
export function createMerchantBrandConfigurationPreparation(
  options: MerchantBrandConfigurationPreparationOptions,
): Prepare {
  return createPreparation({ kind: "Operational", options });
}
function createPreparation(strategy: PreparationStrategy): Prepare {
  const options = strategy.options;
  const fixed = Object.freeze({
      tenantReference: String(parsePublishingReference(options.tenantReference)),
      brandReference: String(parsePublishingReference(options.brandReference)),
      actorReference: String(parsePublishingReference(options.actorReference)),
    }),
    tx = options.transaction,
    query = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    contextPort = authority?.withCurrentContext,
    publishing = authority?.publishing,
    authorize = publishing?.authorize,
    references = options.references,
    referencePort = references?.withCurrentReferences,
    register = options.registerBeforeCommit,
    next = options.nextReference,
    origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil);
  if (
    typeof query !== "function" ||
    typeof now !== "function" ||
    typeof contextPort !== "function" ||
    typeof authorize !== "function" ||
    typeof referencePort !== "function" ||
    typeof register !== "function" ||
    typeof next !== "function" ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return unavailable();
  let latest = origin,
    deadline = originalUntil,
    businessUntil: string | null = null,
    active = false,
    failed = false,
    done = false,
    registered = false,
    guardCalls = 0,
    finalCalls = 0;
  function validatedContext(
    raw: TenantContext | BrandAdministrationContext,
    command: BrandConfigurationCommand,
  ): TenantContext | BrandAdministrationContext {
    if (strategy.kind === "Operational" && ("profile" in raw || !("scopeKind" in raw)))
      return unavailable();
    const context =
      strategy.kind === "Administration"
        ? parseBrandAdministrationContext(raw)
        : createTenantContext(raw.actor, raw.brand, raw.store, raw.resolvedAt);
    check();
    if (
      ("profile" in context
        ? context.profile !== "BrandAdministrationContextV1"
        : context.scopeKind !== "Brand") ||
      context.store !== null ||
      context.brand.brandReference !== fixed.brandReference ||
      context.brand.version !== command.expectedBrandVersion ||
      context.actor.actorReference !== fixed.actorReference ||
      context.resolvedAt < origin ||
      context.resolvedAt > check()
    )
      return unavailable();
    return context;
  }
  async function withContext<T>(
    input: PrepareInput,
    work: (
      context: TenantContext | BrandAdministrationContext,
      actual: BrandConfigurationAuthoringTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    check();
    let calls = 0;
    const held = async (
      raw: TenantContext | BrandAdministrationContext,
      actual: BrandConfigurationAuthoringTransaction,
    ) => {
      if (++calls !== 1 || actual !== tx) return unavailable();
      return work(validatedContext(raw, input.command), actual);
    };
    const result =
      strategy.kind === "Administration"
        ? await strategy.options.authority.withCurrentContext(tx, input, held)
        : await strategy.options.authority.withCurrentContext(tx, input, held);
    check();
    if (calls !== 1) return unavailable();
    return result;
  }
  if (strategy.kind === "Administration" && fixed.tenantReference !== fixed.brandReference)
    return unavailable();
  const allocated = new Set<string>();
  function check(): string {
    if (
      failed ||
      finalCalls !== 0 ||
      options.transaction !== tx ||
      tx.query !== query ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.withCurrentContext !== contextPort ||
      authority.publishing !== publishing ||
      publishing.authorize !== authorize ||
      options.references !== references ||
      references.withCurrentReferences !== referencePort ||
      options.registerBeforeCommit !== register ||
      options.nextReference !== next ||
      options.tenantReference !== fixed.tenantReference ||
      options.brandReference !== fixed.brandReference ||
      options.actorReference !== fixed.actorReference ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return unavailable();
    const at = parseCanonicalInstant(now.call(clock));
    if (at < latest || at >= deadline || (businessUntil !== null && at >= businessUntil))
      return unavailable();
    latest = at;
    return at;
  }
  function allocate(kind: Parameters<typeof next>[0]) {
    check();
    const id = parsePublishingReference(next.call(options, kind));
    check();
    if (allocated.has(id)) return unavailable();
    allocated.add(id);
    return id;
  }
  return async (actualTx, raw) => {
    try {
      check();
      if (active || done || actualTx !== tx) return unavailable();
      active = true;
      const r = closed(raw, ["command", "current", "configuration", "observedAt", "validUntil"]),
        command = parseBrandConfigurationCommand(r.command),
        current = r.current === null ? null : parseBrandConfigurationRevision(r.current),
        configuration = parseTenantRecordedBrandConfiguration(r.configuration),
        observedAt = parseCanonicalInstant(r.observedAt),
        validUntil = parseCanonicalInstant(r.validUntil);
      if (
        command.tenantReference !== fixed.tenantReference ||
        command.brandReference !== fixed.brandReference ||
        command.actorReference !== fixed.actorReference ||
        configuration.brandReference !== fixed.brandReference ||
        configuration.updatedAt > check() ||
        observedAt < origin ||
        observedAt > check() ||
        validUntil > originalUntil ||
        validUntil <= observedAt ||
        (current &&
          (current.tenantReference !== fixed.tenantReference ||
            current.brandReference !== fixed.brandReference))
      )
        return unavailable();
      if (
        (current !== null &&
          (command.expectedHead === null ||
            command.expectedHead.revision !== current.revision ||
            command.expectedHead.configurationVersionReference !==
              current.configuration.configurationVersionReference ||
            command.expectedHead.sourceDigest !== current.sourceDigest ||
            current.brandVersion !== command.expectedBrandVersion)) ||
        (current === null && command.expectedHead !== null) ||
        (command.command === "SaveConfigurationDraft" &&
          !same(
            command.configuration,
            Object.fromEntries(
              brandConfigurationEditableFields.map((key) => [key, configuration[key]]),
            ),
          ))
      )
        return conflict();
      deadline = validUntil;
      const input = Object.freeze({ command, current, configuration, observedAt, validUntil });
      await register.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || !done || active) return unavailable();
            check();
          } catch {
            failed = true;
            return unavailable();
          }
        },
        () => {
          try {
            if (finalCalls !== 0 || failed || !done || active || guardCalls !== 1 || !registered)
              return unavailable();
            // The real host runs this synchronous seal after all asynchronous
            // guards and immediately before returning to its COMMIT owner.
            check();
            finalCalls = 1;
          } catch {
            failed = true;
            return unavailable();
          }
        },
      );
      registered = true;
      check();
      let referenceCalls = 0,
        referenceAnswer: BrandConfigurationFreshPreparation | undefined;
      const answer = await referencePort.call(references, tx, input, async (material, heldTx) => {
        if (++referenceCalls !== 1 || heldTx !== tx) return unavailable();
        check();
        const m = closed(material, ["catalog", "template", "theme"]),
          catalog = parseBrandCatalogSourceExact(
            m.catalog,
            {
              tenantReference: parseCatalogReference(fixed.tenantReference),
              brandReference: parseCatalogReference(fixed.brandReference),
              actorReference: parseCatalogReference(fixed.actorReference),
            },
            configuration.catalogSourceReference,
            check(),
          ),
          template = closed(m.template, [
            "reference",
            "digest",
            "supportedLocales",
            "overrideAllowedFieldCodes",
            "hardRequirementFieldCodes",
            "effectiveFrom",
            "effectiveUntil",
          ]);
        if (
          !catalog.source ||
          parseCanonicalInstant(catalog.validUntil) > deadline ||
          parseCanonicalInstant(catalog.observedAt) < origin
        )
          return unavailable();
        deadline = parseCanonicalInstant(catalog.validUntil);
        if (
          String(parsePublishingReference(template.reference)) !==
          configuration.platformTemplateReference
        )
          return conflict();
        parsePublishingDigest(template.digest);
        const locales = codes(template.supportedLocales),
          allowed = codes(template.overrideAllowedFieldCodes),
          hard = codes(template.hardRequirementFieldCodes);
        if (
          !locales.length ||
          configuration.supportedLocales.some((v) => !locales.includes(v)) ||
          configuration.overrideAllowedFieldCodes.some((v) => !allowed.includes(v)) ||
          hard.some((v) => !configuration.hardRequirementFieldCodes.includes(v)) ||
          hard.some((v) => allowed.includes(v))
        )
          return conflict();
        period(template, configuration);
        if (configuration.mediaThemeReference === null) {
          if (m.theme !== null) return conflict();
        } else {
          const theme = closed(m.theme, ["reference", "digest", "effectiveFrom", "effectiveUntil"]);
          if (
            String(parsePublishingReference(theme.reference)) !== configuration.mediaThemeReference
          )
            return conflict();
          parsePublishingDigest(theme.digest);
          period(theme, configuration);
        }
        check();
        if (command.command === "SaveConfigurationDraft") {
          if (configuration.lifecycle !== "Draft") return conflict();
          const saved = await withContext(input, async () => {
            const at = check();
            referenceAnswer = Object.freeze({
              configuration: createBrandConfigurationVersion({ ...configuration, updatedAt: at }),
              submittedByReference: null,
              publishing: null,
              occurredAt: at,
            });
            return referenceAnswer;
          });
          check();
          if (!referenceAnswer || !same(saved, referenceAnswer)) return unavailable();
          return referenceAnswer;
        }
        if (!current || !same(current.configuration, configuration)) return conflict();
        // This is an owning Tenant permission rule over the actual retained
        // author/submitter facts. Refuse before the generic Core admission
        // wrapper, which deliberately normalizes callback failures.
        if (
          command.command === "ApproveConfiguration" &&
          (current.configuration.authoredByReference === fixed.actorReference ||
            current.submittedByReference === fixed.actorReference)
        )
          throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
        let contextCalls = 0,
          contextAnswer: BrandConfigurationFreshPreparation | undefined;
        const result = await withContext(
          input,
          async (
            rawContext: TenantContext | BrandAdministrationContext,
            actual: BrandConfigurationAuthoringTransaction,
          ) => {
            if (++contextCalls !== 1 || actual !== tx) return unavailable();
            const context = rawContext;
            const scope = createPublishingScope({
                kind: "Brand",
                brandReference: fixed.brandReference,
                storeReference: null,
              }),
              owner = createPostgresPublishingMutationStore(
                { run: (work) => work(tx) },
                fixed.tenantReference,
                scope,
              );
            contextAnswer = await owner.withBrandConfigurationWrite(
              { familyReference: fixed.brandReference },
              async (held) => {
                if (held !== tx) return unavailable();
                const digest = parsePublishingDigest(
                    tenantBrandConfigurationContentDigest(configuration),
                  ),
                  common = {
                    familyReference: parsePublishingReference(fixed.brandReference),
                    configurationType: parsePublishingCode("BRAND_CONFIGURATION"),
                    purposeCode: parsePublishingCode("BRAND_CONFIGURATION"),
                    observedAt: check(),
                  };
                const service = async (
                  value:
                    | ExecutePublishingMutationInput
                    | ExecuteBrandAdministrationPublishingMutationInput,
                ) => {
                  check();
                  const validateAuthorization = (
                    request: {
                      resourceScope: unknown;
                      familyReference: string;
                      purposeCode: string;
                    },
                    actualContext: TenantContext | BrandAdministrationContext,
                  ) => {
                    check();
                    if (
                      !same(actualContext, context) ||
                      !same(request.resourceScope, scope) ||
                      String(request.familyReference) !== fixed.brandReference ||
                      request.purposeCode !== "BRAND_CONFIGURATION"
                    )
                      return unavailable();
                  };
                  if ("administrationContext" in value) {
                    if (strategy.kind !== "Administration") return unavailable();
                    const publisher = strategy.options.authority.publishing;
                    const result = await executeBrandAdministrationPublishingMutation(value, {
                      authorization: {
                        async authorize(request) {
                          validateAuthorization(request, request.administrationContext);
                          const answer = await publisher.authorize(request);
                          check();
                          return answer;
                        },
                      },
                      unitOfWork: { commit: (mutation) => owner.commit(mutation) },
                    });
                    check();
                    return result;
                  }
                  if (strategy.kind !== "Operational") return unavailable();
                  const publisher = strategy.options.authority.publishing;
                  const result = await executePublishingMutation(value, {
                    authorization: {
                      async authorize(request) {
                        validateAuthorization(request, request.tenantContext);
                        const answer = await publisher.authorize(request);
                        check();
                        return answer;
                      },
                    },
                    unitOfWork: { commit: (mutation) => owner.commit(mutation) },
                  });
                  check();
                  return result;
                };
                const envelope = (
                  operation: ExecutePublishingMutationInput["operation"],
                  lifecycle: PublishingLifecycleRecord | null,
                  nextLife: PublishingLifecycleRecord,
                  operationId: string,
                  at: string,
                ):
                  | ExecutePublishingMutationInput
                  | ExecuteBrandAdministrationPublishingMutationInput => ({
                  ...("profile" in context
                    ? { administrationContext: context }
                    : { tenantContext: context }),
                  operation,
                  current: lifecycle,
                  next: nextLife,
                  expectedVersion: lifecycle?.version ?? nextLife.version,
                  idempotencyKey: parsePublishingReference(operationId),
                  auditId: allocate("Audit"),
                  correlationId: parsePublishingReference(command.operationReference),
                  occurredAt: at,
                  sourceChannel: parsePublishingCode("MERCHANT_WEB"),
                });
                if (command.command === "SubmitConfiguration") {
                  if (
                    configuration.lifecycle !== "Draft" ||
                    current.publishing !== null ||
                    command.reviewValidUntil === null ||
                    command.reviewValidUntil <= check()
                  )
                    return conflict();
                  businessUntil = command.reviewValidUntil;
                  if (
                    configuration.effectiveUntil !== null &&
                    businessUntil > configuration.effectiveUntil
                  )
                    return conflict();
                  const at = check(),
                    lifecycle = createPublishingLifecycleRecord({
                      lifecycleId: allocate("Lifecycle"),
                      familyReference: parsePublishingReference(fixed.brandReference),
                      configurationType: parsePublishingCode("BRAND_CONFIGURATION"),
                      purposeCode: parsePublishingCode("BRAND_CONFIGURATION"),
                      snapshotReference: parsePublishingReference(
                        configuration.configurationVersionReference,
                      ),
                      snapshotDigest: digest,
                      scope,
                      version: parsePublishingVersion(1),
                      state: "Draft",
                      validationEvidenceReference: null,
                      approvalEvidenceReference: null,
                      createdAt: parsePublishingInstant(at),
                      changedAt: parsePublishingInstant(at),
                    });
                  await service(envelope("CreateDraft", null, lifecycle, allocate("Mutation"), at));
                  const submittedAt = check(),
                    validation = createPublishingValidationEvidence({
                      evidenceReference: allocate("Validation"),
                      snapshotReference: lifecycle.snapshotReference,
                      snapshotDigest: digest,
                      scope,
                      result: "Pass",
                      checkedAt: parsePublishingInstant(submittedAt),
                      validUntil: parsePublishingInstant(businessUntil),
                      checkCodes: [
                        parsePublishingCode("CATALOG_SOURCE_CURRENT"),
                        parsePublishingCode("PLATFORM_TEMPLATE_COMPATIBILITY"),
                        parsePublishingCode("MEDIA_THEME_CURRENT"),
                      ],
                    }),
                    review = createPublishingLifecycleRecord({
                      ...lifecycle,
                      version: parsePublishingVersion(2),
                      state: "InReview",
                      validationEvidenceReference: validation.evidenceReference,
                      changedAt: parsePublishingInstant(submittedAt),
                    });
                  await service({
                    ...envelope(
                      "SubmitReview",
                      lifecycle,
                      review,
                      command.operationReference,
                      submittedAt,
                    ),
                    validationEvidence: validation,
                  });
                  return Object.freeze({
                    configuration: createBrandConfigurationVersion({
                      ...configuration,
                      lifecycle: "PendingApproval",
                      updatedAt: submittedAt,
                    }),
                    submittedByReference: fixed.actorReference,
                    occurredAt: submittedAt,
                    publishing: Object.freeze({
                      familyReference: fixed.brandReference,
                      lifecycleReference: review.lifecycleId,
                      lifecycleVersion: review.version,
                      mutationOperationReference: command.operationReference,
                      validationEvidenceReference: validation.evidenceReference,
                      approvalEvidenceReference: null,
                      publicationReference: null,
                    }),
                  });
                }
                const binding = current.publishing;
                if (!binding || binding.familyReference !== fixed.brandReference) return conflict();
                const head = await owner.resolveCurrentLifecycleMutation({
                  ...common,
                  lifecycleReference: binding.lifecycleReference,
                });
                if (
                  !head ||
                  head.next.version !== binding.lifecycleVersion ||
                  String(head.next.snapshotReference) !==
                    configuration.configurationVersionReference ||
                  head.next.snapshotDigest !== digest ||
                  head.next.validationEvidenceReference !== binding.validationEvidenceReference ||
                  head.idempotencyKey !== binding.mutationOperationReference
                )
                  return conflict();
                if (command.command === "ApproveConfiguration") {
                  const validation = head.validationEvidence;
                  if (
                    configuration.lifecycle !== "PendingApproval" ||
                    head.operation !== "SubmitReview" ||
                    head.next.state !== "InReview" ||
                    !validation ||
                    validation.evidenceReference !== binding.validationEvidenceReference ||
                    validation.validUntil <= check() ||
                    head.audit.actor.type !== "User" ||
                    head.audit.actor.reference !== current.submittedByReference
                  )
                    return conflict();
                  businessUntil = validation.validUntil;
                  const at = check(),
                    approval = createPublishingApprovalEvidence({
                      evidenceReference: allocate("Approval"),
                      reviewLifecycleId: head.next.lifecycleId,
                      reviewVersion: head.next.version,
                      snapshotReference: head.next.snapshotReference,
                      snapshotDigest: digest,
                      scope,
                      decision: "Accepted",
                      approvedActorReference: parsePublishingReference(fixed.actorReference),
                      approvedAt: parsePublishingInstant(at),
                      validUntil: parsePublishingInstant(businessUntil),
                    }),
                    approved = createPublishingLifecycleRecord({
                      ...head.next,
                      version: parsePublishingVersion(head.next.version + 1),
                      state: "Approved",
                      approvalEvidenceReference: approval.evidenceReference,
                      changedAt: parsePublishingInstant(at),
                    });
                  await service({
                    ...envelope("Approve", head.next, approved, command.operationReference, at),
                    approvalEvidence: approval,
                  });
                  return Object.freeze({
                    configuration: createBrandConfigurationVersion({
                      ...configuration,
                      lifecycle: "Approved",
                      approvedByReference: fixed.actorReference,
                      approvalEvidenceReference: approval.evidenceReference,
                      updatedAt: at,
                    }),
                    submittedByReference: current.submittedByReference,
                    occurredAt: at,
                    publishing: Object.freeze({
                      ...binding,
                      lifecycleVersion: approved.version,
                      mutationOperationReference: command.operationReference,
                      approvalEvidenceReference: approval.evidenceReference,
                    }),
                  });
                }
                if (
                  command.command !== "PublishConfiguration" ||
                  configuration.lifecycle !== "Approved"
                )
                  return conflict();
                const candidate = await owner.resolvePublicationCandidate({
                  ...common,
                  observedAt: check(),
                  lifecycleReference: binding.lifecycleReference,
                });
                if (
                  !same(candidate.lifecycle, head.next) ||
                  candidate.approvalEvidence.evidenceReference !==
                    binding.approvalEvidenceReference ||
                  candidate.validationEvidence.evidenceReference !==
                    binding.validationEvidenceReference ||
                  String(candidate.approvalEvidence.approvedActorReference) !==
                    configuration.approvedByReference ||
                  String(candidate.approvalEvidence.approvedActorReference) ===
                    configuration.authoredByReference ||
                  candidate.approvalEvidence.approvedActorReference === current.submittedByReference
                )
                  return conflict();
                businessUntil =
                  candidate.validationEvidence.validUntil < candidate.approvalEvidence.validUntil
                    ? candidate.validationEvidence.validUntil
                    : candidate.approvalEvidence.validUntil;
                const at = check(),
                  published = createPublishingLifecycleRecord({
                    ...candidate.lifecycle,
                    version: parsePublishingVersion(candidate.lifecycle.version + 1),
                    state: "Published",
                    changedAt: parsePublishingInstant(at),
                  }),
                  release = createPublishingReleaseRecord({
                    releaseId: allocate("Release"),
                    familyReference: parsePublishingReference(fixed.brandReference),
                    configurationType: parsePublishingCode("BRAND_CONFIGURATION"),
                    purposeCode: parsePublishingCode("BRAND_CONFIGURATION"),
                    snapshotReference: published.snapshotReference,
                    snapshotDigest: digest,
                    scope,
                    sourceLifecycleId: published.lifecycleId,
                    sequence: parseReleaseSequence((candidate.previousRelease?.sequence ?? 0) + 1),
                    previousReleaseId: candidate.previousRelease?.releaseId ?? null,
                    kind: "Publish",
                    createdAt: parsePublishingInstant(at),
                  });
                await service({
                  ...envelope(
                    "Publish",
                    candidate.lifecycle,
                    published,
                    command.operationReference,
                    at,
                  ),
                  validationEvidence: candidate.validationEvidence,
                  approvalEvidence: candidate.approvalEvidence,
                  release,
                  ...(candidate.previousRelease === null
                    ? {}
                    : { previousRelease: candidate.previousRelease }),
                });
                return Object.freeze({
                  configuration: createBrandConfigurationVersion({
                    ...configuration,
                    lifecycle: "Published",
                    publicationReference: release.releaseId,
                    updatedAt: at,
                  }),
                  submittedByReference: current.submittedByReference,
                  occurredAt: at,
                  publishing: Object.freeze({
                    ...binding,
                    lifecycleVersion: published.version,
                    mutationOperationReference: command.operationReference,
                    publicationReference: release.releaseId,
                  }),
                });
              },
            );
            return contextAnswer;
          },
        );
        check();
        if (contextCalls !== 1 || !contextAnswer || !same(result, contextAnswer))
          return unavailable();
        referenceAnswer = contextAnswer;
        return contextAnswer;
      });
      check();
      if (referenceCalls !== 1 || !referenceAnswer || !same(answer, referenceAnswer))
        return unavailable();
      done = true;
      return referenceAnswer;
    } catch (error) {
      failed = true;
      if (error instanceof BrandConfigurationOperationError) throw error;
      return unavailable();
    } finally {
      active = false;
    }
  };
}
