import { describe, expect, it } from "vitest";
import { parseRecipePreparationPublication } from "../domain/recipe-preparation-publication.js";
import {
  preparationPublicationFixture,
  preparationTestHash,
} from "./recipe-preparation-publication.fixture.js";
describe("Recipe preparation review binding", () => {
  it("binds independent reviews to the exact preparation content", () => {
    const f = preparationPublicationFixture();
    expect(
      parseRecipePreparationPublication(f.record, f.snapshot, null, preparationTestHash),
    ).toEqual(f.record);
    expect(f.record.reviewEvidence.contentDigest).toBe(f.record.content.contentDigest);
  });
  it.each([
    [
      "wrong content",
      ["reviewEvidence", "contentReference"],
      "0190cccc-0000-7000-8000-000000000999",
    ],
    ["wrong digest", ["reviewEvidence", "contentDigest"], preparationTestHash("changed")],
    ["missing review", ["reviewEvidence", "reviews"], []],
    [
      "same reviewers",
      ["reviewEvidence", "reviews", "1", "reviewerActorReference"],
      "0190cccc-0000-7000-8000-000000000004",
    ],
    [
      "author reviewing",
      ["reviewEvidence", "reviews", "0", "reviewerActorReference"],
      "0190cccc-0000-7000-8000-000000000003",
    ],
    [
      "wrong author",
      ["reviewEvidence", "draftAuthorActorReference"],
      "0190cccc-0000-7000-8000-000000000009",
    ],
    ["duplicate kind", ["reviewEvidence", "reviews", "1", "reviewKind"], "Cost"],
    ["rejected review", ["reviewEvidence", "reviews", "1", "decision"], "Rejected"],
    ["future review", ["reviewEvidence", "reviews", "1", "reviewedAt"], "2026-09-12T10:00:00.000Z"],
    [
      "review predates authorship",
      ["reviewEvidence", "reviews", "1", "reviewedAt"],
      "2026-08-12T10:00:00.000Z",
    ],
    ["authoring before version", ["authoredAt"], "2026-08-12T10:00:00.000Z"],
    ["publication before authoring", ["publishedAt"], "2026-08-12T10:00:00.000Z"],
    ["unknown field", ["unexpected"], true],
  ] as const)("rejects %s", (_name, path, value) => {
    const f = preparationPublicationFixture();
    const copy = JSON.parse(JSON.stringify(f.record)) as Record<string, unknown>;
    let target = copy;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const last = path.at(-1);
    if (last === undefined) throw new Error("fixture mutation path missing");
    target[last] = value;
    expect(() =>
      parseRecipePreparationPublication(copy, f.snapshot, null, preparationTestHash),
    ).toThrow();
  });
  it("normalizes review ordering for exact operation replay", () => {
    const f = preparationPublicationFixture();
    expect(
      parseRecipePreparationPublication(
        {
          ...f.record,
          reviewEvidence: {
            ...f.record.reviewEvidence,
            reviews: [...f.record.reviewEvidence.reviews].reverse(),
          },
        },
        f.snapshot,
        null,
        preparationTestHash,
      ),
    ).toEqual(f.record);
  });
});
