import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
} from "@bop/publishing";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  parsePublicStoreProfileCandidateShape,
  type PublicStoreProfileCandidate,
} from "../contracts/public-store-profile.js";
import {
  parsePublicStoreProfileEdit,
  PublicStoreProfileEditError,
  type PublicStoreProfileEdit,
  type PublicStoreProfileEditErrorCode,
} from "../contracts/public-store-profile-edit.js";
import { createPostgresPublicStoreProfileAuthority } from "./public-profile-authority.js";
import { publicStoreProfileContent } from "./public-profile-authority.js";
import { createPostgresPublicStoreProfileStore } from "./persistence/public-store-profile-store.js";
import { createPostgresPublicStoreProfileTimingStore } from "./persistence/public-store-profile-timing-store.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type CommitInput = Parameters<
  ReturnType<typeof createPostgresPublishingMutationStore>["commit"]
>[0];

/** Audit of one Owner publication: which fields changed and the versions, never their values. */
export interface PublicStoreProfilePublicationAudit {
  readonly auditId: string;
  readonly brandId: string;
  readonly storeId: string;
  readonly actor: { readonly type: "User"; readonly reference: string };
  readonly actionCode: "STORE_PUBLIC_PROFILE_PUBLISHED" | "STORE_PUBLIC_PROFILE_TIMING_RECORDED";
  readonly targetType: "StorePublicProfile" | "StorePublicProfileTiming";
  readonly targetId: string;
  readonly reasonCode: "OWNER_PUBLISHED";
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceChannel: "MERCHANT_WEB";
  readonly dataClassification: "Internal";
  readonly beforeSummary: Readonly<Record<string, unknown>>;
  readonly afterSummary: Readonly<Record<string, unknown>>;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}

/** Store record facts used only when a Store publishes its first public profile. */
export interface PublicStoreProfileFirstPublication {
  readonly defaultLocale: string;
  readonly timeZone: string;
  readonly brandDisplayName: string;
}

