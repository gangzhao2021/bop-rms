import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import { BrandLifecyclePanel } from "./BrandLifecyclePanel.js";
import {
  BrandLifecycleClientError,
  createMerchantBrandLifecycleClient,
} from "./merchant-brand-lifecycle-client.js";
import type { BrandLifecycleJournal } from "./brand-lifecycle-journal.js";
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) },
  props = { scope, csrf: "c".repeat(43), onRefresh: () => undefined };
it("offers real Draft and Suspended activation with named current identity and no implicit command", () => {
  for (const lifecycle of ["Draft", "Suspended"] as const) {
    const html = renderToStaticMarkup(
      <BrandLifecyclePanel
        {...props}
        brand={{ label: "Synthetic Brand", lifecycle, version: 4 }}
      />,
    );
    expect(html).toContain("Activate Brand");
    expect(html).toContain("Archive Brand");
    expect(html).toContain(`Current Synthetic Brand: ${lifecycle}`);
    expect(html).toContain("version 4");
    expect(html).not.toContain(props.csrf);
    expect(html).not.toContain(id(2));
    expect(html).not.toContain("Confirm Activate Brand");
  }
});
it("does not offer activation for Active or commands for Archived, and stays fail-closed until journal loads", () => {
  const active = renderToStaticMarkup(
    <BrandLifecyclePanel
      {...props}
      brand={{ label: "Synthetic Brand", lifecycle: "Active", version: 4 }}
    />,
  );
  expect(active).not.toContain("Activate Brand");
  expect(active).toContain('disabled=""');
  const archived = renderToStaticMarkup(
    <BrandLifecyclePanel
      {...props}
      brand={{ label: "Synthetic Brand", lifecycle: "Archived", version: 5 }}
    />,
  );
  expect(archived).not.toContain("Archive Brand");
  expect(archived).not.toContain("Activate Brand");
});
it("keeps the new Actor ready when an old request recovery load rejects late", async () => {
  // Controlled hooks exercise the component's async scope race without a DOM dependency.
  const states: unknown[] = [],
    refs: { current: unknown }[] = [],
    effects: (() => undefined | (() => void))[] = [];
  let stateIndex = 0,
    refIndex = 0;
  vi.resetModules();
  vi.doMock("react", async () => ({
    ...(await vi.importActual<typeof import("react")>("react")),
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [
        states[index],
        (value: unknown) => {
          states[index] = value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = refIndex++;
      return (refs[index] ??= { current: initial });
    },
    useEffect: (effect: () => undefined | (() => void)) => {
      effects.push(effect);
    },
  }));
  try {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { BrandLifecyclePanel: Panel } = await import("./BrandLifecyclePanel.js"),
      original = createMerchantBrandLifecycleClient().prepare(scope, "ActivateBrand", 4, id(10));
    let rejectOldLoad: (reason: unknown) => void = () => undefined,
      recoveryReached: () => void = () => undefined,
      loads = 0;
    const reached = new Promise<void>((resolve) => {
        recoveryReached = resolve;
      }),
      oldLoad = new Promise<null>((_resolve, reject) => {
        rejectOldLoad = reject;
      }),
      oldJournal: BrandLifecycleJournal = {
        load: () => {
          loads++;
          if (loads === 3) {
            recoveryReached();
            return oldLoad;
          }
          return Promise.resolve(original);
        },
        reserve: async () => undefined,
        complete: async () => undefined,
        releaseConflict: async () => undefined,
      },
      newJournal: BrandLifecycleJournal = { ...oldJournal, load: async () => null },
      client = {
        ...createMerchantBrandLifecycleClient(),
        execute: async () => {
          throw new BrandLifecycleClientError("OutcomeUnknown");
        },
      },
      journalFactory = (selected: typeof scope) =>
        selected.actorReference === scope.actorReference ? oldJournal : newJournal,
      render = (selected: typeof scope) => {
        stateIndex = 0;
        refIndex = 0;
        return Panel({
          ...props,
          scope: selected,
          brand: { label: "Synthetic Brand", lifecycle: "Draft", version: 4 },
          client,
          journalFactory,
        });
      };
    render(scope);
    const firstEffect = effects[0];
    if (!firstEffect) throw new Error("Expected initial lifecycle effect");
    const cleanup = firstEffect();
    await Promise.resolve();
    let clicked = false;
    const clickRetry = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
        if (
          child.type === "button" &&
          child.props.children === "Retry original lifecycle request"
        ) {
          child.props.onClick?.();
          clicked = true;
        } else clickRetry(child.props.children);
      });
    };
    clickRetry(render(scope));
    expect(clicked).toBe(true);
    await reached;
    if (typeof cleanup === "function") cleanup();
    const nextScope = { ...scope, actorReference: id(3) };
    render(nextScope);
    const nextEffect = effects.at(-1);
    if (!nextEffect) throw new Error("Expected new Actor lifecycle effect");
    nextEffect();
    await Promise.resolve();
    expect(renderToStaticMarkup(render(nextScope))).not.toContain('disabled=""');
    rejectOldLoad(new BrandLifecycleClientError("Unavailable"));
    await oldLoad.catch(() => undefined);
    expect(renderToStaticMarkup(render(nextScope))).not.toContain('disabled=""');
    expect(states[3]).toBe("Ready");
  } finally {
    vi.doUnmock("react");
    vi.resetModules();
    vi.unstubAllGlobals();
  }
});
