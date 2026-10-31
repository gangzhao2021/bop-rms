import { createContext } from "react";
import type { ComboPartView } from "./combo-parts.js";
import { newOperationReference } from "./operation-reference.js";

/** WP-2423 item 8 ⑥ part 4: a combo's dish done in the kitchen, or served at its table. */
export class ComboPartClientError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "NotFound" | "NotReady" | "Conflict" | "Offline" | "Unavailable",
  ) {
    super(code);
    this.name = "ComboPartClientError";
  }
}
async function post(csrf: string, path: string, body: unknown, fetcher: typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-bop-csrf": csrf },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ComboPartClientError("Offline");
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = String(payload?.error);
    throw new ComboPartClientError(
      code === "PermissionDenied" ||
        code === "NotFound" ||
        code === "NotReady" ||
        code === "Conflict"
        ? code
        : "Unavailable",
    );
  }
  return payload ?? {};
}

/** The kitchen: this dish of the combo is done. True when every dish of it is done now. */
export async function markComboPartDone(
  csrf: string,
  input: { readonly workItemReference: string; readonly optionReference: string },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const result = await post(
    csrf,
    "/merchant/kitchen/combo-part-done",
    { operationReference: newOperationReference(), ...input },
    fetcher,
  );
  return result.allDone === true;
}

/** A server: this dish of the combo is served. True when every dish of it is served now. */
export async function markComboPartServed(
  csrf: string,
  input: {
    readonly orderReference: string;
    readonly orderItemReference: string;
    readonly optionReference: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const result = await post(
    csrf,
    "/merchant/dining/combo-part-served",
    { operationReference: newOperationReference(), ...input },
    fetcher,
  );
  return result.allServed === true;
}

/** The kitchen board's "this dish is done" for a combo's dish (absent: read only). */
export const ComboPartDoneContext = createContext<
  ((workItemReference: string, part: ComboPartView) => void) | null
>(null);
