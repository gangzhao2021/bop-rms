import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaScope,
  createPostgresMediaPublicationReadSource,
  mediaPublicationReadFields,
  parseMediaPublicationReadRequest,
  parseMediaPublicationReadSnapshot,
  type MediaPublicationReadRequest,
} from "@bop/media";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

type OwnerOptions = Parameters<typeof createPostgresMediaPublicationReadSource>[0];
type OwnerAuthority = OwnerOptions["authority"]["holdUntilTransactionCompletes"];
type Transaction = Parameters<OwnerAuthority>[0];
export interface ProductPublicationMediaAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: Parameters<OwnerAuthority>[1] & {
      readonly command: ProductPublicationQualificationContext["command"];
      readonly commandPurposeCode: ProductPublicationQualificationContext["command"]["purposeCode"];
      readonly originalIntentDigest: string;
      readonly requestObservedAt: string;
      readonly requestValidUntil: string;
    },
  ): ReturnType<OwnerAuthority>;
}
export interface CurrentProductPublicationMedia {
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly check: { readonly code: "MediaReady"; readonly outcome: "Pass" | "HardError" };
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Compose the actual owning pinned-media read in the writer's transaction.
 * Ready for an empty reference set does not satisfy RequiredMediaPresence. */
export function createCurrentProductPublicationMediaSource(options: {
  readonly transaction: Transaction;
  readonly scope: OwnerOptions["scope"];
  readonly clock: { now(): string };
  readonly authority: ProductPublicationMediaAuthority;
  readonly registerBeforeCommit: OwnerOptions["registerBeforeCommit"];
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  let scope: OwnerOptions["scope"];
  try {
    scope = createMediaScope(options.scope);
  } catch {
    return fail();
  }
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options);
  let active = false,
    failed = false;
  async function run<T>(
    bind: () => ProductPublicationQualificationContext,
    work: (assessment: CurrentProductPublicationMedia) => Promise<T>,
  ): Promise<T> {
    if (active || failed) {
      failed = true;
      return fail();
    }
    active = true;
    let ready = false,
      committing = false,
      asyncCalls = 0,
      asyncComplete = false,
      finalCalls = 0,
      inCallback = false,
      assertLease: (() => string) | undefined,
      child: { guard: () => Promise<void>; finalAssert: () => void } | undefined;
    try {
      // Capture the entire input before the first await, while still registering
      // a rejecting host guard when capture fails and a caller catches the error.
      let context: ProductPublicationQualificationContext | undefined,
        request: MediaPublicationReadRequest | undefined;
      try {
        context = bind();
        const content = context.aggregate.draft.editorContent;
        if (
          !content ||
          String(scope.brandReference) !== String(context.brandReference) ||
          (scope.kind === "Store" &&
            (context.scopeSet.length === 0 ||
              context.scopeSet.some(
                (selector) =>
                  selector.level !== "Store" || selector.reference !== scope.storeReference,
              )))
        )
          return fail();
        request = parseMediaPublicationReadRequest({
          profile: "MediaPublicationReadRequestV1",
          intentKind: context.kind === "Publication" ? "PublicationV2" : "WarningAcknowledgementV1",
          tenantReference: context.tenantReference,
          scope,
          actorReference: context.actorReference,
          actorKind: context.actorKind,
          operationReference: context.command.operationReference,
          originalIntentDigest: context.originalIntentDigest,
          productReference: context.productReference,
          versionReference: context.versionReference,
          aggregateSnapshotDigest: context.aggregateSnapshotDigest,
          contentDigest: context.contentDigest,
          configurationDigest: context.configurationDigest,
          replacementIntentDigest: context.replacementIntentDigest,
          references: content.media.map(
            ({
              mediaReference,
              assetReference,
              assetVersionReference,
              cropReference,
              focusReference,
            }) => ({
              mediaReference,
              assetReference,
              assetVersionReference,
              cropReference,
              focusReference,
            }),
          ),
          observedAt: context.observedAt,
          validUntil: context.validUntil,
        });
      } catch {
        failed = true;
      }
      const checkOuter = () => {
        if (failed || !ready || inCallback || !assertLease || !child) {
          failed = true;
          return fail();
        }
        return assertLease();
      };
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++asyncCalls !== 1) return fail();
              committing = true;
              checkOuter();
              if ((await child?.guard()) !== undefined) return fail();
              checkOuter();
              asyncComplete = true;
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          () => {
            try {
              if (++finalCalls !== 1 || asyncCalls !== 1 || !asyncComplete) return fail();
              checkOuter();
              if (child?.finalAssert() !== undefined) return fail();
              checkOuter();
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        )) !== undefined
      )
        return fail();
      if (!context || !request || typeof work !== "function" || failed) return fail();
      const bound = context,
        capturedRequest = request;
      let latest = bound.observedAt,
        deadline: string = bound.validUntil,
        deliveredDeadline: string | undefined;
      const check = () => {
        try {
          const at = parseCatalogInstant(now());
          const descriptor = Object.getOwnPropertyDescriptor(tx, "query");
          if (
            failed ||
            !descriptor ||
            !("value" in descriptor) ||
            descriptor.value !== query ||
            at < latest ||
            at >= deadline
          )
            return fail();
          latest = at;
          return at;
        } catch {
          failed = true;
          return fail();
        }
      };
      assertLease = check;
      check();
      const source = createPostgresMediaPublicationReadSource({
        tenantReference: bound.tenantReference,
        scope,
        actorReference: bound.actorReference,
        actorKind: bound.actorKind,
        clock: { now: check },
        authority: {
          async holdUntilTransactionCompletes(actual, input) {
            try {
              check();
              const captured = copyCategoryPersistenceValue(input);
              if (!captured || typeof captured !== "object" || Array.isArray(captured))
                return fail();
              const fields = ["request", "action", "purposeCode", "requiredFields"];
              if (
                Object.keys(captured).length !== fields.length ||
                fields.some((field) => !Object.hasOwn(captured, field))
              )
                return fail();
              input = captured as typeof input;
              if (
                actual !== tx ||
                input.action !== "media.asset.access" ||
                input.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ" ||
                !equal(input.requiredFields, mediaPublicationReadFields) ||
                !equal(parseMediaPublicationReadRequest(input.request), capturedRequest)
              )
                return fail();
              const lease = await authorize(
                tx,
                Object.freeze({
                  ...input,
                  request: capturedRequest,
                  command: bound.command,
                  commandPurposeCode: bound.command.purposeCode,
                  originalIntentDigest: bound.originalIntentDigest,
                  requestObservedAt: bound.observedAt,
                  requestValidUntil: bound.validUntil,
                }),
              );
              if (
                !lease ||
                typeof lease !== "object" ||
                Object.getPrototypeOf(lease) !== Object.prototype ||
                Reflect.ownKeys(lease).length !== 2
              )
                return fail();
              const from = Object.getOwnPropertyDescriptor(lease, "observedAt"),
                until = Object.getOwnPropertyDescriptor(lease, "validUntil");
              if (
                !from?.enumerable ||
                !("value" in from) ||
                !until?.enumerable ||
                !("value" in until)
              )
                return fail();
              const observedAt = parseCatalogInstant(from.value),
                validUntil = parseCatalogInstant(until.value);
              if (
                observedAt !== bound.observedAt ||
                validUntil > deadline ||
                validUntil <= check() ||
                (deliveredDeadline !== undefined && validUntil < deliveredDeadline)
              )
                return fail();
              deadline = validUntil;
              check();
              return Object.freeze({ observedAt, validUntil });
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        },
        async registerBeforeCommit(actual, guard, finalAssert) {
          try {
            check();
            if (
              actual !== tx ||
              ready ||
              committing ||
              child ||
              typeof guard !== "function" ||
              typeof finalAssert !== "function"
            )
              return fail();
            child = { guard, finalAssert };
          } catch (error) {
            failed = true;
            throw error;
          }
        },
      });
      let calls = 0,
        completed: { value: T } | undefined;
      const result = await source.withCurrentReferences(
        tx,
        capturedRequest,
        async (value, actual) => {
          try {
            if (++calls !== 1 || actual !== tx || ready || committing) return fail();
            const snapshot = parseMediaPublicationReadSnapshot(value);
            if (
              !equal(snapshot.request, capturedRequest) ||
              snapshot.observedAt > check() ||
              snapshot.validUntil > deadline
            )
              return fail();
            deadline = snapshot.validUntil;
            check();
            const reasons = {
              NotFound: "MEDIA_REFERENCE_NOT_FOUND",
              NotReady: "MEDIA_REFERENCE_NOT_READY",
              UnsupportedMedia: "MEDIA_KIND_UNSUPPORTED",
              UnsupportedAdjustment: "MEDIA_ADJUSTMENT_UNSUPPORTED",
            } as const;
            const findings: readonly CatalogProductPublicationValidationFinding[] = Object.freeze(
              snapshot.references.flatMap((reference) =>
                reference.status === "Ready"
                  ? []
                  : [
                      Object.freeze({
                        checkCode: "MediaReady" as const,
                        ruleCode: "MEDIA_REFERENCE_READINESS",
                        outcome: "HardError" as const,
                        subjectReference: reference.mediaReference,
                        reasonCode: reasons[reference.reason],
                        references: Object.freeze([
                          Object.freeze({
                            sourceCode: "MEDIA_READINESS",
                            resourceReference: reference.assetReference,
                            versionReference: reference.assetVersionReference,
                            referenceDigest: hash(reference),
                          }),
                        ]),
                      }),
                    ],
              ),
            );
            const assessment: CurrentProductPublicationMedia = Object.freeze({
              originalIntentDigest: bound.originalIntentDigest,
              replacementIntentDigest: bound.replacementIntentDigest,
              contentDigest: bound.contentDigest,
              configurationDigest: bound.configurationDigest,
              check: Object.freeze({
                code: "MediaReady",
                outcome: findings.length ? "HardError" : "Pass",
              }),
              findings,
              sources: Object.freeze([
                Object.freeze({
                  sourceCode: "MEDIA_READINESS",
                  sourceDigest: snapshot.digest,
                  generation: null,
                  relevantReferenceDigest: snapshot.relevantReferenceDigest,
                  observedAt: snapshot.observedAt,
                  validUntil: snapshot.validUntil,
                }),
              ]),
              observedAt: snapshot.observedAt,
              validUntil: snapshot.validUntil,
            });
            deliveredDeadline = snapshot.validUntil;
            inCallback = true;
            const output = await work(assessment);
            inCallback = false;
            check();
            completed = { value: output };
            return completed;
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            inCallback = false;
          }
        },
      );
      if (calls !== 1 || !completed || result !== completed || !child) return fail();
      check();
      ready = true;
      return completed.value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      work: (assessment: CurrentProductPublicationMedia) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      work: (assessment: CurrentProductPublicationMedia) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), work);
    },
  });
}
