import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction } from "@bop/permission";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPersistentStoreConfigurationAdministration,
  createPostgresStoreConfigurationAuthoringSource,
  createPostgresStoreSetupDraftStore,
  createStoreConfigurationVersion,
  materializeStoreSetupConfigurationVersionV2,
  parseStoreAdministrationReference,
  readStoreConfigurationWithdrawal,
  parseStoreServiceExceptions,
  parseStoreSetupSaveCommand,
  parseStoreWeeklyServiceSchedule,
  storeSetupDraftOperationFields,
  StoreConfigurationAdministrationServiceError,
  StoreSetupOperationError,
  type StoreConfigurationVersion,
  type StoreSetupDraft,
  type StoreSetupDraftStoreOptions,
} from "@rms/store";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import {
  MerchantStoreHoursNoChangeError,
  storeConfigurationAdministrationOptions,
  storeConfigurationChangesNothing,
  type MerchantStoreConfigurationOptions,
  type StoreConfigurationPublishingAccess,
} from "./merchant-store-configuration.js";

/** WP-2423 Q4: the reason recorded with an hours change (same as the hours editor's). */
export const STORE_HOURS_REASON_CODE = "STORE_HOURS_UPDATE";
const refs = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => "sha256:" + sha256Hex(text),
};
const digest = (value: unknown) => refs.hashIntent(refs.canonicalize(value));
const rejected = (): never => {
  throw new StoreConfigurationAdministrationServiceError("STORE_CONFIGURATION_COMMAND_INVALID");
};
// Typed so the transaction host passes it through (a plain Error reads as an outage there).
const denied = (): never => {
  throw new StoreConfigurationAdministrationServiceError("STORE_CONFIGURATION_PERMISSION_DENIED");
};
const unavailable = (): never => {
  throw new StoreSetupOperationError("STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE");
};

export interface StoreHoursSetupDraftCommand {
  /** The Store setup revision this change is made from (the configuration's setup basis). */
  readonly expectedSetup: {
    readonly setupDraftReference: string;
    readonly sourceRevision: number;
    readonly sourceSnapshotDigest: string;
  };
  readonly setupOperationReference: string;
  readonly operationReference: string;
  readonly auditReference: string;
  readonly configurationReference: string;
  readonly expectedVersion: number;
  readonly weeklySchedule: ReturnType<typeof parseStoreWeeklyServiceSchedule>;
  readonly exceptions: ReturnType<typeof parseStoreServiceExceptions>;
  /** The server time the editor read the configuration at; the change applies from then. */
  readonly effectiveFrom: string;
}
/** Transport binding only: an invalid request is a rejected change (422), never an outage. */
export function parseStoreHoursSetupDraftCommand(raw: unknown): StoreHoursSetupDraftCommand {
  try {
    const r = readClosedRecord(raw, [
      "expectedSetup",
      "setupOperationReference",
      "operationReference",
      "auditReference",
      "configurationReference",
      "expectedVersion",
      "weeklySchedule",
      "exceptions",
      "effectiveFrom",
    ]);
    const setup = readClosedRecord(r.expectedSetup, [
      "setupDraftReference",
      "sourceRevision",
      "sourceSnapshotDigest",
    ]);
    const references = [
      r.setupOperationReference,
      r.operationReference,
      r.auditReference,
      r.configurationReference,
    ].map(parseStoreAdministrationReference);
    if (
      new Set(references).size !== references.length ||
      typeof r.expectedVersion !== "number" ||
      !Number.isSafeInteger(r.expectedVersion) ||
      r.expectedVersion < 1 ||
      typeof setup.sourceRevision !== "number" ||
      !Number.isSafeInteger(setup.sourceRevision) ||
      setup.sourceRevision < 1 ||
      setup.sourceRevision > 2147483647 ||
      typeof setup.sourceSnapshotDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(setup.sourceSnapshotDigest)
    )
      return rejected();
    return Object.freeze({
      expectedSetup: Object.freeze({
        setupDraftReference: parseStoreAdministrationReference(setup.setupDraftReference),
        sourceRevision: setup.sourceRevision,
        sourceSnapshotDigest: setup.sourceSnapshotDigest,
      }),
      setupOperationReference: references[0] as string,
      operationReference: references[1] as string,
      auditReference: references[2] as string,
      configurationReference: references[3] as string,
      expectedVersion: r.expectedVersion,
      weeklySchedule: parseStoreWeeklyServiceSchedule(r.weeklySchedule),
      exceptions: parseStoreServiceExceptions(r.exceptions),
      effectiveFrom: parseCanonicalInstant(r.effectiveFrom),
    });
  } catch (error) {
    if (error instanceof StoreConfigurationAdministrationServiceError) throw error;
    return rejected();
  }
}

