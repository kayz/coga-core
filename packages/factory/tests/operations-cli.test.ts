import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coga-factory-cli-"));
  roots.push(root);
  return root;
}

function run(args: string[], cwd = process.cwd()): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 30_000,
    windowsHide: true,
  });
}

describe("Factory operations CLI", () => {
  it("lists an empty durable queue without requiring credentials", () => {
    const root = temporaryRoot();
    const result = JSON.parse(
      run(["operations", "list", "--queue-root", join(root, "queue")]),
    ) as { tasks: unknown[] };
    expect(result).toEqual({ tasks: [] });
  }, 30_000);

  it("enqueues an exact tracked Work Order and shows the same task", () => {
    const root = temporaryRoot();
    const workOrder = resolve(
      repositoryRoot,
      ".coga/work-orders/cedar-status/work-order.yaml",
    );
    const queueRoot = join(root, ".queue");
    const task = JSON.parse(
      run(
        [
          "operations",
          "enqueue",
          workOrder,
          "--repo-root",
          repositoryRoot,
          "--queue-root",
          queueRoot,
        ],
        repositoryRoot,
      ),
    ) as { metadata: { id: string }; spec: { workOrderPath: string } };
    expect(task.spec.workOrderPath).toBe(
      ".coga/work-orders/cedar-status/work-order.yaml",
    );
    const shown = JSON.parse(
      run(
        ["operations", "show", task.metadata.id, "--queue-root", queueRoot],
        repositoryRoot,
      ),
    ) as { metadata: { id: string } };
    expect(shown.metadata.id).toBe(task.metadata.id);
  }, 30_000);

  it("uses exit code 2 for a well-formed but ineligible SLO report", () => {
    const root = temporaryRoot();
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "slo-report",
        join(repositoryRoot, ".coga/factory-slo-policy.json"),
        "--queue-root",
        join(root, "queue"),
        "--measured-at",
        "2026-09-01T00:00:00.000Z",
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "FactorySloReport",
      compliant: false,
    });
  }, 30_000);
});
