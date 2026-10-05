import { expect, test } from "bun:test";

import {
  confirmCommandPattern,
  identity,
  mentionPattern,
  operationMarker,
  userAgent,
} from "./index";

test("exposes the approved runtime identifiers", () => {
  expect(identity).toEqual({
    displayName: "Oriel",
    codeName: "oriel",
    cliName: "oriel",
    applicationDataDirectoryName: "oriel",
    npmPackageName: "@mikan-919/oriel",
    environmentPrefix: "ORIEL_",
    proposalLabel: "oriel:proposed",
    executionConfigFileName: ".oriel.yaml",
    checkpointAuthor: { name: "Oriel", email: "oriel@oriel.invalid" },
    workspaceDocuments: [
      "CONCEPT.md",
      "ROADMAP.md",
      "FEATURE.md",
      "HANDOFF.md",
    ],
    driftWatchedDocuments: ["CONCEPT.md", "ROADMAP.md"],
  });
});

test("derives the User-Agent from the supplied distribution version", () => {
  expect(userAgent("0.0.0")).toBe("oriel/0.0.0");
  expect(userAgent("1.2.3")).toBe("oriel/1.2.3");
});

test("matches the confirm command only at the start of a comment", () => {
  expect(confirmCommandPattern.test("/oriel confirm go ahead")).toBe(true);
  expect(confirmCommandPattern.test("  /Oriel Confirm")).toBe(true);
  expect(confirmCommandPattern.test("please run /oriel confirm")).toBe(false);
  expect(confirmCommandPattern.test("/oriel confirmation")).toBe(false);
  expect(confirmCommandPattern.test("/orielconfirm")).toBe(false);
});

test("matches a mention only on a whole word", () => {
  expect(mentionPattern.test("hey @oriel what do you think?")).toBe(true);
  expect(mentionPattern.test("@ORIEL")).toBe(true);
  expect(mentionPattern.test("@orielle")).toBe(false);
  expect(mentionPattern.test("oriel")).toBe(false);
});

test("marks an external comment with the operation it came from", () => {
  expect(operationMarker("operation-1")).toBe(
    "<!-- oriel-operation:operation-1 -->",
  );
});