type HoursField = "weeklySchedule" | "exceptions" | "effectiveFrom" | "effectiveUntil";
const hoursFields: readonly HoursField[] = [
  "weeklySchedule",
  "exceptions",
  "effectiveFrom",
  "effectiveUntil",
];
/** Store setup content apart from opening hours (what an hours-only change leaves alone). */
const apartFromHours = (content: StoreSetupDraft["content"]) =>
  digest(
    Object.fromEntries(
      Object.entries(content).filter(([field]) => !hoursFields.includes(field as HoursField)),
    ),
  );
/** The exact revision a configuration was made from (the setup basis without its tenant). */
const selectorOf = (basis: {
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
}) => ({
  setupDraftReference: basis.setupDraftReference,
  sourceRevision: basis.sourceRevision,
  sourceSnapshotDigest: basis.sourceSnapshotDigest,
});
/** The opening hours of Store setup content (weekly hours, dated exceptions, effective dates). */
const hoursOf = (content: StoreSetupDraft["content"]) =>
  digest(hoursFields.map((field) => content[field]));

/**
 * One authorized run over the Store's published and latest configuration and its Store setup
 * (hours-only saves), shared by the hours change and the restore after a withdrawal. `actions`:
 * the run needs any one of them allowed (resolved once and re-checked before the commit).
 */
