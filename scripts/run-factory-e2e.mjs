import { spawnSync } from "node:child_process";

const executable = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  executable,
  ["run", "test:e2e", "--workspace", "@coga/factory"],
  {
    stdio: "inherit",
    env: { ...process.env, COGA_FACTORY_DOCKER_E2E: "1" },
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
