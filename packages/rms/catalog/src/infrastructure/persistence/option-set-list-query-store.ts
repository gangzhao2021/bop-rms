import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogLocale,
  parseLocalizedNames,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  CatalogOptionSetListError,
  optionSetListFields,
  optionSetListRecord,
  optionSetListInteger,
  optionSetListBoolean,
  optionSetListLifecycle,
  optionSetListStyle,
  parseOptionSetListRequest,
  parseOptionSetListView,
  parseOptionSetListItem,
  type OptionSetListRequest,
  type OptionSetListItem,
  type OptionSetListView,
} from "../../contracts/option-set-list.js";
export interface OptionSetListTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Transaction = OptionSetListTransaction;
export interface OptionSetListAuthority {
  /** Actual session/selection/Brand/User/fine action/all searched fields, held
   * through this original READ COMMITTED read-write host's COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: Readonly<{
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
      actorKind: "User";
      permission: "catalog.manage";
      requiredPermissions: readonly ["catalog.manage", "catalog.option_set.read"];
      purposeCode: "CATALOG_OPTION_SET_LIST";
      capability: "catalog.cat_optionset_list";
      requiredFields: typeof optionSetListFields;
      request: OptionSetListRequest;
      observedAt: string;
    }>,
  ): Promise<Readonly<{ observedAt: string; validUntil: string }>>;
}
const permissions: readonly ["catalog.manage", "catalog.option_set.read"] = Object.freeze([
  "catalog.manage",
  "catalog.option_set.read",
]);
const fail = (code: CatalogOptionSetListError["code"] = "DependencyUnavailable"): never => {
  throw new CatalogOptionSetListError(code);
};
function sourceRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    return optionSetListRecord(value, keys);
  } catch {
    return fail();
  }
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Catalog source only. Keep search/filter metadata, not the potentially one-MiB
// complete Draft, in the generation. Missing Draft roots are retained and refused.
const sourceSql = `SELECT ${utc("statement_timestamp()")} "asOfUtc",coalesce(jsonb_agg(jsonb_build_object(
 'optionSetReference',s.option_set_id,'brandReference',s.brand_id,'internalCode',s.internal_code,'lifecycle',s.lifecycle,
 'aggregateVersion',s.aggregate_version,'createdAt',${utc("s.created_at")},'updatedAt',${utc("s.updated_at")},
 'draftVersionReference',v.option_set_version_id,'draftUpdatedAt',${utc("v.updated_at")},'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,
 'displayStyle',v.display_style,'minimumSelection',v.minimum_selection,'maximumSelection',v.maximum_selection,
 'allowRepeatedOption',v.allow_repeated_option,'perOptionMaximumQuantity',v.per_option_maximum_quantity,'maximumTotalQuantity',v.maximum_total_quantity,
 'options',coalesce((SELECT jsonb_agg(jsonb_build_object('optionReference',o.option_id,'stableCode',o.stable_code,'localizedNames',o.localized_names_json,'lifecycle',o.lifecycle) ORDER BY o.option_id)
 FROM rms_catalog.option o WHERE o.brand_id=s.brand_id AND o.option_set_id=s.option_set_id AND o.option_set_version_id=v.option_set_version_id),'[]'::jsonb),
 'productBindingCount',(SELECT count(*) FROM rms_catalog.product_option_binding b WHERE b.brand_id=s.brand_id AND b.option_set_id=s.option_set_id),
 'pricingPresent',CASE WHEN v.editor_content_json IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(v.editor_content_json->'optionDetails') d WHERE d->'pricingRule'<>'null'::jsonb) END,
 'consumptionPresent',CASE WHEN v.editor_content_json IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(v.editor_content_json->'optionDetails') d WHERE d->'consumption'<>'null'::jsonb) END,
 'conflictPresent',CASE WHEN EXISTS(SELECT 1 FROM rms_catalog.option_conflict c WHERE c.brand_id=s.brand_id AND c.option_set_id=s.option_set_id) THEN true WHEN v.editor_content_json IS NULL THEN NULL ELSE jsonb_array_length(v.editor_content_json->'conflictRules')>0 END,
 'coherent',v.option_set_version_id IS NOT NULL AND v.brand_id=s.brand_id AND v.status='Draft' AND (v.editor_content_json IS NULL OR (
 v.editor_content_json->>'profile'='CatalogOptionSetEditorContentV1' AND jsonb_typeof(v.editor_content_json->'optionDetails')='array'
 AND jsonb_typeof(v.editor_content_json->'conflictRules')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.editor_content_json->'optionDetails') d
 WHERE NOT(d ?& ARRAY['optionReference','pricingRule','consumption'])
 OR ((d->'pricingRule'='null'::jsonb OR (jsonb_typeof(d->'pricingRule')='object' AND d->'pricingRule' ?& ARRAY['reference','versionReference'] AND (d->'pricingRule')-ARRAY['reference','versionReference']='{}'::jsonb AND d#>>'{pricingRule,reference}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND d#>>'{pricingRule,versionReference}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) IS NOT TRUE)
 OR ((d->'consumption'='null'::jsonb OR (jsonb_typeof(d->'consumption')='object' AND d->'consumption' ?& ARRAY['kind','reference','versionReference','quantity','unitCode'] AND (d->'consumption')-ARRAY['kind','reference','versionReference','quantity','unitCode']='{}'::jsonb AND d#>>'{consumption,kind}' IN ('Inventory','Recipe') AND d#>>'{consumption,reference}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND d#>>'{consumption,versionReference}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND d#>>'{consumption,quantity}' ~ '^(0|[1-9][0-9]{0,13})([.][0-9]{1,6})?$' AND d#>>'{consumption,quantity}' ~ '[1-9]' AND d#>>'{consumption,unitCode}' ~ '^[A-Z][A-Z0-9_-]{0,63}$')) IS NOT TRUE)
 OR NOT EXISTS(SELECT 1 FROM rms_catalog.option o WHERE o.option_id::text=d->>'optionReference' AND o.option_set_version_id=v.option_set_version_id AND o.brand_id=s.brand_id))
 AND jsonb_array_length(v.editor_content_json->'optionDetails')=(SELECT count(*) FROM rms_catalog.option o WHERE o.option_set_version_id=v.option_set_version_id AND o.brand_id=s.brand_id) AND jsonb_array_length(v.editor_content_json->'optionDetails')=(SELECT count(DISTINCT d->>'optionReference') FROM jsonb_array_elements(v.editor_content_json->'optionDetails') d)))) ORDER BY s.option_set_id),'[]'::jsonb) items
 FROM rms_catalog.option_set s LEFT JOIN rms_catalog.option_set_version v ON v.option_set_id=s.option_set_id AND v.brand_id=s.brand_id AND v.status='Draft' WHERE s.brand_id=$1`;
interface Source {
  readonly item: OptionSetListItem;
  readonly defaultLocale: string;
  readonly names: Readonly<Record<string, string>>;
  readonly options: readonly {
    readonly optionReference: string;
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
    readonly lifecycle: string;
  }[];
  readonly draftUpdatedAt: string;
}
const presence = (value: unknown) =>
  value === null
    ? Object.freeze({ status: "Unknown" as const })
    : Object.freeze({ status: "Known" as const, present: optionSetListBoolean(value) });
function parseSource(value: unknown, brand: string, locale: string, asOf: string): Source {
  const r = sourceRecord(value, [
    "optionSetReference",
    "brandReference",
    "internalCode",
    "lifecycle",
    "aggregateVersion",
    "createdAt",
    "updatedAt",
    "draftVersionReference",
    "draftUpdatedAt",
    "defaultLocale",
    "localizedNames",
    "displayStyle",
    "minimumSelection",
    "maximumSelection",
    "allowRepeatedOption",
    "perOptionMaximumQuantity",
    "maximumTotalQuantity",
    "options",
    "productBindingCount",
    "pricingPresent",
    "consumptionPresent",
    "conflictPresent",
    "coherent",
  ]);
  if (
    r.coherent !== true ||
    parseCatalogReference(r.brandReference) !== brand ||
    !Array.isArray(r.options) ||
    r.options.length > 100
  )
    return fail();
  const defaultLocale = parseCatalogLocale(r.defaultLocale),
    names = parseLocalizedNames(r.localizedNames, defaultLocale),
    draftUpdatedAt = parseCatalogInstant(r.draftUpdatedAt);
  if (
    canonicalizeRfc8785(names) !== canonicalizeRfc8785(r.localizedNames) ||
    parseCatalogCode(r.internalCode) !== r.internalCode
  )
    return fail();
  const options = r.options.map((value) => {
    const o = sourceRecord(value, ["optionReference", "stableCode", "localizedNames", "lifecycle"]);
    if (
      o.lifecycle !== "Draft" &&
      o.lifecycle !== "Active" &&
      o.lifecycle !== "Inactive" &&
      o.lifecycle !== "Archived"
    )
      return fail();
    if (
      !o.localizedNames ||
      typeof o.localizedNames !== "object" ||
      Array.isArray(o.localizedNames)
    )
      return fail();
    const actualLocale = Object.keys(o.localizedNames)[0];
    if (actualLocale === undefined) return fail();
    const optionNames = parseLocalizedNames(o.localizedNames, actualLocale);
    if (
      canonicalizeRfc8785(optionNames) !== canonicalizeRfc8785(o.localizedNames) ||
      parseCatalogCode(o.stableCode) !== o.stableCode
    )
      return fail();
    return Object.freeze({
      optionReference: parseCatalogReference(o.optionReference),
      code: parseCatalogCode(o.stableCode),
      names: optionNames,
      lifecycle: o.lifecycle,
    });
  });
  if (
    new Set(options.map((o) => o.optionReference)).size !== options.length ||
    new Set(options.map((o) => o.code)).size !== options.length
  )
    return fail();
  const chosen = Object.hasOwn(names, locale) ? locale : defaultLocale;
  const item = parseOptionSetListItem({
    optionSetReference: parseCatalogReference(r.optionSetReference),
    internalCode: parseCatalogCode(r.internalCode),
    lifecycle: optionSetListLifecycle(r.lifecycle),
    aggregateVersion: optionSetListInteger(r.aggregateVersion, 1),
    draftVersionReference: parseCatalogReference(r.draftVersionReference),
    createdAt: parseCatalogInstant(r.createdAt),
    updatedAt: parseCatalogInstant(r.updatedAt),
    name: names[chosen],
    nameLocale: chosen,
    localeFallback: chosen !== locale,
    selectionRule: {
      displayStyle: optionSetListStyle(r.displayStyle),
      minimumSelection: r.minimumSelection,
      maximumSelection: r.maximumSelection,
      allowRepeatedOption: r.allowRepeatedOption,
      perOptionMaximumQuantity: r.perOptionMaximumQuantity,
      maximumTotalQuantity: r.maximumTotalQuantity,
    },
    optionCount: options.length,
    activeOptionCount: options.filter((o) => o.lifecycle === "Active").length,
    productBindingCount: optionSetListInteger(r.productBindingCount),
    recordedPricingReference: presence(r.pricingPresent),
    recordedConsumptionReference: presence(r.consumptionPresent),
    recordedConflict: presence(r.conflictPresent),
    publishingStatus: { status: "Unavailable" },
    referenceEligibility: "NotEvaluated",
  });
  if (
    item.updatedAt > asOf ||
    item.createdAt > asOf ||
    draftUpdatedAt > asOf ||
    draftUpdatedAt > item.updatedAt
  )
    return fail();
  return Object.freeze({
    item,
    defaultLocale,
    names,
    options: Object.freeze(options),
    draftUpdatedAt,
  });
}
function source(value: unknown, brand: string, locale: string, asOf: string): Source {
  try {
    return parseSource(value, brand, locale, asOf);
  } catch {
    return fail();
  }
}
function resultRows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  const rows = copyCategoryPersistenceValue(descriptor.value);
  if (!Array.isArray(rows)) return fail();
  return rows;
}
const compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
/** Live Catalog Read Model, partial authoring coverage only. Recorded references
 * are not Pricing/Inventory readiness; binding count is recorded Catalog bindings,
 * never current Published/Active Product eligibility. No source writes or cache. */
export function createPostgresOptionSetListQueryStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly cursorKey: Uint8Array;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: OptionSetListAuthority;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
}) {
  const scope = Object.freeze({
    tenantReference: parseCatalogReference(options.tenantReference),
    brandReference: parseCatalogReference(options.brandReference),
    storeReference: parseCatalogReference(options.storeReference),
    actorReference: parseCatalogReference(options.actorReference),
  });
  if (
    !(options.cursorKey instanceof Uint8Array) ||
    options.cursorKey.length < 32 ||
    options.cursorKey.length > 64 ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail("Invalid");
  const key = createHash("sha256")
      .update("catalog.option-set-list.key.v1\0")
      .update(new Uint8Array(options.cursorKey))
      .digest(),
    aad = Buffer.from("CatalogOptionSetListCursorV1"),
    now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  const encrypt = (value: unknown) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(canonicalizeRfc8785(value), "utf8"),
      cipher.final(),
    ]);
    return "os1." + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  };
  const decrypt = (value: string) => {
    try {
      if (!value.startsWith("os1.")) return fail("Invalid");
      const encoded = value.slice(4),
        bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded || bytes.length < 29) return fail("Invalid");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(aad);
      cipher.setAuthTag(bytes.subarray(12, 28));
      return optionSetListRecord(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"),
        ),
        ["profile", "binding", "sourceGeneration", "issuedAt", "reference"],
      );
    } catch {
      return fail("Invalid");
    }
  };
  let active = false,
    reentered = false,
    pending = false;
  const finalAssertions = new WeakMap<object, () => void>();
  async function execute(
    value: unknown,
    suppliedTransaction?: Transaction,
  ): Promise<OptionSetListView> {
    const request = parseOptionSetListRequest(value);
    if (active || pending) {
      reentered = true;
      return fail();
    }
    active = true;
    pending = true;
    reentered = false;
    const { cursor, ...filters } = request,
      binding = hash({
        profile: "CatalogOptionSetListBindingV1",
        scope,
        purposeCode: "CATALOG_OPTION_SET_LIST",
        fields: optionSetListFields,
        filters,
      });
    let calls = 0,
      ready = false,
      failed = false,
      guardStarted = false,
      guardCompleted = false,
      finalized = false,
      txRef: Transaction | undefined,
      queryRef: Transaction["query"] | undefined,
      latest = parseCatalogInstant(now()),
      deadline = originalDeadline;
    const startedAt = latest;
    const poison = (): never => {
      failed = true;
      return fail();
    };
    const check = () => {
      const at = parseCatalogInstant(now());
      if (
        failed ||
        reentered ||
        at < latest ||
        at >= deadline ||
        !txRef ||
        Object.getOwnPropertyDescriptor(txRef, "query")?.value !== queryRef
      )
        return poison();
      latest = at;
      return at;
    };
    const authorize = async () => {
      if (!txRef) return poison();
      const observedAt = check();
      const raw = sourceRecord(
        copyCategoryPersistenceValue(
          await hold(txRef, {
            ...scope,
            actorKind: "User",
            permission: "catalog.manage",
            requiredPermissions: permissions,
            purposeCode: "CATALOG_OPTION_SET_LIST",
            capability: "catalog.cat_optionset_list",
            requiredFields: optionSetListFields,
            request,
            observedAt,
          }),
        ),
        ["observedAt", "validUntil"],
      );
      if (raw.observedAt !== observedAt) return poison();
      const until = parseCatalogInstant(raw.validUntil);
      if (until <= observedAt) return poison();
      if (until < deadline) deadline = until;
      check();
    };
    try {
      if (deadline <= latest || Date.parse(deadline) - Date.parse(latest) > 5000) return poison();
      const work = async (tx: Transaction): Promise<OptionSetListView> => {
        if (++calls !== 1 || finalized) return poison();
        txRef = tx;
        const descriptor = Object.getOwnPropertyDescriptor(tx, "query");
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
          return poison();
        queryRef = tx.query;
        finalAssertions.set(tx, () => {
          if (!finalized || failed || !guardCompleted) return poison();
          check();
        });
        const query = async (sql: string, values: readonly unknown[] = []) => {
          check();
          try {
            const result = await queryRef?.call(tx, sql, values);
            check();
            return result;
          } catch (error) {
            failed = true;
            throw error;
          }
        };
        const registered = await register(
          tx,
          async () => {
            if (!ready || guardStarted || finalized) return poison();
            guardStarted = true;
            try {
              await authorize();
              guardCompleted = true;
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          () => {
            if (!ready || !guardStarted || !guardCompleted || finalized) return poison();
            check();
            finalized = true;
            pending = false;
          },
        );
        if (registered !== undefined) return poison();
        await authorize();
        if (request.publishingStatus !== null) return fail();
        const remaining = Date.parse(deadline) - Date.parse(check());
        if (remaining <= 0) return poison();
        await query(
          "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('bop.tenant_id',$2,true),set_config('bop.brand_id',$3,true),set_config('bop.store_id','',true)",
          [String(remaining), scope.tenantReference, scope.brandReference],
        );
        const isolation = resultRows(
          await query(
            "SELECT current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off' compatible",
          ),
        );
        if (
          isolation.length !== 1 ||
          sourceRecord(isolation[0], ["compatible"]).compatible !== true
        )
          return poison();
        // PostgreSQL SHARE requires owning table lock ACL; no grant is created here.
        await query(
          "LOCK TABLE rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.product_option_binding IN SHARE MODE",
        );
        const selected = resultRows(await query(sourceSql, [scope.brandReference]));
        if (selected.length !== 1) return poison();
        const packet = sourceRecord(selected[0], ["asOfUtc", "items"]),
          asOf = parseCatalogInstant(packet.asOfUtc);
        if (!Array.isArray(packet.items) || asOf > check() || asOf < startedAt) return poison();
        const sources = packet.items.map((v) =>
          source(v, scope.brandReference, request.locale, asOf),
        );
        if (new Set(sources.map((s) => s.item.optionSetReference)).size !== sources.length)
          return poison();
        sources.sort((a, b) => compare(a.item.optionSetReference, b.item.optionSetReference));
        const generation = hash({
          profile: "CatalogOptionSetListSourceV1",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          sources,
        });
        let after: string | null = null,
          issuedAt = asOf;
        if (cursor !== null) {
          const token = decrypt(cursor);
          if (token.profile !== "CatalogOptionSetListCursorV1" || token.binding !== binding)
            return fail("Invalid");
          issuedAt = parseCatalogInstant(token.issuedAt);
          if (
            issuedAt > asOf ||
            Date.parse(asOf) - Date.parse(issuedAt) > 300000 ||
            token.sourceGeneration !== generation
          )
            return fail("Stale");
          after = parseCatalogReference(token.reference);
        }
        const queryText = request.search?.toLocaleLowerCase("und") ?? null;
        const matched = sources.filter((s) => {
          const i = s.item;
          if (
            (!request.includeArchived && i.lifecycle === "Archived") ||
            (request.lifecycle !== null && i.lifecycle !== request.lifecycle) ||
            (request.selectionType !== null &&
              i.selectionRule.displayStyle !== request.selectionType) ||
            (request.hasProductBinding !== null &&
              request.hasProductBinding !== i.productBindingCount > 0) ||
            (request.missingTranslationLocale !== null &&
              Object.hasOwn(s.names, request.missingTranslationLocale))
          )
            return false;
          if (
            queryText !== null &&
            ![
              i.internalCode,
              ...Object.values(s.names),
              ...s.options.flatMap((o) => [o.code, ...Object.values(o.names)]),
            ].some((v) => v.toLocaleLowerCase("und").includes(queryText))
          )
            return false;
          for (const [filter, presence] of [
            [request.hasPricingReference, i.recordedPricingReference],
            [request.hasConsumptionReference, i.recordedConsumptionReference],
            [request.hasConflict, i.recordedConflict],
          ] as const) {
            if (filter !== null) {
              if (presence.status !== "Known") return fail();
              if (presence.present !== filter) return false;
            }
          }
          return true;
        });
        const priority = (s: Source) =>
          queryText !== null &&
          (s.item.internalCode.toLocaleLowerCase("und") === queryText ||
            s.options.some((o) => o.code.toLocaleLowerCase("und") === queryText))
            ? 0
            : 1;
        matched.sort(
          (a, b) =>
            priority(a) - priority(b) ||
            (request.direction === "ASC" ? 1 : -1) *
              compare(a.item[request.sort], b.item[request.sort]) ||
            compare(a.item.optionSetReference, b.item.optionSetReference),
        );
        let offset = 0;
        if (after !== null) {
          const index = matched.findIndex((s) => s.item.optionSetReference === after);
          if (index < 0) return fail("Stale");
          offset = index + 1;
        }
        const page = matched.slice(offset, offset + request.limit + 1),
          hasMore = page.length > request.limit,
          last = page[request.limit - 1];
        const nextCursor =
          hasMore && last
            ? encrypt({
                profile: "CatalogOptionSetListCursorV1",
                binding,
                sourceGeneration: generation,
                issuedAt,
                reference: last.item.optionSetReference,
              })
            : null;
        await authorize();
        check();
        ready = true;
        return parseOptionSetListView({
          projection: {
            name: "catalog_option_set_search_v1",
            version: 1,
            asOfUtc: asOf,
            stale: false,
            partial: true,
            sourceGeneration: generation,
          },
          scope,
          locale: request.locale,
          items: page.slice(0, request.limit).map((s) => s.item),
          hasMore,
          nextCursor,
        });
      };
      const result =
        suppliedTransaction === undefined ? await run(work) : await work(suppliedTransaction);
      if (
        calls !== 1 ||
        !ready ||
        failed ||
        (suppliedTransaction === undefined && (!guardCompleted || !finalized))
      )
        return poison();
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogOptionSetListError) throw error;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
        return fail("Denied");
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    load: (value: unknown) => execute(value),
    /** Tentative read only. The actual original outer host must run the registered
     * async guard, final assertion and COMMIT before returning this view to a client. */
    loadInTransaction: (tx: Transaction, value: unknown) => execute(value, tx),
    /** Assert only this store's exact original host after its real COMMIT. */
    assertFinalized: (tx: Transaction) => {
      const assert = finalAssertions.get(tx);
      if (!assert) return fail();
      assert();
    },
  });
}
