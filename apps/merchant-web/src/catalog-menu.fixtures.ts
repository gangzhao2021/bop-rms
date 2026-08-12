const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export function menuListFixture() {
  return {
    schemaVersion: 1,
    projection: {
      name: "catalog_menu_management_v1",
      version: 1,
      asOfUtc: "2026-08-12T12:00:00.000Z",
      stale: false,
      partial: false,
    },
    items: [
      {
        menuReference: id(1),
        menuVersionReference: id(2),
        internalCode: "ALL_DAY",
        name: "Synthetic All Day",
        lifecycle: "Approved",
        version: 4,
        updatedAt: "2026-08-12T11:00:00.000Z",
      },
    ],
    nextCursor: null,
  };
}

export function menuBuilderFixture() {
  return {
    screenId: "CAT-MENU-BUILDER",
    menuReference: id(1),
    menuVersionReference: id(2),
    internalCode: "ALL_DAY",
    name: "Synthetic All Day",
    lifecycle: "Approved",
    version: 4,
    asOfUtc: "2026-08-12T12:00:00.000Z",
    scopeSummary: "Synthetic Brand scope",
    channelSummary: "Pickup",
    sections: [
      { sectionReference: id(3), name: "Synthetic mains", placementCount: 2, validation: "Valid" },
      {
        sectionReference: id(4),
        name: "Synthetic drinks",
        placementCount: 1,
        validation: "Invalid",
      },
    ],
    unresolvedIssueCount: 1,
    publishEvidence: "Required",
  };
}
