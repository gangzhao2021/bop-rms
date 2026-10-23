import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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

function fill(text: string, values: Readonly<Record<string, string | number>> | undefined) {
  if (values === undefined) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/** The customer's wording of an English text, in the chosen language. */
export function t(text: string, values?: Readonly<Record<string, string | number>>): string {
  if (current === "zh-Hans") {
    const translated = zhHans[text];
    if (translated !== undefined) return fill(translated, values);
  }
  return fill(text, values);
}

export function currentLanguage(): CustomerLanguage {
  return current;
}

/** The locale to ask the Store's menu in: Chinese when chosen, else the entry's own locale. */
export function menuLocale(language: CustomerLanguage, entryLocale: string): string {
  return language === "zh-Hans" ? CHINESE_LOCALE : entryLocale;
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
