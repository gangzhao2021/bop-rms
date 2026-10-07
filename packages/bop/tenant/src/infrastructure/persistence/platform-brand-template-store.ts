import {
  decodePlatformBrandTemplateOperation,
  decodePlatformBrandTemplateRevision,
} from "./platform-brand-template-read-kernel.js";
import { parseCanonicalInstant } from "../../domain/brand-store.js";
import { parsePlatformTenantReference } from "../../contracts/platform-tenant-administration.js";
import {
  PlatformBrandTemplateError,
  copyPlatformBrandTemplateValue,
  parsePlatformBrandTemplateScope,
  parsePlatformBrandTemplateSave,
  parsePlatformBrandTemplateResolve,
  platformBrandTemplateIntentDigest,
  createPlatformBrandTemplateRevision,
  parsePlatformBrandTemplateReceipt,
  parsePlatformBrandTemplateCurrent,
  parsePlatformBrandTemplateExact,
  parsePlatformBrandTemplateHistory,
  parsePlatformBrandTemplateListRequest,
  parsePlatformBrandTemplateList,
  parsePlatformBrandTemplateSummary,
  type PlatformBrandTemplateListRequest,
  type PlatformBrandTemplateScope,
  type PlatformBrandTemplateSave,
  type PlatformBrandTemplateResolve,
  type PlatformBrandTemplateRevision,
  type PlatformBrandTemplateReceipt,
  type PlatformBrandTemplateCodec,
} from "../../contracts/platform-brand-template.js";
export interface PlatformBrandTemplateTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Original = PlatformBrandTemplateSave | PlatformBrandTemplateResolve;
type Mode = "Read" | "Save" | "Resolve";
export const platformBrandTemplateRequiredFields = Object.freeze([
  "templateReference",
  "templateVersionReference",
  "revision",
  "recordKind",
  "content",
  "supersedesVersionReference",
  "authoredByReference",
  "operationReference",
  "auditReference",
  "createdAt",
  "recordedAt",
  "contentDigest",
  "sourceDigest",
  "originalCommand",
  "intentDigest",
  "outcome",
] as const);
export interface PlatformBrandTemplateStoreOptions extends PlatformBrandTemplateScope {
  readonly transaction: PlatformBrandTemplateTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly references: PlatformBrandTemplateCodec & {
    nextReference(kind: "Template" | "Version" | "Audit"): string;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: PlatformBrandTemplateTransaction,
      input: Readonly<
        PlatformBrandTemplateScope & {
          permission: "platform.brand-template.read" | "platform.brand-template.manage";
          mode: Mode;
          requiredFields: typeof platformBrandTemplateRequiredFields;
          original: Original | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly appendAudit: (
    tx: PlatformBrandTemplateTransaction,
    input: Readonly<
      PlatformBrandTemplateScope & {
        mode: "Save" | "Abandon";
        operationReference: string;
        intentDigest: string;
        templateReference: string | null;
        templateVersionReference: string | null;
        auditReference: string;
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
  readonly registerBeforeCommit: (
    tx: PlatformBrandTemplateTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
}
/** Actual global Platform source, never a Brand context or publication claim. */
export function createPostgresPlatformBrandTemplateStore(
  options: PlatformBrandTemplateStoreOptions,
) {
  const fixed = parsePlatformBrandTemplateScope({
      kind: options.kind,
      actorReference: options.actorReference,
      purposeCode: options.purposeCode,
    }),
    tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    refs = options.references,
    canonical = refs.canonicalize,
    hashPort = refs.hashIntent,
    next = refs.nextReference,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    auditPort = options.appendAudit,
    register = options.registerBeforeCommit,
    origin = parseCanonicalInstant(options.originalObservedAt),
    originUntil = parseCanonicalInstant(options.originalValidUntil);
  let deadline: string = originUntil,
    latest: string = origin,
    failed = false,
    active = false,
    registered = false,
    done = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    finalCalls = 0,
    wrote = false;
  const requests = new Map<string, { mode: Mode; original: Original | null }>(),
    heldOperations = new Map<string, PlatformBrandTemplateReceipt>(),
    heldReads = new Map<string, { read: () => Promise<unknown>; value: unknown }>();
  const fail = (
    code: PlatformBrandTemplateError["code"] = "PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new PlatformBrandTemplateError(code);
  };
  const unchanged = () =>
    options.kind === fixed.kind &&
    options.actorReference === fixed.actorReference &&
    options.purposeCode === fixed.purposeCode &&
    options.transaction === tx &&
    tx.query === queryPort &&
    options.clock === clock &&
    clock.now === nowPort &&
    options.references === refs &&
    refs.canonicalize === canonical &&
    refs.hashIntent === hashPort &&
    refs.nextReference === next &&
    options.authority === authority &&
    authority.holdUntilTransactionCompletes === holdPort &&
    options.appendAudit === auditPort &&
    options.registerBeforeCommit === register &&
    options.originalObservedAt === origin &&
    options.originalValidUntil === originUntil;
  function check(): string {
    if (failed || !unchanged()) return fail();
    const at = parseCanonicalInstant(nowPort.call(clock));
    if (!unchanged() || at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  }
  const codec: PlatformBrandTemplateCodec = {
    canonicalize: (v) => {
      check();
      const output = canonical.call(refs, v);
      check();
      return output;
    },
    hashIntent: (v) => {
      check();
      const output = hashPort.call(refs, v);
      check();
      return output;
    },
  };
  const same = (a: unknown, b: unknown) => codec.canonicalize(a) === codec.canonicalize(b);
  const hash = (v: unknown) => codec.hashIntent(codec.canonicalize(v));
  function stored<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      return fail();
    }
  }
  function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
    const c = stored(() => copyPlatformBrandTemplateValue(v));
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Reflect.ownKeys(c).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(c, k))
    )
      return fail();
    return c as Record<string, unknown>;
  }
  function rows(v: unknown, max = 1): unknown[] {
    if (!v || typeof v !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(v, "rows");
    if (!d?.enumerable || !("value" in d)) return fail();
    const input: unknown = d.value;
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > max ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      return fail();
    const result: unknown[] = [];
    for (let i = 0; i < input.length; i++) {
      const entry = Object.getOwnPropertyDescriptor(input, String(i));
      if (!entry?.enumerable || !("value" in entry)) return fail();
      result.push(stored(() => copyPlatformBrandTemplateValue(entry.value)));
    }
    return result;
  }
  async function query(sql: string, values: readonly unknown[]) {
    const remaining = String(Math.max(1, Date.parse(deadline) - Date.parse(check())));
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remaining],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  }
  async function insert(sql: string, values: readonly unknown[]) {
    const r = await query(sql, values);
    if (!r || typeof r !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(r, "rowCount");
    if (!d || !("value" in d) || d.value !== 1) return fail();
  }
  const restore = () =>
    query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.tenant_id','',true),set_config('bop.brand_id','',true),set_config('bop.store_id','',true)",
      [fixed.actorReference, fixed.purposeCode],
    );
  async function hold(mode: Mode, original: Original | null) {
    const answer = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        permission:
          mode === "Read"
            ? ("platform.brand-template.read" as const)
            : ("platform.brand-template.manage" as const),
        mode,
        requiredFields: platformBrandTemplateRequiredFields,
        original,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    const until = parseCanonicalInstant(record(answer, ["validUntil"]).validUntil);
    if (until < deadline) deadline = until;
    check();
    await restore();
  }
  async function operation(
    actor: string,
    op: string,
  ): Promise<PlatformBrandTemplateReceipt | null> {
    await restore();
    const found = rows(
      await query(
        "SELECT actor_id,purpose_code,operation_id,intent_digest,receipt_json,receipt_digest,occurred_at=date_trunc('milliseconds',occurred_at) precise FROM bop_tenant.platform_brand_template_operation WHERE actor_id=$1 AND purpose_code=$2 AND operation_id=$3",
        [actor, fixed.purposeCode, op],
      ),
    );
    if (!found[0]) return null;
    const receipt = stored(() =>
      decodePlatformBrandTemplateOperation(found[0], actor, op, codec, check()),
    );
    return receipt;
  }
  async function revision(row: unknown): Promise<PlatformBrandTemplateRevision> {
    const snapshot = stored(() => decodePlatformBrandTemplateRevision(row, codec, check()));
    const original = await operation(snapshot.authoredByReference, snapshot.operationReference);
    if (!original || original.outcome !== "Committed" || !same(original.snapshot, snapshot))
      return fail();
    heldOperations.set(snapshot.authoredByReference + ":" + snapshot.operationReference, original);
    return snapshot;
  }
  const columns =
    "template_id,version_id,revision::text revision,code,actor_id,operation_id,audit_id,content_digest,source_digest,snapshot_json,created_at=date_trunc('milliseconds',created_at) AND recorded_at=date_trunc('milliseconds',recorded_at) precise";
  async function current(template: string) {
    await restore();
    const found = rows(
      await query(
        `SELECT ${columns} FROM bop_tenant.platform_brand_template_revision WHERE template_id=$1 ORDER BY revision DESC LIMIT 1`,
        [template],
      ),
    );
    return found[0] ? revision(found[0]) : null;
  }
  async function exact(version: string) {
    await restore();
    const found = rows(
      await query(
        `SELECT ${columns} FROM bop_tenant.platform_brand_template_revision WHERE version_id=$1`,
        [version],
      ),
    );
    return found[0] ? revision(found[0]) : null;
  }
  async function page(template: string, before: number | null) {
    await restore();
    const found = rows(
        await query(
          `SELECT ${columns} FROM bop_tenant.platform_brand_template_revision WHERE template_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT 3`,
          [template, before],
        ),
        3,
      ),
      parsed: PlatformBrandTemplateRevision[] = [];
    for (const row of found) parsed.push(await revision(row));
    return {
      entries: parsed.slice(0, 2),
      nextBeforeRevision: parsed.length === 3 ? (parsed[1]?.revision ?? fail()) : null,
    };
  }
  async function listPage(request: PlatformBrandTemplateListRequest) {
    await restore();
    const found = rows(
        await query(
          `SELECT ${columns} FROM (SELECT DISTINCT ON(template_id) * FROM bop_tenant.platform_brand_template_revision ORDER BY template_id,revision DESC) AS current_template WHERE ($1::text IS NULL OR code COLLATE "C">$1::text COLLATE "C" OR (code COLLATE "C"=$1::text COLLATE "C" AND template_id>$2::uuid)) ORDER BY code COLLATE "C",template_id LIMIT $3`,
          [
            request.after?.code ?? null,
            request.after?.templateReference ?? null,
            request.limit + 1,
          ],
        ),
        21,
      ),
      parsed = [];
    for (const row of found) {
      const source = await revision(row);
      parsed.push(
        parsePlatformBrandTemplateSummary({
          templateReference: source.templateReference,
          templateVersionReference: source.templateVersionReference,
          revision: source.revision,
          code: source.content.code,
          name: source.content.name,
          contentDigest: source.contentDigest,
          sourceDigest: source.sourceDigest,
          authoredByReference: source.authoredByReference,
          recordedAt: source.recordedAt,
        }),
      );
    }
    const items = parsed.slice(0, request.limit),
      last = items.at(-1),
      hasMore = parsed.length > request.limit;
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last ? { code: last.code, templateReference: last.templateReference } : null,
    };
  }
  async function admit(mode: Mode, original: Original | null) {
    if (active || phase !== "Work") return fail();
    active = true;
    if (
      original &&
      !same(
        parsePlatformBrandTemplateScope({
          kind: original.kind,
          actorReference: original.actorReference,
          purposeCode: original.purposeCode,
        }),
        fixed,
      )
    )
      return fail("PLATFORM_TEMPLATE_PERMISSION_DENIED");
    requests.set(mode + ":" + (original?.operationReference ?? "Read"), { mode, original });
    if (!registered) {
      registered = true;
      const returned = await register.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            for (const request of requests.values()) await hold(request.mode, request.original);
            for (const held of heldReads.values())
              if (!same(await held.read(), held.value))
                return fail("PLATFORM_TEMPLATE_VERSION_CONFLICT");
            for (const receipt of [...heldOperations.values()])
              if (
                !same(await operation(receipt.actorReference, receipt.operationReference), receipt)
              )
                return fail();
            await restore();
            if (wrote)
              await query(
                "SET CONSTRAINTS bop_tenant.platform_brand_template_revision_coherence,bop_tenant.platform_brand_template_operation_coherence IMMEDIATE",
                [],
              );
            check();
            done = true;
          } catch (e) {
            failed = true;
            if (e instanceof PlatformBrandTemplateError) throw e;
            return fail();
          }
        },
        () => {
          if (++finalCalls !== 1 || !done || guardCalls !== 1 || active || phase !== "Checks")
            return fail();
          check();
          phase = "Final";
        },
      );
      if (returned !== undefined) return fail();
    }
    await hold(mode, original);
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (record(isolation[0], ["isolation"]).isolation !== "read committed") return fail();
    await query("SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)", [
      fixed.actorReference,
      original?.operationReference ?? null,
    ]);
    check();
  }
  async function protect<T>(
    mode: Mode,
    original: Original | null,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      await admit(mode, original);
      const value = await work();
      await hold(mode, original);
      check();
      return value;
    } catch (e) {
      failed = true;
      if (e instanceof PlatformBrandTemplateError) throw e;
      return fail();
    } finally {
      active = false;
    }
  }
  async function lookup(original: Original) {
    const found = await operation(fixed.actorReference, original.operationReference);
    if (found) {
      const intent =
        original.profile === "PlatformBrandTemplateSaveV1"
          ? platformBrandTemplateIntentDigest(original, codec)
          : original.intentDigest;
      if (found.intentDigest !== intent) return fail("PLATFORM_TEMPLATE_INTENT_CONFLICT");
      heldOperations.set(fixed.actorReference + ":" + original.operationReference, found);
    }
    return found;
  }
  async function append(
    original: Original,
    snapshot: PlatformBrandTemplateRevision | null,
    auditReference: string,
    occurredAt: string,
  ) {
    const intentDigest =
        original.profile === "PlatformBrandTemplateSaveV1"
          ? platformBrandTemplateIntentDigest(original, codec)
          : original.intentDigest,
      receipt = stored(() =>
        parsePlatformBrandTemplateReceipt(
          {
            profile: "PlatformBrandTemplateOperationV1",
            ...fixed,
            operationReference: original.operationReference,
            intentDigest,
            originalCommand: snapshot ? original : null,
            outcome: snapshot ? "Committed" : "Abandoned",
            snapshot,
            auditReference,
            occurredAt,
            dataClassification: "ConfigurationMetadata",
          },
          codec,
        ),
      );
    const result: unknown = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        mode: snapshot ? ("Save" as const) : ("Abandon" as const),
        operationReference: original.operationReference,
        intentDigest,
        templateReference: snapshot?.templateReference ?? null,
        templateVersionReference: snapshot?.templateVersionReference ?? null,
        auditReference,
        occurredAt,
      }),
    );
    if (result !== undefined) return fail();
    check();
    await restore();
    if (snapshot)
      await insert(
        "INSERT INTO bop_tenant.platform_brand_template_revision(template_id,version_id,revision,code,actor_id,operation_id,audit_id,content_digest,source_digest,snapshot_json,created_at,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
        [
          snapshot.templateReference,
          snapshot.templateVersionReference,
          snapshot.revision,
          snapshot.content.code,
          snapshot.authoredByReference,
          snapshot.operationReference,
          snapshot.auditReference,
          snapshot.contentDigest,
          snapshot.sourceDigest,
          codec.canonicalize(snapshot),
          snapshot.createdAt,
          snapshot.recordedAt,
        ],
      );
    await insert(
      "INSERT INTO bop_tenant.platform_brand_template_operation(actor_id,purpose_code,operation_id,intent_digest,outcome,template_id,version_id,revision,audit_id,command_json,receipt_json,receipt_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)",
      [
        fixed.actorReference,
        fixed.purposeCode,
        original.operationReference,
        intentDigest,
        receipt.outcome,
        snapshot?.templateReference ?? null,
        snapshot?.templateVersionReference ?? null,
        snapshot?.revision ?? null,
        auditReference,
        receipt.originalCommand === null ? null : codec.canonicalize(receipt.originalCommand),
        codec.canonicalize(receipt),
        hash(receipt),
        occurredAt,
      ],
    );
    wrote = true;
    heldOperations.set(fixed.actorReference + ":" + original.operationReference, receipt);
    return receipt;
  }
  if (
    [queryPort, nowPort, canonical, hashPort, next, holdPort, auditPort, register].some(
      (p) => typeof p !== "function",
    ) ||
    originUntil <= origin ||
    Date.parse(originUntil) - Date.parse(origin) > 5000
  )
    return fail();
  check();
  const time = () => ({
    observedAt: check(),
    validUntil: deadline,
    publication: "NotEvaluated" as const,
  });
  return Object.freeze({
    list(raw: unknown) {
      return protect("Read", null, async () => {
        const request = parsePlatformBrandTemplateListRequest(raw),
          page = await listPage(request);
        heldReads.set("list:" + canonical.call(refs, request), {
          read: () => listPage(request),
          value: page,
        });
        return parsePlatformBrandTemplateList({
          profile: "PlatformBrandTemplateListV1",
          ...fixed,
          ...request,
          ...page,
          ...time(),
        });
      });
    },
    save(raw: unknown) {
      const original = parsePlatformBrandTemplateSave(raw);
      return protect("Save", original, async () => {
        const found = await lookup(original);
        if (found) {
          if (found.outcome === "Abandoned") return fail("PLATFORM_TEMPLATE_VERSION_CONFLICT");
          return found;
        }
        const prior =
          original.templateReference === null ? null : await current(original.templateReference);
        if (
          original.expectedHead === null
            ? prior !== null
            : !prior ||
              prior.revision !== original.expectedHead.revision ||
              prior.templateVersionReference !== original.expectedHead.templateVersionReference ||
              prior.sourceDigest !== original.expectedHead.sourceDigest
        )
          return fail("PLATFORM_TEMPLATE_VERSION_CONFLICT");
        if (prior && prior.content.code !== original.content.code)
          return fail("PLATFORM_TEMPLATE_VERSION_CONFLICT");
        const duplicate = rows(
          await query(
            "SELECT template_id FROM bop_tenant.platform_brand_template_revision WHERE code=$1 AND ($2::uuid IS NULL OR template_id<>$2) LIMIT 1",
            [original.content.code, original.templateReference],
          ),
        );
        if (duplicate.length) return fail("PLATFORM_TEMPLATE_VERSION_CONFLICT");
        const templateReference =
          prior?.templateReference ?? parsePlatformTenantReference(next.call(refs, "Template"));
        check();
        const templateVersionReference = parsePlatformTenantReference(next.call(refs, "Version"));
        check();
        const auditReference = parsePlatformTenantReference(next.call(refs, "Audit")),
          occurredAt = check(),
          snapshot = createPlatformBrandTemplateRevision(
            {
              profile: "PlatformBrandTemplateRevisionV1",
              templateReference,
              templateVersionReference,
              revision: (prior?.revision ?? 0) + 1,
              recordKind: "AuthoredContent",
              content: original.content,
              supersedesVersionReference: prior?.templateVersionReference ?? null,
              authoredByReference: fixed.actorReference,
              operationReference: original.operationReference,
              auditReference,
              createdAt: prior?.createdAt ?? occurredAt,
              recordedAt: occurredAt,
              dataClassification: "ConfigurationMetadata",
            },
            codec,
          ),
          receipt = await append(original, snapshot, auditReference, occurredAt);
        heldReads.set("current:" + templateReference, {
          read: () => current(templateReference),
          value: snapshot,
        });
        return receipt;
      });
    },
    resolve(raw: unknown) {
      const original = parsePlatformBrandTemplateResolve(raw);
      return protect("Resolve", original, async () => {
        const found = await lookup(original);
        if (found) return found;
        const auditReference = parsePlatformTenantReference(next.call(refs, "Audit")),
          occurredAt = check();
        return append(original, null, auditReference, occurredAt);
      });
    },
    current(raw: unknown) {
      const r = record(raw, ["templateReference"]),
        template = stored(() => parsePlatformTenantReference(r.templateReference));
      return protect("Read", null, async () => {
        const value = await current(template);
        heldReads.set("current:" + template, { read: () => current(template), value });
        return parsePlatformBrandTemplateCurrent(
          {
            profile: "PlatformBrandTemplateCurrentV1",
            ...fixed,
            templateReference: template,
            current: value,
            ...time(),
          },
          codec,
        );
      });
    },
    exact(raw: unknown) {
      const r = record(raw, ["templateVersionReference"]),
        version = stored(() => parsePlatformTenantReference(r.templateVersionReference));
      return protect("Read", null, async () => {
        const value = await exact(version);
        heldReads.set("exact:" + version, { read: () => exact(version), value });
        return parsePlatformBrandTemplateExact(
          {
            profile: "PlatformBrandTemplateExactV1",
            ...fixed,
            templateVersionReference: version,
            snapshot: value,
            ...time(),
          },
          codec,
        );
      });
    },
    history(raw: unknown) {
      const r = record(raw, ["templateReference", "beforeRevision"]),
        template = stored(() => parsePlatformTenantReference(r.templateReference)),
        before = r.beforeRevision;
      if (
        before !== null &&
        (typeof before !== "number" ||
          !Number.isInteger(before) ||
          before < 1 ||
          before > 2147483647)
      )
        return fail("PLATFORM_TEMPLATE_INPUT_INVALID");
      return protect("Read", null, async () => {
        const value = await page(template, before);
        heldReads.set("history:" + template + ":" + before, {
          read: () => page(template, before),
          value,
        });
        return parsePlatformBrandTemplateHistory(
          {
            profile: "PlatformBrandTemplateHistoryV1",
            ...fixed,
            templateReference: template,
            beforeRevision: before,
            ...value,
            ...time(),
          },
          codec,
        );
      });
    },
    assertFinalized(): void {
      if (
        failed ||
        !unchanged() ||
        !registered ||
        !done ||
        guardCalls !== 1 ||
        finalCalls !== 1 ||
        phase !== "Final" ||
        active
      )
        return fail();
    },
  });
}
