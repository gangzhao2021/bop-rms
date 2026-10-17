import { useEffect, useId, useRef, useState } from "react";
import { newOperationReference } from "./RoleAdministrationPages.js";

/**
 * WP-2423: Home (HOME-OVERVIEW) asks a signed-in staff member who has no recorded name to add one,
 * so lists, approvals and records show who did what. Only the name is collected; once it is
 * recorded a manager maintains it on the staff page. Nothing is shown when the member already has
 * a name, is not a member of this Store, or the read fails (the rest of Home is unaffected).
 */
export type OwnNameState =
  | { readonly name: "Missing"; readonly profileVersion: 0 }
  | { readonly name: "Recorded"; readonly displayName: string }
  | { readonly name: "NotStoreMember" };
export type OwnNameErrorCode =
  "PermissionDenied" | "NotFound" | "Conflict" | "Invalid" | "Offline" | "Unavailable";
export class OwnNameError extends Error {
  constructor(readonly code: OwnNameErrorCode) {
    super("Your name could not be read or saved");
    this.name = "OwnNameError";
  }
}
export interface OwnNameClient {
  read(): Promise<OwnNameState>;
  save(input: {
    readonly displayName: string;
    readonly operationReference: string;
  }): Promise<{ readonly status: "Applied" | "AlreadyApplied" }>;
}

export const OWN_NAME_PURPOSE = "Shown to your team so everyone can see who did what.";
export const OWN_NAME_PROMPT = "Add your name so your team sees who did what.";
export const OWN_NAME_SAVED = "Thanks. Your team now sees your name.";

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new OwnNameError("Unavailable");
  return value as Record<string, unknown>;
};
export function parseOwnNameState(value: unknown): OwnNameState {
  const name = (value as { name?: unknown } | null)?.name;
  if (name === "Missing") {
    const r = exact(value, ["name", "profileVersion"]);
    if (r.profileVersion !== 0) throw new OwnNameError("Unavailable");
    return { name: "Missing", profileVersion: 0 };
  }
  if (name === "Recorded") {
    const r = exact(value, ["name", "displayName"]);
    if (typeof r.displayName !== "string") throw new OwnNameError("Unavailable");
    return { name: "Recorded", displayName: r.displayName };
  }
  exact(value, ["name"]);
  if (name !== "NotStoreMember") throw new OwnNameError("Unavailable");
  return { name: "NotStoreMember" };
}

/** The name as it will be stored: trimmed, 1–80 characters, no control characters. */
export function ownNameProblem(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return "Enter your name.";
  if ([...name].length > 80) return "Use 80 characters or fewer.";
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return "Use letters, spaces and punctuation only.";
  return null;
}

export function ownNameFailureText(error: unknown): string {
  const code = error instanceof OwnNameError ? error.code : "Unavailable";
  switch (code) {
    case "Invalid":
      return "Use up to 80 letters, spaces and punctuation.";
    case "Conflict":
      return "Your name was already added. Ask a manager if it needs to change.";
    case "PermissionDenied":
    case "NotFound":
      return "Your sign-in has ended or doesn't allow this. Sign in again, then add your name.";
    case "Offline":
    case "Unavailable":
      return "Your name couldn't be saved. Check the connection and try again.";
  }
}

const codes: Record<string, OwnNameErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  Invalid: "Invalid",
};
export function createOwnNameClient(csrf: string, fetcher: typeof fetch = fetch): OwnNameClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new OwnNameError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new OwnNameError(
        codes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
      );
    }
    return response.json().catch(() => {
      throw new OwnNameError("Unavailable");
    }) as Promise<unknown>;
  };
  return {
    read: async () => parseOwnNameState(await post("/merchant/organization/staff/me", {})),
    save: async (input) => {
      const result = exact(
        await post("/merchant/organization/staff/me/name", {
          displayName: input.displayName,
          expectedProfileVersion: 0,
          operationReference: input.operationReference,
        }),
        ["status", "profileVersion"],
      );
      if (result.status !== "Applied" && result.status !== "AlreadyApplied")
        throw new OwnNameError("Unavailable");
      return { status: result.status };
    },
  };
}

export interface OwnNamePromptViewProps {
  readonly name: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly idPrefix: string;
}
export function OwnNamePromptView({
  name,
  busy,
  problem,
  onChange,
  onSubmit,
  idPrefix,
}: OwnNamePromptViewProps) {
  const field = idPrefix + "-name",
    hint = idPrefix + "-hint",
    error = idPrefix + "-error";
  return (
    <section className="overview-card own-name-prompt" aria-labelledby={idPrefix + "-heading"}>
      <h3 id={idPrefix + "-heading"}>Add your name</h3>
      <p>{OWN_NAME_PROMPT}</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor={field}>Your name</label>
        <input
          id={field}
          name="displayName"
          autoComplete="name"
          maxLength={80}
          required
          value={name}
          aria-describedby={problem === null ? hint : hint + " " + error}
          aria-invalid={problem === null ? undefined : true}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <p id={hint} className="own-name-prompt__hint">
          {OWN_NAME_PURPOSE}
        </p>
        {problem === null ? null : (
          <p id={error} className="command-error" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save name"}
        </button>
      </form>
    </section>
  );
}

export function OwnNamePrompt({
  csrf,
  client,
}: {
  readonly csrf: string;
  readonly client?: OwnNameClient;
}) {
  const source = useRef<OwnNameClient>(client ?? createOwnNameClient(csrf));
  const [state, setState] = useState<"Hidden" | "Asking" | "Saved">("Hidden");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One operation per name: a retry after a lost answer repeats it instead of adding another.
  const pending = useRef<{ readonly name: string; readonly reference: string } | null>(null);
  const idPrefix = "own-name-" + useId().replace(/[^A-Za-z0-9_-]/gu, "");
  useEffect(() => {
    let current = true;
    source.current.read().then(
      (result) => {
        if (current && result.name === "Missing") setState("Asking");
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  if (state === "Hidden") return null;
  if (state === "Saved")
    return (
      <section className="overview-card own-name-prompt" aria-label="Your name">
        <p role="status">{OWN_NAME_SAVED}</p>
      </section>
    );
  const submit = async () => {
    const invalid = ownNameProblem(name);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    const displayName = name.trim();
    if (pending.current?.name !== displayName)
      pending.current = { name: displayName, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      await source.current.save({
        displayName,
        operationReference: pending.current.reference,
      });
      pending.current = null;
      setState("Saved");
    } catch (error) {
      if (error instanceof OwnNameError && error.code === "Conflict") pending.current = null;
      setProblem(ownNameFailureText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <OwnNamePromptView
      name={name}
      busy={busy}
      problem={problem}
      idPrefix={idPrefix}
      onChange={(value) => {
        setName(value);
        if (problem !== null) setProblem(null);
      }}
      onSubmit={() => void submit()}
    />
  );
}
