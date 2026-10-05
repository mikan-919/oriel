import { join } from "node:path";

import { expect, test } from "bun:test";

import { identity } from "@mikan-919/oriel-identity";

import { resolveStatePath } from "./state-path";

test("an explicitly configured state path takes priority", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      explicitPath: join(
        "/var/lib",
        identity.applicationDataDirectoryName,
        "custom.sqlite",
      ),
      xdgDataHome: "/xdg/data",
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe(
    join("/var/lib", identity.applicationDataDirectoryName, "custom.sqlite"),
  );
  expect(directories).toEqual([
    join("/var/lib", identity.applicationDataDirectoryName),
  ]);
});

test("the XDG data home is used for the default state path", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      xdgDataHome: "/xdg/data",
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe(
    join("/xdg/data", identity.applicationDataDirectoryName, "state.sqlite"),
  );
  expect(directories).toEqual([
    join("/xdg/data", identity.applicationDataDirectoryName),
  ]);
});

test("the default state path uses the user's local data directory", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe(
    join(
      "/home/tester",
      ".local",
      "share",
      identity.applicationDataDirectoryName,
      "state.sqlite",
    ),
  );
  expect(directories).toEqual([
    join(
      "/home/tester",
      ".local",
      "share",
      identity.applicationDataDirectoryName,
    ),
  ]);
});
