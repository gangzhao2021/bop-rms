import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresPlatformBrandTemplateReferenceSource,
  parseBrandAdministrationContext,
  type PlatformBrandTemplateReferenceSourceOptions,
  type PlatformBrandTemplateRevision,
} from "@bop/tenant";
import {
  PublishingContractError,
  parsePublishingInstant,
  parsePublishingReference,
} from "../../contracts/publishing.js";
import {
  parseStoredPlatformPublishingHead,
  type StoredPlatformPublishingHead,
} from "./platform-publishing-read-kernel.js";

export type PlatformTemplateBrandReferenceSourceOptions = Omit<
  PlatformBrandTemplateReferenceSourceOptions,
  "references"
>;
export interface PlatformTemplateBrandCandidate {
  readonly template: PlatformBrandTemplateRevision;
  readonly releaseReference: string;
  readonly releaseSequence: number;
  readonly publishedAt: string;
  readonly publicationSourceDigest: string;
}
interface Observation {
  readonly scope: PlatformTemplateBrandReferenceSourceOptions["scope"];
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PlatformTemplateBrandReferenceCurrent extends Observation {
  readonly profile: "PlatformTemplateBrandReferenceCurrentV1";
  readonly reference: PlatformTemplateBrandCandidate | null;
}
export interface PlatformTemplateBrandReferenceList extends Observation {
  readonly profile: "PlatformTemplateBrandReferenceListV1";
  readonly items: readonly PlatformTemplateBrandCandidate[];
  readonly hasMore: boolean;
  /** Cursor follows scanned families, including currently out-of-period rows. */
  readonly nextAfterTemplateReference: string | null;
}
const invalid = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function rows(value: unknown, maximum: number): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d?.enumerable ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > maximum ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < d.value.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(d.value, String(i));
    if (!entry?.enumerable || !("value" in entry)) return invalid();
    result.push(entry.value);
  }
  return result;
}
const rowKeys = [
  "family_reference",
  "sequence",
  "release_active",
  "selected_receipt_text",
  "selected_receipt_digest",
  "release_receipt_text",
  "release_receipt_digest",
] as const;
const readSql =
  "SELECT family_reference,sequence,release_active,selected_receipt_text,selected_receipt_digest,release_receipt_text,release_receipt_digest FROM bop_publishing.brand_template_publication_read($1::uuid,$2::uuid,$3::uuid)";
const listSql =
  "SELECT family_reference,sequence,release_active,selected_receipt_text,selected_receipt_digest,release_receipt_text,release_receipt_digest FROM bop_publishing.brand_template_publication_list($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::boolean)";

/** One current OR list operation per holder. Content is held through the actual
 * public Tenant source before Publishing fences. List uses a bounded table SHARE
 * fence for new-family phantoms and never acquires a family fence afterwards.
 * The actual outer host owns COMMIT and must run both registered seals. */
