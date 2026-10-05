import { expect, test } from "bun:test";

import identityPackageManifest from "../../../packages/identity/package.json" with { type: "json" };
import rootPackageManifest from "../../../package.json" with { type: "json" };
import servePackageManifest from "../package.json" with { type: "json" };
import { identity } from "@mikan-919/oriel-identity";

const cliUrl = new URL("../../../dist/cli.js", import.meta.url);

test("the built CLI has a Bun shebang and prints the distribution version", async () => {
  const cliSource = await Bun.file(cliUrl).text();
  const bun = Bun.which("bun");

  if (bun === null) {
    throw new Error("Bun executable was not found");
  }

  const child = Bun.spawn([bun, cliUrl.pathname, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(cliSource.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe(`${rootPackageManifest.version}\n`);
});

test("the package manifests align with the public runtime identity", async () => {
  const bunVersion = (
    await Bun.file(new URL("../../../.bun-version", import.meta.url)).text()
  ).trim();

  expect(rootPackageManifest.name).toBe(identity.npmPackageName);
  expect(Object.keys(rootPackageManifest.bin)).toEqual([identity.cliName]);
  expect(rootPackageManifest.packageManager).toBe(`bun@${bunVersion}`);
  expect(rootPackageManifest.devDependencies["@types/bun"]).toBe(bunVersion);
  expect(identityPackageManifest.private).toBe(true);
  expect(servePackageManifest.private).toBe(true);
});
