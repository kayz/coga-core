import type {
  FactoryTargetRunResult,
  PlannedTarget,
  ProcessResult,
  WorkOrder,
} from "./types.js";
import {
  GITHUB_FACTORY_TOKEN_ENVIRONMENT,
  assertSeparatedDeliveryIdentity,
  expectedDeliveryAuthor,
} from "./identity.js";
import { runProcess } from "./utils.js";

function remoteMatches(url: string, repository: string): boolean {
  const normalized = url
    .trim()
    .replace(/\.git$/u, "")
    .toLowerCase();
  const expected = repository.toLowerCase();
  return (
    normalized === `https://github.com/${expected}` ||
    normalized === `git@github.com:${expected}` ||
    normalized === `ssh://git@github.com/${expected}`
  );
}

interface PullRequestSnapshot {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  author: string;
  baseRepository: string;
  baseRefName: string;
  baseRefOid: string;
  headRepository: string;
  headRefName: string;
  headRefOid: string;
}

interface RestPullRequest {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  merged_at?: unknown;
  user?: { login?: unknown } | null;
  base?: {
    sha?: unknown;
    ref?: unknown;
    repo?: { full_name?: unknown } | null;
  } | null;
  head?: {
    sha?: unknown;
    ref?: unknown;
    repo?: { full_name?: unknown } | null;
  } | null;
}

export type GitHubDeliveryCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ProcessResult>;

export interface GitHubDeliveryDependencies {
  environment?: NodeJS.ProcessEnv;
  runner?: GitHubDeliveryCommandRunner;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const TOKEN_PATTERN = /^ghs_[A-Za-z0-9_.-]{16,8188}$/u;
const MAX_INSTALLATION_REPOSITORIES = 1000;
const GIT_URL_REWRITE_PATTERN = "^url\\..*\\.(insteadof|pushinsteadof)$";
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const normalized = key.toUpperCase();
      return (
        normalized !== GITHUB_FACTORY_TOKEN_ENVIRONMENT &&
        !normalized.startsWith("GH_") &&
        !normalized.startsWith("GITHUB_") &&
        !normalized.startsWith("GIT_") &&
        !normalized.startsWith("GCM_") &&
        normalized !== "GIT_CONFIG" &&
        normalized !== "SSH_ASKPASS" &&
        normalized !== "SSH_ASKPASS_REQUIRE"
      );
    }),
  );
}

function credentialVariants(token: string): string[] {
  return [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  ];
}

function redact(value: string, token: string): string {
  return credentialVariants(token).reduce(
    (result, secret) => result.replaceAll(secret, "[redacted]"),
    value,
  );
}

async function assertNoApplicableGitUrlRewrite(parameters: {
  runner: GitHubDeliveryCommandRunner;
  token: string;
  environment: NodeJS.ProcessEnv;
  workspace: string;
  targetUrl: string;
}): Promise<void> {
  let response: ProcessResult;
  try {
    response = await parameters.runner(
      "git",
      ["config", "--null", "--get-regexp", GIT_URL_REWRITE_PATTERN],
      {
        cwd: parameters.workspace,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        env: parameters.environment,
      },
    );
  } catch (error) {
    throw new Error(
      `Git URL rewrite inspection failed: ${redact(error instanceof Error ? error.message : String(error), parameters.token)}`,
    );
  }
  if (response.exitCode === 1 && response.stdout.length === 0) return;
  if (response.exitCode !== 0) {
    const detail =
      response.stderr.trim() || response.stdout.trim() || "no command output";
    throw new Error(
      `Git URL rewrite inspection failed with exit ${response.exitCode}: ${redact(detail, parameters.token)}`,
    );
  }

  const target = parameters.targetUrl.toLowerCase();
  for (const record of response.stdout.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    if (separator < 1) {
      throw new Error("Git URL rewrite inspection returned invalid output.");
    }
    const prefix = record.slice(separator + 1);
    if (target.startsWith(prefix.toLowerCase())) {
      throw new Error(
        "Git URL rewrite configuration applies to the Factory delivery endpoint; refusing credentialed Git access.",
      );
    }
  }
}

