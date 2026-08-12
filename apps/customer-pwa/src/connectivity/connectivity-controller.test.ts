import { describe, expect, it } from "vitest";
import { createConnectivityController } from "./connectivity-controller.js";

describe("WP-1707 connectivity shell controller", () => {
  it("announces offline and restored without accepting a business callback", () => {
    const controller = createConnectivityController(true);
    expect(controller.getState()).toEqual({ status: "online" });
    controller.setOnline(false);
    expect(controller.getState()).toEqual({ status: "offline" });
    controller.setOnline(true);
    expect(controller.getState()).toEqual({ status: "restored" });
    controller.dismissRestored();
    expect(controller.getState()).toEqual({ status: "online" });
  });

  it("does not turn an ordinary online event into a retry notice", () => {
    const controller = createConnectivityController(true);
    controller.setOnline(true);
    expect(controller.getState()).toEqual({ status: "online" });
  });

  it("stops publishing after disposal", () => {
    const controller = createConnectivityController(false);
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });
    controller.dispose();
    controller.setOnline(false);
    expect(publications).toBe(0);
    expect(controller.getState()).toEqual({ status: "online" });
  });
});
