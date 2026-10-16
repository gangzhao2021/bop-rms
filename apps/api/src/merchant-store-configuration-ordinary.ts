import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { parseBusinessAction } from "@bop/permission";
import { parseCanonicalInstant, parseStoreReference } from "@bop/tenant";
import {
  createPostgresStoreConfigurationOriginalStore,
  createPostgresStoreConfigurationAuthoringSource,
  createPostgresStoreConfigurationHistorySource,
  storeConfigurationHistoryRequiredFields,
  createPostgresStoreSetupDraftStore,
  createPersistentStoreConfigurationAdministration,
  createPersistentStoreConfigurationV2Preparation,
  createStoreConfigurationPublicationHash,
  createStoreConfigurationVersion,
  materializeStoreSetupConfigurationVersionV2,
  parseStoreAdministrationReference,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  StoreConfigurationOriginalError,
  storeConfigurationOriginalRequiredFields,
  storeSetupDraftOperationFields,
  type StoreConfigurationVersion,
  type StoreConfigurationOriginalScope,
  type StoreConfigurationOrdinaryCommand,
  type StoreConfigurationV2PreparationOptions,
} from "@rms/store";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  parseMerchantStoreConfigurationOrdinaryWorkspace,
  parseMerchantStoreConfigurationHistoryPage,
} from "./merchant-store-configuration-ordinary-values.js";
import type { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type { StoreConfigurationPublicationChecks } from "./merchant-store-configuration-publication-checks.js";

type Existing = Parameters<typeof createMerchantStoreConfiguration>[0];
type Scope = Parameters<Existing["configure"]>[1];
type Commit = Parameters<ReturnType<Existing["configure"]>["appendAudit"]>[1];
const refs = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => "sha256:" + sha256Hex(text),
};
const digest = (value: unknown) => refs.hashIntent(refs.canonicalize(value));
const keys = ["tenantReference", "brandReference", "storeReference", "actorReference"] as const;
/** Every Publishing decision a fresh V2 Submit, Approve or Publish preparation may request. */
const publishingActions = [
  "publishing.draft.create",
  "publishing.review.submit",
  "publishing.review.approve",
  "publishing.release.publish",
  "publishing.release.archive",
  "publishing.release.rollback",
] as const;
const stage = {
  Materialize: "saveDraft",
  Validate: "validate",
  Submit: "submit",
  Approve: "approve",
  Publish: "publish",
} as const;
export interface MerchantStoreConfigurationOrdinarySourceHost {
  registerBeforeCommit(
    actual: Parameters<Existing["configure"]>[0],
    guard: () => Promise<void>,
    final: () => void,
  ): Promise<void>;
  registerAfterCommit(
    actual: Parameters<Existing["configure"]>[0],
    pureAssertFinalized: () => unknown,
  ): void;
}
export interface MerchantStoreConfigurationOrdinaryOptions extends Omit<
  Existing,
  "review" | "configure"
> {
  readonly configure: (
    tx: Parameters<Existing["configure"]>[0],
    scope: Scope,
    sourceHost: MerchantStoreConfigurationOrdinarySourceHost,
  ) => ReturnType<Existing["configure"]> & {
    /** WP-2423 DEC-STORE-SETUP-PUBLICATION: the publication checks of a configuration created
     * from Store setup, read from their owners in this run's transaction. */
    readonly publicationChecks?: (
      configuration: StoreConfigurationVersion,
    ) => Promise<StoreConfigurationPublicationChecks>;
  };
  nextReference(): string;
  /** Actual public-owner producers. Absence blocks fresh transitions only. */
  readonly v2?: Pick<
    StoreConfigurationV2PreparationOptions,
    "requiredValidationCheckCodes" | "validateSubmit" | "approvalValidUntil" | "liveGateEvidence"
  >;
}
/** The common host owns COMMIT. Immutable originals are arbitrated before saved
 * Setup, current configuration, qualification or server references are acquired. */
