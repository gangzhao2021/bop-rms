import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  buildProductOptionPriceContextSnapshot,
  parseProductOptionPriceContextSnapshot,
  parseProductOptionPriceContextRequest,
  type ProductOptionPriceContextRequest,
  type ProductOptionPriceContextSnapshot,
} from "../../contracts/product-option-price-context-source.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction as Transaction,
} from "./product-lifecycle-store.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
export const productOptionPriceContextSourceFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "productVersionReference",
  "binding",
  "optionRule",
  "skuReference",
  "skuCode",
  "skuLifecycle",
  "skuLocalizedNames",
  "defaultLocale",
  "productSnapshotDigest",
  "aggregateDigest",
  "contentDigest",
  "configurationDigest",
] as const);
export interface ProductOptionPriceContextSourceStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: Readonly<{
        tenantReference: string;
        brandReference: string;
        actorReference: string;
        actorKind: "User";
        productReference: string;
        request: ProductOptionPriceContextRequest;
        permission: "catalog.manage";
        owningAction: "catalog.product.read";
        purposeCode: "CATALOG_PRODUCT_OPTION_PRICE_CONTEXT_READ";
        requiredFields: typeof productOptionPriceContextSourceFields;
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<{ readonly validUntil: string }>;
  };
}
/** Same owning Product barrier, narrow read authority. The real outer host executes
 * both guards; borrowed runner return is not COMMIT. No Category/Edit qualification. */
