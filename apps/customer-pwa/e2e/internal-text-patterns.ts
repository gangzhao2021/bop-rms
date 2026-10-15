// Mirrors apps/merchant-web/e2e/internal-text-patterns.ts verbatim (apps must not import each other); keep the two copies in sync.
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
  // Provider and internal record references such as simset_20261014_9df991b5…, ch_3Nx…, re_1Ab…
  // (a short lowercase prefix, an underscore, then a token with a digit).
  { name: "internal reference", pattern: /\b[a-z]{2,8}_[A-Za-z0-9_]*\d[A-Za-z0-9_]*\b/gu },
  { name: "UTC", pattern: /\bUTC\b/gu },
  {
    name: "technical term",
    pattern:
      /\b(?:KDS|idempoten\w*|projection|payload|enum|credential|masked|null|undefined|NaN)\b|\[object Object\]/giu,
  },
  // "Unavailable" / "Not available yet" placeholders instead of a working state.
  { name: "placeholder", pattern: /\bunavailable\b|\bnot available yet\b/giu },
  // Machine dates and times: 2026-10-14T15:00:00.000Z, 2026-10-14 22:11 or a bare 2026-10-14.
  // Staff and guests read "Oct 14, 10:11 PM" (the T-only form let "2026-10-14 22:11" through).
  {
    name: "timestamp",
    pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/gu,
  },
  // "Not available here yet" style stubs.
  { name: "stub", pattern: /\bnot available here yet\b|\bcannot be selected here yet\b/giu },
  // Doubled sentence punctuation such as "9:46 p.m.." (an ellipsis is fine).
  { name: "double period", pattern: /(?<!\.)\.\.(?!\.)/gu },
  // Wait times in contract seconds ("whole seconds from 0 to 86400", "Order cutoff seconds")
  // instead of minutes. Narrow on purpose: "in 30 seconds" and 86400000 stay allowed.
  {
    name: "seconds unit",
    pattern: /\b86,?400\b|\bwhole seconds\b|\b(?:cutoff|lead time|wait time)s? seconds\b/giu,
  },
  // IANA zone identifiers such as Africa/Abidjan or America/Argentina/Salta; staff read
  // "Eastern Time (Toronto, …)". Only the IANA area names are matched, so "and/or" is fine.
  {
    name: "time zone identifier",
    pattern:
      /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*/gu,
  },
  // Retired configuration phrases that staff read as jargon. Single words such as "Draft",
  // "configuration" or "policy" are also real staff words, so only these exact phrases are matched.
  {
    name: "configuration jargon",
    pattern:
      /\bfee contexts?\b|\beffective policy\b|\bdraft configuration\b|\bbind Store configuration\b/giu,
  },
  // A role written as a code-like proper noun mid-sentence ("ask Staff"); guests ask staff.
  { name: "capitalized role", pattern: /\b(?:[Aa]sk|[Tt]ell|[Ss]how|[Cc]all) Staff\b/gu },
];

/** Reviewed business language that the rules above would otherwise flag. */
export const reviewedInternalTextAllowlist: readonly RegExp[] = [
  // Product and brand names rendered from fixtures or the operating system.
  /\bPayPal\b/u,
  /\biPhone\b/u,
  /\bApple Pay\b/u,
  /\bGoogle Pay\b/u,
  // A real place name in the store time zone list ("New Zealand Time (McMurdo)").
  /\bMcMurdo\b/u,
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
