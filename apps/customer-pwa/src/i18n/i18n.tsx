import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { zhHans } from "./zh-Hans.js";

/**
 * Customer languages (Owner 2026-10-23: English and Simplified Chinese across the customer
 * journey). Customer-facing text is written in English in the components and passed through
 * `t()`, which returns the Simplified Chinese wording while Chinese is chosen. `{name}` marks a
 * value inserted into the sentence.
 */
export type CustomerLanguage = "en" | "zh-Hans";

const STORAGE_KEY = "bop.customer.language";
/** The menu locale requested for Chinese; menu content falls back to the menu language. */
export const CHINESE_LOCALE = "zh-Hans-CA";

// Decided at load so text written before the app renders (the session check) already follows
// the guest's language; LanguageRoot keeps it current afterwards.
let current: CustomerLanguage = "en";

/**
 * Fills `{name}` values. A value that already ends with a period ("8:08 a.m.", as Canadian English
 * writes a time) takes the place of the sentence's own period after it, so a sentence never ends
 * "a.m.." (WP-2423 store-service-controls, v15 live check).
 */
function fill(
  text: string,
  values: Readonly<Record<string, string | number>> | undefined,
  chinese = false,
) {
  if (values === undefined) return text;
  return text.replace(
    /\{([a-zA-Z][a-zA-Z0-9]*)\}(\.(?!\.))?/gu,
    (whole, name: string, stop: string | undefined, at: number, sentence: string) => {
      if (!Object.hasOwn(values, name)) return whole;
      const value = chinese
        ? spacedInChinese(sentence[at - 1], String(values[name]), sentence[at + name.length + 2])
        : String(values[name]);
      return stop !== undefined && !value.endsWith(".") ? value + stop : value;
    },
  );
}

/**
 * Batch 46 (v15 overnight 45), one rule with the staff screens (v15 b12): a value filled into
 * Chinese text meets a Chinese character directly when its own edge is Chinese ("牛肉面现在不供应",
 * "可能含芝麻"), and with a space when its edge is Latin letters or digits ("已选择在 Lane Dessert
 * (TEST) 自取"). Templates write no space of their own next to a name.
 */
const hanCharacter = /\p{Script=Han}/u;
const latinStart = /^[A-Za-z0-9]/u;
const latinEnd = /[A-Za-z0-9)]$/u;
function spacedInChinese(before: string | undefined, value: string, after: string | undefined) {
  const lead = before !== undefined && hanCharacter.test(before) && latinStart.test(value);
  const trail = after !== undefined && hanCharacter.test(after) && latinEnd.test(value);
  return (lead ? " " : "") + value + (trail ? " " : "");
}

// v15 2026-11-01: as on the staff screens, a table the owner named is said as they wrote it.
const NAME_OPEN = "\uE000",
  NAME_CLOSE = "\uE001";
// Batch 46 (v15 b45 live): the spaces next to a name are part of the match, so one rule decides
// them wherever the sentence put them ("请扫 E45 A (TEST)的桌台" and "E45 A (TEST) 没有点单"
// read alike).
const namedTable = new RegExp(
  `( ?)(?:[Tt]able |桌号 ?)?${NAME_OPEN}([^${NAME_CLOSE}]*)${NAME_CLOSE}(?: ?桌)?( ?)`,
  "gu",
);
/** "Table 12", "table A1": the word only with a number or code; "Patio 3" as written. */
export function saidTable(label: string): string {
  return /^[A-Za-z0-9-]*[0-9][A-Za-z0-9-]*$/u.test(label) ? label : NAME_OPEN + label + NAME_CLOSE;
}
// Batch 42 (v15 b41 live "…not production 的L41V A (TEST) 还没开台"): a name said as written keeps
// a space where it meets Chinese text and it starts or ends in Latin letters, digits or other
// half-width signs, as a Chinese sentence writes "的 L41V A (TEST) 还没开台"; Chinese names get
// none, and nor does full-width punctuation ("并到 E45 A (TEST)，"). Batch 46: a name ending
// in ")" is half-width too ("扫 E45 A (TEST) 的桌台"), and a sentence's own space next to a
// Chinese name goes ("包间没有点单"). Elsewhere (English) the sentence's spaces stay as written.
const han = /\p{Script=Han}/u;
const latinEdge = /[!-~\p{Script=Latin}]/u;
const said = (text: string) =>
  text.includes(NAME_OPEN)
    ? text.replace(
        namedTable,
        (whole: string, lead: string, name: string, trail: string, offset: number, all: string) => {
          const before = all[offset - 1] ?? "";
          const after = all[offset + whole.length] ?? "";
          const gap = (neighbour: string, edge: string, written: string) =>
            han.test(neighbour) ? (latinEdge.test(edge) ? " " : "") : written;
          return gap(before, name[0] ?? "", lead) + name + gap(after, name.at(-1) ?? "", trail);
        },
      )
    : text;

