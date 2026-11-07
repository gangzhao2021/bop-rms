import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertKitchenRoutingRevision,
  parseKitchenRoutingConfigurationRecord,
  rebindKitchenRoutingEvidence,
} from "../domain/station-routing-configuration.js";
const id = (n: number) => "0190aaaa-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const at = "2026-09-12T10:00:00.000Z";
function fixture() {
  return parseKitchenRoutingConfigurationRecord(
    {
      operationReference: id(1),
      actorReference: id(2),
      purposeCode: "SyntheticConfiguration",
      permissionCode: "synthetic.configure",
      reasonCode: "SYNTHETIC_SETUP",
      recordedAt: at,
      expectedVersion: 0,
      configuration: rebindKitchenRoutingEvidence(
        {
          brandReference: id(3),
          storeReference: id(4),
          evidenceReference: id(5),
          evidenceVersion: 1,
          effectiveAt: at,
          evidenceDigest: hash("placeholder"),
          candidates: [
            {
              stationReference: id(6),
              stationVersion: 1,
              stationStatus: "Active",
              stationCapabilityReferences: [id(7)],
              routingRuleReference: id(8),
              routingRuleVersion: 1,
              routingRuleStatus: "Active",
              selector: { kind: "AllPreparedItems" },
              targetStationReference: id(6),
              routingRuleDigest: hash("placeholder"),
            },
          ],
        },
        at,
        hash,
      ),
    },
    hash,
  );
}
describe("persisted single-Station configuration", () => {
  it("binds a validated configuration to the exact later release instant without mutating history", () => {
    const record = fixture();
    const later = "2026-09-12T10:00:01.000Z";
    const evidence = rebindKitchenRoutingEvidence(record.configuration, later, hash);
    expect(evidence.evidenceReference).toBe(record.configuration.evidenceReference);
    expect(evidence.evidenceVersion).toBe(1);
    expect(evidence.effectiveAt).toBe(later);
    expect(evidence.evidenceDigest).not.toBe(record.configuration.evidenceDigest);
    expect(evidence.candidates[0]?.routingRuleDigest).not.toBe(
      record.configuration.candidates[0]?.routingRuleDigest,
    );
    expect(record.configuration.effectiveAt).toBe(at);
    assertKitchenRoutingRevision(null, record);
  });
  it.each([
    ["unexpected field", { unknown: true }],
    ["backdated configuration", { recordedAt: "2026-09-12T10:00:01.000Z" }],
    ["negative version", { expectedVersion: -1 }],
    ["mismatched version", { expectedVersion: 1 }],
    ["overflow version", { expectedVersion: 2147483647 }],
    ["unnamed actor", { actorReference: null }],
    ["unbounded purpose", { purposeCode: "bad purpose" }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      parseKitchenRoutingConfigurationRecord({ ...fixture(), ...patch }, hash),
    ).toThrow();
  });
  it("rejects altered content even when the configuration's outer hash was copied", () => {
    const record = fixture();
    expect(() =>
      parseKitchenRoutingConfigurationRecord(
        {
          ...record,
          configuration: { ...record.configuration, evidenceDigest: hash("altered") },
        },
        hash,
      ),
    ).toThrow();
  });
  it("rejects a rule targeting a different Station", () => {
    const record = fixture();
    const candidate = record.configuration.candidates[0];
    const configuration = rebindKitchenRoutingEvidence(
      {
        ...record.configuration,
        candidates: [{ ...candidate, targetStationReference: id(9) }],
      },
      at,
      hash,
    );
    expect(() =>
      parseKitchenRoutingConfigurationRecord({ ...record, configuration }, hash),
    ).toThrow();
  });
  it("requires owner version increments when capabilities or active status change", () => {
    const record = fixture();
    const candidate = record.configuration.candidates[0];
    const changed = parseKitchenRoutingConfigurationRecord(
      {
        ...record,
        operationReference: id(10),
        expectedVersion: 1,
        configuration: rebindKitchenRoutingEvidence(
          {
            ...record.configuration,
            evidenceReference: id(11),
            evidenceVersion: 2,
            candidates: [
              { ...candidate, stationStatus: "Inactive", routingRuleStatus: "Inactive" },
            ],
          },
          "2026-09-12T10:00:01.000Z",
          hash,
        ),
      },
      hash,
    );
    expect(() => assertKitchenRoutingRevision(record, changed)).toThrow();
    const incremented = parseKitchenRoutingConfigurationRecord(
      {
        ...changed,
        configuration: rebindKitchenRoutingEvidence(
          {
            ...changed.configuration,
            candidates: [
              { ...changed.configuration.candidates[0], stationVersion: 2, routingRuleVersion: 2 },
            ],
          },
          changed.configuration.effectiveAt,
          hash,
        ),
      },
      hash,
    );
    expect(() => assertKitchenRoutingRevision(record, incremented)).not.toThrow();
  });
  it("does not reset versions after removal and later reintroduction of an identity", () => {
    const initial = fixture();
    const removed = parseKitchenRoutingConfigurationRecord(
      {
        ...initial,
        operationReference: id(12),
        expectedVersion: 1,
        configuration: rebindKitchenRoutingEvidence(
          {
            ...initial.configuration,
            evidenceReference: id(13),
            evidenceVersion: 2,
            candidates: [],
          },
          "2026-09-12T10:00:01.000Z",
          hash,
        ),
      },
      hash,
    );
    const candidate = initial.configuration.candidates[0];
    const restored = parseKitchenRoutingConfigurationRecord(
      {
        ...initial,
        operationReference: id(14),
        expectedVersion: 2,
        configuration: rebindKitchenRoutingEvidence(
          {
            ...initial.configuration,
            evidenceReference: id(15),
            evidenceVersion: 3,
            candidates: [{ ...candidate, stationCapabilityReferences: [] }],
          },
          "2026-09-12T10:00:02.000Z",
          hash,
        ),
      },
      hash,
    );
    expect(() => assertKitchenRoutingRevision(removed, restored, candidate, candidate)).toThrow();
  });
  it("rejects effective-time regression even with the next configuration version", () => {
    const initial = fixture();
    const next = parseKitchenRoutingConfigurationRecord(
      {
        ...initial,
        expectedVersion: 1,
        configuration: rebindKitchenRoutingEvidence(
          {
            ...initial.configuration,
            evidenceReference: id(16),
            evidenceVersion: 2,
          },
          at,
          hash,
        ),
      },
      hash,
    );
    expect(() => assertKitchenRoutingRevision(initial, next)).toThrow();
  });
});