export function createMerchantStoreConfigurationOrdinary(
  options: MerchantStoreConfigurationOrdinaryOptions,
) {
  const persistence = options.persistence,
    authentication = options.authentication,
    runner = persistence.transactions,
    run = runner.run,
    now = persistence.now,
    authorize = authentication.authorize,
    configure = options.configure,
    next = options.nextReference,
    actions = options.actionPermissions;
  const actionValues = readClosedRecord(actions, [
    "saveDraft",
    "validate",
    "submit",
    "approve",
    "publish",
  ]);
  const v2Descriptor = Object.getOwnPropertyDescriptor(options, "v2");
  if (v2Descriptor && !("value" in v2Descriptor))
    throw new StoreConfigurationOriginalError(
      "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    );
  const v2: MerchantStoreConfigurationOrdinaryOptions["v2"] = v2Descriptor?.value;
  const v2Ports = v2 ? Object.getOwnPropertyDescriptors(v2) : undefined;
  if (
    v2Ports &&
    Reflect.ownKeys(v2Ports).some((k) => {
      const descriptor = v2Ports[String(k)];
      return !descriptor || !("value" in descriptor);
    })
  )
    throw new StoreConfigurationOriginalError(
      "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    );
  const host = createMerchantCategoryTransactions(runner),
    resolveScope = createMerchantStoreScope(persistence);
  const fail: (code?: StoreConfigurationOriginalError["code"]) => never = (
    code: StoreConfigurationOriginalError["code"] = "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new StoreConfigurationOriginalError(code);
  };
  const capture = () => {
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      persistence.transactions !== runner ||
      runner.run !== run ||
      persistence.now !== now ||
      authentication.authorize !== authorize ||
      options.configure !== configure ||
      options.nextReference !== next ||
      options.actionPermissions !== actions ||
      Object.keys(actionValues).some(
        (k) =>
          Object.getOwnPropertyDescriptor(actions, k)?.value !==
          Object.getOwnPropertyDescriptor(actionValues, k)?.value,
      ) ||
      Object.getOwnPropertyDescriptor(options, "v2")?.value !== v2 ||
      (v2 &&
        v2Ports &&
        Reflect.ownKeys(v2Ports).some(
          (k) => Object.getOwnPropertyDescriptor(v2, k)?.value !== v2Ports[String(k)]?.value,
        ))
    )
      fail();
  };
  const permission = (action: StoreConfigurationOrdinaryCommand["action"]) =>
    parseBusinessAction(actionValues[stage[action]]);
  for (const action of Object.keys(stage) as StoreConfigurationOrdinaryCommand["action"][])
    if (!permission(action).startsWith("store.service.")) fail();
  const scoped = (value: unknown): StoreConfigurationOriginalScope => {
    try {
      const r = readClosedRecord(value, keys);
      return Object.freeze({
        tenantReference: parseStoreAdministrationReference(r.tenantReference),
        brandReference: parseStoreAdministrationReference(r.brandReference),
        storeReference: parseStoreAdministrationReference(r.storeReference),
        actorReference: parseStoreAdministrationReference(r.actorReference),
      });
    } catch {
      return fail("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    }
  };
  async function execute(
    input: {
      sessionCookie: unknown;
      csrf?: unknown;
      expectedScope: unknown;
      expectedStoreReference?: unknown;
      command?: unknown;
      original?: unknown;
    },
    write: boolean,
    historyRequest?: { beforeSequence: number | null },
  ) {
    capture();
    const origin = parseCanonicalInstant(now.call(persistence));
    let last: string = origin,
      deadline: string = new Date(Date.parse(origin) + 5000).toISOString();
    const check = () => {
      capture();
      const at = parseCanonicalInstant(now.call(persistence));
      if (at < last || at >= deadline) fail();
      last = at;
      return at;
    };
    const tighten = (until: string | null) => {
      if (until === null) fail();
      const value = parseCanonicalInstant(until);
      if (value < deadline) deadline = value;
      check();
    };
    const expected = scoped(input.expectedScope),
      body = input.command ?? input.original;
    const command =
      body === undefined
        ? undefined
        : (() => {
            try {
              const d = Object.getOwnPropertyDescriptor(body, "profile");
              const r =
                d?.value === "StoreConfigurationOrdinaryResolveV1"
                  ? parseStoreConfigurationOrdinaryResolve(body)
                  : parseStoreConfigurationOrdinaryCommand(body);
              if (keys.some((k) => r[k] !== expected[k]))
                return fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
              return r;
            } catch (error) {
              if (error instanceof StoreConfigurationOriginalError) throw error;
              return fail("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
            }
          })();
    const authorityCommand = command
      ? (() => {
          const value = { ...command, profile: "StoreConfigurationOrdinaryCommandV1" };
          Reflect.deleteProperty(value, "intentDigest");
          return parseStoreConfigurationOrdinaryCommand(value);
        })()
      : undefined;
    if (write && !command) fail("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    const session =
      write || input.original !== undefined || historyRequest !== undefined
        ? await authorize
            .call(authentication, { sessionCookie: input.sessionCookie, csrf: input.csrf })
            .catch((error: unknown) => {
              if (error instanceof BrowserSessionError)
                return fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
              throw error;
            })
        : undefined;
    check();
    let finalized: (() => void) | undefined,
      sourceRegistrationOpen = true,
      sourceFailed = false,
      // WP-2423: set once the run's full re-check passed; the host's before-commit checks run
      // right after it, inside the same transaction.
      rechecked = false;
    const afterCommit: (() => void)[] = [];
    const usedPublishing = new Set<string>();
    const activeAction = command
      ? permission(command.action)
      : historyRequest !== undefined
        ? "store.service.read"
        : null;
    const requestedPublishing: readonly string[] =
      command && v2 && ["Submit", "Approve", "Publish"].includes(command.action)
        ? publishingActions
        : [];
    const deniedRun = () => fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    const scopeFix = (s: Scope) =>
      Object.freeze({
        tenantReference: s.selected.tenantReference,
        brandReference: s.context.brand.brandReference,
        storeReference: s.store.storeReference,
        actorReference: String(s.actorReference),
      });
    const output = await host.transactions
      .run((tx) =>
        // WP-2423: one authorized run. The caller, `organization.manage`, the command's (or
        // history's) permission and the Publishing decisions a fresh preparation may request are
        // resolved in full once at the start (one permission packet), and the permissions used
        // are re-checked in full once more inside the transaction before its checks and COMMIT.
        // Owner callbacks in between take the run's guard instead of re-resolving the caller.
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const base = await resolveScope(
                tx,
                input.sessionCookie,
                "organization.manage",
                session?.sessionReference,
              );
              const fixed = scopeFix(base);
              if (
                keys.some((k) => fixed[k] !== expected[k]) ||
                (input.expectedStoreReference !== undefined &&
                  parseStoreReference(input.expectedStoreReference) !== fixed.storeReference)
              )
                return deniedRun();
              const required = [
                "organization.manage",
                ...(activeAction === null ? [] : [activeAction]),
              ];
              const decisions = await base.authorizeActions([...required, ...requestedPublishing]);
              if (required.some((action) => decisions.get(action)?.effect !== "Allow"))
                return deniedRun();
              tighten(base.authorizationValidUntil());
              return { base, fixed, decisions };
            },
            recheck: async ({ base }) => {
              check();
              const actions = [
                "organization.manage",
                ...(activeAction === null ? [] : [activeAction]),
                ...usedPublishing,
              ];
              const current = await base.authorizeActions(actions);
              if (!actions.every((action) => current.get(action)?.effect === "Allow")) return false;
              tighten(base.authorizationValidUntil());
              rechecked = true;
              return true;
            },
            denied: deniedRun,
          },
          (authority) => runAuthorized(tx, authority),
        ),
      )
      .finally(() => {
        sourceRegistrationOpen = false;
        rechecked = false;
      });
    if (!finalized) fail();
    finalized();
    for (const finalizeSource of afterCommit) finalizeSource();
    check();
    if (output.profile === "StoreConfigurationOrdinaryWorkspaceV1")
      return parseMerchantStoreConfigurationOrdinaryWorkspace(
        { ...output, validUntil: deadline },
        expected,
      );
    if (output.profile === "StoreConfigurationHistoryEnvelopeInternal") {
      if (!historyRequest) fail();
      return Object.freeze({
        profile: output.profile,
        page: parseMerchantStoreConfigurationHistoryPage(
          { ...output.page, validUntil: deadline },
          expected,
          historyRequest.beforeSequence,
        ),
      });
    }
    return output;
    async function runAuthorized(
      tx: Parameters<Parameters<typeof host.transactions.run>[0]>[0],
      authority: MerchantTransactionAuthority<{
        base: Scope;
        fixed: ReturnType<typeof scopeFix>;
        decisions: ReadonlyMap<string, Awaited<ReturnType<Scope["authorizeAction"]>>>;
      }>,
    ) {
      const query = tx.query,
        { base, fixed, decisions } = authority.scope,
        lease = base.authorizationValidUntil,
        baseStore = base.store,
        baseSession = base.sessionReference;
      /** The run's guard (no query), or the run's full re-check that has just passed. */
      const authorized = async () => (await authority.guard()) || rechecked;
      // Owner configuration takes this scope: its `allowed` is the run's guard.
      const active: Scope = Object.freeze({ ...base, allowed: authorized });
      const assertScope = () => {
        if (
          tx.query !== query ||
          base.authorizationValidUntil !== lease ||
          base.store !== baseStore ||
          base.sessionReference !== baseSession ||
          keys.some((k) => scopeFix(base)[k] !== fixed[k])
        )
          fail();
      };
      const fresh = async () => {
        check();
        assertScope();
        if (!(await authorized())) fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
        assertScope();
        tighten(lease.call(base));
        assertScope();
      };
      await fresh();
      const sourceCheck = () => {
        if (sourceFailed) fail();
        try {
          assertScope();
          check();
          assertScope();
        } catch (error) {
          sourceFailed = true;
          throw error;
        }
      };
      const sourceRegistration = (actual: Parameters<Existing["configure"]>[0]) => {
        if (!sourceRegistrationOpen || actual !== tx || tx.query !== query) {
          sourceFailed = true;
          fail();
        }
        sourceCheck();
      };
      const syncVoid = (work: () => unknown) => {
        sourceCheck();
        const returned: unknown = work();
        if (returned !== undefined) {
          sourceFailed = true;
          if (returned instanceof Promise) void returned.catch(() => undefined);
          fail();
        }
        sourceCheck();
      };
      const sourceHost: MerchantStoreConfigurationOrdinarySourceHost = Object.freeze({
        async registerBeforeCommit(
          actual: Parameters<Existing["configure"]>[0],
          guard: () => Promise<void>,
          final: () => void,
        ) {
          sourceRegistration(actual);
          if (typeof guard !== "function" || typeof final !== "function") {
            sourceFailed = true;
            fail();
          }
          try {
            await host.registerBeforeCommit(
              tx,
              async () => {
                sourceCheck();
                const returned: unknown = await guard();
                if (returned !== undefined) {
                  sourceFailed = true;
                  fail();
                }
                sourceCheck();
              },
              () => syncVoid(final),
            );
            sourceRegistration(actual);
          } catch (error) {
            sourceFailed = true;
            throw error;
          }
        },
        registerAfterCommit(
          actual: Parameters<Existing["configure"]>[0],
          pureAssertFinalized: () => unknown,
        ) {
          sourceRegistration(actual);
          if (typeof pureAssertFinalized !== "function" || afterCommit.length >= 128) {
            sourceFailed = true;
            fail();
          }
          afterCommit.push(() => syncVoid(pureAssertFinalized));
        },
      });
      let configured:
        ReturnType<MerchantStoreConfigurationOrdinaryOptions["configure"]> | undefined;
      const configuration = () => (configured ??= configure.call(options, tx, active, sourceHost));
      let expectedState: StoreConfigurationVersion | null | undefined,
        headReader: ReturnType<typeof createPostgresStoreConfigurationAuthoringSource> | undefined;
      const current = async () => {
        await fresh();
        const value = await configuration().publishedBaseline(tx);
        if (value === null) return null;
        const parsed = createStoreConfigurationVersion(value);
        if (
          parsed.lifecycle !== "Published" ||
          parsed.brandReference !== fixed.brandReference ||
          parsed.storeReference !== fixed.storeReference ||
          (parsed.setupBasis !== undefined &&
            parsed.setupBasis.tenantReference !== fixed.tenantReference)
        )
          fail();
        return parsed;
      };
      const latest = async (mode: "Read" | "Write") => {
        if (!headReader)
          headReader = createPostgresStoreConfigurationAuthoringSource({
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            mode,
            authorize: async (actual) => {
              if (actual !== tx) fail();
              await fresh();
              return true;
            },
          });
        return headReader(tx, check());
      };
      let checks = false;
      await host.registerBeforeCommit(
        tx,
        async () => {
          sourceRegistrationOpen = false;
          sourceCheck();
          if (checks) fail();
          await fresh();
          if (expectedState !== undefined) {
            const actual = (await latest("Read")) ?? (await current());
            if (digest(actual) !== digest(expectedState))
              fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
          }
          checks = true;
        },
        () => {
          sourceCheck();
          if (!checks || tx.query !== query) fail();
          assertScope();
          check();
        },
      );
      if (historyRequest !== undefined) {
        const history = createPostgresStoreConfigurationHistorySource({
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          readerActorReference: fixed.actorReference,
          transaction: tx,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          canonicalize: canonicalizeRfc8785,
          registerBeforeCommit: async (actual, guard, final) => {
            if (actual !== tx) fail();
            await host.registerBeforeCommit(tx, guard, final);
          },
          authority: {
            holdUntilTransactionCompletes: async (actual, packet) => {
              if (
                actual !== tx ||
                packet.tenantReference !== fixed.tenantReference ||
                packet.brandReference !== fixed.brandReference ||
                packet.storeReference !== fixed.storeReference ||
                packet.actorReference !== fixed.actorReference ||
                packet.permission !== "store.service.read" ||
                packet.purposeCode !== "STORE_CONFIGURATION_HISTORY" ||
                digest(packet.requiredFields) !== digest(storeConfigurationHistoryRequiredFields) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > deadline
              )
                fail();
              await fresh();
              return { validUntil: deadline };
            },
          },
        });
        const page = await history.readPage(historyRequest);
        finalized = () => {
          assertScope();
          tighten(history.assertFinalized(tx));
          check();
        };
        return Object.freeze({
          profile: "StoreConfigurationHistoryEnvelopeInternal" as const,
          page,
        });
      }
      const originals = command
        ? createPostgresStoreConfigurationOriginalStore({
            ...fixed,
            transaction: tx,
            clock: { now: check },
            originalObservedAt: origin,
            originalValidUntil: deadline,
            registerBeforeCommit: async (actual, guard, final) => {
              if (actual !== tx) fail();
              await host.registerBeforeCommit(tx, guard, final);
            },
            references: {
              ...refs,
              nextReference: () => {
                check();
                return next.call(options);
              },
            },
            authority: {
              holdUntilTransactionCompletes: async (actual, packet) => {
                if (
                  actual !== tx ||
                  keys.some((k) => packet[k] !== fixed[k]) ||
                  packet.purposeCode !== "STORE_CONFIGURATION" ||
                  packet.action !== authorityCommand?.action ||
                  digest(packet.command) !== digest(authorityCommand) ||
                  digest(packet.requiredFields) !==
                    digest(storeConfigurationOriginalRequiredFields) ||
                  packet.observedAt < origin ||
                  packet.observedAt > check() ||
                  packet.validUntil > deadline
                )
                  fail();
                await fresh();
                return { validUntil: deadline };
              },
            },
            appendAbandonedAudit: async (actual, packet) => {
              if (actual !== tx || keys.some((k) => packet[k] !== fixed[k])) fail();
              const audit = validateAuditRecord(
                {
                  auditId: packet.auditReference,
                  brandId: fixed.brandReference,
                  storeId: fixed.storeReference,
                  actor: { type: "User", reference: fixed.actorReference },
                  actionCode: "STORE_CONFIGURATION_ORIGINAL_ABANDONED",
                  targetType: "StoreConfigurationOriginal",
                  targetId: packet.operationReference,
                  afterSummary: { intentDigest: packet.intentDigest },
                  reasonCode: "AUTHORIZED_OPERATION",
                  correlationId: packet.operationReference,
                  occurredAt: packet.occurredAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: "OPERATIONAL",
                  retentionPolicyVersion: 1,
                },
                Date.parse(check()),
              );
              await appendAuditRecordInTransaction(tx, audit);
              check();
            },
          })
        : undefined;
      let original = originals && command ? await originals.readOriginal(command) : null;
      let setup: ReturnType<typeof createPostgresStoreSetupDraftStore> | undefined;
      const finish = () => {
        finalized = () => {
          assertScope();
          check();
          originals?.assertFinalized(tx);
          setup?.assertFinalized(tx);
          assertScope();
          check();
        };
      };
      if (write && command && originals) {
        if (command.profile === "StoreConfigurationOrdinaryResolveV1") {
          const result = await originals.resolve(command);
          finish();
          return result;
        }
        if (original) {
          finish();
          return original;
        }
        let snapshot:
          | Awaited<
              ReturnType<ReturnType<typeof createPostgresStoreSetupDraftStore>["readCurrent"]>
            >
          | undefined;
        if (command.action === "Materialize") {
          setup = createPostgresStoreSetupDraftStore({
            ...fixed,
            transaction: tx,
            clock: { now: check },
            originalObservedAt: origin,
            originalValidUntil: deadline,
            registerBeforeCommit: async (actual, guard, final) => {
              if (actual !== tx) fail();
              await host.registerBeforeCommit(tx, guard, final);
            },
            references: { ...refs, nextReference: () => fail() },
            authority: {
              holdUntilTransactionCompletes: async (actual, packet) => {
                if (
                  actual !== tx ||
                  packet.mode !== "Read" ||
                  packet.command !== null ||
                  packet.permission !== "organization.manage" ||
                  packet.purposeCode !== "STORE_SETUP_DRAFT" ||
                  digest(packet.requiredFields) !== digest(storeSetupDraftOperationFields) ||
                  keys.some((k) => packet[k] !== fixed[k]) ||
                  packet.validUntil > deadline
                )
                  fail();
                await fresh();
                return { validUntil: deadline };
              },
            },
            appendAudit: async () => fail(),
            withCurrentSaveScope: async () => fail(),
          });
          snapshot = await setup.readCurrent();
          if (
            !snapshot.snapshot ||
            snapshot.snapshot.setupDraftReference !== command.setupSelector.setupDraftReference ||
            snapshot.snapshot.revision !== command.setupSelector.sourceRevision ||
            digest(snapshot.snapshot) !== command.setupSelector.sourceSnapshotDigest
          )
            fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
        }
        const state = (await latest("Write")) ?? (await current()),
          head = state
            ? {
                configurationReference: state.configurationReference,
                configurationVersion: state.configurationVersion,
                contentDigest: digest(state),
              }
            : { configurationReference: null, configurationVersion: 0, contentDigest: null };
        if (digest(head) !== digest(command.expectedHead))
          fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
        const at = check(),
          configuredOptions = configuration();
        let candidate: StoreConfigurationVersion;
        if (command.action === "Materialize") {
          if (!snapshot?.snapshot || active.store.currencyCode !== "CAD") fail();
          candidate = materializeStoreSetupConfigurationVersionV2(
            snapshot.snapshot,
            {
              ...fixed,
              defaultLocale: active.store.locale,
              currencyCode: "CAD",
              baseConfigurationReference: state?.configurationReference ?? null,
            },
            {
              configurationReference: next.call(options),
              configurationVersion: (state?.configurationVersion ?? 0) + 1,
              reasonCode: command.reasonCode,
              createdAt: at,
              updatedAt: at,
            },
            refs,
          );
        } else {
          if (!state || state.setupBasis === undefined)
            fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
          candidate = state;
        }
        const audit = next.call(options),
          committed: { input: Commit | undefined } = { input: undefined };
        const administration = createPersistentStoreConfigurationAdministration({
          ...configuredOptions,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          run: async (work) => work(tx),
          now: check,
          publication: {
            ...configuredOptions.publication,
            tenantReference: fixed.tenantReference,
            setupSnapshotReferences: refs,
            hashContent: createStoreConfigurationPublicationHash(refs),
            authorize: async (actual, observed) => {
              if (actual !== tx) fail();
              await fresh();
              return configuredOptions.publication.authorize(actual, observed);
            },
          },
          ports: (actual) => {
            if (actual !== tx) fail();
            const supplied = configuredOptions.ports(actual);
            return {
              ...supplied,
              authorization: {
                authorize: async (packet) => {
                  await fresh();
                  return supplied.authorization.authorize(packet);
                },
              },
              prepareFresh: async (action, packet, prior) => {
                if (action !== "Submit" && action !== "Approve" && action !== "Publish")
                  return packet.configuration;
                if (!v2) fail();
                const preparation = createPersistentStoreConfigurationV2Preparation({
                  ...v2,
                  ...fixed,
                  publishingFamilyReference:
                    configuredOptions.publication.publishingFamilyReference,
                  configurationType: configuredOptions.publication.configurationType,
                  purposeCode: configuredOptions.publication.purposeCode,
                  originalObservedAt: origin,
                  originalValidUntil: deadline,
                  clock: { now: check },
                  setupSnapshotReferences: refs,
                  nextReference: () => {
                    check();
                    return next.call(options);
                  },
                  hashContent: createStoreConfigurationPublicationHash(refs),
                  // The context resolved in full at the start of this run (same transaction).
                  currentTenantContext: async () => {
                    await fresh();
                    return base.context;
                  },
                  // The Publishing decision taken at the start of this run (no query); every
                  // decision used is re-checked in full before the commit.
                  publishingAuthorization: () => ({
                    authorize: async (request) => {
                      await fresh();
                      const decision = decisions.get(String(request.action));
                      if (!decision || decision.effect !== "Allow")
                        fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
                      usedPublishing.add(String(request.action));
                      return decision;
                    },
                  }),
                });
                return preparation.forTransaction(tx)(action, packet, prior);
              },
            };
          },
          appendAudit: async (actual, packet) => {
            if (actual !== tx) fail();
            await configuredOptions.appendAudit(actual, packet);
            committed.input = packet;
            check();
          },
        });
        await administration[stage[command.action]]({
          operationReference: command.operationReference,
          actorReference: fixed.actorReference,
          purposeCode: "STORE_CONFIGURATION",
          auditReference: audit,
          expectedVersion: state?.configurationVersion ?? 0,
          occurredAt: at,
          configuration: candidate,
        });
        const originalInput = committed.input?.originalInput;
        if (!originalInput) fail();
        original = await originals.recordCommitted(command, originalInput);
        expectedState = original.operation?.configuration ?? fail();
        finish();
        return original;
      }
      const recordedLatest = await latest("Read"),
        published = await current();
      expectedState = recordedLatest ?? published;
      // WP-2423 DEC-STORE-SETUP-PUBLICATION: a configuration from Store setup that still awaits
      // sending, approval or publication carries its checks, so the Owner sees what blocks it.
      const evaluate = configuration().publicationChecks;
      const publicationChecks =
        evaluate !== undefined &&
        recordedLatest !== null &&
        recordedLatest.setupBasis !== undefined &&
        (recordedLatest.lifecycle === "Draft" ||
          recordedLatest.lifecycle === "PendingApproval" ||
          recordedLatest.lifecycle === "Approved")
          ? await evaluate(recordedLatest)
          : undefined;
      finish();
      return parseMerchantStoreConfigurationOrdinaryWorkspace(
        {
          profile: "StoreConfigurationOrdinaryWorkspaceV1",
          scope: fixed,
          latest: recordedLatest,
          current: published,
          expectedHead: expectedState
            ? {
                configurationReference: expectedState.configurationReference,
                configurationVersion: expectedState.configurationVersion,
                contentDigest: digest(expectedState),
              }
            : { configurationReference: null, configurationVersion: 0, contentDigest: null },
          original,
          observedAt: check(),
          validUntil: deadline,
          businessReferenceValidation: "NotEvaluated",
          ...(publicationChecks === undefined ? {} : { publicationChecks }),
        },
        fixed,
      );
    }
  }
  return Object.freeze({
    history: async (input: {
      sessionCookie: unknown;
      csrf: unknown;
      expectedStoreReference: unknown;
      expectedScope: unknown;
      beforeSequence: unknown;
    }) => {
      const beforeSequence = input.beforeSequence;
      if (
        beforeSequence !== null &&
        (typeof beforeSequence !== "number" ||
          !Number.isSafeInteger(beforeSequence) ||
          beforeSequence < 1)
      )
        fail("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
      const value = await execute(input, false, { beforeSequence });
      if (value.profile !== "StoreConfigurationHistoryEnvelopeInternal") fail();
      return value.page;
    },
    read: async (input: {
      sessionCookie: unknown;
      expectedStoreReference: unknown;
      expectedScope: unknown;
      original?: unknown;
      csrf?: unknown;
    }) => {
      const value = await execute(input, false);
      if (value.profile !== "StoreConfigurationOrdinaryWorkspaceV1") return fail();
      return value;
    },
    write: async (input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
      expectedScope: unknown;
    }) => {
      const value = await execute(input, true);
      if (value.profile !== "StoreConfigurationOrdinaryReceiptV1") return fail();
      return value;
    },
  });
}
