import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
export const menuReferenceSourceMaximumRows = 10000;
export const menuReferenceSourceFields = Object.freeze([
  "generation",
  "reviewReference",
  "brandReference",
  "menuReference",
  "menuVersionReference",
  "snapshotDigest",
  "createdAt",
  "sectionReference",
  "placementReference",
  "skuReference",
  "productVersionReference",
  "lifecycleVersion",
  "state",
  "changedAt",
  "releaseReference",
  "releaseSequence",
  "previousReleaseReference",
  "releaseKind",
  "timingReference",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "periodDigest",
] as const);
export interface MenuReferenceSourceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export interface MenuReviewReference {
  readonly reviewReference: string;
  readonly brandReference: string;
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
}
export interface MenuPlacementReference {
  readonly reviewReference: string;
  readonly sectionReference: string;
  readonly placementReference: string;
  readonly skuReference: string;
  readonly productVersionReference: string;
}
export interface MenuRevisionReference {
  readonly reviewReference: string;
  readonly brandReference: string;
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly snapshotDigest: string;
  readonly lifecycleVersion: number;
  readonly state: "Draft" | "InReview" | "Approved" | "Published" | "Archived" | "Superseded";
  readonly changedAt: string;
}
export interface MenuReleaseReference {
  readonly releaseReference: string;
  readonly reviewReference: string;
  readonly brandReference: string;
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly snapshotDigest: string;
  readonly lifecycleVersion: number;
  readonly releaseSequence: number;
  readonly previousReleaseReference: string | null;
  readonly releaseKind: "Publish" | "Rollback";
  readonly createdAt: string;
}
export interface MenuPeriodReference {
  readonly timingReference: string;
  readonly releaseReference: string;
  readonly brandReference: string;
  readonly menuReference: string;
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly periodDigest: string;
  readonly createdAt: string;
}
export interface MenuReferenceSourceSnapshot {
  readonly request: MenuReferenceSourceRequest;
  readonly profile: "BrandMenuStoredReferencesV1";
  readonly coverage: "CompleteStoredReferences";
  readonly consistency: "StatementSnapshot";
  readonly applicability: "Unavailable";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly reviews: readonly MenuReviewReference[];
  readonly placements: readonly MenuPlacementReference[];
  readonly revisions: readonly MenuRevisionReference[];
  readonly releases: readonly MenuReleaseReference[];
  readonly periods: readonly MenuPeriodReference[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > menuReferenceSourceMaximumRows ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const hash = (value: unknown) =>
  typeof value === "string" && value.startsWith("sha256:")
    ? "sha256:" + parseCatalogHash(value.slice(7))
    : fail();
export function parseMenuReferenceSourceRequest(value: unknown): MenuReferenceSourceRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_MENU_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      operationReference: parseCatalogReference(r.operationReference),
      catalogIntentDigest: hash(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}

const reviewFields = [
  "reviewReference",
  "brandReference",
  "menuReference",
  "menuVersionReference",
  "snapshotDigest",
  "createdAt",
] as const;
const placementFields = [
  "reviewReference",
  "sectionReference",
  "placementReference",
  "skuReference",
  "productVersionReference",
] as const;
const revisionFields = [
  "reviewReference",
  "brandReference",
  "menuReference",
  "menuVersionReference",
  "snapshotDigest",
  "lifecycleVersion",
  "state",
  "changedAt",
] as const;
const releaseFields = [
  "releaseReference",
  "reviewReference",
  "brandReference",
  "menuReference",
  "menuVersionReference",
  "snapshotDigest",
  "lifecycleVersion",
  "releaseSequence",
  "previousReleaseReference",
  "releaseKind",
  "createdAt",
] as const;
const periodFields = [
  "timingReference",
  "releaseReference",
  "brandReference",
  "menuReference",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "periodDigest",
  "createdAt",
] as const;
const families = ["reviews", "placements", "revisions", "releases", "periods"] as const;
const integer = (v: unknown) =>
  Number.isSafeInteger(v) && typeof v === "number" && v >= 1 && v <= 2147483647 ? v : fail();
/** Stored publication reference graph only; current publication/sale/approval remains separate. */
export function buildMenuReferenceSourceSnapshot(
  value: unknown,
  input: MenuReferenceSourceRequest,
  now: string,
): MenuReferenceSourceSnapshot {
  try {
    const request = parseMenuReferenceSourceRequest(input),
      r = exact(value, ["generation", "counts", "observedAt", ...families]),
      counts = exact(r.counts, families),
      observedAt = parseCatalogInstant(r.observedAt),
      at = parseCatalogInstant(now);
    const raw = Object.fromEntries(families.map((k) => [k, array(r[k])])) as Record<
      (typeof families)[number],
      unknown[]
    >;
    const total = families.reduce((n, k) => n + raw[k].length, 0);
    if (
      total > menuReferenceSourceMaximumRows ||
      at < observedAt ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      families.some((k) => counts[k] !== String(raw[k].length))
    )
      return fail();
    const generation = r.generation === null && total === 0 ? "0" : r.generation;
    if (
      typeof generation !== "string" ||
      generation.length > 19 ||
      !/^(0|[1-9][0-9]*)$/.test(generation) ||
      BigInt(generation) > 9223372036854775807n
    )
      return fail();
    const ref = parseCatalogReference;
    const past = (v: unknown) => {
      const t = parseCatalogInstant(v);
      return t <= observedAt ? t : fail();
    };
    const brand = (v: unknown) => {
      const b = ref(v);
      return b === request.brandReference ? b : fail();
    };
    const read = (v: unknown, keys: readonly string[]) => {
      const e = exact(v, [...keys, "precise"]);
      if (e.precise !== true) return fail();
      return e;
    };
    const reviews = raw.reviews.map((v) => {
      const e = read(v, reviewFields);
      return Object.freeze({
        reviewReference: ref(e.reviewReference),
        brandReference: brand(e.brandReference),
        menuReference: ref(e.menuReference),
        menuVersionReference: ref(e.menuVersionReference),
        snapshotDigest: hash(e.snapshotDigest),
        createdAt: past(e.createdAt),
      });
    });
    const reviewMap = new Map(reviews.map((r) => [r.reviewReference, r]));
    if (reviewMap.size !== reviews.length) return fail();
    const parent = (e: Record<string, unknown>) => {
      const p = reviewMap.get(ref(e.reviewReference));
      if (
        !p ||
        e.brandReference !== p.brandReference ||
        e.menuReference !== p.menuReference ||
        e.menuVersionReference !== p.menuVersionReference ||
        e.snapshotDigest !== p.snapshotDigest
      )
        return fail();
      return p;
    };
    const placementKeys = new Set<string>();
    const placements = raw.placements.map((v) => {
      const e = exact(v, placementFields),
        reviewReference = ref(e.reviewReference),
        placementReference = ref(e.placementReference),
        key = reviewReference + ":" + placementReference;
      if (!reviewMap.has(reviewReference) || placementKeys.has(key)) return fail();
      placementKeys.add(key);
      return Object.freeze({
        reviewReference,
        sectionReference: ref(e.sectionReference),
        placementReference,
        skuReference: ref(e.skuReference),
        productVersionReference: ref(e.productVersionReference),
      });
    });
    const states = [
      "Draft",
      "InReview",
      "Approved",
      "Published",
      "Archived",
      "Superseded",
    ] as const;
    const revisionMap = new Map<string, MenuRevisionReference>();
    const revisions = raw.revisions.map((v) => {
      const e = read(v, revisionFields),
        p = parent(e),
        lifecycleVersion = integer(e.lifecycleVersion),
        changedAt = past(e.changedAt),
        state = states.find((s) => s === e.state),
        key = p.reviewReference + ":" + lifecycleVersion;
      if (!state || changedAt < p.createdAt || revisionMap.has(key)) return fail();
      const result = Object.freeze({
        reviewReference: p.reviewReference,
        brandReference: p.brandReference,
        menuReference: p.menuReference,
        menuVersionReference: p.menuVersionReference,
        snapshotDigest: p.snapshotDigest,
        lifecycleVersion,
        state,
        changedAt,
      });
      revisionMap.set(key, result);
      return result;
    });
    for (const review of reviews) {
      const history = revisions
        .filter((v) => v.reviewReference === review.reviewReference)
        .sort((a, b) => a.lifecycleVersion - b.lifecycleVersion);
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1],
          b = history[i];
        if (!a || !b || b.lifecycleVersion !== a.lifecycleVersion + 1 || b.changedAt < a.changedAt)
          return fail();
      }
    }
    const releaseMap = new Map<string, MenuReleaseReference>();
    const releases = raw.releases.map((v) => {
      const e = read(v, releaseFields),
        p = parent(e),
        releaseReference = ref(e.releaseReference),
        lifecycleVersion = integer(e.lifecycleVersion),
        revision = revisionMap.get(p.reviewReference + ":" + lifecycleVersion),
        createdAt = past(e.createdAt),
        releaseKind = e.releaseKind;
      if (
        releaseMap.has(releaseReference) ||
        !revision ||
        revision.state !== "Published" ||
        revision.changedAt > createdAt ||
        (releaseKind !== "Publish" && releaseKind !== "Rollback")
      )
        return fail();
      const result = Object.freeze({
        releaseReference,
        reviewReference: p.reviewReference,
        brandReference: p.brandReference,
        menuReference: p.menuReference,
        menuVersionReference: p.menuVersionReference,
        snapshotDigest: p.snapshotDigest,
        lifecycleVersion,
        releaseSequence: integer(e.releaseSequence),
        previousReleaseReference:
          e.previousReleaseReference === null ? null : ref(e.previousReleaseReference),
        releaseKind,
        createdAt,
      });
      releaseMap.set(releaseReference, result);
      return result;
    });
    const sequences = new Set<string>();
    for (const r of releases) {
      const key = r.menuReference + ":" + r.releaseSequence;
      if (sequences.has(key)) return fail();
      sequences.add(key);
      if (r.releaseSequence === 1) {
        if (r.previousReleaseReference !== null) return fail();
      } else {
        const p =
          r.previousReleaseReference === null
            ? undefined
            : releaseMap.get(r.previousReleaseReference);
        if (
          !p ||
          p.menuReference !== r.menuReference ||
          p.brandReference !== r.brandReference ||
          p.releaseSequence !== r.releaseSequence - 1 ||
          p.createdAt > r.createdAt
        )
          return fail();
      }
    }
    const timingKeys = new Set<string>();
    const periods = raw.periods.map((v) => {
      const e = read(v, periodFields),
        timingReference = ref(e.timingReference),
        releaseReference = ref(e.releaseReference),
        release = releaseMap.get(releaseReference),
        createdAt = past(e.createdAt),
        effectiveFrom = parseCatalogInstant(e.effectiveFrom),
        effectiveUntil = e.effectiveUntil === null ? null : parseCatalogInstant(e.effectiveUntil);
      if (
        !release ||
        timingKeys.has(timingReference) ||
        e.brandReference !== release.brandReference ||
        e.menuReference !== release.menuReference ||
        createdAt < release.createdAt ||
        (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
        typeof e.timeZone !== "string" ||
        e.timeZone.length < 1 ||
        e.timeZone.length > 63 ||
        !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(e.timeZone)
      )
        return fail();
      new Intl.DateTimeFormat("en-CA", { timeZone: e.timeZone });
      timingKeys.add(timingReference);
      return Object.freeze({
        timingReference,
        releaseReference,
        brandReference: release.brandReference,
        menuReference: release.menuReference,
        timeZone: e.timeZone,
        effectiveFrom,
        effectiveUntil,
        periodDigest: hash(e.periodDigest),
        createdAt,
      });
    });
    const body = {
      request,
      profile: "BrandMenuStoredReferencesV1" as const,
      coverage: "CompleteStoredReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      generation,
      reviews: Object.freeze(
        reviews.sort((a, b) => a.reviewReference.localeCompare(b.reviewReference)),
      ),
      placements: Object.freeze(
        placements.sort(
          (a, b) =>
            a.reviewReference.localeCompare(b.reviewReference) ||
            a.placementReference.localeCompare(b.placementReference),
        ),
      ),
      revisions: Object.freeze(
        revisions.sort(
          (a, b) =>
            a.reviewReference.localeCompare(b.reviewReference) ||
            a.lifecycleVersion - b.lifecycleVersion,
        ),
      ),
      releases: Object.freeze(
        releases.sort((a, b) => a.releaseReference.localeCompare(b.releaseReference)),
      ),
      periods: Object.freeze(
        periods.sort((a, b) => a.timingReference.localeCompare(b.timingReference)),
      ),
    };
    return Object.freeze({
      ...body,
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
export function parseMenuReferenceSourceSnapshot(
  value: unknown,
  input: MenuReferenceSourceRequest,
  now: string,
): MenuReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "generation",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseMenuReferenceSourceRequest(input);
    if (
      canonicalizeRfc8785(parseMenuReferenceSourceRequest(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandMenuStoredReferencesV1" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string"
    )
      return fail();
    const keys = {
      reviews: reviewFields,
      placements: placementFields,
      revisions: revisionFields,
      releases: releaseFields,
      periods: periodFields,
    };
    const raw = Object.fromEntries(
      families.map((k) => [
        k,
        array(r[k]).map((v) => ({
          ...exact(v, keys[k]),
          ...(k === "placements" ? {} : { precise: true }),
        })),
      ]),
    );
    const result = buildMenuReferenceSourceSnapshot(
      {
        generation: r.generation,
        observedAt: r.observedAt,
        counts: Object.fromEntries(families.map((k) => [k, String(array(r[k]).length)])),
        ...raw,
      },
      request,
      now,
    );
    if (result.digest !== hash(r.digest)) return fail();
    return result;
  } catch {
    return fail();
  }
}
