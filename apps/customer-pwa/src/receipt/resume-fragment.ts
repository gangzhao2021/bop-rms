const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const token = /^[A-Za-z0-9_-]{43,128}$/u;

export function extractAndClearReceiptResumeFragment(input: {
  readonly url: string;
  readonly replaceCleanUrl: (cleanPath: string) => void;
}): { readonly orderReference: string; readonly plaintextToken: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  const match = /^\/orders\/([^/]+)\/receipt$/u.exec(parsed.pathname);
  if (!match || !reference.test(match[1] ?? "") || parsed.search.length > 0) return null;
  const fragment = /^#resume=([A-Za-z0-9_-]{43,128})$/u.exec(parsed.hash);
  if (!fragment || !token.test(fragment[1] ?? "")) return null;
  input.replaceCleanUrl(parsed.pathname);
  return Object.freeze({
    orderReference: match[1] as string,
    plaintextToken: fragment[1] as string,
  });
}
