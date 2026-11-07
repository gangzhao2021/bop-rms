import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import {
  staffContentLocale,
  staffContentLocaleMiddleware,
  staffContentName,
  staffNameLocales,
} from "./staff-content-locale.js";

async function ask(header: string | undefined) {
  const app = express();
  app.use(staffContentLocaleMiddleware());
  app.get("/merchant/x", (_request, response) => {
    // Read inside a later tick, as an owner read in the request would.
    setImmediate(() =>
      response.json({
        locale: staffContentLocale(),
        locales: staffNameLocales("en-CA"),
        latte: staffContentName({ "en-CA": "Latte", "zh-Hans-CA": "拿铁" }, "en-CA"),
        bagel: staffContentName({ "en-CA": "Plain bagel" }, "en-CA"),
      }),
    );
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/merchant/x`,
      header === undefined ? {} : { headers: { "x-bop-content-locale": header } },
    );
    return await response.json();
  } finally {
    server.close();
  }
}

it("Owner 2026-10-24: names Store content in the staff member's chosen language, else the Store's", async () => {
  expect(await ask("zh-Hans-CA")).toEqual({
    locale: "zh-Hans-CA",
    locales: ["zh-Hans-CA", "en-CA"],
    latte: "拿铁",
    bagel: "Plain bagel",
  });
  for (const header of [undefined, "zh_CN", "zh-Hans-CA, en"])
    expect(await ask(header)).toEqual({
      locale: null,
      locales: ["en-CA"],
      latte: "Latte",
      bagel: "Plain bagel",
    });
  // Outside a request: the Store's own language.
  expect(staffContentLocale()).toBeNull();
  expect(staffContentName({ "fr-CA": "Thé" }, "en-CA")).toBe("Thé");
  expect(staffContentName({}, "en-CA")).toBe("");
});
