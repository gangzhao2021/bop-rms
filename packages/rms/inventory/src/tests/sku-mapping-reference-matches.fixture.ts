import {
  buildInventoryConfigurationReferenceSnapshot,
  buildInventorySkuMappingReferenceSnapshot,
  type InventoryConfigurationReferenceRequest,
} from "../index.js";
export const mappingMatchId = (n: number) =>
  `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const mappingMatchAt = "2026-09-29T12:00:00.000Z";
export const mappingMatchHash = "sha256:" + "a".repeat(64);
export function mappingMatchSource(
  request: InventoryConfigurationReferenceRequest,
  digest = mappingMatchHash,
  cleared = false,
  now = mappingMatchAt,
) {
  const id = mappingMatchId,
    scope = { tenantReference: request.tenantReference, brandReference: request.brandReference };
  const rows = [
    [6, 1, 7],
    [6, 2, 17],
    [20, 1, 27],
    [30, 1, 37],
  ];
  const base = buildInventoryConfigurationReferenceSnapshot(
    {
      generation: "14",
      observedAt: now,
      counts: { items: "3", versions: "4", operations: "4" },
      items: [6, 20, 30].map((n) => ({
        ...scope,
        itemReference: id(n),
        itemType: n === 30 ? "RawMaterial" : "FinishedGood",
        createdAt: mappingMatchAt,
        precise: true,
      })),
      versions: rows.map(([n = 0, v = 0]) => ({
        ...scope,
        itemReference: id(n),
        itemVersion: String(v),
        itemType: n === 30 ? "RawMaterial" : "FinishedGood",
        lifecycle: "Inactive",
        recordedAt: mappingMatchAt,
        precise: true,
      })),
      operations: rows.map(([n = 0, v = 0, o = 0]) => ({
        ...scope,
        itemReference: id(n),
        itemVersion: String(v),
        operationReference: id(o),
        action: v === 1 ? "Create" : "Update",
      })),
    },
    request,
    now,
  );
  return buildInventorySkuMappingReferenceSnapshot(
    {
      generation: "14",
      observedAt: now,
      count: cleared ? "2" : "1",
      mappings: (cleared ? [1, 2] : [1]).map((v) => ({
        ...scope,
        mappingReference: id(5),
        itemReference: id(6),
        mappingVersion: String(v),
        sourceItemVersion: String(v),
        sourceConfigurationOperationReference: id(v === 1 ? 7 : 17),
        action: v === 1 ? "Set" : "Clear",
        target:
          v === 1
            ? {
                productReference: id(8),
                productVersionReference: id(9),
                skuReference: id(10),
                catalogConfigurationDigest: digest,
              }
            : null,
        operationReference: id(40 + v),
        mappingIntentDigest: mappingMatchHash,
        occurredAt: mappingMatchAt,
        precise: true,
      })),
    },
    base,
    request,
    now,
  );
}