async function checked(
  runner: GitHubDeliveryCommandRunner,
  token: string,
  command: string,
  args: readonly string[],
  options: Parameters<GitHubDeliveryCommandRunner>[2],
  label: string,
): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    result = await runner(command, args, options);
  } catch (error) {
    throw new Error(
      `${label} failed: ${redact(error instanceof Error ? error.message : String(error), token)}`,
    );
  }
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "no command output";
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${redact(detail, token)}`,
    );
  }
  return result;
}

function parseJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function parseInstallationRepositoriesPage(source: string): {
  totalCount: number;
  repositories: string[];
} {
  const value = parseJson<unknown>(source, "GitHub App installation preflight");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("total_count" in value) ||
    typeof value.total_count !== "number" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 1 ||
    value.total_count > MAX_INSTALLATION_REPOSITORIES ||
    !("repositories" in value) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 100
  ) {
    throw new Error(
      "GitHub App installation preflight returned an invalid or over-budget repository set.",
    );
  }
  const repositories = value.repositories.map((repository) => {
    if (
      !repository ||
      typeof repository !== "object" ||
      Array.isArray(repository) ||
      !("full_name" in repository) ||
      typeof repository.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.full_name)
    ) {
      throw new Error(
        "GitHub App installation preflight returned a repository without a valid identity.",
      );
    }
    return repository.full_name;
  });
  return { totalCount: value.total_count, repositories };
}

function author(snapshot: PullRequestSnapshot, expected: string): string {
  const actual = snapshot.author;
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `GitHub Draft PR author must be the declared delivery identity '${expected}', but a different or missing author was returned.`,
    );
  }
  return actual;
}

function assertSnapshot(
  snapshot: unknown,
  repository: string,
  baseBranch: string,
  headBranch: string,
  label: string,
): asserts snapshot is PullRequestSnapshot {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("number" in snapshot) ||
    !("url" in snapshot) ||
    !("state" in snapshot) ||
    !("isDraft" in snapshot) ||
    !("author" in snapshot) ||
    !("baseRepository" in snapshot) ||
    !("baseRefName" in snapshot) ||
    !("baseRefOid" in snapshot) ||
    !("headRepository" in snapshot) ||
    !("headRefName" in snapshot) ||
    !("headRefOid" in snapshot) ||
    typeof snapshot.number !== "number" ||
    !Number.isSafeInteger(snapshot.number) ||
    snapshot.number < 1 ||
    typeof snapshot.url !== "string" ||
    snapshot.url.toLowerCase() !==
      `https://github.com/${repository}/pull/${snapshot.number}`.toLowerCase() ||
    typeof snapshot.state !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(snapshot.state) ||
    typeof snapshot.isDraft !== "boolean" ||
    typeof snapshot.author !== "string" ||
    snapshot.author.length < 1 ||
    typeof snapshot.baseRepository !== "string" ||
    snapshot.baseRepository.toLowerCase() !== repository.toLowerCase() ||
    typeof snapshot.baseRefName !== "string" ||
    snapshot.baseRefName !== baseBranch ||
    typeof snapshot.baseRefOid !== "string" ||
    !COMMIT_PATTERN.test(snapshot.baseRefOid) ||
    typeof snapshot.headRepository !== "string" ||
    snapshot.headRepository.toLowerCase() !== repository.toLowerCase() ||
    typeof snapshot.headRefName !== "string" ||
    snapshot.headRefName !== headBranch ||
    typeof snapshot.headRefOid !== "string" ||
    !COMMIT_PATTERN.test(snapshot.headRefOid)
  ) {
    throw new Error(`${label} returned an invalid PR identity.`);
  }
}

