import { describe, expect, it, vi } from "vitest";
import {
  createCurrentAvailabilityQueryService,
  type CurrentAvailabilityQueryPorts,
} from "../index.js";
const id = (n: number) => "018f7100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-10T16:00:00.000Z";
const later = "2026-09-10T16:01:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const input = {
  ...scope,
  sellableReference: id(3),
  channelCode: "WEB",
  orderTypeCode: "PICKUP",
  observedAt: at,
};
function rule(change: Record<string, unknown> = {}) {
  return {
    ruleReference: id(4),
    brandReference: id(1),
    internalCode: "SYNTHETIC",
    aggregateVersion: 1,
    lifecycle: "Active",
    sellableReference: id(3),
    sellableType: "Sku",
    storeReference: id(2),
    channelCodes: ["WEB"],
    orderTypeCodes: ["PICKUP"],
    effectiveFrom: at,
    effectiveUntil: null,
    decision: "Available",
    priority: 10,
    reasonCode: "CONFIGURED",
    createdAt: at,
    createdByActorReference: id(5),
    updatedAt: at,
    ...change,
  };
}
function safety(kind = "KillSwitch", change: Record<string, unknown> = {}) {
  return {
    kind,
    ...scope,
    sellableReference: id(3),
    status: kind === "KillSwitch" ? "Clear" : "Available",
    observedAt: at,
    expiresAt: later,
    reasonCode: "SYNTHETIC_CLEAR",
    ...change,
  };
}
function fixture() {
  const ports = {
    rules: {
      loadCurrentRules: vi.fn<CurrentAvailabilityQueryPorts["rules"]["loadCurrentRules"]>(
        async () => [rule()],
      ),
    },
    killSwitch: {
      loadEvidence: vi.fn<CurrentAvailabilityQueryPorts["killSwitch"]["loadEvidence"]>(async () =>
        safety(),
      ),
    },
    inventory: {
      loadEvidence: vi.fn<CurrentAvailabilityQueryPorts["inventory"]["loadEvidence"]>(async () =>
        safety("Inventory"),
      ),
    },
    clock: { now: vi.fn(() => at) },
  };
  return { ports, service: createCurrentAvailabilityQueryService(ports, scope) };
}
const dependency = { code: "CATALOG_DEPENDENCY_UNAVAILABLE", message: "catalog is unavailable" };
describe("current availability evidence composition", () => {
  it("constructs without I/O and preserves frozen observation/input", async () => {
    const f = fixture();
    expect(f.ports.clock.now).not.toHaveBeenCalled();
    expect(f.ports.rules.loadCurrentRules).not.toHaveBeenCalled();
    const result = await f.service.resolveCurrent(input);
    expect(result).toEqual({
      status: "Available",
      reasonCode: "CONFIGURED",
      ruleReference: id(4),
      observedAt: at,
    });
    expect(Object.isFrozen(result)).toBe(true);
    for (const call of [
      f.ports.rules.loadCurrentRules,
      f.ports.killSwitch.loadEvidence,
      f.ports.inventory.loadEvidence,
    ]) {
      expect(call).toHaveBeenCalledWith(input);
      expect(Object.isFrozen(call.mock.calls[0]?.[0])).toBe(true);
    }
  });
  it.each(["killSwitch", "inventory"] as const)("requires %s evidence", async (provider) => {
    const f = fixture();
    f.ports[provider].loadEvidence.mockResolvedValue(null);
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Indeterminate",
      reasonCode: "EVIDENCE_MISSING",
    });
  });
  it.each([
    ["KillSwitch", "Blocked", "Unavailable"],
    ["Inventory", "Unavailable", "Unavailable"],
    ["KillSwitch", "Indeterminate", "Indeterminate"],
    ["Inventory", "Indeterminate", "Indeterminate"],
  ])("honors %s/%s", async (kind, status, expected) => {
    const f = fixture();
    const provider = kind === "KillSwitch" ? f.ports.killSwitch : f.ports.inventory;
    provider.loadEvidence.mockResolvedValue(safety(kind, { status }));
    expect(await f.service.resolveCurrent(input)).toMatchObject({ status: expected });
  });
  it.each([
    { channelCode: "bad code" },
    { sellableReference: "bad" },
    { observedAt: "bad" },
    { extra: true },
  ])("denies malformed input before I/O %j", async (change) => {
    const f = fixture();
    await expect(f.service.resolveCurrent({ ...input, ...change })).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
    expect(f.ports.clock.now).not.toHaveBeenCalled();
    expect(f.ports.rules.loadCurrentRules).not.toHaveBeenCalled();
  });
  it.each(["brandReference", "storeReference"])("denies foreign %s before I/O", async (field) => {
    const f = fixture();
    await expect(f.service.resolveCurrent({ ...input, [field]: id(9) })).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.ports.clock.now).not.toHaveBeenCalled();
  });
  it("does not invoke request accessors", async () => {
    const f = fixture(),
      getter = vi.fn(() => id(3));
    await expect(
      f.service.resolveCurrent(
        Object.defineProperty({ ...input }, "sellableReference", { get: getter }),
      ),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("captures fixed scope and request before awaits", async () => {
    const f = fixture(),
      fixed = { ...scope },
      value = { ...input };
    const service = createCurrentAvailabilityQueryService(f.ports, fixed);
    fixed.brandReference = id(9);
    f.ports.rules.loadCurrentRules.mockImplementation(async () => {
      value.brandReference = id(9);
      value.sellableReference = id(9);
      return [rule()];
    });
    expect(await service.resolveCurrent(value)).toMatchObject({ status: "Available" });
    expect(f.ports.inventory.loadEvidence).toHaveBeenCalledWith(input);
  });
  it("captures rules and first evidence before later waits", async () => {
    const f = fixture(),
      candidate = rule(),
      first = safety();
    f.ports.rules.loadCurrentRules.mockResolvedValue([candidate]);
    f.ports.killSwitch.loadEvidence.mockImplementation(async () => {
      candidate.brandReference = id(9);
      candidate.channelCodes.push("OTHER");
      return first;
    });
    f.ports.inventory.loadEvidence.mockImplementation(async () => {
      first.status = "Blocked";
      first.brandReference = id(9);
      return safety("Inventory");
    });
    expect(await f.service.resolveCurrent(input)).toMatchObject({ status: "Available" });
  });
  it.each(["killSwitch", "inventory"] as const)("bounds %s failures", async (provider) => {
    const f = fixture();
    f.ports[provider].loadEvidence.mockRejectedValue(new Error("synthetic private detail"));
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
  });
  it.each([
    { brandReference: id(9) },
    { storeReference: id(9) },
    { sellableReference: id(9) },
    { kind: "Inventory" },
    { status: "Available" },
    { extra: true },
  ])("rejects malformed/foreign safety %j", async (change) => {
    const f = fixture();
    f.ports.killSwitch.loadEvidence.mockResolvedValue(safety("KillSwitch", change));
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
  });
  it("rejects a foreign first owner result before consulting the next owner", async () => {
    const f = fixture();
    f.ports.killSwitch.loadEvidence.mockResolvedValue(
      safety("KillSwitch", { brandReference: id(9) }),
    );
    f.ports.inventory.loadEvidence.mockResolvedValue(null);
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
    expect(f.ports.inventory.loadEvidence).not.toHaveBeenCalled();
  });
  it("rejects two copies of the same safety kind", async () => {
    const f = fixture();
    f.ports.inventory.loadEvidence.mockResolvedValue(safety());
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
  });
  it("does not coerce an executable status", async () => {
    const f = fixture(),
      toString = vi.fn(() => "Clear");
    f.ports.killSwitch.loadEvidence.mockResolvedValue(
      safety("KillSwitch", { status: { toString } }),
    );
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
    expect(toString).not.toHaveBeenCalled();
  });
  it("does not invoke evidence getters", async () => {
    const f = fixture(),
      getter = vi.fn(() => "Clear");
    f.ports.killSwitch.loadEvidence.mockResolvedValue(
      Object.defineProperty(safety(), "status", { get: getter }),
    );
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects future observations before owner I/O", async () => {
    const f = fixture();
    expect(await f.service.resolveCurrent({ ...input, observedAt: later })).toMatchObject({
      status: "Indeterminate",
      reasonCode: "EVIDENCE_INVALID",
    });
    expect(f.ports.rules.loadCurrentRules).not.toHaveBeenCalled();
  });
  it.each(["killSwitch", "inventory"] as const)(
    "checks %s expiry at final clock",
    async (provider) => {
      const f = fixture();
      f.ports[provider].loadEvidence.mockResolvedValue(
        safety(provider === "killSwitch" ? "KillSwitch" : "Inventory"),
      );
      f.ports.clock.now.mockReturnValueOnce(at).mockReturnValue(later);
      expect(await f.service.resolveCurrent(input)).toMatchObject({
        status: "Indeterminate",
        reasonCode: "EVIDENCE_INVALID",
      });
    },
  );
  it("denies safety observed after query observation", async () => {
    const f = fixture();
    f.ports.killSwitch.loadEvidence.mockResolvedValue(
      safety("KillSwitch", { observedAt: "2026-09-10T16:00:01.000Z" }),
    );
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Indeterminate",
      reasonCode: "EVIDENCE_INVALID",
    });
  });
  it.each(["bad", "2026-09-10T15:59:59.000Z"])("rejects invalid/reversed clock %s", async (now) => {
    const f = fixture();
    f.ports.clock.now.mockReturnValueOnce(at).mockReturnValue(now);
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
  });
  it("preserves ambiguous Store decisions", async () => {
    const f = fixture();
    f.ports.rules.loadCurrentRules.mockResolvedValue([
      rule(),
      rule({ ruleReference: id(6), decision: "Unavailable" }),
    ]);
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Indeterminate",
      reasonCode: "AMBIGUOUS_RULE",
    });
  });
  it("preserves Store specificity despite higher Brand priority", async () => {
    const f = fixture();
    f.ports.rules.loadCurrentRules.mockResolvedValue([
      rule({ ruleReference: id(6), storeReference: null, priority: 1000, decision: "Unavailable" }),
      rule(),
    ]);
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Available",
      ruleReference: id(4),
    });
  });
  it("does not substitute a new winner if the observed rule expires during waits", async () => {
    const f = fixture();
    f.ports.rules.loadCurrentRules.mockResolvedValue([
      rule({ effectiveUntil: "2026-09-10T16:00:01.000Z" }),
      rule({ ruleReference: id(6), storeReference: null }),
    ]);
    f.ports.clock.now.mockReturnValueOnce(at).mockReturnValue("2026-09-10T16:00:02.000Z");
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Indeterminate",
      reasonCode: "RULE_OBSERVATION_CHANGED",
    });
  });
  it("does not grant availability without rules", async () => {
    const f = fixture();
    f.ports.rules.loadCurrentRules.mockResolvedValue([]);
    expect(await f.service.resolveCurrent(input)).toMatchObject({
      status: "Indeterminate",
      reasonCode: "NO_EFFECTIVE_RULE",
    });
  });
  it.each([
    { brandReference: id(9) },
    { storeReference: id(9) },
    { sellableReference: id(9) },
    { sellableType: "Product" },
    { lifecycle: "Inactive" },
    { channelCodes: ["OTHER"] },
    { orderTypeCodes: ["OTHER"] },
    { effectiveFrom: later },
    { updatedAt: later },
  ])("rejects invalid candidates %j", async (change) => {
    const f = fixture();
    f.ports.rules.loadCurrentRules.mockResolvedValue([rule(change)]);
    await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
  });
  it.each(["rows", "channelCodes", "orderTypeCodes"])(
    "rejects executable collections %s",
    async (field) => {
      const f = fixture(),
        map = vi.fn(() => []);
      const value = field === "rows" ? [rule()] : ["OTHER"];
      Object.defineProperty(value, "map", { value: map });
      f.ports.rules.loadCurrentRules.mockResolvedValue(
        field === "rows" ? value : [rule({ [field]: value })],
      );
      await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
      expect(map).not.toHaveBeenCalled();
    },
  );
  it.each([{ value: null }, { value: new Array(1) }, { value: [rule(), rule()] }])(
    "rejects missing/sparse/duplicate rule data",
    async ({ value }) => {
      const f = fixture();
      f.ports.rules.loadCurrentRules.mockResolvedValue(value);
      await expect(f.service.resolveCurrent(input)).rejects.toMatchObject(dependency);
    },
  );
});
