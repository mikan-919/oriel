import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { identity } from "@mikan-919/oriel-identity";

export function resolveStatePath(options: {
  explicitPath?: string;
  xdgDataHome?: string;
  homeDirectory?: string;
  ensureDirectory?: (directory: string) => void;
}): string {
  const {
    explicitPath,
    xdgDataHome,
    homeDirectory = homedir(),
    ensureDirectory = (directory) => mkdirSync(directory, { recursive: true }),
  } = options;
  const dataHome = xdgDataHome ?? join(homeDirectory, ".local", "share");
  const statePath =
    explicitPath ??
    join(dataHome, identity.applicationDataDirectoryName, "state.sqlite");

  ensureDirectory(dirname(statePath));

  return statePath;
}
