import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const source = new URL("../src/", import.meta.url);
const destination = new URL("../dist/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all((await readdir(source))
  .filter((name) => name.endsWith(".json"))
  .map((name) => copyFile(new URL(name, source), new URL(name, destination))));
