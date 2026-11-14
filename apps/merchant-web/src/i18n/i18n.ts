import { zhHans } from "./zh-Hans.js";

/**
 * Staff languages (Owner 2026-10-24: English and Simplified Chinese across the whole back office,
 * after the customer side of 2026-10-23). Staff text is written in English in the code and passed
 * through `t()`, which returns the Simplified Chinese wording while Chinese is chosen. `{name}`
 * marks a value inserted into the sentence.
 *
 * Each device keeps its own choice (a shared counter tablet and a cook's kitchen screen can
 * differ). Choosing another language reloads the app once, so every text — including texts a
 * module prepares when it loads — is written in that language; staff switch rarely, and the
 * reload keeps the signed-in session.
 */
export type StaffLanguage = "en" | "zh-Hans";

const STORAGE_KEY = "bop.merchant.language";
/** The locale Store content (item and option names) is asked in while Chinese is chosen. */
export const CHINESE_LOCALE = "zh-Hans-CA";

function storedLanguage(): StaffLanguage | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === "en" || value === "zh-Hans" ? value : null;
  } catch {
    return null;
  }
}

/** First use on a device: Chinese when the device prefers Chinese; afterwards its own choice. */
export function initialLanguage(
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): StaffLanguage {
  const stored = typeof window === "undefined" ? null : storedLanguage();
  if (stored !== null) return stored;
  const preferred = languages[0]?.toLowerCase() ?? "";
  return preferred.startsWith("zh") ? "zh-Hans" : "en";
}

// Decided before any screen module prepares its texts (this module has no app dependencies, so it
// is evaluated first); fixed for the life of the page.
let current: StaffLanguage = typeof window === "undefined" ? "en" : initialLanguage();
if (typeof document !== "undefined")
  document.documentElement.lang = current === "zh-Hans" ? "zh-Hans" : "en";

/**
 * v15 b12: Chinese text puts a space between a Chinese character and Latin letters or digits
 * ("为 B10 桌点单", "员工录入的 5 轮"). Templates are written so; a value filled in (a table's
 * own name, a number) gets the space where it meets a Chinese character of the sentence.
 */
const hanCharacter = /\p{Script=Han}/u;
const latinStart = /^[A-Za-z0-9]/u;
const latinEnd = /[A-Za-z0-9)]$/u;
function spacedInChinese(before: string | undefined, value: string, after: string | undefined) {
  const lead = before !== undefined && hanCharacter.test(before) && latinStart.test(value);
  const trail = after !== undefined && hanCharacter.test(after) && latinEnd.test(value);
  return (lead ? " " : "") + value + (trail ? " " : "");
}
function fill(
  text: string,
  values: Readonly<Record<string, string | number>> | undefined,
  chinese = false,
) {
  if (values === undefined) return text;
  return text.replace(
    /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu,
    (whole, name: string, at: number, sentence: string) => {
      if (!Object.hasOwn(values, name)) return whole;
      const value = String(values[name]);
      return chinese
        ? spacedInChinese(sentence[at - 1], value, sentence[at + whole.length])
        : value;
    },
  );
}

// v15 2026-11-01: the wrapper around a table's own name (see `saidTable`), and the word of the
// sentence it replaces ("Table {table}", "{table} 号桌", "桌台 {tableLabel}", "{table} 桌").
const NAME_OPEN = "\uE000",
  NAME_CLOSE = "\uE001";
const namedTable = new RegExp(
  `(?:[Tt]able |桌台 ?|桌号 ?)?${NAME_OPEN}([^${NAME_CLOSE}]*)${NAME_CLOSE}(?: ?号桌| ?桌)?`,
  "gu",
);
/**
 * A table's label for a sentence that says "Table {table}". A number or short code reads with the
 * word ("Table 12", "Table A1", "DEMO-01"→"Table DEMO-01"); a name the owner gave is said as they
 * wrote it ("Table 1 (TEST)", "Patio 3", "靠窗 3 号"), never "Table Table 1 (TEST)".
 */
export function saidTable(label: string): string {
  return /^[A-Za-z0-9-]*[0-9][A-Za-z0-9-]*$/u.test(label) ? label : NAME_OPEN + label + NAME_CLOSE;
}
const said = (text: string) =>
  text.includes(NAME_OPEN)
    ? text.replace(namedTable, (whole, name: string, at: number, sentence: string) =>
        spacedInChinese(sentence[at - 1], name, sentence[at + whole.length]),
      )
    : text;

/** The staff wording of an English text, in the chosen language. */
export function t(text: string, values?: Readonly<Record<string, string | number>>): string {
  if (current === "zh-Hans") {
    const translated = zhHans[text];
    if (translated !== undefined) return said(fill(translated, values, true));
  }
  return said(fill(text, values));
}

export function currentLanguage(): StaffLanguage {
  return current;
}

