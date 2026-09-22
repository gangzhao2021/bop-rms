interface InternalLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}
export async function loadInternalEntryToken({
  enabled,
  location,
  fetcher,
}: {
  readonly enabled: boolean;
  readonly location: InternalLocation;
  readonly fetcher: typeof fetch;
}): Promise<string | undefined> {
  if (
    !enabled ||
    location.origin !== "https://127.0.0.1:4443" ||
    location.pathname !== "/" ||
    location.search !== ""
  )
    return undefined;
  const dining = /^#internal-dining=([a-z][a-z0-9-]{0,39})$/.exec(location.hash);
  if (location.hash !== "" && !dining) return undefined;
  const path = dining
    ? `/bff/internal-test/dining-entry?table=${dining[1]}`
    : "/bff/internal-test/pickup-entry";
  try {
    const response = await fetcher(path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (
      !response.ok ||
      response.headers.get("cache-control") !== "no-store" ||
      !response.headers.get("content-type")?.startsWith("application/json")
    )
      return undefined;
    const text = await response.text();
    if (text.length > 8192) return undefined;
    const value: unknown = JSON.parse(text);
    if (
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).length === 2 &&
      "schemaVersion" in value &&
      value.schemaVersion === 1 &&
      "qrToken" in value &&
      typeof value.qrToken === "string" &&
      value.qrToken.length > 0 &&
      value.qrToken.length <= 2048
    )
      return value.qrToken;
  } catch {
    /* Existing entry validation reports unavailable context. */
  }
  return undefined;
}
