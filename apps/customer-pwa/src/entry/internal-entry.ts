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
  if (!enabled || location.pathname !== "/" || location.search !== "") return undefined;
  const dining = /^#internal-dining=([a-z][a-z0-9-]{0,39})$/.exec(location.hash);
  // 2026-11-01: a Store's own pickup link or poster (`/#pickup=<public Store reference>`) opens
  // pickup ordering at that Store, at an installation with several Stores.
  const pickup =
    /^#pickup=([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      location.hash,
    );
  if (location.hash !== "" && !dining && !pickup) return undefined;
  // DEC-PILOT-RUNTIME-ENVIRONMENT: the Store's own address opens pickup ordering on whichever
  // origin served the app (the server answers same-origin only); the DEMO table launcher exists
  // only on the local InternalTest entry.
  if (dining && location.origin !== "https://127.0.0.1:4443") return undefined;
  const path = dining
    ? `/bff/internal-test/dining-entry?table=${dining[1]}`
    : pickup
      ? `/bff/customer/pickup-entry?store=${pickup[1]}`
      : "/bff/customer/pickup-entry";
  return fetchEntryToken(fetcher, path);
}

const publicStorePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * M02 (v15 07b7a1b7): a pickup code for one named Store ("Start a new order" at the restored
 * visit's Store), or with none named, the installation's only Store; an installation of several
 * Stores answers that with none, and the guest is asked to scan.
 */
export async function loadPickupEntryToken({
  enabled,
  fetcher,
  publicStoreReference,
}: {
  readonly enabled: boolean;
  readonly fetcher: typeof fetch;
  readonly publicStoreReference?: string | undefined;
}): Promise<string | undefined> {
  if (!enabled) return undefined;
  if (publicStoreReference === undefined)
    return fetchEntryToken(fetcher, "/bff/customer/pickup-entry");
  if (!publicStorePattern.test(publicStoreReference)) return undefined;
  return fetchEntryToken(fetcher, `/bff/customer/pickup-entry?store=${publicStoreReference}`);
}

async function fetchEntryToken(fetcher: typeof fetch, path: string): Promise<string | undefined> {
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
