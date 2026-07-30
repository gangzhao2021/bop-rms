import { createEffectiveConfigurationVersion } from "@bop/effective-period";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaReference,
  evaluateMediaReference,
} from "@bop/media";
import { createPublishingLifecycleRecord, createPublishingReleaseRecord } from "@bop/publishing";
import type { CanonicalInstant } from "@bop/tenant";
import {
  parseGetPublicStoreRequest,
  parsePublicStoreProfileCandidateShape,
  parsePublicStoreResolutionEvidence,
  readExactRecord,
  StoreContractError,
  type GetPublicStoreResult,
  type PublicStoreLogoEvidence,
  type PublicStoreProfile,
  type PublicStoreProfileCandidate,
  type PublicStoreResolutionEvidence,
  type StoreLocale,
} from "../contracts/public-store-profile.js";
import { resolvePublicStoreProfileSelection } from "../domain/resolve-public-store-profile.js";
import type {
  PublicStoreProfilePorts,
  PublicStoreTelemetryReason,
} from "./ports/public-store-profile-ports.js";

const invalidRequest = Object.freeze({ status: "InvalidRequest" } as const);
const unavailable = Object.freeze({ status: "StoreUnavailable" } as const);

function record(
  ports: PublicStoreProfilePorts,
  outcome: "AVAILABLE" | "INVALID_REQUEST" | "STORE_UNAVAILABLE",
  reason: PublicStoreTelemetryReason,
): void {
  try {
    ports.telemetry.record({ operation: "GetPublicStore", outcome, reason });
  } catch {
    // Telemetry must not change public query behavior.
  }
}

function sameScope(
  scope: {
    readonly kind: string;
    readonly brandReference: string;
    readonly storeReference: string | null;
  },
  evidence: PublicStoreResolutionEvidence,
): boolean {
  return (
    scope.kind === "Store" &&
    scope.brandReference === evidence.brandReference &&
    scope.storeReference === evidence.storeReference
  );
}

function validatePublishing(
  candidate: PublicStoreProfileCandidate,
  evidence: PublicStoreResolutionEvidence,
  evaluatedAt: CanonicalInstant,
): void {
  const lifecycle = createPublishingLifecycleRecord(candidate.publishingLifecycle);
  const release = createPublishingReleaseRecord(candidate.publishingRelease);
  if (
    lifecycle.state !== "Published" ||
    lifecycle.configurationType !== "STORE_PROFILE" ||
    lifecycle.purposeCode !== "CUSTOMER_ENTRY" ||
    !sameScope(lifecycle.scope, evidence) ||
    String(lifecycle.snapshotReference) !== candidate.profileReference ||
    String(lifecycle.snapshotDigest) !== candidate.contentDigest ||
    release.sourceLifecycleId !== lifecycle.lifecycleId ||
    release.familyReference !== lifecycle.familyReference ||
    release.configurationType !== lifecycle.configurationType ||
    release.purposeCode !== lifecycle.purposeCode ||
    String(release.snapshotReference) !== candidate.profileReference ||
    String(release.snapshotDigest) !== candidate.contentDigest ||
    !sameScope(release.scope, evidence) ||
    Date.parse(release.createdAt) > Date.parse(evaluatedAt)
  )
    throw new StoreContractError("STORE_PROFILE_INVALID");
}

function validateEffectivePeriod(
  candidate: PublicStoreProfileCandidate,
  evidence: PublicStoreResolutionEvidence,
  evaluatedAt: CanonicalInstant,
): PublicStoreProfileCandidate {
  const effectiveVersion = createEffectiveConfigurationVersion(candidate.effectiveVersion);
  if (
    effectiveVersion.configurationType !== "STORE_PROFILE" ||
    effectiveVersion.purposeCode !== "CUSTOMER_ENTRY" ||
    !sameScope(effectiveVersion.scope, evidence) ||
    String(effectiveVersion.configurationReference) !== candidate.profileReference ||
    String(effectiveVersion.snapshotReference) !== candidate.profileReference ||
    String(effectiveVersion.snapshotDigest) !== candidate.contentDigest ||
    String(effectiveVersion.releaseReference) !== candidate.publishingRelease.releaseId ||
    effectiveVersion.period.timeZone !== candidate.timeZone ||
    Date.parse(effectiveVersion.createdAt) > Date.parse(evaluatedAt)
  )
    throw new StoreContractError("STORE_PROFILE_INVALID");
  return Object.freeze({ ...candidate, effectiveVersion });
}

function validateLogo(
  value: PublicStoreLogoEvidence | null,
  candidate: PublicStoreProfileCandidate,
  evidence: PublicStoreResolutionEvidence,
): string | null {
  if (value === null) return null;
  const logo = readExactRecord(value, ["reference", "asset", "version"], "STORE_PROFILE_INVALID");
  const reference = createMediaReference(logo.reference as PublicStoreLogoEvidence["reference"]);
  const asset = createMediaAsset(logo.asset as PublicStoreLogoEvidence["asset"]);
  const version = createMediaAssetVersion(logo.version as PublicStoreLogoEvidence["version"]);
  const evaluation = evaluateMediaReference({
    reference,
    asset,
    versions: [version],
    context: {
      kind: "Store",
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
    },
    use: "Published",
  });
  if (
    !evaluation.allowed ||
    reference.kind !== "Pinned" ||
    asset.scope.kind !== "Store" ||
    asset.scope.brandReference !== evidence.brandReference ||
    asset.scope.storeReference !== evidence.storeReference ||
    asset.purpose !== "STORE_PROFILE_LOGO" ||
    asset.ownerType !== "STORE_PROFILE" ||
    String(asset.ownerReference) !== candidate.profileReference ||
    asset.classification !== "Public" ||
    asset.mediaKind !== "Image" ||
    !version.contentType.startsWith("image/") ||
    evaluation.assetVersionId === null
  )
    throw new StoreContractError("STORE_PROFILE_INVALID");
  return evaluation.assetVersionId;
}

