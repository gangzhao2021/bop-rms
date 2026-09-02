export type MenuLifecycle =
  "Draft" | "InReview" | "Approved" | "Published" | "Superseded" | "Archived";

export interface MenuSummary {
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly internalCode: string;
  readonly name: string;
  readonly lifecycle: MenuLifecycle;
  readonly version: number;
  readonly updatedAt: string;
}

export interface MenuListView {
  readonly screenId: "CAT-MENU-LIST";
  readonly asOfUtc: string;
  readonly items: readonly MenuSummary[];
  readonly nextCursor: string | null;
}

export interface MenuBuilderView {
  readonly screenId: "CAT-MENU-BUILDER";
  readonly menuReference: string;
  readonly menuVersionReference: string;
  readonly internalCode: string;
  readonly name: string;
  readonly lifecycle: MenuLifecycle;
  readonly version: number;
  readonly asOfUtc: string;
  readonly scopeSummary: string;
  readonly channelSummary: string;
  readonly sections: readonly {
    readonly sectionReference: string;
    readonly name: string;
    readonly placementCount: number;
    readonly validation: "Valid" | "Invalid" | "Unavailable";
  }[];
  readonly unresolvedIssueCount: number;
  readonly publishEvidence: "Required" | "Satisfied";
}

export interface CatalogMenuClient {
  listMenus(): Promise<unknown>;
  loadBuilder(menuReference: string): Promise<unknown>;
}

export class CatalogMenuClientError extends Error {
  readonly code: "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "Unavailable";

  constructor(code: CatalogMenuClientError["code"]) {
    super("Catalog menu administration is unavailable");
    this.name = "CatalogMenuClientError";
    this.code = code;
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CODE = /^[A-Z][A-Z0-9_-]{0,62}$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const LIFECYCLES: readonly MenuLifecycle[] = [
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Superseded",
  "Archived",
];

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("CATALOG_MENU_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("CATALOG_MENU_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("CATALOG_MENU_INVALID");
  return value;
}

export function parseMenuRouteReference(value: unknown): string {
  return reference(value);
}

function text(value: unknown, code = false): string {
  if (typeof value !== "string" || !(code ? CODE : SAFE_TEXT).test(value))
    throw new Error("CATALOG_MENU_INVALID");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !INSTANT.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("CATALOG_MENU_INVALID");
  return value;
}

function positive(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1))
    throw new Error("CATALOG_MENU_INVALID");
  return value as number;
}

function lifecycle(value: unknown): MenuLifecycle {
  if (!LIFECYCLES.includes(value as MenuLifecycle)) throw new Error("CATALOG_MENU_INVALID");
  return value as MenuLifecycle;
}

function summary(value: unknown): MenuSummary {
  const input = closed(value, [
    "menuReference",
    "menuVersionReference",
    "internalCode",
    "name",
    "lifecycle",
    "version",
    "updatedAt",
  ]);
  return Object.freeze({
    menuReference: reference(input.menuReference),
    menuVersionReference: reference(input.menuVersionReference),
    internalCode: text(input.internalCode, true),
    name: text(input.name),
    lifecycle: lifecycle(input.lifecycle),
    version: positive(input.version),
    updatedAt: instant(input.updatedAt),
  });
}

export function parseMenuListView(value: unknown): MenuListView {
  const input = closed(value, ["schemaVersion", "projection", "items", "nextCursor"]);
  const projection = closed(input.projection, ["name", "version", "asOfUtc", "stale", "partial"]);
  if (
    input.schemaVersion !== 1 ||
    projection.name !== "catalog_menu_management_v1" ||
    projection.version !== 1 ||
    projection.stale !== false ||
    projection.partial !== false ||
    !Array.isArray(input.items) ||
    input.items.length > 100 ||
    (input.nextCursor !== null &&
      (typeof input.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.nextCursor)))
  )
    throw new Error("CATALOG_MENU_INVALID");
  const items = Object.freeze(input.items.map(summary));
  if (new Set(items.map((item) => item.menuReference)).size !== items.length)
    throw new Error("CATALOG_MENU_INVALID");
  return Object.freeze({
    screenId: "CAT-MENU-LIST",
    asOfUtc: instant(projection.asOfUtc),
    items,
    nextCursor: input.nextCursor as string | null,
  });
}

export function parseMenuBuilderView(value: unknown): MenuBuilderView {
  const input = closed(value, [
    "screenId",
    "menuReference",
    "menuVersionReference",
    "internalCode",
    "name",
    "lifecycle",
    "version",
    "asOfUtc",
    "scopeSummary",
    "channelSummary",
    "sections",
    "unresolvedIssueCount",
    "publishEvidence",
  ]);
  if (
    input.screenId !== "CAT-MENU-BUILDER" ||
    !Array.isArray(input.sections) ||
    input.sections.length > 100 ||
    !["Required", "Satisfied"].includes(String(input.publishEvidence))
  )
    throw new Error("CATALOG_MENU_INVALID");
  const sections = Object.freeze(
    input.sections.map((value) => {
      const section = closed(value, ["sectionReference", "name", "placementCount", "validation"]);
      if (!["Valid", "Invalid", "Unavailable"].includes(String(section.validation)))
        throw new Error("CATALOG_MENU_INVALID");
      return Object.freeze({
        sectionReference: reference(section.sectionReference),
        name: text(section.name),
        placementCount: positive(section.placementCount, true),
        validation: section.validation as MenuBuilderView["sections"][number]["validation"],
      });
    }),
  );
  if (new Set(sections.map((section) => section.sectionReference)).size !== sections.length)
    throw new Error("CATALOG_MENU_INVALID");
  return Object.freeze({
    screenId: "CAT-MENU-BUILDER",
    menuReference: reference(input.menuReference),
    menuVersionReference: reference(input.menuVersionReference),
    internalCode: text(input.internalCode, true),
    name: text(input.name),
    lifecycle: lifecycle(input.lifecycle),
    version: positive(input.version),
    asOfUtc: instant(input.asOfUtc),
    scopeSummary: text(input.scopeSummary),
    channelSummary: text(input.channelSummary),
    sections,
    unresolvedIssueCount: positive(input.unresolvedIssueCount, true),
    publishEvidence: input.publishEvidence as MenuBuilderView["publishEvidence"],
  });
}

export const unavailableCatalogMenuClient: CatalogMenuClient = Object.freeze({
  async listMenus() {
    throw new CatalogMenuClientError("Unavailable");
  },
  async loadBuilder() {
    throw new CatalogMenuClientError("Unavailable");
  },
});