function createStoreHoursSetupRun(
  options: MerchantStoreConfigurationOptions,
  actions: readonly string[],
) {
  const source = options.persistence;
  const resolveScope = createMerchantStoreScope(source);
  const host = createMerchantCategoryTransactions(source.transactions);
  const parsed = actions.map((action) => parseBusinessAction(action));
  if (parsed.length === 0 || parsed.some((action) => !action.startsWith("store.service.")))
    throw new Error("STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID");
  return async <T>(
    input: { sessionCookie: unknown; csrf: unknown },
    audit: { readonly reasonCode: string; readonly correlationReference?: string },
    work: (run: {
      readonly tx: Parameters<Parameters<typeof host.transactions.run>[0]>[0];
      readonly fixed: Readonly<{
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      }>;
      readonly scope: Parameters<MerchantStoreConfigurationOptions["configure"]>[1];
      readonly configured: ReturnType<MerchantStoreConfigurationOptions["configure"]>;
      readonly published: StoreConfigurationVersion | null;
      readonly recorded: StoreConfigurationVersion | null;
      readonly setup: ReturnType<typeof createPostgresStoreSetupDraftStore>;
      /** The Store setup save this run makes (at most one), named before it is saved. */
      plan(command: ReturnType<typeof parseStoreSetupSaveCommand>): void;
      check(): string;
      guard(): Promise<boolean>;
    }) => Promise<T>,
  ): Promise<T> => {
    const session = await options.authentication.authorize(input);
    const origin = parseCanonicalInstant(source.now());
    let last: string = origin,
      deadline: string = new Date(Date.parse(origin) + 5000).toISOString();
    const check = () => {
      const at = parseCanonicalInstant(source.now());
      if (at < last || at >= deadline) return unavailable();
      last = at;
      return at;
    };
    const anyAllowed = (
      decisions: ReadonlyMap<string, { readonly effect: string } | null | undefined>,
    ) => parsed.some((action) => decisions.get(action)?.effect === "Allow");
    // Set once the run's full re-check passed; the before-commit checks run right after it.
    let rechecked = false;
    let finalize: (() => void) | undefined;
    const result = await host.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const scope = await resolveScope(
              tx,
              input.sessionCookie,
              "store.service.read",
              session.sessionReference,
            );
            if (!anyAllowed(await scope.authorizeActions(parsed))) return denied();
            return scope;
          },
          recheck: async (scope) => {
            rechecked = anyAllowed(await scope.authorizeActions(parsed));
            return rechecked;
          },
          denied,
        },
        async (authority) => {
          const resolved = authority.scope;
          const guard = () => authority.guard();
          /** The run's guard, or its full re-check that has just passed (before-commit checks). */
          const authorized = async () => (await guard()) || rechecked;
          const scope = Object.freeze({ ...resolved, allowed: authorized });
          const until = resolved.authorizationValidUntil();
          if (until === null) return unavailable();
          if (until < deadline) deadline = parseCanonicalInstant(until);
          const fixed = Object.freeze({
            tenantReference: String(scope.selected.tenantReference),
            brandReference: String(scope.context.brand.brandReference),
            storeReference: String(scope.store.storeReference),
            actorReference: String(scope.actorReference),
          });
          const fresh = async () => {
            check();
            if (!(await authorized())) denied();
          };
          const configured = options.configure(tx, scope, {
            authorize: async () => denied(),
            observedAt: origin,
          } satisfies StoreConfigurationPublishingAccess);
          // The Store's published configuration and its latest recorded one (authoring fence held
          // for writing until COMMIT, so no other change interleaves).
          const publishedValue = await configured.publishedBaseline(tx);
          const published =
            publishedValue === null ? null : createStoreConfigurationVersion(publishedValue);
          const recorded = await createPostgresStoreConfigurationAuthoringSource({
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            mode: "Write",
            authorize: async (actual) => actual === tx && (await authorized()),
          })(tx, check);
          const latest: StoreConfigurationVersion | null = recorded ?? published;
          let setupCommand: ReturnType<typeof parseStoreSetupSaveCommand> | null = null;
          const storeOptions: StoreSetupDraftStoreOptions = {
            ...fixed,
            changeScope: "Hours",
            transaction: tx,
            clock: { now: check },
            originalObservedAt: origin,
            originalValidUntil: deadline,
            registerBeforeCommit: (actual, check, final) => {
              if (actual !== tx) return unavailable();
              return host.registerBeforeCommit(tx, check, final);
            },
            references: {
              ...refs,
              nextReference: (kind) => {
                if (kind !== "Audit") return unavailable();
                return parseStoreAdministrationReference(configured.nextReference());
              },
            },
            authority: {
              async holdUntilTransactionCompletes(actual, packet) {
                if (
                  actual !== tx ||
                  packet.tenantReference !== fixed.tenantReference ||
                  packet.brandReference !== fixed.brandReference ||
                  packet.storeReference !== fixed.storeReference ||
                  packet.actorReference !== fixed.actorReference ||
                  packet.permission !== "store.service.save-draft" ||
                  packet.purposeCode !== "STORE_SETUP_DRAFT" ||
                  (packet.mode !== "Read" && packet.mode !== "Save") ||
                  digest(packet.requiredFields) !== digest(storeSetupDraftOperationFields) ||
                  (packet.command !== null && digest(packet.command) !== digest(setupCommand)) ||
                  packet.observedAt < origin ||
                  packet.validUntil > deadline
                )
                  return unavailable();
                await fresh();
                return Object.freeze({ validUntil: deadline });
              },
            },
            // The Store setup save is audited as Store setup saves are (by the person acting).
            async appendAudit(actual, packet) {
              if (
                actual !== tx ||
                setupCommand === null ||
                packet.mode !== "Save" ||
                packet.operationReference !== setupCommand.operationReference ||
                packet.intentDigest !== digest(setupCommand) ||
                packet.actorReference !== fixed.actorReference
              )
                return unavailable();
              const record = validateAuditRecord(
                {
                  auditId: packet.auditReference,
                  brandId: fixed.brandReference,
                  storeId: fixed.storeReference,
                  actor: { type: "User", reference: fixed.actorReference },
                  actionCode: "STORE_SETUP_DRAFT_SAVED",
                  targetType: "StoreSetupDraft",
                  targetId: packet.operationReference,
                  afterSummary: { intentDigest: packet.intentDigest },
                  reasonCode: audit.reasonCode,
                  correlationId: audit.correlationReference ?? packet.operationReference,
                  occurredAt: packet.occurredAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: "OPERATIONAL",
                  retentionPolicyVersion: 1,
                },
                Date.parse(check()),
              );
              await appendAuditRecordInTransaction(tx, record);
            },
            // An hours revision is based on the Store's latest configuration.
            async withCurrentSaveScope(actual, packet, work) {
              if (
                actual !== tx ||
                packet.actorReference !== fixed.actorReference ||
                packet.storeReference !== fixed.storeReference ||
                latest === null
              )
                return unavailable();
              await fresh();
              return work(
                Object.freeze({
                  ...fixed,
                  defaultLocale: scope.store.locale,
                  currencyCode: scope.store.currencyCode,
                  baseConfigurationReference: latest.configurationReference,
                }),
              );
            },
          };
          const setup = createPostgresStoreSetupDraftStore(storeOptions);
          let used = false;
          const value = await work({
            tx,
            fixed,
            scope,
            configured,
            published,
            recorded,
            setup,
            plan: (command) => {
              setupCommand = command;
              used = true;
            },
            check,
            guard,
          });
          // A run that saved Store setup must have completed that save's before-commit checks; a
          // run that changed nothing still re-checks its authority before it answers.
          if (!used)
            await host.registerBeforeCommit(tx, async () => {
              if (!(await authorized())) denied();
            });
          finalize = used ? () => void setup.assertFinalized(tx) : () => undefined;
          return value;
        },
      ),
    );
    if (!finalize) return unavailable();
    finalize();
    return result;
  };
}

