import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationCommand,
  type ProductPublicationCommand,
} from "./product-publication.js";
import {
  parseProductPublicationCommandV2,
  type ProductPublicationCommandV2,
} from "./product-publication-v2.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type CatalogProductPublicationWarningAcknowledgementCommand,
} from "./product-publication-warning-acknowledgement.js";

export type CatalogProductPublicationResolutionOriginalKind =
  "PublicationV1" | "PublicationV2" | "WarningAcknowledgementV1";
interface Envelope {
  readonly profile: "CatalogProductPublicationResolutionCommandV1";
}
export type CatalogProductPublicationResolutionCommand = Envelope &
  (
    | {
        readonly originalKind: "PublicationV1";
        readonly originalCommand: ProductPublicationCommand;
      }
    | {
        readonly originalKind: "PublicationV2";
        readonly originalCommand: ProductPublicationCommandV2;
      }
    | {
        readonly originalKind: "WarningAcknowledgementV1";
        readonly originalCommand: CatalogProductPublicationWarningAcknowledgementCommand;
      }
  );
export interface CatalogProductPublicationResolution {
  readonly profile: "CatalogProductPublicationResolutionV1";
  readonly outcome: "Committed" | "Abandoned";
  readonly originalKind: CatalogProductPublicationResolutionOriginalKind;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly operationReference: string;
  readonly originalIntentDigest: string;
  readonly recordedAt: string;
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const safe = copyCategoryPersistenceValue(value);
  if (
    !safe ||
    typeof safe !== "object" ||
    Array.isArray(safe) ||
    Object.keys(safe).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(safe, key))
  )
    return fail();
  return safe as Record<string, unknown>;
}
function kind(value: unknown): CatalogProductPublicationResolutionOriginalKind {
  if (
    value !== "PublicationV1" &&
    value !== "PublicationV2" &&
    value !== "WarningAcknowledgementV1"
  )
    return fail();
  return value;
}
/** The V1/V2 publication protocols occupy the same original idempotency namespace.
 * Actor, intent digest and Product are deliberately not part of the fence key. */
export function catalogProductPublicationResolutionNamespace(
  originalKind: CatalogProductPublicationResolutionOriginalKind,
) {
  return kind(originalKind) === "WarningAcknowledgementV1"
    ? ("CatalogProductWarningAcknowledgement" as const)
    : ("CatalogProductOperation" as const);
}
/** Recovery never changes the original command or admits it against today's root.
 * Only the original owning parser selects its protocol; no V2-to-V1 projection. */
export function parseCatalogProductPublicationResolutionCommand(
  value: unknown,
): CatalogProductPublicationResolutionCommand {
  const r = closed(value, ["profile", "originalKind", "originalCommand"]);
  if (r.profile !== "CatalogProductPublicationResolutionCommandV1") return fail();
  const originalKind = kind(r.originalKind);
  if (originalKind === "WarningAcknowledgementV1")
    return Object.freeze({
      profile: r.profile,
      originalKind,
      originalCommand: parseCatalogProductPublicationWarningAcknowledgementCommand(
        r.originalCommand,
      ),
    });
  if (originalKind === "PublicationV1") {
    const originalCommand = parseProductPublicationCommand(r.originalCommand);
    if (originalCommand.actorKind !== "User") return fail();
    return Object.freeze({ profile: r.profile, originalKind, originalCommand });
  }
  const originalCommand = parseProductPublicationCommandV2(r.originalCommand);
  if (originalCommand.actorKind !== "User") return fail();
  return Object.freeze({ profile: r.profile, originalKind, originalCommand });
}
/** Integrity parsing is not proof of a database result. The owning transaction
 * establishes receipt presence or appends the permanent abandonment fence. */
export function parseCatalogProductPublicationResolution(
  value: unknown,
): CatalogProductPublicationResolution {
  const r = closed(value, [
    "profile",
    "outcome",
    "originalKind",
    "tenantReference",
    "brandReference",
    "actorReference",
    "productReference",
    "versionReference",
    "operationReference",
    "originalIntentDigest",
    "recordedAt",
    "digest",
  ]);
  if (
    r.profile !== "CatalogProductPublicationResolutionV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    typeof r.originalIntentDigest !== "string" ||
    !r.originalIntentDigest.startsWith("sha256:")
  )
    return fail();
  const body: Omit<CatalogProductPublicationResolution, "digest"> = {
    profile: r.profile,
    outcome: r.outcome,
    originalKind: kind(r.originalKind),
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    operationReference: parseCatalogReference(r.operationReference),
    originalIntentDigest: "sha256:" + parseCatalogHash(r.originalIntentDigest.slice(7)),
    recordedAt: parseCatalogInstant(r.recordedAt),
  };
  if (r.digest !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
export function buildCatalogProductPublicationResolution(
  commandValue: unknown,
  outcome: "Committed" | "Abandoned",
  recordedAt: unknown,
): CatalogProductPublicationResolution {
  const command = parseCatalogProductPublicationResolutionCommand(commandValue),
    c = command.originalCommand;
  const body = {
    profile: "CatalogProductPublicationResolutionV1",
    outcome,
    originalKind: command.originalKind,
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    actorReference: c.actorReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    operationReference: c.operationReference,
    originalIntentDigest: hash(c),
    recordedAt: parseCatalogInstant(recordedAt),
  };
  return parseCatalogProductPublicationResolution({ ...body, digest: hash(body) });
}
