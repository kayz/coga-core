import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error("npm_execpath is required to run the Factory E2E suite.");
const result = spawnSync(
  process.execPath,
  [npmCli, "run", "test:e2e", "--workspace", "@coga/factory"],
  {
    stdio: "inherit",
    env: { ...process.env, COGA_FACTORY_DOCKER_E2E: "1" },
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
