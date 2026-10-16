import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresStoreReceiptConfigurationSource } from "@rms/store";
import {
  createPostgresDigitalReceiptTemplateStore,
  createPostgresDigitalReceiptTemplateSubmissionStore,
  createPostgresInstalledReceiptTemplatePublicationProof,
  createPostgresReceiptTemplateContentPublicationProof,
  DigitalReceiptTemplateError,
  type DigitalReceiptTemplateAuthoredContent,
  type DigitalReceiptTemplateVersion,
} from "@rms/printing-device";
import { DigitalReceiptError, parseOrderingReference } from "@rms/ordering";
import type { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";
type Request = Parameters<Parameters<typeof createReceiptIssuanceSources>[0]["template"]>[1];
type StoreOptions = Parameters<typeof createPostgresStoreReceiptConfigurationSource>[0];
type Binding = Awaited<
  ReturnType<ReturnType<typeof createPostgresStoreReceiptConfigurationSource>>
>;

/** Why the Store's receipt template cannot be used right now (closed set, staff-facing via alerts). */
export type ReceiptTemplateUnavailableReason =
  "StoreConfigurationUnavailable" | "TemplateNotProven";
export type ReceiptTemplateReadiness =
  | Readonly<{
      ready: true;
      templateReference: string;
      versionReference: string;
      versionCode: string;
    }>
  | Readonly<{ ready: false; reason: ReceiptTemplateUnavailableReason }>;

const unavailable = (code: DigitalReceiptError["code"]): never => {
  throw new DigitalReceiptError(code);
};
const ownerReadWindowMs = 5000;

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: runtime composition of public owners. The template is the
 * one the Store's currently published configuration names (`receiptReference`), never a template
 * fixed in operating files. Each published version is proved as its owners publish it: a version
 * with an authored submission (written in the product, sent for approval, approved — by another
 * person, or by a sole operator with its recorded mark — and published) by its authored content
 * proof; a version without one (the installer's template, e.g. RECEIPT_V1) by its exact current
 * Publishing release. Anything not proved refuses issuance with DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE
 * (fail closed: no receipt is issued with a guessed or older template).
 */
export function createPublishedReceiptTemplateSource(options: {
  store: StoreOptions;
  templatePublication: {
    tenantReference: string;
    configurationType: string;
    purposeCode: string;
    authorize(transaction: ConsumerTransaction, observedAt: string): Promise<boolean>;
  };
  authorize(transaction: ConsumerTransaction, request: Request): Promise<boolean>;
  /** Clock for the owner reads' bounded window (defaults to the system clock). */
  now?: () => string;
}) {
  const tenantReference = String(parseOrderingReference(options.store.tenantReference));
  if (
    tenantReference !== String(parseOrderingReference(options.templatePublication.tenantReference))
  )
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  const scope = {
    brandReference: String(parseOrderingReference(options.store.brandReference)),
    storeReference: String(parseOrderingReference(options.store.storeReference)),
  };
  const publication = options.templatePublication;
  const now = options.now ?? (() => new Date().toISOString());
  const readStore = createPostgresStoreReceiptConfigurationSource(options.store);

  /** The Store's current template and the exact version proved now (same transaction). */
  const resolveCurrent = async (
    transaction: ConsumerTransaction,
    observedAt: string,
    admit: () => Promise<unknown>,
  ): Promise<{ binding: Binding; version: DigitalReceiptTemplateVersion }> => {
    let binding: Binding;
    try {
      binding = await readStore(transaction, observedAt);
    } catch {
      return unavailable("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
    }
    const templateReference = String(parseOrderingReference(binding.templateReference));
    const pending: { guard: () => Promise<void>; final: () => void }[] = [];
    const owners: ReturnType<typeof createPostgresDigitalReceiptTemplateSubmissionStore>[] = [];
    const settings = (
      await transaction.query<{ lock: string; statement: string }>(
        "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement",
        [],
      )
    ).rows[0];
    const authorizePublication = async (actual: unknown, at: string) => {
      if (actual !== transaction) return false;
      await admit();
      return (await publication.authorize(transaction, at)) === true;
    };
    // Authored content of one version (null: none recorded, e.g. the installer's template).
    // Submission and draft records are append-only; the owner's own guard re-reads them before
    // this source returns.
    const readAuthored = async (version: DigitalReceiptTemplateVersion) => {
      const origin = now();
      const owner = createPostgresDigitalReceiptTemplateSubmissionStore({
        tenantReference,
        ...scope,
        // Read-only owner read for the Store's own receipt issuance (System); the actor is
        // recorded nowhere in this mode.
        actorReference: scope.storeReference,
        transaction,
        clock: { now },
        originalObservedAt: origin,
        originalValidUntil: new Date(Date.parse(origin) + ownerReadWindowMs).toISOString(),
        registerBeforeCommit: (actual, guard, final) => {
          if (actual !== transaction) throw new DigitalReceiptTemplateError();
          pending.push({ guard, final });
        },
        references: {
          canonicalize: canonicalizeRfc8785,
          hashIntent: (value) => "sha256:" + sha256Hex(value),
        },
        readPublishingReview: async () => {
          throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
        },
        authority: {
          holdUntilTransactionCompletes: async (actual, input) => {
            if (
              actual !== transaction ||
              input.mode !== "ReadAuthoredContent" ||
              input.command !== null ||
              input.templateReference !== templateReference ||
              input.versionReference !== String(version.versionReference) ||
              !(await authorizePublication(actual, input.observedAt))
            )
              throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
            return Object.freeze({ validUntil: input.validUntil });
          },
        },
      });
      owners.push(owner);
      const content: DigitalReceiptTemplateAuthoredContent | null =
        (await owner.readAuthoredContent({
          templateReference,
          versionReference: String(version.versionReference),
        })) ?? null;
      return content;
    };
    const installedProof = createPostgresInstalledReceiptTemplatePublicationProof({
      tenantReference,
      ...scope,
      configurationType: publication.configurationType,
      purposeCode: publication.purposeCode,
      authorize: authorizePublication,
    });
    const templates = createPostgresDigitalReceiptTemplateStore({
      ...scope,
      authorize: async (actual, input) => {
        if (
          actual !== transaction ||
          input.action !== "Read" ||
          input.templateReference !== templateReference
        )
          return false;
        await admit();
        return true;
      },
      validatePublication: async () => false,
      isCurrentPublication: async (actual, version, at) => {
        if (actual !== transaction) return false;
        const content = await readAuthored(version);
        if (content === null) return (await installedProof(transaction, version, at)) !== null;
        const proof = createPostgresReceiptTemplateContentPublicationProof({
          tenantReference,
          ...scope,
          familyReference: String(content.familyReference),
          configurationType: publication.configurationType,
          purposeCode: publication.purposeCode,
          authorize: authorizePublication,
          readAuthoredContent: async (tx, input) => {
            if (
              tx !== transaction ||
              input.templateReference !== templateReference ||
              input.versionReference !== String(version.versionReference)
            )
              throw new DigitalReceiptTemplateError();
            return content;
          },
        });
        // Not the current release of its family (e.g. a superseded version): not in use.
        return (await proof(transaction, version, at)) !== null;
      },
    });
    let version: DigitalReceiptTemplateVersion;
    try {
      version = await templates.resolve(transaction, {
        templateReference,
        locale: binding.locale,
        observedAt,
      });
      for (const hook of pending) await hook.guard();
      for (const hook of pending) hook.final();
      for (const owner of owners) owner.assertFinalized(transaction);
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      if (
        error instanceof DigitalReceiptTemplateError &&
        error.code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
      )
        return unavailable("DIGITAL_RECEIPT_PERMISSION_DENIED");
      return unavailable("DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE");
    }
    // The owner reads bound their statements; the caller's own limits apply again after them.
    if (settings)
      await transaction.query(
        "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [settings.lock, settings.statement],
      );
    return { binding, version };
  };

  const source = async (transaction: ConsumerTransaction, request: Request) => {
    try {
      const authorize = async () => {
        if (
          request.brandReference !== scope.brandReference ||
          request.storeReference !== scope.storeReference ||
          (await options.authorize(transaction, request)) !== true
        )
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        return true;
      };
      await authorize();
      const { binding, version } = await resolveCurrent(transaction, request.observedAt, authorize);
      if (binding.currencyCode !== request.currencyCode)
        return unavailable("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
      await authorize();
      return Object.freeze({
        template: Object.freeze({
          ...scope,
          locale: binding.locale,
          version: version.versionCode,
          versionReference: String(version.versionReference),
        }),
        evidenceReference: version.versionReference,
        evidenceDigest:
          "sha256:" +
          sha256Hex(canonicalizeRfc8785(JSON.parse(JSON.stringify({ binding, version })))),
      });
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      return unavailable("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
    }
  };

  /**
   * Whether a receipt could be issued with the Store's published template now (no write). Used by
   * the operations monitor to tell staff before and while receipts are refused.
   */
  const readiness = async (
    transaction: ConsumerTransaction,
    observedAt: string,
  ): Promise<ReceiptTemplateReadiness> => {
    try {
      const { binding, version } = await resolveCurrent(transaction, observedAt, async () => true);
      return Object.freeze({
        ready: true,
        templateReference: String(binding.templateReference),
        versionReference: String(version.versionReference),
        versionCode: version.versionCode,
      });
    } catch (error) {
      if (
        error instanceof DigitalReceiptError &&
        error.code === "DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE"
      )
        return Object.freeze({ ready: false, reason: "TemplateNotProven" });
      if (
        error instanceof DigitalReceiptError &&
        error.code === "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE"
      )
        return Object.freeze({ ready: false, reason: "StoreConfigurationUnavailable" });
      throw error;
    }
  };
  return Object.assign(source, { readiness });
}