/** The customer's wording of an English text, in the chosen language. */
export function t(text: string, values?: Readonly<Record<string, string | number>>): string {
  if (current === "zh-Hans") {
    const translated = zhHans[text];
    if (translated !== undefined) return said(fill(translated, values, true));
  }
  return said(fill(text, values));
}

export function currentLanguage(): CustomerLanguage {
  return current;
}

/** How a list of names is joined: "Milk, Soy" / "牛奶、大豆". */
export function listSeparator(): string {
  return current === "zh-Hans" ? "、" : ", ";
}
/** Between two clauses and at the end of a sentence built from parts. */
export function clauseSeparator(): string {
  return current === "zh-Hans" ? "；" : "; ";
}
export function sentenceEnd(): string {
  return current === "zh-Hans" ? "。" : ".";
}
/** After a label's colon or between sentences built from parts: a space in English, none in Chinese. */
export function wordGap(): string {
  return current === "zh-Hans" ? "" : " ";
}
/** The locale times and dates are written in for the chosen language. */
export function dateLocale(): string {
  return current === "zh-Hans" ? "zh-CN" : "en-CA";
}

/** The locale to ask the Store's menu in: Chinese when chosen, else the entry's own locale. */
export function menuLocale(language: CustomerLanguage, entryLocale: string): string {
  return language === "zh-Hans" ? CHINESE_LOCALE : entryLocale;
}

/**
 * The path of a customer read (cart, order status, receipt, table) asking its item and option
 * names in the chosen language: Chinese adds `locale=zh-Hans-CA` (names without a Chinese name come
 * back in the menu language); English asks nothing extra, so the session's own locale is used.
 */
/** The locale names are asked in, for a request that carries it in its body (null: as stored). */
export function nameLocale(): string | null {
  return current === "zh-Hans" ? CHINESE_LOCALE : null;
}

export function withNameLocale(path: string): string {
  if (current !== "zh-Hans") return path;
  return `${path}${path.includes("?") ? "&" : "?"}locale=${CHINESE_LOCALE}`;
}

function storedLanguage(): CustomerLanguage | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "zh-Hans" ? value : null;
  } catch {
    return null;
  }
}

/** First visit: Chinese when the device prefers Chinese; afterwards the guest's own choice. */
export function initialLanguage(
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): CustomerLanguage {
  const stored = typeof window === "undefined" ? null : storedLanguage();
  if (stored !== null) return stored;
  const preferred = languages[0]?.toLowerCase() ?? "";
  return preferred.startsWith("zh") ? "zh-Hans" : "en";
}

if (typeof window !== "undefined") current = initialLanguage();

const LanguageContext = createContext<{
  readonly language: CustomerLanguage;
  readonly setLanguage: (language: CustomerLanguage) => void;
}>({ language: "en", setLanguage: () => undefined });

/**
 * Holds the chosen language above the whole customer app. `children` is a render function so a
 * change re-renders every page in place (forms, carts and payments keep their state).
 */
export function LanguageRoot({
  initial = initialLanguage(),
  children,
}: {
  readonly initial?: CustomerLanguage;
  readonly children: () => ReactNode;
}) {
  const [language, setLanguageState] = useState<CustomerLanguage>(initial);
  current = language;
  useEffect(() => {
    document.documentElement.lang = language === "zh-Hans" ? "zh-Hans" : "en";
  }, [language]);
  const setLanguage = (next: CustomerLanguage) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing: the choice holds for this visit only.
    }
    setLanguageState(next);
  };
  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children()}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

/**
 * Reads the page again after the guest switches language (not when it opens), so item and option
 * names the server writes follow the new language (see {@link withNameLocale}).
 */
export function useReloadOnLanguageChange(reload: () => void): void {
  const { language } = useLanguage();
  const shown = useRef(language);
  useEffect(() => {
    if (shown.current === language) return;
    shown.current = language;
    reload();
  }, [language, reload]);
}

/** "中文" / "English": switches the whole customer journey. */
export function LanguageSwitch() {
  const { language, setLanguage } = useLanguage();
  const next: CustomerLanguage = language === "zh-Hans" ? "en" : "zh-Hans";
  return (
    <button
      type="button"
      className="language-switch"
      lang={next === "zh-Hans" ? "zh-Hans" : "en"}
      aria-label={next === "zh-Hans" ? "切换到中文" : "Switch to English"}
      onClick={() => setLanguage(next)}
    >
      {next === "zh-Hans" ? "中文" : "English"}
    </button>
  );
}
