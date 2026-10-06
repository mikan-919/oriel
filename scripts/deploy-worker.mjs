import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// cf beta.5 hardcodes strict uploads, blocking intentional config migrations.
// Keep cloudflare.config.ts authoritative; adapt its build output, not a second config.
const { readBuildOutput } = await import(pathToFileURL(join(process.cwd(), "node_modules/@cloudflare/build-output-utils/dist/index.mjs")));
const { convertToWranglerConfig } = await import(pathToFileURL(join(process.cwd(), "node_modules/@cloudflare/config/dist/index.mjs")));
const output = await readBuildOutput(process.cwd());
const worker = output.workers.default;
const config = convertToWranglerConfig({
  ...output.rootConfig,
  containers: [],
  worker: { ...worker.config, entrypoint: join(worker.bundleDir, worker.config.manifest.mainModule) },
});
config.no_bundle = true;
config.find_additional_modules = true;
if (worker.assetsDir) config.assets.directory = worker.assetsDir;
const configPath = join(process.cwd(), ".cloudflare", "wrangler-deploy.json");
await writeFile(configPath, JSON.stringify(config, null, 2));
const result = spawnSync("npx", ["--no-install", "wrangler", "deploy", "--config", configPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
