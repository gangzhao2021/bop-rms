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

function fill(text: string, values: Readonly<Record<string, string | number>> | undefined) {
  if (values === undefined) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/** The staff wording of an English text, in the chosen language. */
export function t(text: string, values?: Readonly<Record<string, string | number>>): string {
  if (current === "zh-Hans") {
    const translated = zhHans[text];
    if (translated !== undefined) return fill(translated, values);
  }
  return fill(text, values);
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

/** Chooses a language for this device and reloads, so every text follows it. */
export function chooseLanguage(language: StaffLanguage): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Private browsing: the choice holds until the reload below only.
  }
  if (language === current) return;
  current = language;
  globalThis.location.reload();
}

/** "中文" / "English": switches the whole back office on this device. */
export function LanguageSwitch({ className }: { readonly className?: string }) {
  const next: StaffLanguage = current === "zh-Hans" ? "en" : "zh-Hans";
  return (
    <button
      type="button"
      className={className === undefined ? "language-switch" : `language-switch ${className}`}
      lang={next === "zh-Hans" ? "zh-Hans" : "en"}
      aria-label={next === "zh-Hans" ? "切换到中文" : "Switch to English"}
      onClick={() => chooseLanguage(next)}
    >
      {next === "zh-Hans" ? "中文" : "English"}
    </button>
  );
}