/** Test-only: render under a language without a page reload. */
export function setLanguageForTest(language: StaffLanguage): void {
  current = language;
}

/**
 * "3 orders" / "3 笔订单": a count with its noun, in the chosen language. Only the nouns listed
 * here may be counted (English adds "s" unless an irregular plural is listed).
 */
const COUNTED: Readonly<Record<string, readonly [plural: string, chinese: string]>> = {
  order: ["orders", "笔订单"],
  round: ["rounds", "轮"],
  table: ["tables", "张桌台"],
  refund: ["refunds", "笔退款"],
  payment: ["payments", "笔付款"],
  difference: ["differences", "项差异"],
  charge: ["charges", "笔扣款"],
  run: ["runs", "次运行"],
  item: ["items", "项"],
  dish: ["dishes", "道菜"],
};
export type CountedNoun = keyof typeof COUNTED;
export function countOf(count: number, noun: CountedNoun): string {
  const [plural, chinese] = COUNTED[noun] as readonly [string, string];
  if (current === "zh-Hans") return `${count} ${chinese}`;
  return `${count} ${count === 1 ? noun : plural}`;
}

/**
 * A Store content name (item, option) chosen from its names for this staff member: Chinese while
 * chosen (when the item has a Chinese name), else the Store's English name, else any it has.
 */
export function contentName(names: Readonly<Record<string, string>>): string | undefined {
  const usable = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const chinese =
    current === "zh-Hans"
      ? (usable(names[CHINESE_LOCALE]) ??
        usable(Object.entries(names).find(([key]) => key.startsWith("zh"))?.[1]))
      : undefined;
  return (
    chinese ??
    usable(names["en-CA"]) ??
    usable(names.en) ??
    Object.values(names).find((value) => usable(value) !== undefined)
  );
}

/**
 * WP-2423 item 8 ③ (Owner decision 8): kitchen tickets show a dish's Chinese name whenever it has
 * one, whatever language the screen is in (the kitchen of a Chinese restaurant reads Chinese),
 * with its English name under it for staff who read English. Without a Chinese name, the name in
 * the screen's language as elsewhere.
 */
export function kitchenDishNames(names: Readonly<Record<string, string>>): {
  readonly displayName: string | undefined;
  readonly otherName: string | null;
} {
  const usable = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const chinese =
    usable(names[CHINESE_LOCALE]) ??
    usable(Object.entries(names).find(([key]) => key.startsWith("zh"))?.[1]);
  if (chinese === undefined) return { displayName: contentName(names), otherName: null };
  const english = usable(names["en-CA"]) ?? usable(names.en);
  return {
    displayName: chinese,
    otherName: english === undefined || english === chinese ? null : english,
  };
}

/**
 * Owner 2026-10-24: the Canadian priority allergens in Simplified Chinese, by registry code (as on
 * the customer side). Used while Chinese is chosen unless the registry already names it in Chinese.
 */
const CHINESE_ALLERGEN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  CRUSTACEAN_MOLLUSC: "甲壳类和软体类海鲜",
  EGG: "蛋",
  FISH: "鱼",
  GLUTEN: "麸质来源（大麦、燕麦、黑麦）",
  MILK: "牛奶",
  MUSTARD: "芥末",
  PEANUT: "花生",
  SESAME: "芝麻",
  SOY: "大豆",
  SULPHITES: "亚硫酸盐",
  TREE_NUT: "坚果",
  WHEAT_TRITICALE: "小麦和黑小麦",
});
export function allergenName(code: string, name: string): string {
  if (current !== "zh-Hans" || /\p{Script=Han}/u.test(name)) return name;
  return CHINESE_ALLERGEN_NAMES[code] ?? name;
}

/**
 * Words the server sends from a fixed system catalog (built-in role names and descriptions,
 * permission descriptions), in the chosen language. A Store's own text (a custom role name) has
 * no entry and is shown as written. `i18n.test.ts` checks every catalog text has its wording.
 */
export function systemText<T extends string | undefined>(text: T): T {
  if (current !== "zh-Hans" || text === undefined) return text;
  return (zhHans[text] ?? text) as T;
}

/** A service mode (order type) in staff words: "Dine-in" / "堂食". */
export function serviceModeText(mode: string): string {
  return mode === "DineIn"
    ? t("Dine-in")
    : mode === "Pickup"
      ? t("Pickup")
      : mode === "Delivery"
        ? t("Delivery")
        : mode;
}

/** How a list of names is joined: "Milk, Soy" / "牛奶、大豆". */
export function listSeparator(): string {
  return current === "zh-Hans" ? "、" : ", ";
}

/**
 * The locale times and dates are written in for the chosen language ("Oct 14, 3:00 PM" /
 * "10月14日 15:00"). Display only: machine formats (business dates, form values) stay en-CA.
 */
export function displayLocale(): string {
  return current === "zh-Hans" ? "zh-CN" : "en-US";
}

