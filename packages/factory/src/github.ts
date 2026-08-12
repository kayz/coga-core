import type {
  FactoryTargetRunResult,
  PlannedTarget,
  WorkOrder,
} from "./types.js";
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
  baseRefOid: string;
  headRefOid: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export async function deliverGitHubDraft(parameters: {
  workspace: string;
  workOrder: WorkOrder;
  target: PlannedTarget;
  baseCommit: string;
  resultCommit: string;
  evidencePath: string;
  evidenceDigest: string;
}): Promise<NonNullable<FactoryTargetRunResult["pullRequest"]>> {
  const { repository: repositoryName } = parameters.workOrder.spec.delivery;
  const { branch, title, body } = parameters.target.delivery;
  const repository = parameters.workOrder.spec.repository;
  if (
    !COMMIT_PATTERN.test(parameters.baseCommit) ||
    !COMMIT_PATTERN.test(parameters.resultCommit)
  ) {
    throw new Error(
      "GitHub delivery requires exact lowercase commit identifiers.",
    );
  }
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
  const remoteTarget = await runChecked(
    "git",
    ["ls-remote", "--heads", repository.remote, `refs/heads/${branch}`],
    { cwd: parameters.workspace, timeoutMs: 60_000 },
    "GitHub target branch lookup",
  );
  const targetLines = remoteTarget.stdout.trim()
    ? remoteTarget.stdout.trim().split(/\r?\n/u)
    : [];
  if (targetLines.length > 1) {
    throw new Error(`Remote target branch '${branch}' resolved ambiguously.`);
  }
  const remoteTargetCommit = targetLines[0]?.split(/\s+/u)[0];
  if (remoteTargetCommit && remoteTargetCommit !== parameters.resultCommit) {
    throw new Error(
      `Remote target branch '${branch}' already points to a different commit; refusing to overwrite it.`,
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
      "--limit",
      "100",
      "--json",
      "number,url,state,isDraft,baseRefOid,headRefOid",
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
  if (snapshots.length > 1) {
    throw new Error(
      `Multiple PRs already exist for factory branch '${branch}'; refusing ambiguous reuse.`,
    );
  }
  const open = snapshots.find((entry) => entry.state === "OPEN");
  if (open) {
    if (
      !open.isDraft ||
      open.baseRefOid !== parameters.baseCommit ||
      open.headRefOid !== parameters.resultCommit
    ) {
      throw new Error(
        `Existing PR for factory branch '${branch}' is not the exact open Draft candidate.`,
      );
    }
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

  const fullBody = `${body}\n\n## Factory evidence\n\n- Application: \`${parameters.target.application.id}@${parameters.target.application.version}\`\n- Base: \`${parameters.baseCommit}\`\n- Result: \`${parameters.resultCommit}\`\n- Proposal receipt: \`${parameters.target.proposalReceipt.metadata.receiptDigest}\`\n- Evidence: \`${parameters.evidencePath}\`\n- Evidence digest: \`${parameters.evidenceDigest}\`\n- Required governance approvals remain visible in the Evidence Bundle; this PR is draft-only.\n`;
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
      "number,url,state,isDraft,baseRefOid,headRefOid",
    ],
    { cwd: parameters.workspace, timeoutMs: 60_000 },
    "Draft PR verification",
  );
  const snapshot = JSON.parse(viewed.stdout) as PullRequestSnapshot;
  if (
    snapshot.state !== "OPEN" ||
    snapshot.isDraft !== true ||
    snapshot.baseRefOid !== parameters.baseCommit ||
    snapshot.headRefOid !== parameters.resultCommit
  ) {
    throw new Error("GitHub delivery did not produce an open Draft PR.");
  }
  return {
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    draft: snapshot.isDraft,
  };
}
