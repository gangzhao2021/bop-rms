export class DiningHostClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Unknown") {
    super("Dining host operation unavailable");
  }
}
const fail = (): never => {
  throw new DiningHostClientError("Unavailable");
};
function object(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
const reference = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
  )
    return fail();
  return v;
};
const instant = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    return fail();
  return v;
};
function selection(value: unknown) {
  const raw = object(value, [
      "diningSessionReference",
      "sessionVersion",
      "phase",
      "hostParticipantReference",
      "participants",
      "observedAt",
    ]),
    session = reference(raw.diningSessionReference),
    host = raw.hostParticipantReference === null ? null : reference(raw.hostParticipantReference),
    at = instant(raw.observedAt);
  if (
    typeof raw.sessionVersion !== "number" ||
    !Number.isSafeInteger(raw.sessionVersion) ||
    raw.sessionVersion < 1 ||
    raw.sessionVersion >= 2147483647 ||
    (raw.phase !== "Active" && raw.phase !== "Closing") ||
    !Array.isArray(raw.participants) ||
    raw.participants.length > 100
  )
    return fail();
  const seen = new Set<string>();
  const participants = raw.participants.map((value) => {
    const p = object(value, ["participantReference", "joinedAt", "isHost"]),
      id = reference(p.participantReference),
      joinedAt = instant(p.joinedAt);
    if (seen.has(id) || joinedAt > at || p.isHost !== (id === host)) return fail();
    seen.add(id);
    return Object.freeze({ participantReference: id, joinedAt, isHost: p.isHost as boolean });
  });
  return Object.freeze({
    diningSessionReference: session,
    sessionVersion: raw.sessionVersion,
    phase: raw.phase,
    hostParticipantReference: host,
    participants: Object.freeze(participants),
    observedAt: at,
  });
}
export type DiningHostSelection = ReturnType<typeof selection>;
export function createDiningHostTransferClient(fetcher: typeof fetch = fetch) {
  async function send(
    path: string,
    body: string,
    csrf: string,
    signal: AbortSignal | undefined,
    mutation: boolean,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body,
      });
      if (controller.signal.aborted) return fail();
      if ([401, 403, 409].includes(response.status)) throw new DiningHostClientError("Denied");
      if (
        !response.ok ||
        response.redirected ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.startsWith("application/json") ||
        !response.body
      )
        return fail();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (controller.signal.aborted) return fail();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) return fail();
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof DiningHostClientError && error.code === "Denied") throw error;
      throw new DiningHostClientError(mutation ? "Unknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  return Object.freeze({
    async selection(sessionReference: string, csrf: string, signal?: AbortSignal) {
      const requested = reference(sessionReference);
      const result = selection(
        await send(
          "/merchant/dining/sessions/host-selection",
          JSON.stringify({ diningSessionReference: requested }),
          csrf,
          signal,
          false,
        ),
      );
      if (result.diningSessionReference !== requested) return fail();
      return result;
    },
    prepare(source: DiningHostSelection, targetReference: string, operationReference: string) {
      const snapshot = selection(source),
        target = reference(targetReference),
        operation = reference(operationReference);
      if (!snapshot.participants.some((p) => p.participantReference === target && !p.isHost))
        return fail();
      const command = Object.freeze({
        operationReference: operation,
        diningSessionReference: snapshot.diningSessionReference,
        expectedSessionVersion: snapshot.sessionVersion,
        expectedHostParticipantReference: snapshot.hostParticipantReference,
        targetParticipantReference: target,
      });
      const body = JSON.stringify(command);
      let unknown = false;
      return Object.freeze({
        async execute(csrf: string, signal?: AbortSignal) {
          try {
            const raw = object(
              await send("/merchant/dining/sessions/host-transfer", body, csrf, signal, true),
              [
                "status",
                "operationReference",
                "diningSessionReference",
                "previousHostParticipantReference",
                "hostParticipantReference",
                "sessionVersion",
                "transferredAt",
              ],
            );
            if (
              (raw.status !== "Applied" && raw.status !== "AlreadyApplied") ||
              raw.operationReference !== operation ||
              raw.diningSessionReference !== snapshot.diningSessionReference ||
              raw.previousHostParticipantReference !== snapshot.hostParticipantReference ||
              raw.hostParticipantReference !== target ||
              raw.sessionVersion !== snapshot.sessionVersion + 1 ||
              instant(raw.transferredAt) < snapshot.observedAt
            )
              return fail();
            return Object.freeze({
              status: raw.status,
              sessionVersion: raw.sessionVersion,
              transferredAt: instant(raw.transferredAt),
            });
          } catch (error) {
            if (error instanceof DiningHostClientError && error.code === "Denied" && !unknown)
              throw error;
            unknown = true;
            throw new DiningHostClientError("Unknown");
          }
        },
      });
    },
  });
}