/**
 * The locale to ask Store content in (item and option names on orders, the kitchen and pickup):
 * Chinese when chosen, else null for the Store's own language. Names without a Chinese name come
 * back in the menu language.
 */
export function contentLocale(): string | null {
  return current === "zh-Hans" ? CHINESE_LOCALE : null;
}

/** A read path that asks item names in the chosen language (`?locale=zh-Hans-CA` for Chinese). */
export function withNameLocale(path: string): string {
  const locale = contentLocale();
  if (locale === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}locale=${locale}`;
}

/**
 * Asks the server for Store content (item and option names on orders, the kitchen, pickup, tables
 * and counter order) in the chosen language: same-origin `/merchant/` requests carry
 * `X-Bop-Content-Locale` while Chinese is chosen. Names without a Chinese name come back in the
 * Store's language; nothing is written differently.
 */
export function withContentLocale(
  fetcher: typeof globalThis.fetch,
  origin: () => string | undefined,
) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const locale = contentLocale();
    if (locale === null) return fetcher(input, init);
    let url: URL;
    try {
      const base = origin();
      url = new URL(input instanceof Request ? input.url : String(input), base);
      if (base !== undefined && url.origin !== new URL(base).origin) return fetcher(input, init);
    } catch {
      return fetcher(input, init);
    }
    if (!url.pathname.startsWith("/merchant/")) return fetcher(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("x-bop-content-locale", locale);
    return fetcher(input, { ...init, headers });
  };
}

/**
 * b7 (sold-out-allergens): forms with typed but unsaved work (a new dish half filled in) hold the
 * language switch: it asks first, in the staff's words, instead of reloading the work away.
 */
const unsavedWork = new Set<symbol>();
let leavingOnPurpose = false;
/** Marks unsaved work on screen until the returned release is called (on save, close or unmount). */
export function holdUnsavedWork(): () => void {
  const key = Symbol("unsaved");
  unsavedWork.add(key);
  return () => {
    unsavedWork.delete(key);
  };
}
/** True once staff chose to switch language and lose unsaved work (the page asks no more). */
export function leavingWithUnsavedWork(): boolean {
  return leavingOnPurpose;
}

/**
 * v15 b12: work in progress a screen keeps across the language switch's reload (an order being
 * taken), in this tab only, read back for a minute after it: switching the language never loses it.
 */
const keptThroughSwitch = new Map<string, () => unknown>();
const KEPT_PREFIX = "bop.merchant.keptThroughLanguageSwitch.";
export function keepThroughLanguageSwitch(key: string, snapshot: () => unknown): () => void {
  keptThroughSwitch.set(key, snapshot);
  return () => {
    if (keptThroughSwitch.get(key) === snapshot) keptThroughSwitch.delete(key);
  };
}
/** How long after a language switch what a screen kept is read back (the reload's own time). */
const KEPT_FOR_MS = 60_000;
/**
 * What the screen kept under `key` at the last language switch, while the reload is recent (null:
 * nothing). Read as often as the screen renders; the screen forgets it once it is used.
 */
export function takeKeptThroughLanguageSwitch(key: string): unknown {
  try {
    const raw = globalThis.sessionStorage.getItem(KEPT_PREFIX + key);
    if (raw === null) return null;
    const kept = JSON.parse(raw) as { at?: unknown; value?: unknown } | null;
    if (
      kept === null ||
      typeof kept.at !== "number" ||
      Math.abs(Date.now() - kept.at) > KEPT_FOR_MS
    ) {
      globalThis.sessionStorage.removeItem(KEPT_PREFIX + key);
      return null;
    }
    return kept.value ?? null;
  } catch {
    return null;
  }
}
/** The screen used (or no longer needs) what it kept: a later reload does not bring it back. */
export function forgetKeptThroughLanguageSwitch(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(KEPT_PREFIX + key);
  } catch {
    // Nothing kept.
  }
}
function keepForSwitch(): void {
  for (const [key, snapshot] of keptThroughSwitch) {
    try {
      const value = snapshot();
      if (value !== null && value !== undefined)
        globalThis.sessionStorage.setItem(
          KEPT_PREFIX + key,
          JSON.stringify({ at: Date.now(), value }),
        );
    } catch {
      // Private browsing or a full store: the page reloads without it, as before.
    }
  }
}

/** Chooses a language for this device and reloads, so every text follows it. */
export function chooseLanguage(language: StaffLanguage): void {
  if (
    language !== current &&
    unsavedWork.size > 0 &&
    !globalThis.confirm(
      t(
        "What you typed here is not saved yet. Switching the language reloads the page and loses it. Switch anyway?",
      ),
    )
  )
    return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Private browsing: the choice holds until the reload below only.
  }
  if (language === current) return;
  current = language;
  leavingOnPurpose = unsavedWork.size > 0;
  keepForSwitch();
  globalThis.location.reload();
}