/** Whether `head` is `basis` with only its opening hours changed back to `live`'s. */
const isHoursRestore = (
  head: StoreSetupDraft,
  basis: StoreSetupDraft,
  live: StoreSetupDraft,
): boolean =>
  head.setupDraftReference === basis.setupDraftReference &&
  head.revision > basis.revision &&
  apartFromHours(head.content) === apartFromHours(live.content) &&
  hoursOf(head.content) === hoursOf(live.content);

/**
 * WP-2423 Q4 (DEC-STORE-SETUP-PUBLICATION): an hours change on a Store whose configuration came
 * from Store setup. In one transaction and one authorized run (`store.service.save-draft`,
 * resolved once and re-checked before the commit) the Store Manager's opening hours and dated
 * exceptions become an hours-only Store setup revision (based on the Store's latest configuration,
 * audited as a Store setup save) and the draft configuration made from it (saved through the
 * hours editor's owner ports). Store setup therefore always shows the latest hours, and every
 * configuration keeps its exact Store setup provenance. A Store setup holding saved changes the
 * latest configuration does not include is refused: those changes are the Owner's to publish or
 * finish first. A retried request (same references) returns the recorded result.
 */
export function createMerchantStoreHoursSetupDraft(options: MerchantStoreConfigurationOptions) {
  const action = parseBusinessAction(options.actionPermissions.saveDraft);
  if (!action.startsWith("store.service."))
    throw new Error("STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID");
  const run = createStoreHoursSetupRun(options, [action]);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const command = parseStoreHoursSetupDraftCommand(input.command);
    const result = await run(
      input,
      { reasonCode: "AUTHORIZED_OPERATION" },
      async ({ tx, fixed, scope, configured, published, recorded, setup, plan, check, guard }) => {
        const latest: StoreConfigurationVersion | null = recorded ?? published;
        if (
          published === null ||
          latest === null ||
          published.lifecycle !== "Published" ||
          published.setupBasis === undefined ||
          latest.setupBasis === undefined ||
          published.setupBasis.tenantReference !== fixed.tenantReference ||
          latest.setupBasis.tenantReference !== fixed.tenantReference ||
          published.brandReference !== fixed.brandReference ||
          published.storeReference !== fixed.storeReference
        )
          throw new StoreConfigurationAdministrationServiceError(
            "STORE_CONFIGURATION_LIFECYCLE_CONFLICT",
          );
        const latestBasis = latest.setupBasis;
        const basisOf = (revision: StoreSetupDraft) => ({
          setupDraftReference: revision.setupDraftReference,
          sourceRevision: revision.revision,
          sourceSnapshotDigest: digest(revision),
        });
        // v15 `8bd902e3` D2: a withdrawn or declined latest change never steers the next one. It
        // is continued from only when it changed nothing but hours (its hours are replaced by
        // this change); Store setup changes it carried are the Owner's to finish in Store setup.
        const withdrawn =
          recorded !== null &&
          recorded.configurationReference !== published.configurationReference &&
          (recorded.lifecycle === "Draft" ||
            recorded.lifecycle === "PendingApproval" ||
            recorded.lifecycle === "Approved") &&
          (await readStoreConfigurationWithdrawal(tx, {
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            configurationReference: recorded.configurationReference,
          })) !== null;
        // Only when the latest configuration came from the Store setup's latest revision: other
        // saved Store setup changes are the Owner's to publish or finish first.
        const head = (await setup.readCurrent()).snapshot;
        const atBasis =
          head !== null &&
          head.setupDraftReference === latestBasis.setupDraftReference &&
          head.revision === latestBasis.sourceRevision &&
          digest(head) === latestBasis.sourceSnapshotDigest;
        // WP-2423 (2026-10-16 v15): after a withdrawal Store setup's hours return to the published
        // hours (a later revision, see `createMerchantStoreHoursSetupRestore`); the next hours
        // change continues from that revision.
        let restored: StoreSetupDraft | null = null;
        if (withdrawn && head !== null) {
          const live: StoreSetupDraft = await setup.readRevision(selectorOf(published.setupBasis));
          if (apartFromHours(head.content) !== apartFromHours(live.content))
            throw new StoreSetupOperationError("STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES");
          if (!atBasis) {
            const basis: StoreSetupDraft = await setup.readRevision(selectorOf(latestBasis));
            if (!isHoursRestore(head, basis, live))
              throw new StoreSetupOperationError("STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES");
            restored = head;
          }
        } else if (!atBasis)
          throw new StoreSetupOperationError("STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES");
        // Everything but hours comes from the exact revision the editor showed (immutable), so a
        // retried request rebuilds the identical change. The editor shows the latest
        // configuration's revision; after a withdrawal whose hours were restored, the change is
        // saved on that restored revision (same content apart from hours).
        let from: StoreSetupDraft;
        let expectedRevision: number;
        if (
          recorded !== null &&
          recorded.configurationReference === command.configurationReference
        ) {
          // A retry of a change already made: rebuild it as it was saved, so the recorded results
          // are returned. Saved on the revision the editor showed, or (after a withdrawal whose
          // hours were restored) on the revision before the one it saved (same content apart from
          // the hours this change sets).
          if (recorded.setupBasis === undefined) return unavailable();
          const shown: StoreSetupDraft = await setup.readRevision(command.expectedSetup);
          if (shown.revision === recorded.setupBasis.sourceRevision - 1) {
            from = shown;
            expectedRevision = shown.revision;
          } else {
            from = await setup.readRevision(selectorOf(recorded.setupBasis));
            expectedRevision = from.revision - 1;
          }
        } else if (restored !== null) {
          if (
            digest(command.expectedSetup) !== digest(selectorOf(latestBasis)) &&
            digest(command.expectedSetup) !== digest(basisOf(restored))
          )
            throw new StoreSetupOperationError("STORE_SETUP_OPERATION_VERSION_CONFLICT");
          from = restored;
          expectedRevision = restored.revision;
        } else {
          from = await setup.readRevision(command.expectedSetup);
          expectedRevision = from.revision;
        }
        if (command.effectiveFrom > check() || command.effectiveFrom < published.effectiveFrom)
          return rejected();
        // WP-2423 (2026-10-16 v15): the same hours and closures as the change already saved (or as
        // the published hours when there is none, or it was withdrawn or declined) write nothing:
        // no Store setup revision, no configuration. A retry of a recorded change is not one.
        if (
          recorded === null ||
          recorded.configurationReference !== command.configurationReference
        ) {
          const base = withdrawn ? published : latest;
          if (
            storeConfigurationChangesNothing(base, {
              ...base,
              weeklySchedule: command.weeklySchedule,
              exceptions: command.exceptions,
              effectiveUntil: null,
            })
          )
            return Object.freeze({ status: "NoChange" as const });
        }
        const setupCommand = parseStoreSetupSaveCommand({
          profile: "StoreSetupSaveV2",
          ...fixed,
          operationReference: command.setupOperationReference,
          expectedSetupReference: from.setupDraftReference,
          expectedRevision,
          purposeCode: "STORE_SETUP_DRAFT",
          content: {
            ...from.content,
            weeklySchedule: { state: "Configured", value: command.weeklySchedule },
            exceptions: { state: "Configured", value: command.exceptions },
            effectiveFrom: { state: "Configured", value: command.effectiveFrom },
            effectiveUntil: { state: "Configured", value: null },
          },
        });
        plan(setupCommand);
        const saved = (await setup.save(setupCommand)).snapshot ?? unavailable();
        let candidate: StoreConfigurationVersion;
        try {
          candidate = materializeStoreSetupConfigurationVersionV2(
            saved,
            {
              ...fixed,
              defaultLocale: scope.store.locale,
              currencyCode: "CAD",
              baseConfigurationReference: saved.baseConfigurationReference,
            },
            {
              configurationReference: command.configurationReference,
              configurationVersion: command.expectedVersion + 1,
              reasonCode: STORE_HOURS_REASON_CODE,
              // The revision's own time: a retried request yields the identical configuration.
              createdAt: saved.updatedAt,
              updatedAt: saved.updatedAt,
            },
            refs,
          );
        } catch {
          return rejected();
        }
        const administration = createPersistentStoreConfigurationAdministration(
          storeConfigurationAdministrationOptions({
            configured,
            scope,
            transaction: tx,
            now: check,
            guard,
          }),
        );
        const outcome = await administration.saveDraft({
          operationReference: command.operationReference,
          actorReference: fixed.actorReference,
          purposeCode: "STORE_CONFIGURATION",
          auditReference: command.auditReference,
          expectedVersion: command.expectedVersion,
          occurredAt: check(),
          configuration: candidate,
        });
        return Object.freeze({
          status: outcome.status,
          resultingVersion: outcome.operation.resultingVersion,
        });
      },
    );
    // Nothing was written; the run still re-checked the caller's authority before it answered.
    if (result.status === "NoChange") throw new MerchantStoreHoursNoChangeError();
    return result;
  };
}

