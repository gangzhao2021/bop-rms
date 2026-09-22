import { expect, it } from "vitest";
import { bindWorkflowPublicationSnapshot, createWorkflowPublicationSnapshot } from "../index.js";
import { definition, id } from "./workflow-definition.fixture.js";
const draft = () =>
  definition({ lifecycle: "Draft", publicationReference: null, approvalEvidenceReference: null });
it("binds the complete original Draft snapshot to its Published successor", () => {
  const original = draft();
  const published = {
    ...original,
    versionNumber: 2,
    versionReference: id(90),
    lifecycle: "Published",
    publicationReference: id(91),
    approvalEvidenceReference: id(92),
  };
  const snapshot = bindWorkflowPublicationSnapshot(published, original);
  expect(snapshot.snapshotReference).toBe(original.versionReference);
  expect(snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(snapshot).toEqual(createWorkflowPublicationSnapshot(original));
  expect(() =>
    bindWorkflowPublicationSnapshot({ ...published, purposeCode: "Changed" }, original),
  ).toThrow();
  expect(() =>
    bindWorkflowPublicationSnapshot({ ...published, versionNumber: 3 }, original),
  ).toThrow();
  expect(() => createWorkflowPublicationSnapshot(published)).toThrow();
  const changed = { ...original, effectiveUntil: "2026-09-12T10:00:00.000Z" };
  expect(createWorkflowPublicationSnapshot(changed).snapshotDigest).not.toBe(
    snapshot.snapshotDigest,
  );
});
