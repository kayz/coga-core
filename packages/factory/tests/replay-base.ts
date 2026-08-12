import { execFileSync } from "node:child_process";

export const workOrderRelativePath =
  ".coga/work-orders/cedar-status/work-order.yaml";

const patchRelativePaths = [
  ".coga/work-orders/cedar-status/domain-change.patch",
  ".coga/work-orders/cedar-status/agent-proposal.patch",
  ".coga/work-orders/cedar-status/birch-agent-proposal.patch",
] as const;

function succeeds(root: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function selectReplayBase(repository: string): string {
  const head = execFileSync(
    "git",
    ["-C", repository, "rev-parse", "FETCH_HEAD^{commit}"],
    { encoding: "utf8" },
  ).trim();
  const line = execFileSync(
    "git",
    ["-C", repository, "rev-list", "--parents", "-n", "1", head],
    { encoding: "utf8" },
  ).trim();
  const candidates = line.split(/\s+/u);
  for (const commit of candidates) {
    if (
      !succeeds(
        repository,
        "cat-file",
        "-e",
        `${commit}:${workOrderRelativePath}`,
      )
    ) {
      continue;
    }
    execFileSync("git", ["-C", repository, "checkout", "--detach", commit]);
    const applicable = patchRelativePaths.every(
      (path) =>
        !succeeds(
          repository,
          "apply",
          "--reverse",
          "--check",
          "--unidiff-zero",
          path,
        ) &&
        succeeds(
          repository,
          "apply",
          "--check",
          "--unidiff-zero",
          "--whitespace=error-all",
          path,
        ),
    );
    if (applicable) return commit;
  }
  throw new Error(
    "No current or immediate parent commit contains an unapplied governed Factory Work Order.",
  );
}