export function createPostgresPlatformTemplateBrandReferenceSource(
  options: PlatformTemplateBrandReferenceSourceOptions,
) {
  readClosedRecord(options, [
    "transaction",
    "scope",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "authority",
    "registerBeforeCommit",
  ]);
  const rawScope = readClosedRecord(options.scope, [
    "tenantReference",
    "brandReference",
    "actorReference",
  ]);
  const scope = Object.freeze({
    tenantReference: String(parsePublishingReference(rawScope.tenantReference)),
    brandReference: String(parsePublishingReference(rawScope.brandReference)),
    actorReference: String(parsePublishingReference(rawScope.actorReference)),
  });
  readClosedRecord(options.clock, ["now"]);
  readClosedRecord(options.authority, ["holdUntilTransactionCompletes"]);
  const tx = options.transaction,
    port = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.holdUntilTransactionCompletes,
    register = options.registerBeforeCommit,
    origin = String(parsePublishingInstant(options.originalObservedAt)),
    originalUntil = String(parsePublishingInstant(options.originalValidUntil));
  if (
    scope.tenantReference !== scope.brandReference ||
    origin >= originalUntil ||
    Date.parse(originalUntil) > Date.parse(origin) + 5000 ||
    [port, now, hold, register].some((v) => typeof v !== "function")
  )
    return invalid();
  let phase: "Work" | "Checks" | "Final" | "Poison" = "Work",
    busy = false,
    used = false,
    registered = false,
    guardDone = false,
    guardCalls = 0,
    finalCalls = 0,
    latest = origin,
    deadline = originalUntil,
    identity: string | undefined;
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  let reread: (() => Promise<unknown>) | undefined, pinned: string | undefined;
  const fail = (): never => {
    phase = "Poison";
    return invalid();
  };
  function check() {
    try {
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== port ||
        options.clock !== clock ||
        clock.now !== now ||
        options.authority !== authority ||
        authority.holdUntilTransactionCompletes !== hold ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalUntil ||
        canonicalizeRfc8785(
          readClosedRecord(options.scope, ["tenantReference", "brandReference", "actorReference"]),
        ) !== canonicalizeRfc8785(scope)
      )
        return fail();
      const at = String(parsePublishingInstant(now.call(clock)));
      if (at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    } catch {
      return fail();
    }
  }
  async function query(sql: string, values: readonly unknown[]) {
    check();
    const result = await port.call(tx, sql, values);
    check();
    return result;
  }
  async function authorize() {
    const observedAt = check();
    const raw = readClosedRecord(
      await hold.call(
        authority,
        tx,
        Object.freeze({
          scope,
          purposeCode: "BRAND_ADMINISTRATION",
          permission: "organization.manage",
          observedAt,
          validUntil: deadline,
        }),
      ),
      ["administrationContext", "validUntil"],
    );
    check();
    const context = parseBrandAdministrationContext(raw.administrationContext),
      until = String(parsePublishingInstant(raw.validUntil));
    if (
      String(context.actor.actorReference) !== scope.actorReference ||
      String(context.brand.brandReference) !== scope.brandReference ||
      String(context.resolvedAt) < observedAt ||
      String(context.resolvedAt) > check() ||
      until <= check()
    )
      return fail();
    const stable = canonicalizeRfc8785({
      actor: context.actor,
      brand: context.brand,
      store: context.store,
      profile: context.profile,
      purposeCode: context.purposeCode,
    });
    if (identity !== undefined && identity !== stable) return fail();
    identity = stable;
    if (until < deadline) deadline = until;
    check();
    return Object.freeze({ administrationContext: context, validUntil: deadline });
  }
  const templates = createPostgresPlatformBrandTemplateReferenceSource({
    transaction: tx,
    scope,
    clock,
    originalObservedAt: origin,
    originalValidUntil: originalUntil,
    references: {
      canonicalize: canonicalizeRfc8785,
      hashIntent: (text) => `sha256:${sha256Hex(text)}`,
    },
    authority: {
      holdUntilTransactionCompletes: async (actual, input) => {
        check();
        if (
          actual !== tx ||
          input.permission !== "organization.manage" ||
          input.purposeCode !== "BRAND_ADMINISTRATION" ||
          canonicalizeRfc8785(input.scope) !== canonicalizeRfc8785(scope)
        )
          return fail();
        return authorize();
      },
    },
    registerBeforeCommit: async (actual, guard, final) => {
      check();
      if (
        actual !== tx ||
        phase !== "Work" ||
        typeof guard !== "function" ||
        typeof final !== "function"
      )
        return fail();
      guards.push(guard);
      finals.push(final);
    },
  });
  async function scopeSql() {
    const remaining = String(Math.max(1, Date.parse(deadline) - Date.parse(check())));
    await query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remaining],
    );
    await query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('bop.brand_template_actor_id',$2,true),set_config('bop.brand_template_purpose','BRAND_ADMINISTRATION',true)",
      [scope.brandReference, scope.actorReference],
    );
  }
  function decode(value: unknown) {
    const r = readClosedRecord(value, rowKeys),
      family = String(parsePublishingReference(r.family_reference));
    const head = parseStoredPlatformPublishingHead(
      Object.fromEntries(rowKeys.filter((k) => k !== "family_reference").map((k) => [k, r[k]])),
      family,
      check(),
    );
    if (head.release === null && r.release_receipt_digest !== null) return fail();
    return { family, head };
  }
  async function head(family: string) {
    await scopeSql();
    const result = rows(
      await query(readSql, [scope.actorReference, scope.brandReference, family]),
      1,
    );
    if (result.length === 0) return null;
    const actual = decode(result[0]);
    if (actual.family !== family) return fail();
    return actual.head;
  }
  function candidate(
    material: PlatformBrandTemplateRevision,
    actual: StoredPlatformPublishingHead | null,
  ): PlatformTemplateBrandCandidate | null {
    if (!actual?.releaseActive || !actual.release) return null;
    const source = actual.release,
      release = source.command.release;
    if (
      !release ||
      source.command.operation !== "Publish" ||
      source.command.next.state !== "Published"
    )
      return fail();
    // Replaced versions are normal absence for this exact immutable reference.
    if (String(source.command.next.snapshotReference) !== String(material.templateVersionReference))
      return null;
    if (
      String(source.command.next.familyReference) !== String(material.templateReference) ||
      source.command.next.snapshotDigest !== material.contentDigest ||
      source.templateSourceDigest !== material.sourceDigest ||
      String(source.command.next.authoredActorReference) !== String(material.authoredByReference) ||
      material.recordedAt > source.command.occurredAt ||
      !source.command.validationEvidence ||
      material.recordedAt > source.command.validationEvidence.checkedAt ||
      (actual.selected.command.next.lifecycleId === source.command.next.lifecycleId &&
        actual.selected.command.next.state === "Archived")
    )
      return fail();
    const at = check();
    if (material.content.effectiveFrom > at) {
      if (material.content.effectiveFrom < deadline) deadline = material.content.effectiveFrom;
      return null;
    }
    if (material.content.effectiveUntil !== null && material.content.effectiveUntil <= at)
      return null;
    if (material.content.effectiveUntil !== null && material.content.effectiveUntil < deadline)
      deadline = material.content.effectiveUntil;
    check();
    return Object.freeze({
      template: material,
      releaseReference: String(release.releaseId),
      releaseSequence: release.sequence,
      publishedAt: String(release.createdAt),
      publicationSourceDigest: source.sourceDigest,
    });
  }
  async function seal() {
    if (registered) return;
    registered = true;
    if (
      (await register(
        tx,
        async () => {
          if (busy || phase !== "Work" || !used || ++guardCalls !== 1) return fail();
          busy = true;
          phase = "Checks";
          try {
            for (const guard of guards) {
              if ((await guard()) !== undefined) return fail();
              check();
            }
            await authorize();
            if (!reread || pinned === undefined || canonicalizeRfc8785(await reread()) !== pinned)
              return fail();
            check();
            guardDone = true;
          } catch {
            return fail();
          } finally {
            busy = false;
          }
        },
        () => {
          if (busy || phase !== "Checks" || !guardDone || guardCalls !== 1 || ++finalCalls !== 1)
            return fail();
          try {
            check();
            for (const final of finals) {
              if (final() !== undefined) return fail();
            }
            check();
            phase = "Final";
          } catch {
            return fail();
          }
        },
      )) !== undefined
    )
      return fail();
    check();
  }
  async function protect<T>(work: () => Promise<T>) {
    try {
      if (busy || phase !== "Work" || used) return fail();
      busy = true;
      await seal();
      check();
      used = true;
      await authorize();
      const isolation = rows(
        await query("SELECT current_setting('transaction_isolation') AS isolation_level", []),
        1,
      );
      if (
        isolation.length !== 1 ||
        readClosedRecord(isolation[0], ["isolation_level"]).isolation_level !== "read committed"
      )
        return fail();
      const result = await work();
      check();
      return result;
    } catch {
      return fail();
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    async current(value: unknown): Promise<PlatformTemplateBrandReferenceCurrent> {
      return protect(async () => {
        const r = readClosedRecord(value, ["templateVersionReference"]),
          version = String(parsePublishingReference(r.templateVersionReference));
        const material = await templates.exact({ templateVersionReference: version });
        check();
        let actual: StoredPlatformPublishingHead | null = null;
        if (material) {
          const family = String(material.templateReference),
            before = await head(family);
          await scopeSql();
          await query(
            "SELECT bop_publishing.brand_template_publication_hold($1::uuid,$2::uuid,$3::uuid)",
            [scope.actorReference, scope.brandReference, family],
          );
          actual = await head(family);
          if (canonicalizeRfc8785(before) !== canonicalizeRfc8785(actual)) return fail();
          reread = () => head(family);
          pinned = canonicalizeRfc8785(actual);
        } else {
          reread = async () => null;
          pinned = "null";
        }
        const reference = material ? candidate(material, actual) : null;
        return Object.freeze({
          profile: "PlatformTemplateBrandReferenceCurrentV1",
          scope,
          reference,
          observedAt: check(),
          validUntil: deadline,
        });
      });
    },
    async list(value: unknown): Promise<PlatformTemplateBrandReferenceList> {
      return protect(async () => {
        const r = readClosedRecord(value, ["afterTemplateReference", "limit"]),
          after =
            r.afterTemplateReference === null
              ? null
              : String(parsePublishingReference(r.afterTemplateReference)),
          limit = r.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20)
          return fail();
        const read = async (held: boolean) => {
          await scopeSql();
          const found = rows(
            await query(listSql, [scope.actorReference, scope.brandReference, after, limit, held]),
            limit + 1,
          ).map(decode);
          let previous = after;
          for (const row of found) {
            if (
              !row.head.releaseActive ||
              !row.head.release ||
              (previous !== null && row.family <= previous)
            )
              return fail();
            previous = row.family;
          }
          return found;
        };
        const before = await read(false),
          materials = new Map<string, PlatformBrandTemplateRevision>();
        for (const row of before) {
          const source = row.head.release;
          if (!source) return fail();
          const material = await templates.exact({
            templateVersionReference: String(source.command.next.snapshotReference),
          });
          check();
          if (!material || String(material.templateReference) !== row.family) return fail();
          materials.set(row.family, material);
        }
        const actual = await read(true);
        if (canonicalizeRfc8785(before) !== canonicalizeRfc8785(actual)) return fail();
        reread = () => read(true);
        pinned = canonicalizeRfc8785(actual);
        const qualified = actual.map((row) => {
          const material = materials.get(row.family);
          if (!material) return fail();
          return candidate(material, row.head);
        });
        const items = qualified
            .slice(0, limit)
            .filter((item): item is PlatformTemplateBrandCandidate => item !== null),
          hasMore = actual.length > limit;
        return Object.freeze({
          profile: "PlatformTemplateBrandReferenceListV1",
          scope,
          items: Object.freeze(items),
          hasMore,
          nextAfterTemplateReference: hasMore ? (actual[limit - 1]?.family ?? fail()) : null,
          observedAt: check(),
          validUntil: deadline,
        });
      });
    },
    assertFinalized() {
      if (phase !== "Final" || !guardDone || guardCalls !== 1 || finalCalls !== 1) return fail();
      if (guards.length > 0) templates.assertFinalized();
    },
  });
}
