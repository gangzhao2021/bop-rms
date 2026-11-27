import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * WP-2423 M121: on a phone a plain table becomes one card per row (packages/ui tokens.css), and
 * each cell says its column through data-label. Without it a product row read "Main 1 of 1 HST".
 * Each row's first cell is the row's name and needs no label.
 */
it("WP-2423 M121: product, price and recipe tables name every column on a phone", () => {
  for (const file of ["ProductPages.tsx", "StorePricePages.tsx", "RecipePages.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const bodies = source.split("<tbody>").slice(1);
    for (const body of bodies) {
      const rows = body
        .slice(0, body.indexOf("</tbody>"))
        .split(/<tr[\s>]/u)
        .slice(1);
      for (const row of rows) {
        // Each cell with what it holds; a cell holding only the row's buttons needs no label.
        const cells = row.split(/(?=<td[\s>])/u).slice(1);
        const unlabelled = cells
          .slice(1)
          .filter((cell) => !/^<td[^>]*data-label/u.test(cell))
          .filter((cell) => !cell.slice(0, cell.indexOf("</td>")).includes("<button"))
          .map((cell) => cell.slice(0, 60));
        expect({ file, unlabelled }).toEqual({ file, unlabelled: [] });
      }
    }
  }
});