/**
 * WP-2423 (2026-10-16 v15): after an hours-only change from Store setup is withdrawn or declined,
 * Store setup's saved hours return to the published hours, so the withdrawn hours are never
 * published from Store setup by mistake and Store setup shows what customers see. History is kept:
 * a new hours-only Store setup revision is appended (published hours, everything else unchanged),
 * audited as a Store setup save by the person who withdrew or declined, correlated to the
 * withdrawal. Nothing happens when the latest change is not withdrawn, carried Store setup changes
 * beyond hours (the Owner's to finish in Store setup), or Store setup was saved again since; so a
 * repeat is harmless. Allowed to whoever may withdraw (save a draft) or decline (approve).
 */
export function createMerchantStoreHoursSetupRestore(options: MerchantStoreConfigurationOptions) {
  const run = createStoreHoursSetupRun(options, [
    options.actionPermissions.saveDraft,
    options.actionPermissions.approve,
  ]);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    /** The withdrawal's audit reference (correlates the Store setup save with it). */
    withdrawalReference: string;
  }): Promise<{ readonly status: "Restored" | "NotNeeded" }> => {
    const correlation = parseStoreAdministrationReference(input.withdrawalReference);
    return run(
      input,
      { reasonCode: "STORE_HOURS_RESTORED_AFTER_WITHDRAWAL", correlationReference: correlation },
      async ({ tx, fixed, configured, published, recorded, setup, plan }) => {
        const notNeeded = Object.freeze({ status: "NotNeeded" as const });
        if (
          published === null ||
          recorded === null ||
          published.lifecycle !== "Published" ||
          published.setupBasis === undefined ||
          recorded.setupBasis === undefined ||
          recorded.configurationReference === published.configurationReference ||
          (recorded.lifecycle !== "Draft" &&
            recorded.lifecycle !== "PendingApproval" &&
            recorded.lifecycle !== "Approved") ||
          published.setupBasis.tenantReference !== fixed.tenantReference ||
          recorded.setupBasis.tenantReference !== fixed.tenantReference
        )
          return notNeeded;
        const withdrawal = await readStoreConfigurationWithdrawal(tx, {
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          configurationReference: recorded.configurationReference,
        });
        if (withdrawal === null) return notNeeded;
        const head = (await setup.readCurrent()).snapshot;
        if (
          head === null ||
          head.setupDraftReference !== recorded.setupBasis.setupDraftReference ||
          head.revision !== recorded.setupBasis.sourceRevision ||
          digest(head) !== recorded.setupBasis.sourceSnapshotDigest
        )
          return notNeeded;
        const live: StoreSetupDraft = await setup.readRevision(selectorOf(published.setupBasis));
        if (
          apartFromHours(head.content) !== apartFromHours(live.content) ||
          hoursOf(head.content) === hoursOf(live.content)
        )
          return notNeeded;
        const command = parseStoreSetupSaveCommand({
          profile: "StoreSetupSaveV2",
          ...fixed,
          operationReference: parseStoreAdministrationReference(configured.nextReference()),
          expectedSetupReference: head.setupDraftReference,
          expectedRevision: head.revision,
          purposeCode: "STORE_SETUP_DRAFT",
          content: {
            ...head.content,
            ...Object.fromEntries(hoursFields.map((field) => [field, live.content[field]])),
          },
        });
        plan(command);
        await setup.save(command);
        return Object.freeze({ status: "Restored" as const });
      },
    );
  };
}
