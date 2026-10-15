/**
 * Staff- and guest-facing text must use their language (AGENTS.md pilot rules): no enum values,
 * codes, identifiers, technical terms or placeholder words. This pure scanner is shared by the
 * production browser specs (rendered text) and unit tests (rendered markup). Keep the allowlist
 * small and reviewed: each entry names text that is real business language, not an internal token.
 */
export interface InternalTextRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export const internalTextRules: readonly InternalTextRule[] = [
  // Enum or field names such as ServiceCharge, OrderNumber, PaymentStatus, NamedKdsOperator.
  { name: "PascalCase token", pattern: /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/gu },
  // Codes such as PROFILE_CURRENT or STORE_SETUP_UNAVAILABLE.
  { name: "SCREAMING_CASE code", pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu },
  // Raw identifiers and the vocabulary used to describe them.
  {
    name: "identifier",
    pattern: /\bUUID\w*|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/giu,
  },
  { name: "UTC", pattern: /\bUTC\b/gu },
  {
    name: "technical term",
    pattern:
      /\b(?:KDS|idempoten\w*|projection|payload|enum|credential|masked|null|undefined|NaN)\b|\[object Object\]/giu,
  },
  // "Unavailable" / "Not available yet" placeholders instead of a working state.
  { name: "placeholder", pattern: /\bunavailable\b|\bnot available yet\b/giu },
  // Raw machine timestamps such as 2026-10-14T15:00:00.000Z.
  { name: "timestamp", pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/gu },
  // "Not available here yet" style stubs.
  { name: "stub", pattern: /\bnot available here yet\b|\bcannot be selected here yet\b/giu },
  // Doubled sentence punctuation such as "9:46 p.m.." (an ellipsis is fine).
  { name: "double period", pattern: /(?<!\.)\.\.(?!\.)/gu },
];

/** Reviewed business language that the rules above would otherwise flag. */
export const reviewedInternalTextAllowlist: readonly RegExp[] = [
  // Product and brand names rendered from fixtures or the operating system.
  /\bPayPal\b/u,
  /\biPhone\b/u,
  /\bApple Pay\b/u,
  /\bGoogle Pay\b/u,
];

export interface InternalTextFinding {
  readonly rule: string;
  readonly token: string;
  readonly text: string;
}

export function findInternalText(
  texts: readonly string[],
  allow: readonly (RegExp | string)[] = [],
): InternalTextFinding[] {
  const allowed = [...reviewedInternalTextAllowlist, ...allow];
  const findings: InternalTextFinding[] = [];
  for (const raw of texts) {
    for (const line of raw.split(/\n+/u)) {
      let text = line.trim();
      if (!text) continue;
      for (const entry of allowed)
        text =
          typeof entry === "string"
            ? text.split(entry).join(" ")
            : text.replace(new RegExp(entry.source, entry.flags.replace("g", "") + "g"), " ");
      for (const rule of internalTextRules)
        for (const match of text.matchAll(rule.pattern))
          findings.push({ rule: rule.name, token: match[0], text: line.trim() });
    }
  }
  return findings;
}

/**
 * Text a reader meets in server-rendered markup (unit tests): text nodes plus the accessible
 * names and placeholders carried in attributes (tooltips are not scanned). Entities are decoded for the common cases.
 */
export function staticText(html: string): string {
  const attributes = [...html.matchAll(/\s(?:placeholder|aria-label|alt)="([^"]*)"/gu)].map(
    (match) => match[1] ?? "",
  );
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gu, "\n")
    .replace(/<[^>]+>/gu, "\n")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&nbsp;/gu, " ");
  return [text, ...attributes].join("\n");
}
