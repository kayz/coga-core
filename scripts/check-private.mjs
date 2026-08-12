import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const privateRoot = "private/application";
if (!existsSync(`${privateRoot}/package.json`)) {
  console.log(
    "No local-only application is present; public checks are complete.",
  );
  process.exit(0);
}

const manifest = spawnSync(
  process.execPath,
  [
    "../../packages/core/dist/cli.js",
    "validate",
    "local-instance.yaml",
    "--profile",
    "local",
    "--root",
    "../..",
  ],
  {
    cwd: privateRoot,
    stdio: "inherit",
  },
);
if (manifest.status !== 0) process.exit(manifest.status ?? 1);

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  console.error("Run this integration gate through 'npm run check:local'.");
  process.exit(2);
}

for (const script of ["typecheck", "test", "build"]) {
  const result = spawnSync(
    process.execPath,
    [npmExecPath, "run", script, "--if-present"],
    {
      cwd: privateRoot,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Local-only application checks passed.");
