/**
 * WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): one kitchen screen, each dish marked
 * with the kitchen section (档口) that makes it, the screen filtered by section (2000_127). The
 * owner names the Store's sections (a versioned list) and marks each dish; a dish with no section
 * is shown as "no section". Caller authorizes and owns the transaction.
 */
interface SectionTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const sectionName = /^[^\p{Cc}\p{Cf}<>{}$]{1,24}$/u;
export class KitchenSectionError extends Error {
  constructor(
    readonly code:
      | "KITCHEN_SECTION_INPUT_INVALID"
      /** Another change came first, or the operation was reused for another change. */
      | "KITCHEN_SECTION_CHANGED"
      /** The dish's section is not one of the Store's sections now. */
      | "KITCHEN_SECTION_UNKNOWN"
      | "KITCHEN_SECTION_UNAVAILABLE",
  ) {
    super(code);
    this.name = "KitchenSectionError";
  }
}
const invalid = (): never => {
  throw new KitchenSectionError("KITCHEN_SECTION_INPUT_INVALID");
};
const reference = (value: string): string => (uuid.test(value) ? value : invalid());
const at = (value: string): string =>
  instant.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid();
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const context = async (tx: SectionTransaction, scope: Scope) => {
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { brand, store };
};

export interface KitchenSection {
  readonly sectionReference: string;
  readonly name: string;
}
export interface KitchenSectionList {
  /** 0: never set (no sections). */
  readonly version: number;
  readonly sections: readonly KitchenSection[];
}
const parseSections = (value: unknown): readonly KitchenSection[] => {
  if (!Array.isArray(value) || value.length > 12) return invalid();
  const sections = value.map((entry: unknown) => {
    const raw = entry as Record<string, unknown> | null;
    if (
      raw === null ||
      typeof raw !== "object" ||
      Object.keys(raw).sort().join(",") !== "name,sectionReference" ||
      typeof raw.sectionReference !== "string" ||
      typeof raw.name !== "string" ||
      !sectionName.test(raw.name) ||
      raw.name.trim() !== raw.name
    )
      return invalid();
    return Object.freeze({ sectionReference: reference(raw.sectionReference), name: raw.name });
  });
  if (
    new Set(sections.map((s) => s.name)).size !== sections.length ||
    new Set(sections.map((s) => s.sectionReference)).size !== sections.length
  )
    return invalid();
  return Object.freeze(sections);
};

/** The Store's kitchen sections now (none until the owner names one). */
export async function loadKitchenSections(
  tx: SectionTransaction,
  scope: Scope,
): Promise<KitchenSectionList> {
  const { brand, store } = await context(tx, scope);
  const row = (
    await tx.query<Record<string, unknown>>(
      "SELECT version,sections FROM rms_kitchen.kitchen_section_list WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [brand, store],
    )
  ).rows[0];
  if (row === undefined) return Object.freeze({ version: 0, sections: Object.freeze([]) });
  try {
    return Object.freeze({ version: Number(row.version), sections: parseSections(row.sections) });
  } catch {
    throw new KitchenSectionError("KITCHEN_SECTION_UNAVAILABLE");
  }
}

/**
 * The owner names the Store's sections (at most 12, names unique): the next version, against the
 * version they saw. A section keeps its reference when renamed, so dishes keep it. The same
 * operation again returns what it recorded.
 */
export async function changeKitchenSections(
  tx: SectionTransaction,
  scope: Scope & { readonly tenantReference: string },
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly sections: readonly KitchenSection[];
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<KitchenSectionList> {
  const { brand, store } = await context(tx, scope);
  const operation = reference(input.operationReference);
  const sections = parseSections(input.sections);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return invalid();
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `KitchenSections:${brand}:${store}`,
  ]);
  const prior = (
    await tx.query<Record<string, unknown>>(
      "SELECT version,sections FROM rms_kitchen.kitchen_section_list WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (JSON.stringify(parseSections(prior.sections)) !== JSON.stringify(sections))
      throw new KitchenSectionError("KITCHEN_SECTION_CHANGED");
    return Object.freeze({ version: Number(prior.version), sections });
  }
  const current = await loadKitchenSections(tx, scope);
  if (current.version !== input.expectedVersion)
    throw new KitchenSectionError("KITCHEN_SECTION_CHANGED");
  const version = current.version + 1;
  const inserted = await tx.query(
    "INSERT INTO rms_kitchen.kitchen_section_list (tenant_id,brand_id,store_id,version,operation_id,sections,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
    [
      reference(scope.tenantReference),
      brand,
      store,
      version,
      operation,
      JSON.stringify(sections),
      reference(input.actorReference),
      at(input.observedAt),
    ],
  );
  if (inserted.rowCount !== 1) throw new KitchenSectionError("KITCHEN_SECTION_UNAVAILABLE");
  return Object.freeze({ version, sections });
}