export function createPostgresProductOptionPriceContextSourceStore(
  options: ProductOptionPriceContextSourceStoreOptions,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    origin = parseCatalogInstant(options.originalObservedAt),
    originalUntil = parseCatalogInstant(options.originalValidUntil);
  const clockObject = options.clock,
    transactionsObject = options.transactions,
    authorityObject = options.authority;
  const nowPort = options.clock.now,
    runPort = options.transactions.run,
    holdPort = options.authority.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit;
  const fail = (
    code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new CatalogError(code);
  };
  let failed = false,
    active = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0,
    deadline = originalUntil,
    lastObserved = origin;
  let actualTx: Transaction | undefined,
    queryPort: Transaction["query"] | undefined,
    originalRequest: ProductOptionPriceContextRequest | undefined,
    baseline: ProductOptionPriceContextSnapshot | undefined;
  if (
    [nowPort, runPort, holdPort, registerPort].some((p) => typeof p !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  const now = nowPort.bind(options.clock),
    run = runPort.bind(options.transactions),
    hold = holdPort.bind(options.authority),
    register = registerPort.bind(options);
  const check = () => {
    if (
      failed ||
      options.clock !== clockObject ||
      options.transactions !== transactionsObject ||
      options.authority !== authorityObject ||
      options.clock.now !== nowPort ||
      options.transactions.run !== runPort ||
      options.authority.holdUntilTransactionCompletes !== holdPort ||
      options.registerBeforeCommit !== registerPort ||
      (actualTx && actualTx.query !== queryPort)
    )
      return fail();
    const at = parseCatalogInstant(now());
    if (at < lastObserved || at >= deadline) return fail();
    lastObserved = at;
    return at;
  };
  const authorize = async (tx: Transaction, request: ProductOptionPriceContextRequest) => {
    const observedAt = check();
    const raw = await hold(
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        productReference: request.productReference,
        request,
        permission: "catalog.manage",
        owningAction: "catalog.product.read",
        purposeCode: "CATALOG_PRODUCT_OPTION_PRICE_CONTEXT_READ",
        requiredFields: productOptionPriceContextSourceFields,
        observedAt,
        validUntil: deadline,
      }),
    );
    const value = copyCategoryPersistenceValue(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 1 ||
      !Object.hasOwn(value, "validUntil")
    )
      return fail();
    const lease = parseCatalogInstant(Object.getOwnPropertyDescriptor(value, "validUntil")?.value);
    if (lease < deadline) deadline = lease;
    check();
  };
  const query = async <Row = Record<string, unknown>>(
    tx: Transaction,
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount?: number | null }> => {
    const at = check(),
      remaining = String(Math.max(1, Date.parse(deadline) - Date.parse(at)));
    const original = queryPort;
    if (!original) return fail();
    await original.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remaining],
    );
    check();
    const result = (await original.call(tx, sql, values)) as {
      rows: readonly Row[];
      rowCount?: number | null;
    };
    check();
    return result;
  };
  const read = async (tx: Transaction, request: ProductOptionPriceContextRequest) => {
    await authorize(tx, request);
    await query(
      tx,
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [tenant, brand],
    );
    const isolation = await query<{ isolation: string }>(
      tx,
      "SELECT current_setting('transaction_isolation') AS isolation",
      [],
    );
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== "read committed")
      return fail();
    await holdProductSourceBarrier({ query: (sql, values) => query(tx, sql, values) }, brand);
    const result = await query<{ snapshot: unknown; precise: boolean }>(
      tx,
      productSnapshotSelectSql,
      [brand, request.productReference],
    );
    const rows = copyCategoryPersistenceValue(
      Object.getOwnPropertyDescriptor(result, "rows")?.value,
    );
    if (!Array.isArray(rows) || rows.length !== 1) return fail("CATALOG_VERSION_CONFLICT");
    const row = rows[0];
    if (
      !row ||
      typeof row !== "object" ||
      Reflect.ownKeys(row).length !== 2 ||
      Object.getOwnPropertyDescriptor(row, "precise")?.value !== true
    )
      return fail();
    const packet = buildProductOptionPriceContextSnapshot(
      Object.getOwnPropertyDescriptor(row, "snapshot")?.value,
      { tenantReference: tenant, brandReference: brand, actorReference: actor },
      request,
      check(),
      deadline,
    );
    if (baseline && packet.aggregateDigest !== baseline.aggregateDigest)
      return fail("CATALOG_VERSION_CONFLICT");
    await authorize(tx, request);
    return parseProductOptionPriceContextSnapshot({ ...packet, validUntil: deadline });
  };
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: ProductOptionPriceContextRequest,
      work: (snapshot: ProductOptionPriceContextSnapshot, tx: Transaction) => Promise<T>,
    ): Promise<T> {
      try {
        check();
        if (active || phase !== "Work" || typeof work !== "function") return fail();
        active = true;
        const request = parseProductOptionPriceContextRequest(input);
        if (originalRequest && JSON.stringify(request) !== JSON.stringify(originalRequest))
          return fail();
        originalRequest = request;
        let calls = 0,
          completed: { value: T } | undefined;
        const result = await run(async (tx) => {
          if (++calls !== 1 || (actualTx && actualTx !== tx)) return fail();
          if (!actualTx) {
            actualTx = tx;
            queryPort = tx.query;
            if (typeof queryPort !== "function") return fail();
            const registration = await register(
              tx,
              async () => {
                try {
                  if (
                    ++guardCalls !== 1 ||
                    active ||
                    phase !== "Work" ||
                    !baseline ||
                    !originalRequest
                  )
                    return fail();
                  phase = "Checks";
                  await read(tx, originalRequest);
                  check();
                  guardComplete = true;
                } catch (error) {
                  failed = true;
                  throw error;
                }
              },
              () => {
                if (
                  ++finalCalls !== 1 ||
                  guardCalls !== 1 ||
                  !guardComplete ||
                  active ||
                  phase !== "Checks"
                )
                  return fail();
                check();
                phase = "Final";
              },
            );
            if (registration !== undefined) return fail();
            check();
          }
          const packet = await read(tx, request);
          baseline ??= packet;
          completed = { value: await work(packet, tx) };
          await read(tx, request);
          check();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        active = false;
        return completed.value;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
    assertFinalized(tx: Transaction): string {
      if (
        tx !== actualTx ||
        phase !== "Final" ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1 ||
        active
      )
        return fail();
      check();
      return deadline;
    },
  });
}