function resolveProfile(input: {
  readonly evidence: PublicStoreResolutionEvidence;
  readonly candidates: unknown;
  readonly requestedLocale: StoreLocale;
  readonly evaluatedAt: CanonicalInstant;
}): PublicStoreProfile | null {
  if (!Array.isArray(input.candidates) || input.candidates.length > 50)
    throw new StoreContractError("STORE_PROFILE_INVALID");
  const candidates = input.candidates.map((value) => {
    const candidate = parsePublicStoreProfileCandidateShape(value);
    if (
      candidate.brandReference !== input.evidence.brandReference ||
      candidate.storeReference !== input.evidence.storeReference
    )
      throw new StoreContractError("STORE_PROFILE_INVALID");
    validatePublishing(candidate, input.evidence, input.evaluatedAt);
    const validated = validateEffectivePeriod(candidate, input.evidence, input.evaluatedAt);
    return Object.freeze({
      candidate: validated,
      logoAssetVersionReference: validateLogo(validated.logo, validated, input.evidence),
    });
  });
  const selection = resolvePublicStoreProfileSelection({
    candidates: candidates.map(({ candidate }, candidateIndex) => ({
      candidateIndex,
      timingVersionReference: candidate.effectiveVersion.timingVersionReference,
      effectiveFrom: candidate.effectiveVersion.period.effectiveFrom.instant,
      effectiveUntil: candidate.effectiveVersion.period.effectiveUntil?.instant ?? null,
      defaultLocale: candidate.defaultLocale,
      supportedLocales: candidate.supportedLocales,
    })),
    requestedLocale: input.requestedLocale,
    evaluatedAt: input.evaluatedAt,
  });
  if (selection === null) return null;
  const selectedEntry = candidates[selection.candidateIndex];
  if (selectedEntry === undefined) throw new StoreContractError("STORE_PROFILE_INVALID");
  const selected = selectedEntry.candidate;
  const localized = selected.localizedFields[selection.selectedLocale];
  if (localized === undefined) throw new StoreContractError("STORE_PROFILE_INVALID");
  return Object.freeze({
    profileReference: selected.profileReference,
    profileVersion: selected.profileVersion,
    releaseReference: selected.publishingRelease.releaseId,
    contentDigest: selected.contentDigest,
    defaultLocale: selected.defaultLocale,
    selectedLocale: selection.selectedLocale as StoreLocale,
    currencyCode: "CAD",
    timeZone: selected.timeZone,
    brandDisplayName: localized.brandDisplayName,
    storeDisplayName: localized.storeDisplayName,
    address: selected.address,
    businessPhone: selected.businessPhone,
    website: selected.website,
    logoAssetVersionReference: selectedEntry.logoAssetVersionReference,
  });
}

export function createPublicStoreProfileService(ports: PublicStoreProfilePorts) {
  return Object.freeze({
    async getPublicStore(request: unknown): Promise<GetPublicStoreResult> {
      let parsed;
      try {
        parsed = parseGetPublicStoreRequest(request);
      } catch {
        record(ports, "INVALID_REQUEST", "REQUEST_INVALID");
        return invalidRequest;
      }

      try {
        const rawEvidence = await ports.resolution.resolve({
          publicStoreReference: parsed.publicStoreReference,
          evaluatedAt: parsed.evaluatedAt,
          purpose: parsed.purpose,
        });
        if (rawEvidence === null) {
          record(ports, "STORE_UNAVAILABLE", "SCOPE_UNAVAILABLE");
          return unavailable;
        }
        const evidence = parsePublicStoreResolutionEvidence(rawEvidence);
        if (
          evidence.publicStoreReference !== parsed.publicStoreReference ||
          evidence.brandLifecycle !== "Active" ||
          evidence.storeLifecycle !== "Active" ||
          Date.parse(evidence.validUntil) <= Date.parse(parsed.evaluatedAt)
        ) {
          record(ports, "STORE_UNAVAILABLE", "SCOPE_UNAVAILABLE");
          return unavailable;
        }
        const candidates = await ports.profiles.loadCandidates({
          brandReference: evidence.brandReference,
          storeReference: evidence.storeReference,
        });
        const profile = resolveProfile({
          evidence,
          candidates,
          requestedLocale: parsed.requestedLocale,
          evaluatedAt: parsed.evaluatedAt,
        });
        if (profile === null) {
          record(ports, "STORE_UNAVAILABLE", "PROFILE_UNAVAILABLE");
          return unavailable;
        }
        record(ports, "AVAILABLE", "PROFILE_AVAILABLE");
        return Object.freeze({ status: "Available", profile });
      } catch {
        record(ports, "STORE_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE");
        return unavailable;
      }
    },
  });
}
