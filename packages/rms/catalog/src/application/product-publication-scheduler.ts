import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseProductAggregate,
} from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationVersion,
  type ProductPublicationCommand,
  type ProductPublicationVersion,
} from "../contracts/product-publication.js";
import type { ProductPublicationWriteResult } from "../infrastructure/persistence/product-publication-store.js";
import type { ProductPublicationWriteResultV2 } from "../infrastructure/persistence/product-publication-store.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  recoverCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationContent } from "../contracts/product-publication-content.js";
import { parseCatalogProductScopeRetirementHeader } from "../contracts/product-scope-retirement.js";
import { bindCatalogProductPublicationValidationReportToPublication } from "../contracts/product-publication-validation-report.js";

export interface DueProductPublicationCandidate {
  readonly publication: ProductPublicationVersion;
  readonly expectedAggregateVersion: number;
}
/** Discovery is a locator. The real owning writer repeats current System
 * authority, source/policy/approval validation, expected versions and atomic
 * content/successor/Audit/Outbox. Stable IDs are supplied by trusted runtime
 * composition for the exact schedule reference/version; never random per retry. */
export function createProductPublicationScheduledActivator(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly systemActorReference: string;
  readonly references: {
    operation(candidate: DueProductPublicationCandidate): string;
    successorDraft(candidate: DueProductPublicationCandidate): string;
  };
  readonly writer: {
    execute(command: ProductPublicationCommand): Promise<ProductPublicationWriteResult>;
  };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.systemActorReference);
  return Object.freeze({
    async activate(value: unknown): Promise<"Applied" | "Replayed"> {
      const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, "publication") ||
        !Object.hasOwn(raw, "expectedAggregateVersion")
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const p = parseProductPublicationVersion(raw.publication);
      if (
        p.tenantReference !== tenant ||
        p.brandReference !== brand ||
        p.state !== "Scheduled" ||
        p.scheduleReference === null ||
        !Number.isInteger(raw.expectedAggregateVersion) ||
        (raw.expectedAggregateVersion as number) < p.productAggregateVersion + 1 ||
        (raw.expectedAggregateVersion as number) >= 2147483647
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const candidate = Object.freeze({
        publication: p,
        expectedAggregateVersion: raw.expectedAggregateVersion as number,
      });
      const operationReference = parseCatalogReference(options.references.operation(candidate)),
        successorDraftVersionReference = parseCatalogReference(
          options.references.successorDraft(candidate),
        );
      const result = await options.writer.execute(
        Object.freeze({
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "System",
          operationReference,
          productReference: p.productReference,
          versionReference: p.versionReference,
          expectedProductAggregateVersion: candidate.expectedAggregateVersion,
          expectedPublicationVersion: p.publicationVersion,
          action: "ActivateScheduled",
          contentDigest: p.contentDigest,
          configurationDigest: p.configurationDigest,
          scopeSet: p.scopeSet,
          effectivePeriod: p.effectivePeriod,
          scheduleReference: p.scheduleReference,
          replacementVersionReference: null,
          successorDraftVersionReference,
          occurredAt: p.effectivePeriod.effectiveFrom.instant,
          reasonCode: "SCHEDULE_DUE",
        }),
      );
      if (
        (result.status !== "Applied" && result.status !== "Replayed") ||
        result.publication.state !== "Published" ||
        result.publication.operationReference !== operationReference ||
        result.publication.versionReference !== p.versionReference ||
        result.publication.scheduleReference !== p.scheduleReference ||
        result.publication.scheduleVersion !== p.scheduleVersion + 1 ||
        result.aggregate.aggregateVersion !== candidate.expectedAggregateVersion + 1 ||
        result.publication.successorDraftVersionReference !== successorDraftVersionReference ||
        result.content === null
      )
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return result.status;
    },
  });
}

