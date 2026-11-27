import { describe, expect, it } from "vitest";
import { equipmentText, parseKitchenStatementView } from "./StoreKitchenStatement.js";

describe("WP-2423 (M178): the kitchen statement on Store setup", () => {
  it("reads the statement and the list to tick from; refuses free text as equipment", () => {
    const view = parseKitchenStatementView({
      status: "Current",
      statement: { handledAllergenCodes: ["PEANUT"], sharedEquipment: ["Woks"] },
      allergenChoices: [{ code: "PEANUT", name: "Peanuts", nameZh: "" }],
    });
    expect(view.statement?.sharedEquipment).toEqual(["Woks"]);
    expect(
      parseKitchenStatementView({ status: "Current", statement: null, allergenChoices: [] })
        .statement,
    ).toBeNull();
    expect(() =>
      parseKitchenStatementView({
        status: "Current",
        statement: { handledAllergenCodes: [], sharedEquipment: ["Our wok"] },
        allergenChoices: [],
      }),
    ).toThrow();
    expect(equipmentText("FryerOil")).toBe("Fryer oil");
  });
});
