import type { FactoryRunResult, WorkOrder } from "./types.js";
import { runChecked, runProcess } from "./utils.js";

function remoteMatches(url: string, repository: string): boolean {
  const normalized = url.trim().replace(/\.git$/u, "");
  return (
    normalized === `https://github.com/${repository}` ||
    normalized === `git@github.com:${repository}` ||
    normalized === `ssh://git@github.com/${repository}`
  );
}

interface PullRequestSnapshot {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
}

export async function deliverGitHubDraft(parameters: {
  workspace: string;
  workOrder: WorkOrder;
  baseCommit: string;
  resultCommit: string;
  evidencePath: string;
  evidenceDigest: string;
}): Promise<NonNullable<FactoryRunResult["pullRequest"]>> {
  const {
    repository: repositoryName,
    branch,
    title,
    body,
  } = parameters.workOrder.spec.delivery;
  const repository = parameters.workOrder.spec.repository;
  const remoteUrl = await runChecked(
    "git",
    ["remote", "get-url", repository.remote],
    { cwd: parameters.workspace, timeoutMs: 30_000 },
    "Git remote lookup",
  );
  if (!remoteMatches(remoteUrl.stdout, repositoryName)) {
    throw new Error(
      `Work Order repository '${repositoryName}' does not match remote '${remoteUrl.stdout.trim()}'.`,
    );
  }
  const remoteBase = await runChecked(
    "git",
    [
      "ls-remote",
      "--heads",
      repository.remote,
      `refs/heads/${repository.baseBranch}`,
    ],
    { cwd: parameters.workspace, timeoutMs: 60_000 },
    "GitHub base branch lookup",
  );
  const remoteCommit = remoteBase.stdout.trim().split(/\s+/u)[0];
  if (remoteCommit !== parameters.baseCommit) {
    throw new Error(
      `Remote base '${repository.baseBranch}' moved: expected ${parameters.baseCommit}, received ${remoteCommit || "missing"}.`,
    );
  }
  await runChecked(
    "git",
    ["push", "--set-upstream", repository.remote, `HEAD:refs/heads/${branch}`],
    {
      cwd: parameters.workspace,
      timeoutMs: 120_000,
      maxOutputBytes: 2 * 1024 * 1024,
    },
    "Factory branch push",
  );

  const existing = await runChecked(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repositoryName,
      "--head",
      branch,
      "--base",
      repository.baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,state,isDraft",
    ],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    },
    "GitHub PR lookup",
  );
  const snapshots = JSON.parse(
    existing.stdout || "[]",
  ) as PullRequestSnapshot[];
  const open = snapshots.find((entry) => entry.state === "OPEN");
  if (open) {
    return {
      number: open.number,
      url: open.url,
      state: open.state,
      draft: open.isDraft,
    };
  }
  if (snapshots.length > 0) {
    throw new Error(
      `A closed or merged PR already exists for factory branch '${branch}'; refusing to create a duplicate.`,
    );
  }

  const fullBody = `${body}\n\n## Factory evidence\n\n- Base: \`${parameters.baseCommit}\`\n- Result: \`${parameters.resultCommit}\`\n- Evidence: \`${parameters.evidencePath}\`\n- Evidence digest: \`${parameters.evidenceDigest}\`\n- Required governance approvals remain visible in the Evidence Bundle; this PR is draft-only.\n`;
  const created = await runProcess(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repositoryName,
      "--base",
      repository.baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      fullBody,
      "--draft",
    ],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (created.exitCode !== 0) {
    throw new Error(
      `Draft PR creation failed: ${created.stderr.trim() || created.stdout.trim()}.`,
    );
  }
  const viewed = await runChecked(
    "gh",
    [
      "pr",
      "view",
      created.stdout.trim(),
      "--repo",
      repositoryName,
      "--json",
      "number,url,state,isDraft",
    ],
    { cwd: parameters.workspace, timeoutMs: 60_000 },
    "Draft PR verification",
  );
  const snapshot = JSON.parse(viewed.stdout) as PullRequestSnapshot;
  if (snapshot.state !== "OPEN" || snapshot.isDraft !== true) {
    throw new Error("GitHub delivery did not produce an open Draft PR.");
  }
  return {
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    draft: snapshot.isDraft,
  };
}