export interface DueProductPublicationCandidateV2 {
  readonly publication: ProductPublicationVersionV2;
  readonly expectedAggregateVersion: number;
}
/** Explicit V2 composition only. Discovery supplies a locator; the native V2
 * writer owns held current authority, Required approval and complete retirement
 * coverage. Planned start remains the original retry identity, while the result
 * and its content/header must bind the actual held execution observation. */
export function createProductPublicationScheduledActivatorV2(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly systemActorReference: string;
  readonly references: {
    operation(candidate: DueProductPublicationCandidateV2): string;
    successorDraft(candidate: DueProductPublicationCandidateV2): string;
  };
  readonly writer: {
    execute(command: ProductPublicationCommandV2): Promise<ProductPublicationWriteResultV2>;
  };
}) {
  if (
    typeof options.references?.operation !== "function" ||
    typeof options.references?.successorDraft !== "function" ||
    typeof options.writer?.execute !== "function"
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.systemActorReference),
    operation = options.references.operation.bind(options.references),
    successorDraft = options.references.successorDraft.bind(options.references),
    execute = options.writer.execute.bind(options.writer),
    hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
    unavailable = (): never => {
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    };
  return Object.freeze({
    async activate(value: unknown): Promise<"Applied" | "Replayed"> {
      const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, "publication") ||
        !Object.hasOwn(raw, "expectedAggregateVersion")
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const p = parseProductPublicationVersionV2(raw.publication);
      if (
        p.tenantReference !== tenant ||
        p.brandReference !== brand ||
        p.state !== "Scheduled" ||
        p.scheduleReference === null ||
        !Number.isSafeInteger(raw.expectedAggregateVersion) ||
        (raw.expectedAggregateVersion as number) < p.productAggregateVersion + 1 ||
        (raw.expectedAggregateVersion as number) >= 2147483647
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const candidate = Object.freeze({
          publication: p,
          expectedAggregateVersion: raw.expectedAggregateVersion as number,
        }),
        command = parseProductPublicationCommandV2({
          profile: "CatalogProductPublicationCommandV2",
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "System",
          operationReference: parseCatalogReference(operation(candidate)),
          productReference: p.productReference,
          versionReference: p.versionReference,
          expectedProductAggregateVersion: candidate.expectedAggregateVersion,
          expectedPublicationVersion: p.publicationVersion,
          action: "ActivateScheduled",
          contentDigest: p.contentDigest,
          configurationDigest: p.configurationDigest,
          scopeSet: p.scopeSet,
          effectivePeriod: p.effectivePeriod,
          scheduleReference: p.scheduleReference,
          replacementVersionReference: null,
          successorDraftVersionReference: parseCatalogReference(successorDraft(candidate)),
          occurredAt: p.effectivePeriod.effectiveFrom.instant,
          reasonCode: "SCHEDULE_DUE",
          replacementIntent: p.replacementIntent,
          replacementIntentDigest: p.replacementIntentDigest,
        }),
        resultValue = await execute(command);
      try {
        // Capture the closed wrappers without spending one shared JSON budget on
        // the independently bounded aggregate, immutable content and new report.
        const closed = (value: unknown, keys: readonly string[]) => {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Reflect.ownKeys(value).length !== keys.length
          )
            return unavailable();
          const captured: Record<string, unknown> = {};
          for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
            captured[key] = descriptor.value;
          }
          return captured;
        };
        const r = closed(resultValue, [
          "status",
          "publication",
          "aggregate",
          "content",
          "scopeRetirementHeader",
          "validationReport",
        ]);
        if (r.status !== "Applied" && r.status !== "Replayed") return unavailable();
        const publication = recoverCatalogProductPublicationV2(command, r.publication),
          aggregate = parseProductAggregate(copyCategoryPersistenceValue(r.aggregate)),
          content = parseCatalogProductPublicationContent(r.content),
          header = parseCatalogProductScopeRetirementHeader(r.scopeRetirementHeader),
          retirement = header.retirements[0];
        const reportCoverage = closed(r.validationReport, ["status", "report"]);
        if (reportCoverage.status === "Recorded") {
          const report = bindCatalogProductPublicationValidationReportToPublication(
            reportCoverage.report,
            publication,
          );
          if (report.publicationAction !== command.action) return unavailable();
        } else if (
          reportCoverage.status !== "NotRecorded" ||
          r.status !== "Replayed" ||
          reportCoverage.report !== null
        ) {
          return unavailable();
        }
        if (
          publication.state !== "Published" ||
          publication.actorKind !== "System" ||
          publication.actorReference !== actor ||
          publication.productAggregateVersion !== candidate.expectedAggregateVersion ||
          publication.contentDigest !== p.contentDigest ||
          publication.configurationDigest !== p.configurationDigest ||
          publication.scopeDigest !== p.scopeDigest ||
          publication.periodDigest !== p.periodDigest ||
          publication.scheduleReference !== p.scheduleReference ||
          publication.scheduleVersion !== p.scheduleVersion + 1 ||
          publication.policyReference !== p.policyReference ||
          publication.policyVersion !== p.policyVersion ||
          publication.approvalPolicy !== p.approvalPolicy ||
          publication.reviewReference !== p.reviewReference ||
          publication.reviewVersion !== p.reviewVersion ||
          publication.submittedByActorReference !== p.submittedByActorReference ||
          publication.approvalEvidenceReference !== p.approvalEvidenceReference ||
          publication.successorDraftVersionReference !== command.successorDraftVersionReference ||
          publication.occurredAt < command.occurredAt ||
          publication.occurredAt < p.occurredAt ||
          publication.publishedAt !== publication.occurredAt ||
          (p.effectivePeriod.effectiveUntil !== null &&
            publication.occurredAt >= p.effectivePeriod.effectiveUntil.instant) ||
          aggregate.brandReference !== brand ||
          aggregate.productReference !== p.productReference ||
          aggregate.aggregateVersion !== candidate.expectedAggregateVersion + 1 ||
          aggregate.updatedAt !== publication.occurredAt ||
          aggregate.draft.versionReference !== command.successorDraftVersionReference ||
          aggregate.draft.baseVersionReference !== p.versionReference ||
          aggregate.draft.status !== "Draft" ||
          aggregate.draft.createdAt !== publication.occurredAt ||
          aggregate.draft.updatedAt !== publication.occurredAt ||
          content.tenantReference !== tenant ||
          content.brandReference !== brand ||
          content.productReference !== p.productReference ||
          content.versionReference !== p.versionReference ||
          content.sourceAggregateVersion !== candidate.expectedAggregateVersion ||
          content.publicationOperationReference !== command.operationReference ||
          content.sealedAt !== publication.occurredAt ||
          content.contentDigest !== p.contentDigest ||
          content.configurationDigest !== p.configurationDigest ||
          header.tenantReference !== tenant ||
          header.brandReference !== brand ||
          header.productReference !== p.productReference ||
          header.operationReference !== command.operationReference ||
          header.versionReference !== p.versionReference ||
          header.publicationVersion !== publication.publicationVersion ||
          header.publicationAction !== "ActivateScheduled" ||
          header.sourceAggregateVersion !== candidate.expectedAggregateVersion ||
          header.resultAggregateVersion !== aggregate.aggregateVersion ||
          header.publicationIntentDigest !== publication.intentDigest ||
          header.publicationSnapshotDigest !== hash(publication) ||
          header.recordedAt !== publication.occurredAt ||
          (p.replacementIntent.mode === "None"
            ? header.retirements.length !== 0
            : header.retirements.length !== 1 ||
              retirement === undefined ||
              retirement.replacementIntent.digest !== p.replacementIntentDigest ||
              retirement.retiredAt !== publication.occurredAt)
        )
          return unavailable();
        return r.status;
      } catch {
        return unavailable();
      }
    },
  });
}