/** Each of these dishes' section mark now (absent: never marked), with the mark's version. */
export async function loadKitchenProductSections(
  tx: SectionTransaction,
  scope: Scope,
  productReferences: readonly string[],
): Promise<
  ReadonlyMap<string, { readonly sectionReference: string | null; readonly version: number }>
> {
  const { brand, store } = await context(tx, scope);
  const products = productReferences.map(reference);
  const found = new Map<string, { sectionReference: string | null; version: number }>();
  if (products.length === 0) return found;
  const { rows } = await tx.query<Record<string, unknown>>(
    "SELECT DISTINCT ON (product_id) product_id::text AS product,version,section_id::text AS section FROM rms_kitchen.kitchen_product_section WHERE brand_id=$1 AND store_id=$2 AND product_id=ANY($3::uuid[]) ORDER BY product_id,version DESC",
    [brand, store, products],
  );
  for (const row of rows) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new KitchenSectionError("KITCHEN_SECTION_UNAVAILABLE");
    found.set(
      String(row.product),
      Object.freeze({
        sectionReference: row.section === null ? null : String(row.section),
        version,
      }),
    );
  }
  return found;
}

/**
 * The owner marks a dish with one of the Store's sections (or none): the dish's next version, with
 * who and when, against the version they saw (0: never marked). The same operation again returns
 * what it recorded.
 */
export async function changeKitchenProductSection(
  tx: SectionTransaction,
  scope: Scope & { readonly tenantReference: string },
  input: {
    readonly productReference: string;
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly sectionReference: string | null;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<{ readonly sectionReference: string | null; readonly version: number }> {
  const { brand, store } = await context(tx, scope);
  const product = reference(input.productReference);
  const operation = reference(input.operationReference);
  const section = input.sectionReference === null ? null : reference(input.sectionReference);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return invalid();
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `KitchenProductSection:${brand}:${store}:${product}`,
  ]);
  const prior = (
    await tx.query<Record<string, unknown>>(
      "SELECT product_id::text AS product,section_id::text AS section,version FROM rms_kitchen.kitchen_product_section WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (String(prior.product) !== product || (prior.section ?? null) !== section)
      throw new KitchenSectionError("KITCHEN_SECTION_CHANGED");
    return Object.freeze({ sectionReference: section, version: Number(prior.version) });
  }
  const current = (await loadKitchenProductSections(tx, scope, [product])).get(product);
  if ((current?.version ?? 0) !== input.expectedVersion)
    throw new KitchenSectionError("KITCHEN_SECTION_CHANGED");
  if (
    section !== null &&
    !(await loadKitchenSections(tx, scope)).sections.some((s) => s.sectionReference === section)
  )
    throw new KitchenSectionError("KITCHEN_SECTION_UNKNOWN");
  if ((current?.sectionReference ?? null) === section)
    return current ?? Object.freeze({ sectionReference: null, version: 0 });
  const version = (current?.version ?? 0) + 1;
  const inserted = await tx.query(
    "INSERT INTO rms_kitchen.kitchen_product_section (tenant_id,brand_id,store_id,product_id,version,operation_id,section_id,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      reference(scope.tenantReference),
      brand,
      store,
      product,
      version,
      operation,
      section,
      reference(input.actorReference),
      at(input.observedAt),
    ],
  );
  if (inserted.rowCount !== 1) throw new KitchenSectionError("KITCHEN_SECTION_UNAVAILABLE");
  return Object.freeze({ sectionReference: section, version });
}

/**
 * The section of each of these kitchen work items' dishes, by its name now (null: the dish has no
 * section, or its section was removed from the Store's list). Items not found are absent.
 */
export async function listKitchenWorkItemSections(
  tx: SectionTransaction,
  scope: Scope,
  workItemReferences: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  const { brand, store } = await context(tx, scope);
  const items = workItemReferences.map(reference);
  const found = new Map<string, string | null>();
  if (items.length === 0) return found;
  const sections = new Map(
    (await loadKitchenSections(tx, scope)).sections.map((s) => [s.sectionReference, s.name]),
  );
  const { rows } = await tx.query<Record<string, unknown>>(
    "SELECT w.kitchen_work_item_id::text AS item,(SELECT p.section_id::text FROM rms_kitchen.kitchen_product_section p WHERE p.brand_id=w.brand_id AND p.store_id=w.store_id AND p.product_id=w.product_id ORDER BY p.version DESC LIMIT 1) AS section FROM rms_kitchen.kitchen_work_item w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.kitchen_work_item_id=ANY($3::uuid[])",
    [brand, store, items],
  );
  for (const row of rows)
    found.set(
      String(row.item),
      row.section === null ? null : (sections.get(String(row.section)) ?? null),
    );
  return found;
}