const fail = (
  code: PublicStoreProfileEditErrorCode = "STORE_PUBLIC_PROFILE_UNAVAILABLE",
): never => {
  throw new PublicStoreProfileEditError(code);
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The local wall-clock reading of `instant` in `timeZone`, as Effective Period expects it. */
export function storeZonedBoundary(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const localDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
  return Object.freeze({
    instant,
    localDateTime,
    utcOffsetMinutes: (Date.parse(localDateTime + "Z") - Date.parse(instant)) / 60_000,
  });
}

/** What the Owner can change, as it stands in a profile (for "no change" and retry checks). */
export function publicStoreProfileEditOf(
  profile: PublicStoreProfileCandidate,
): PublicStoreProfileEdit {
  const names: Record<string, string> = {};
  for (const locale of profile.supportedLocales) {
    const fields = profile.localizedFields[locale];
    if (fields === undefined) return fail();
    names[locale] = fields.storeDisplayName;
  }
  return Object.freeze({
    storeDisplayNames: Object.freeze(names),
    address: profile.address,
    businessPhone: profile.businessPhone,
  });
}

/**
 * WP-2423 store name (DEC-STORE-CUSTOMER-NAME): the Store's Owner publishes a new version of the
 * Store's public profile (the name customers see, street address and phone). One command, one
 * transaction: a Publishing lifecycle in the Store profile family (draft, system validation, the
 * Owner's approval, release superseding the current one), an open-ended effective period starting
 * now, and the immutable profile version, each with its audit. Earlier versions stay as history
 * and stop being current; nothing is rewritten. The caller retains the Owner's authority fence
 * (`authorize`) and supplies hashing, media verification, references and audit append.
 */
export function createPostgresPublicStoreProfilePublisher(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  hash(value: unknown): string;
  verifyMedia(tx: Transaction, profile: PublicStoreProfileCandidate, at: string): Promise<boolean>;
  appendAudit(tx: Transaction, record: PublicStoreProfilePublicationAudit): Promise<void>;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}) {
  const scope = {
    brandReference: options.brandReference,
    storeReference: options.storeReference,
  };
  const publishingScope = createPublishingScope({ kind: "Store", ...scope });
  const plainScope = { kind: "Store" as const, ...scope };
  const authorize = async (tx: Transaction, at: string) =>
    (await options.authorize(tx, at)) === true;
  const timing = (
    appendAudit: Parameters<typeof createPostgresPublicStoreProfileTimingStore>[0]["appendAudit"],
  ) =>
    createPostgresPublicStoreProfileTimingStore({
      ...scope,
      authorize,
      authorizeApproval: (tx, _timing, _approval, at) => authorize(tx, at),
      hashPeriod: options.hash,
      appendAudit,
    });
  const profiles = (
    timingStore: ReturnType<typeof timing>,
    appendAudit: Parameters<typeof createPostgresPublicStoreProfileStore>[0]["appendAudit"],
  ) =>
    createPostgresPublicStoreProfileStore({
      ...scope,
      authorize,
      verifyCurrent: createPostgresPublicStoreProfileAuthority({
        ...scope,
        tenantReference: options.tenantReference,
        authorize,
        hashContent: options.hash,
        verifyMedia: options.verifyMedia,
        verifyEffective: (tx, profile, at) => timingStore.verify(tx, profile.effectiveVersion, at),
      }),
      hashSnapshot: options.hash,
      appendAudit,
    });
  const readOnly = async (): Promise<never> => fail();
  return Object.freeze({
    /** The current published profile (null when the Store has none current). */
    async readCurrent(tx: Transaction, observedAt: string) {
      return profiles(timing(readOnly), readOnly).loadLatestCurrent(tx, observedAt);
    },
    async publish(
      tx: Transaction,
      input: {
        readonly actorReference: string;
        readonly operationReference: string;
        readonly expectedVersion: number;
        readonly recordedAt: string;
        readonly edit: unknown;
        readonly firstPublication: PublicStoreProfileFirstPublication;
        /** Stable reference derived from the operation, so a retry finds what it recorded. */
        reference(purpose: string): string;
      },
    ): Promise<{ status: "Published" | "AlreadyPublished"; profile: PublicStoreProfileCandidate }> {
      const at = parseCanonicalInstant(input.recordedAt);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
        return fail("STORE_PUBLIC_PROFILE_INVALID");
      const actor = String(parsePublishingReference(input.actorReference));
      const operation = String(parsePublishingReference(input.operationReference));
      const ref = (purpose: string) => String(parsePublishingReference(input.reference(purpose)));
      if (!(await authorize(tx, at))) return fail("STORE_PUBLIC_PROFILE_DENIED");
      let before: PublicStoreProfileCandidate | null = null;
      const audit = (
        actionCode: PublicStoreProfilePublicationAudit["actionCode"],
        targetType: PublicStoreProfilePublicationAudit["targetType"],
        targetId: string,
        auditId: string,
        beforeSummary: Record<string, unknown>,
        afterSummary: Record<string, unknown>,
      ): PublicStoreProfilePublicationAudit =>
        Object.freeze({
          auditId,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: Object.freeze({ type: "User" as const, reference: actor }),
          actionCode,
          targetType,
          targetId,
          reasonCode: "OWNER_PUBLISHED" as const,
          correlationId: operation,
          occurredAt: at,
          sourceChannel: "MERCHANT_WEB" as const,
          dataClassification: "Internal" as const,
          beforeSummary: Object.freeze(beforeSummary),
          afterSummary: Object.freeze(afterSummary),
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        });
      let edit: PublicStoreProfileEdit | null = null;
      const timingStore = timing((t, record) =>
        options.appendAudit(
          t,
          audit(
            "STORE_PUBLIC_PROFILE_TIMING_RECORDED",
            "StorePublicProfileTiming",
            String(record.timing.timingVersionReference),
            record.auditReference,
            {},
            { effectiveFrom: record.timing.period.effectiveFrom.instant, effectiveUntil: null },
          ),
        ),
      );
      const store = profiles(timingStore, (t, record) => {
        const changed =
          before === null || edit === null
            ? ["storeDisplayName", "address", "businessPhone"]
            : [
                ...(same(publicStoreProfileEditOf(before).storeDisplayNames, edit.storeDisplayNames)
                  ? []
                  : ["storeDisplayName"]),
                ...(same(before.address, edit.address) ? [] : ["address"]),
                ...(before.businessPhone === edit.businessPhone ? [] : ["businessPhone"]),
              ];
        return options.appendAudit(
          t,
          audit(
            "STORE_PUBLIC_PROFILE_PUBLISHED",
            "StorePublicProfile",
            record.profile.profileReference,
            record.auditReference,
            { profileVersion: before?.profileVersion ?? 0 },
            {
              profileVersion: record.profile.profileVersion,
              releaseReference: record.profile.publishingRelease.releaseId,
              changedFields: changed,
            },
          ),
        );
      });
      try {
        await store.lockPublication(tx, at);
        const current = await store.loadLatestCurrent(tx, at);
        before = current;
        const releaseId = ref("release");
        // A retry of this same operation finds the version it published.
        if (current !== null && current.publishingRelease.releaseId === releaseId) {
          const recorded = publicStoreProfileEditOf(current);
          const again = parsePublicStoreProfileEdit(input.edit, current.supportedLocales);
          if (!same(recorded, again)) return fail("STORE_PUBLIC_PROFILE_OPERATION_CONFLICT");
          if (!(await authorize(tx, at))) return fail("STORE_PUBLIC_PROFILE_DENIED");
          return Object.freeze({ status: "AlreadyPublished" as const, profile: current });
        }
        if ((current?.profileVersion ?? 0) !== input.expectedVersion)
          return fail("STORE_PUBLIC_PROFILE_VERSION_CONFLICT");
        const first = input.firstPublication;
        const locales = current?.supportedLocales ?? [first.defaultLocale];
        edit = parsePublicStoreProfileEdit(input.edit, locales);
        if (current !== null && same(publicStoreProfileEditOf(current), edit))
          return fail("STORE_PUBLIC_PROFILE_NO_CHANGE");
        if (current !== null && Date.parse(at) < Date.parse(current.publishingRelease.createdAt))
          return fail();
        const profileReference = current?.profileReference ?? ref("profile");
        const profileVersion = (await store.highestVersion(tx, profileReference, at)) + 1;
        const localizedFields: Record<
          string,
          { brandDisplayName: string; storeDisplayName: string }
        > = {};
        for (const locale of locales) {
          const name = edit.storeDisplayNames[locale];
          if (name === undefined) return fail("STORE_PUBLIC_PROFILE_INVALID");
          localizedFields[locale] = {
            brandDisplayName:
              current?.localizedFields[locale]?.brandDisplayName ?? first.brandDisplayName,
            storeDisplayName: name,
          };
        }
        const timeZone = current?.timeZone ?? first.timeZone;
        const placeholder = "sha256:" + "0".repeat(64);
        const draft = {
          profileReference,
          profileVersion,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          classification: "Public",
          defaultLocale: current?.defaultLocale ?? first.defaultLocale,
          supportedLocales: [...locales],
          localizedFields,
          currencyCode: "CAD",
          timeZone,
          address: {
            countryCode: edit.address.countryCode,
            regionCode: edit.address.regionCode,
            locality: edit.address.locality,
            postalCode: edit.address.postalCode,
            addressLines: [...edit.address.addressLines],
          },
          businessPhone: edit.businessPhone,
          website: current?.website ?? null,
          contentDigest: placeholder,
          publishingLifecycle: {},
          publishingRelease: {},
          effectiveVersion: {},
          logo: current?.logo ?? null,
        };
        let contentDigest: string;
        try {
          contentDigest = options.hash(
            publicStoreProfileContent(parsePublicStoreProfileCandidateShape(draft)),
          );
        } catch {
          return fail("STORE_PUBLIC_PROFILE_INVALID");
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(contentDigest)) return fail();

        // Publishing: draft → review (system validation) → Owner approval → release.
        const family = current?.publishingLifecycle.familyReference ?? ref("publishing-family");
        const head = current?.publishingRelease ?? null;
        const lifecycleId = ref("lifecycle");
        const validUntil = new Date(Date.parse(at) + 3_600_000).toISOString();
        const publishing = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          parsePublishingReference(options.tenantReference),
          publishingScope,
        );
        const base = {
          lifecycleId,
          familyReference: family,
          configurationType: "STORE_PROFILE",
          purposeCode: "CUSTOMER_ENTRY",
          snapshotReference: profileReference,
          snapshotDigest: contentDigest,
          scope: plainScope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: at,
          changedAt: at,
        };
        const actions = {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
        } as const;
        const mutation = (
          kind: keyof typeof actions,
          previous: Readonly<{ version: number }> | null,
          next: Readonly<{ version: number }>,
          extra: Record<string, unknown> = {},
        ) =>
          ({
            operation: kind,
            expectedVersion: previous?.version ?? 1,
            idempotencyKey: ref("publishing-" + kind),
            current: previous,
            next,
            release: null,
            supersededReleaseId: null,
            rollbackTargetReleaseId: null,
            validationEvidence: null,
            approvalEvidence: null,
            audit: {
              auditId: ref("publishing-audit-" + kind),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "User", reference: actor },
              actionCode: actions[kind],
              targetType: "PublishingLifecycle",
              targetId: lifecycleId,
              reasonCode: "OWNER_PUBLISHED",
              correlationId: operation,
              occurredAt: at,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Confidential",
              retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
              retentionPolicyVersion: 1,
            },
            ...extra,
          }) as unknown as CommitInput;
        const validation = {
          evidenceReference: ref("validation"),
          snapshotReference: profileReference,
          snapshotDigest: contentDigest,
          scope: plainScope,
          result: "Pass",
          checkedAt: at,
          validUntil,
          checkCodes: ["STORE_PUBLIC_PROFILE_FIELDS_VALID"],
        };
        const approval = {
          evidenceReference: ref("approval"),
          reviewLifecycleId: lifecycleId,
          reviewVersion: 2,
          snapshotReference: profileReference,
          snapshotDigest: contentDigest,
          scope: plainScope,
          decision: "Accepted",
          approvedActorReference: actor,
          approvedAt: at,
          validUntil,
        };
        const review = {
          ...base,
          version: 2,
          state: "InReview",
          validationEvidenceReference: validation.evidenceReference,
        };
        const approved = {
          ...review,
          version: 3,
          state: "Approved",
          approvalEvidenceReference: approval.evidenceReference,
        };
        const published = { ...approved, version: 4, state: "Published" };
        const release = {
          releaseId,
          familyReference: family,
          configurationType: "STORE_PROFILE",
          purposeCode: "CUSTOMER_ENTRY",
          snapshotReference: profileReference,
          snapshotDigest: contentDigest,
          scope: plainScope,
          sequence: (head?.sequence ?? 0) + 1,
          sourceLifecycleId: lifecycleId,
          kind: "Publish",
          previousReleaseId: head?.releaseId ?? null,
          createdAt: at,
        };
        await publishing.commit(mutation("CreateDraft", null, base));
        await publishing.commit(
          mutation("SubmitReview", base, review, { validationEvidence: validation }),
        );
        await publishing.commit(
          mutation("Approve", review, approved, { approvalEvidence: approval }),
        );
        await publishing.commit(
          mutation("Publish", approved, published, {
            validationEvidence: validation,
            approvalEvidence: approval,
            release,
            supersededReleaseId: head?.releaseId ?? null,
          }),
        );

        // Effective from now, open-ended, in the Store's time zone.
        const period = {
          timeZone,
          effectiveFrom: storeZonedBoundary(at, timeZone),
          effectiveUntil: null,
        };
        const effectiveVersion = {
          timingVersionReference: ref("timing"),
          familyReference: ref("timing-family"),
          configurationReference: profileReference,
          releaseReference: releaseId,
          snapshotReference: profileReference,
          snapshotDigest: contentDigest,
          configurationType: "STORE_PROFILE",
          purposeCode: "CUSTOMER_ENTRY",
          scope: plainScope,
          version: 1,
          period,
          periodDigest: options.hash(period),
          approvalEvidenceReference: ref("timing-approval"),
          createdAt: at,
        };
        await timingStore.append(tx, {
          timing: effectiveVersion as never,
          approval: {
            evidenceReference: effectiveVersion.approvalEvidenceReference,
            familyReference: effectiveVersion.familyReference,
            timingVersionReference: effectiveVersion.timingVersionReference,
            version: 1,
            scope: plainScope,
            periodDigest: effectiveVersion.periodDigest,
            decision: "Accepted",
            approvedActorReference: actor,
            approvedAt: at,
            validUntil,
          } as never,
          auditReference: ref("timing-audit"),
          recordedAt: at,
        });
        const profile = parsePublicStoreProfileCandidateShape({
          ...draft,
          contentDigest,
          publishingLifecycle: published,
          publishingRelease: release,
          effectiveVersion,
        });
        if (
          (await store.append(tx, {
            profile,
            actorReference: actor,
            auditReference: ref("profile-audit"),
            recordedAt: at,
          })) !== "Created"
        )
          return fail();
        if (!(await authorize(tx, at))) return fail("STORE_PUBLIC_PROFILE_DENIED");
        return Object.freeze({ status: "Published" as const, profile });
      } catch (error) {
        if (error instanceof PublicStoreProfileEditError) throw error;
        return fail();
      }
    },
  });
}
