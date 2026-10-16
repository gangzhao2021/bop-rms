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
  storeConfigurationAdministrationOptions,
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
  const source = options.persistence;
  const resolveScope = createMerchantStoreScope(source);
  const host = createMerchantCategoryTransactions(source.transactions);
  const action = parseBusinessAction(options.actionPermissions.saveDraft);
  if (!action.startsWith("store.service."))
    throw new Error("STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID");
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const command = parseStoreHoursSetupDraftCommand(input.command);
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
            const decisions = await scope.authorizeActions([action]);
            if (decisions.get(action)?.effect !== "Allow") return denied();
            return scope;
          },
          recheck: async (scope) => {
            const current = await scope.authorizeActions([action]);
            rechecked = current.get(action)?.effect === "Allow";
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
          })(tx, check());
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
            // The Store setup save is audited as Store setup saves are (by the Store Manager).
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
              const audit = validateAuditRecord(
                {
                  auditId: packet.auditReference,
                  brandId: fixed.brandReference,
                  storeId: fixed.storeReference,
                  actor: { type: "User", reference: fixed.actorReference },
                  actionCode: "STORE_SETUP_DRAFT_SAVED",
                  targetType: "StoreSetupDraft",
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
            },
            // The hours revision is based on the Store's latest configuration.
            async withCurrentSaveScope(actual, packet, work) {
              if (
                actual !== tx ||
                packet.actorReference !== fixed.actorReference ||
                packet.storeReference !== fixed.storeReference
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
          finalize = () => {
            setup.assertFinalized(tx);
          };
          // Only when the latest configuration came from the Store setup's latest revision: other
          // saved Store setup changes are the Owner's to publish or finish first.
          const head = (await setup.readCurrent()).snapshot;
          if (
            head === null ||
            head.setupDraftReference !== latestBasis.setupDraftReference ||
            head.revision !== latestBasis.sourceRevision ||
            digest(head) !== latestBasis.sourceSnapshotDigest
          )
            throw new StoreSetupOperationError("STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES");
          // Everything but hours comes from the exact revision the editor showed (immutable), so a
          // retried request rebuilds the identical change.
          const from: StoreSetupDraft = await setup.readRevision(command.expectedSetup);
          if (command.effectiveFrom > check() || command.effectiveFrom < published.effectiveFrom)
            return rejected();
          setupCommand = parseStoreSetupSaveCommand({
            profile: "StoreSetupSaveV2",
            ...fixed,
            operationReference: command.setupOperationReference,
            expectedSetupReference: from.setupDraftReference,
            expectedRevision: from.revision,
            purposeCode: "STORE_SETUP_DRAFT",
            content: {
              ...from.content,
              weeklySchedule: { state: "Configured", value: command.weeklySchedule },
              exceptions: { state: "Configured", value: command.exceptions },
              effectiveFrom: { state: "Configured", value: command.effectiveFrom },
              effectiveUntil: { state: "Configured", value: null },
            },
          });
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
      ),
    );
    if (!finalize) return unavailable();
    finalize();
    return result;
  };
}
