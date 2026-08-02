import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  parsePublishingDigest,
  type PublishingLifecycleRecord,
} from "@bop/publishing";

import type {
  MenuPublicationCommand,
  MenuPublicationRecord,
} from "../contracts/menu-publication.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "../contracts/product.js";
import {
  transitionMenuPublication,
  validateMenuEffectivePeriod,
} from "../domain/menu-publication.js";
import type {
  MenuPublicationOperationRecord,
  MenuPublicationPorts,
} from "./ports/menu-publication-ports.js";
import { createMenuPublishedEnvelope } from "./menu-published-event.js";

function dependency(error?: unknown): never {
  if (error instanceof CatalogError) throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}

function parseCommand(value: MenuPublicationCommand): MenuPublicationCommand {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !["SubmitReview", "Approve", "Publish", "Archive"].includes(value.action) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return Object.freeze({
    action: value.action,
    operationReference: parseCatalogReference(value.operationReference),
    menuReference: parseCatalogReference(value.menuReference),
    menuVersionReference: parseCatalogReference(value.menuVersionReference),
    expectedVersion: value.expectedVersion,
    snapshotDigest: parsePublishingDigest(value.snapshotDigest),
    requestedAt: parseCatalogInstant(value.requestedAt),
    effectivePeriod: value.effectivePeriod,
  });
}

function intent(command: MenuPublicationCommand, ports: MenuPublicationPorts) {
  return ports.references.hashIntent(
    JSON.stringify([
      command.action,
      command.menuReference,
      command.menuVersionReference,
      command.expectedVersion,
      command.snapshotDigest,
      command.requestedAt,
      command.effectivePeriod,
    ]),
  );
}

function verifyAuthority(
  evidence: Awaited<ReturnType<MenuPublicationPorts["authorization"]["authorize"]>>,
  command: MenuPublicationCommand,
) {
  if (evidence === null) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(command.requestedAt));
    const expectedAction = `catalog.menu.${command.action === "SubmitReview" ? "submit" : command.action.toLowerCase()}`;
    if (
      context.scopeKind !== "Brand" ||
      context.actor.actorReference === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.scopeKind !== "Brand" ||
      evidence.permission.action !== expectedAction ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== context.actor.actorReference ||
      audit.actionCode !== `CATALOG_MENU_${command.action.toUpperCase()}` ||
      audit.targetType !== "CatalogMenuVersion" ||
      audit.targetId !== command.menuVersionReference ||
      audit.occurredAt !== command.requestedAt
    )
      throw new Error("denied");
    return {
      brandReference: parseCatalogReference(context.brand.brandReference),
      actorReference: parseCatalogReference(context.actor.actorReference),
      audit,
    };
  } catch {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  }
}

function verifyResult(
  value: MenuPublicationOperationRecord,
  expected: MenuPublicationOperationRecord,
  ports: MenuPublicationPorts,
): MenuPublicationRecord {
  if (
    value.command.operationReference !== expected.command.operationReference ||
    !ports.references.equals(value.intentHash, expected.intentHash) ||
    value.result.lifecycle.lifecycleId !== expected.result.lifecycle.lifecycleId ||
    value.result.lifecycle.version !== expected.result.lifecycle.version
  )
    dependency();
  return value.result;
}

export function createMenuPublicationService(ports: MenuPublicationPorts) {
  return Object.freeze({
    async execute(value: MenuPublicationCommand) {
      const command = parseCommand(value);
      const commandIntent = intent(command, ports);
      const prior = await ports.repository
        .resolveOperation(command.operationReference)
        .catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentHash, commandIntent))
          throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, record: prior.result });
      }
      const authority = verifyAuthority(
        await ports.authorization.authorize(command).catch(dependency),
        command,
      );
      let currentRecord = await ports.repository
        .load(command.menuVersionReference)
        .catch(dependency);
      let current: PublishingLifecycleRecord;
      if (currentRecord === null) {
        if (command.action !== "SubmitReview" || command.expectedVersion !== 1)
          throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
        const draft = await ports.facts
          .loadDraftSnapshot({
            menuReference: command.menuReference,
            menuVersionReference: command.menuVersionReference,
            brandReference: authority.brandReference,
            snapshotDigest: command.snapshotDigest,
          })
          .catch(dependency);
        if (draft === null) throw new CatalogError("CATALOG_UNAVAILABLE");
        current = createPublishingLifecycleRecord(draft);
        currentRecord = Object.freeze({ lifecycle: current, effectivePeriod: null, release: null });
      } else {
        current = createPublishingLifecycleRecord(currentRecord.lifecycle);
      }
      if (
        current.version !== command.expectedVersion ||
        String(current.familyReference) !== command.menuReference ||
        String(current.snapshotReference) !== command.menuVersionReference ||
        String(current.snapshotDigest) !== command.snapshotDigest ||
        String(current.scope.brandReference) !== authority.brandReference
      )
        throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const [validation, approval] = await Promise.all([
        command.action === "SubmitReview"
          ? ports.evidence.validation(command).catch(dependency)
          : Promise.resolve(null),
        command.action === "Approve"
          ? ports.evidence.approval(command).catch(dependency)
          : Promise.resolve(null),
      ]);
      const lifecycle = transitionMenuPublication({
        operation: command.action,
        current,
        validation,
        approval,
        at: command.requestedAt,
      });
      let release = currentRecord.release;
      let effectivePeriod = currentRecord.effectivePeriod;
      if (command.action === "Publish") {
        effectivePeriod = validateMenuEffectivePeriod(command.effectivePeriod);
        const previous = await ports.repository
          .currentRelease(command.menuReference)
          .catch(dependency);
        release = createPublishingReleaseRecord({
          releaseId: ports.references.generate("Release") as never,
          familyReference: lifecycle.familyReference,
          configurationType: lifecycle.configurationType,
          purposeCode: lifecycle.purposeCode,
          snapshotReference: lifecycle.snapshotReference,
          snapshotDigest: lifecycle.snapshotDigest,
          scope: lifecycle.scope,
          sequence: (await ports.repository
            .nextReleaseSequence(command.menuReference)
            .catch(dependency)) as never,
          sourceLifecycleId: lifecycle.lifecycleId,
          kind: "Publish",
          previousReleaseId: previous?.releaseId ?? null,
          createdAt: command.requestedAt as never,
        });
      } else if (command.effectivePeriod !== null) {
        throw new CatalogError("CATALOG_INPUT_INVALID");
      }
      const result = Object.freeze({ lifecycle, effectivePeriod, release });
      if (
        command.action === "Publish" &&
        (await ports.repository.hasEffectiveOverlap(result).catch(dependency))
      )
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      const operation = Object.freeze({ command, intentHash: commandIntent, result });
      const event =
        command.action === "Publish"
          ? createMenuPublishedEnvelope({
              eventReference: ports.references.generate("Event"),
              operationReference: command.operationReference,
              correlationReference: authority.audit.correlationId,
              actorReference: authority.actorReference,
              menuReference: command.menuReference,
              brandReference: authority.brandReference,
              record: result,
            })
          : null;
      const saved = await ports.repository
        .commit({
          operation,
          expectedVersion: command.expectedVersion,
          audit: authority.audit,
          event,
        })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        record: verifyResult(saved, operation, ports),
      });
    },
  });
}
