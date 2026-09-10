import { useCallback, useMemo, useState } from "react";
import { Route, Routes } from "react-router";
import { EntryContextPage } from "./entry/EntryContextPage.js";
import type { CustomerEntryClient, CustomerEntryScreenState } from "./entry/types.js";

type Name = "A" | "B";
type Action = "start" | "retry";
function createHarness(changed: () => void) {
  const calls = { A: { start: 0, retry: 0 }, B: { start: 0, retry: 0 } };
  const pending: {
    name: Name;
    action: Action;
    resolve: (state: CustomerEntryScreenState) => void;
    reject: () => void;
  }[] = [];
  let throwRetry = false;
  let throwStart = false;
  function client(name: Name): CustomerEntryClient {
    function request(action: Action): Promise<CustomerEntryScreenState> {
      calls[name][action]++;
      changed();
      if ((action === "retry" && throwRetry) || (action === "start" && throwStart))
        throw new Error("synthetic entry failure");
      return new Promise((resolve, reject) =>
        pending.push({
          name,
          action,
          resolve,
          reject: () => reject(new Error("synthetic entry failure")),
        }),
      );
    }
    return Object.freeze({
      hasEntry: true,
      start: () => request("start"),
      retry: () => request("retry"),
    });
  }
  return {
    clients: { A: client("A"), B: client("B") },
    calls,
    throwOnStart() {
      throwStart = true;
    },
    throwOnRetry() {
      throwRetry = true;
    },
    settle(name: Name, action: Action, fail = false) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const request = pending[i];
        if (!request || request.name !== name || request.action !== action) continue;
        pending.splice(i, 1);
        if (fail) request.reject();
        else
          request.resolve({
            kind: "Established",
            context: {
              brandDisplayName: "Synthetic lifecycle kitchen",
              storeDisplayName: `Lifecycle training store ${name}`,
              publicStoreReference: "01902311-0000-7000-8000-000000000001",
              publicTableReference: null,
              channel: "Pickup",
              operatingState: "Open",
              availableServiceModes: ["Pickup"],
              locale: "en-CA",
              contextExpiresAt: "2026-09-10T23:59:00.000Z",
              csrfToken: "l".repeat(43),
            },
          });
      }
    },
  };
}
/** Deterministic synthetic React lifecycle exercise; imported only by the local demo entry. */
export function EntryLifecycleDemo() {
  const [, refresh] = useState(0);
  const harness = useMemo(() => createHarness(() => refresh((value) => value + 1)), []);
  const [selected, setSelected] = useState<Name>("A");
  const [mounted, setMounted] = useState(true);
  const [callbackVersion, setCallbackVersion] = useState(1);
  const [publications, setPublications] = useState<string[]>([]);
  const established = useCallback(
    (context: { storeDisplayName: string }) => {
      setPublications((previous) => [
        ...previous,
        `${context.storeDisplayName}:v${callbackVersion}`,
      ]);
    },
    [callbackVersion],
  );
  return (
    <>
      <aside aria-label="Entry lifecycle training controls">
        <h1>Entry lifecycle training</h1>
        <p>Synthetic local verification only. No API requests or orders.</p>
        <output aria-label="Client calls">{JSON.stringify(harness.calls)}</output>
        <output aria-label="Established publications">{JSON.stringify(publications)}</output>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => setSelected("B")}>
            Replace client
          </button>
          <button type="button" onClick={() => setMounted(false)}>
            Unmount entry
          </button>
          <button type="button" onClick={() => setMounted(true)}>
            Mount entry
          </button>
          <button type="button" onClick={() => setCallbackVersion((value) => value + 1)}>
            Use new callback
          </button>
          <button type="button" onClick={() => harness.throwOnStart()}>
            Throw on start
          </button>
          <button type="button" onClick={() => harness.throwOnRetry()}>
            Throw on retry
          </button>
          {(["A", "B"] as const).flatMap((name) =>
            (["start", "retry"] as const).flatMap((action) => [
              <button
                key={`${name}-${action}-resolve`}
                type="button"
                onClick={() => harness.settle(name, action)}
              >
                Resolve {name} {action}
              </button>,
              <button
                key={`${name}-${action}-fail`}
                type="button"
                onClick={() => harness.settle(name, action, true)}
              >
                Fail {name} {action}
              </button>,
            ]),
          )}
        </div>
      </aside>
      <Routes>
        <Route
          path="/"
          element={
            mounted ? (
              <EntryContextPage client={harness.clients[selected]} onEstablished={established} />
            ) : (
              <p>Entry unmounted</p>
            )
          }
        />
        <Route path="/menu" element={<h2>Lifecycle training menu</h2>} />
      </Routes>
    </>
  );
}