function fromRestPullRequest(value: RestPullRequest): PullRequestSnapshot {
  const state =
    typeof value.merged_at === "string"
      ? "MERGED"
      : typeof value.state === "string"
        ? value.state.toUpperCase()
        : "";
  return {
    number: value.number as number,
    url: value.html_url as string,
    state,
    isDraft: value.draft as boolean,
    author: value.user?.login as string,
    baseRepository: value.base?.repo?.full_name as string,
    baseRefName: value.base?.ref as string,
    baseRefOid: value.base?.sha as string,
    headRepository: value.head?.repo?.full_name as string,
    headRefName: value.head?.ref as string,
    headRefOid: value.head?.sha as string,
  };
}

function parseRestPullRequest(
  value: unknown,
  repository: string,
  baseBranch: string,
  headBranch: string,
  label: string,
): PullRequestSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid PR object.`);
  }
  const snapshot = fromRestPullRequest(value as RestPullRequest);
  assertSnapshot(snapshot, repository, baseBranch, headBranch, label);
  return snapshot;
}

async function assertInstallationRepositoryAccess(parameters: {
  runner: GitHubDeliveryCommandRunner;
  token: string;
  environment: NodeJS.ProcessEnv;
  workspace: string;
  repository: string;
}): Promise<void> {
  const repositories = new Set<string>();
  let total = -1;
  for (let page = 1; page <= 10; page += 1) {
    const response = await checked(
      parameters.runner,
      parameters.token,
      "gh",
      ["api", `/installation/repositories?per_page=100&page=${page}`],
      {
        cwd: parameters.workspace,
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        env: parameters.environment,
      },
      "GitHub App installation preflight",
    );
    const value = parseInstallationRepositoriesPage(response.stdout);
    if (total === -1) total = value.totalCount;
    if (value.totalCount !== total) {
      throw new Error(
        "GitHub App installation repository set changed during preflight.",
      );
    }
    for (const repository of value.repositories) {
      repositories.add(repository.toLowerCase());
    }
    if (repositories.size >= total) break;
    if (value.repositories.length === 0) {
      throw new Error(
        "GitHub App installation repository enumeration ended early.",
      );
    }
  }
  if (repositories.size !== total) {
    throw new Error(
      "GitHub App installation repository enumeration is incomplete.",
    );
  }
  if (!repositories.has(parameters.repository.toLowerCase())) {
    throw new Error(
      `GitHub App installation is not authorized for '${parameters.repository}'.`,
    );
  }
}

export async function deliverGitHubDraft(
  parameters: {
    workspace: string;
    workOrder: WorkOrder;
    target: PlannedTarget;
    baseCommit: string;
    resultCommit: string;
    evidencePath: string;
    evidenceDigest: string;
  },
  dependencies: GitHubDeliveryDependencies = {},
): Promise<NonNullable<FactoryTargetRunResult["pullRequest"]>> {
  const { repository: repositoryName } = parameters.workOrder.spec.delivery;
  assertSeparatedDeliveryIdentity(parameters.workOrder);
  const { branch, title, body } = parameters.target.delivery;
  const repository = parameters.workOrder.spec.repository;
  const expectedAuthor = expectedDeliveryAuthor(parameters.workOrder);
  const environment = dependencies.environment ?? process.env;
  const token = environment[GITHUB_FACTORY_TOKEN_ENVIRONMENT];
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new Error(
      `GitHub App delivery requires a valid ${GITHUB_FACTORY_TOKEN_ENVIRONMENT} installation token.`,
    );
  }
  const baseEnvironment = cleanEnvironment(environment);
  const ghEnvironment = {
    ...baseEnvironment,
    GH_TOKEN: token,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  const gitBaseEnvironment = {
    ...baseEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
  };
  const authenticatedUrl = `https://github.com/${repositoryName}.git`;
  const scopedHttpConfiguration = `http.${authenticatedUrl}.`;
  const gitEnvironment = {
    ...gitBaseEnvironment,
    GCM_INTERACTIVE: "Never",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.askPass",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.extraheader",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: `${scopedHttpConfiguration}extraheader`,
    GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: `${scopedHttpConfiguration}extraheader`,
    GIT_CONFIG_VALUE_4: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
    GIT_CONFIG_KEY_5: `${scopedHttpConfiguration}sslVerify`,
    GIT_CONFIG_VALUE_5: "true",
    GIT_CONFIG_KEY_6: `${scopedHttpConfiguration}followRedirects`,
    GIT_CONFIG_VALUE_6: "initial",
  };
  const runner = dependencies.runner ?? runProcess;
  if (
    !COMMIT_PATTERN.test(parameters.baseCommit) ||
    !COMMIT_PATTERN.test(parameters.resultCommit)
  ) {
    throw new Error(
      "GitHub delivery requires exact lowercase commit identifiers.",
    );
  }

  await assertInstallationRepositoryAccess({
    runner,
    token,
    environment: ghEnvironment,
    workspace: parameters.workspace,
    repository: repositoryName,
  });

  const remoteUrl = await checked(
    runner,
    token,
    "git",
    ["remote", "get-url", repository.remote],
    {
      cwd: parameters.workspace,
      timeoutMs: 30_000,
      env: gitBaseEnvironment,
    },
    "Git remote lookup",
  );
  if (!remoteMatches(remoteUrl.stdout, repositoryName)) {
    throw new Error(
      `Work Order repository '${repositoryName}' does not match the configured Git remote.`,
    );
  }
  const localHead = await checked(
    runner,
    token,
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    {
      cwd: parameters.workspace,
      timeoutMs: 30_000,
      env: gitBaseEnvironment,
    },
    "Git local candidate lookup",
  );
  if (localHead.stdout.trim() !== parameters.resultCommit) {
    throw new Error(
      `Local candidate moved: expected ${parameters.resultCommit}, received ${localHead.stdout.trim() || "missing"}.`,
    );
  }
  const localBranch = await checked(
    runner,
    token,
    "git",
    ["branch", "--show-current"],
    {
      cwd: parameters.workspace,
      timeoutMs: 30_000,
      env: gitBaseEnvironment,
    },
    "Git local branch lookup",
  );
  if (localBranch.stdout.trim() !== branch) {
    throw new Error(
      `Local Factory branch must be '${branch}', received '${localBranch.stdout.trim() || "detached"}'.`,
    );
  }
  await assertNoApplicableGitUrlRewrite({
    runner,
    token,
    environment: gitBaseEnvironment,
    workspace: parameters.workspace,
    targetUrl: authenticatedUrl,
  });
  const remoteBase = await checked(
    runner,
    token,
    "git",
    [
      "ls-remote",
      "--heads",
      authenticatedUrl,
      `refs/heads/${repository.baseBranch}`,
    ],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      env: gitEnvironment,
    },
    "GitHub base branch lookup",
  );
  const remoteCommit = remoteBase.stdout.trim().split(/\s+/u)[0];
  if (remoteCommit !== parameters.baseCommit) {
    throw new Error(
      `Remote base '${repository.baseBranch}' moved: expected ${parameters.baseCommit}, received ${remoteCommit || "missing"}.`,
    );
  }
  const remoteTarget = await checked(
    runner,
    token,
    "git",
    ["ls-remote", "--heads", authenticatedUrl, `refs/heads/${branch}`],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      env: gitEnvironment,
    },
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
  await checked(
    runner,
    token,
    "git",
    ["push", "--no-verify", authenticatedUrl, `HEAD:refs/heads/${branch}`],
    {
      cwd: parameters.workspace,
      timeoutMs: 120_000,
      maxOutputBytes: 2 * 1024 * 1024,
      env: gitEnvironment,
    },
    "Factory branch push",
  );

  const [repositoryOwner] = repositoryName.split("/");
  if (!repositoryOwner) {
    throw new Error("GitHub repository owner is missing.");
  }
  const pullRequestQuery = `repos/${repositoryName}/pulls?state=all&head=${encodeURIComponent(`${repositoryOwner}:${branch}`)}&base=${encodeURIComponent(repository.baseBranch)}&per_page=100`;
  const existing = await checked(
    runner,
    token,
    "gh",
    ["api", `${pullRequestQuery}&page=1`],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      env: ghEnvironment,
    },
    "GitHub PR lookup",
  );
  const values = parseJson<unknown[]>(
    existing.stdout || "[]",
    "GitHub PR lookup",
  );
  if (!Array.isArray(values)) {
    throw new Error("GitHub PR lookup returned a non-array response.");
  }
  const overflow = await checked(
    runner,
    token,
    "gh",
    ["api", `${pullRequestQuery}&page=2`],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      env: ghEnvironment,
    },
    "GitHub PR overflow lookup",
  );
  const overflowValues = parseJson<unknown[]>(
    overflow.stdout || "[]",
    "GitHub PR overflow lookup",
  );
  if (!Array.isArray(overflowValues) || overflowValues.length > 0) {
    throw new Error("GitHub PR lookup exceeds the 100-entry budget.");
  }
  const snapshots = values.map((value) =>
    parseRestPullRequest(
      value,
      repositoryName,
      repository.baseBranch,
      branch,
      "GitHub PR lookup",
    ),
  );
  if (snapshots.length > 1) {
    throw new Error(
      `Multiple PRs already exist for factory branch '${branch}'; refusing ambiguous reuse.`,
    );
  }
  const open = snapshots.find((entry) => entry.state === "OPEN");
  if (open) {
    const actualAuthor = author(open, expectedAuthor);
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
      author: actualAuthor,
    };
  }
  if (snapshots.length > 0) {
    throw new Error(
      `A closed or merged PR already exists for factory branch '${branch}'; refusing to create a duplicate.`,
    );
  }

  const fullBody = `${body}\n\n## Factory evidence\n\n- Application: \`${parameters.target.application.id}@${parameters.target.application.version}\`\n- Base: \`${parameters.baseCommit}\`\n- Result: \`${parameters.resultCommit}\`\n- Proposal receipt: \`${parameters.target.proposalReceipt.metadata.receiptDigest}\`\n- Evidence: \`${parameters.evidencePath}\`\n- Evidence digest: \`${parameters.evidenceDigest}\`\n- Delivery identity: \`${expectedAuthor}\`\n- Required governance approvals remain visible in the Evidence Bundle; this PR is draft-only.\n`;
  const created = await checked(
    runner,
    token,
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repositoryName}/pulls`,
      "-f",
      `base=${repository.baseBranch}`,
      "-f",
      `head=${branch}`,
      "-f",
      `title=${title}`,
      "-f",
      `body=${fullBody}`,
      "-F",
      "draft=true",
    ],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      env: ghEnvironment,
    },
    "Draft PR creation",
  );
  const createdSnapshot = parseRestPullRequest(
    parseJson<unknown>(created.stdout, "Draft PR creation"),
    repositoryName,
    repository.baseBranch,
    branch,
    "Draft PR creation",
  );
  const pullRequestNumber = createdSnapshot.number;
  const viewed = await checked(
    runner,
    token,
    "gh",
    ["api", `repos/${repositoryName}/pulls/${pullRequestNumber}`],
    {
      cwd: parameters.workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      env: ghEnvironment,
    },
    "Draft PR verification",
  );
  const snapshot = parseRestPullRequest(
    parseJson<unknown>(viewed.stdout, "Draft PR verification"),
    repositoryName,
    repository.baseBranch,
    branch,
    "Draft PR verification",
  );
  if (snapshot.number !== pullRequestNumber) {
    throw new Error("Draft PR verification returned a different PR number.");
  }
  const actualAuthor = author(snapshot, expectedAuthor);
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
    author: actualAuthor,
  };
}
