import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deliverGitHubDraft,
  type GitHubDeliveryCommandRunner,
} from "../src/github.js";
import {
  loadAgentProposalReceipt,
  loadApplicationFactory,
  loadWorkOrder,
} from "../src/schema.js";
import type { PlannedTarget, ProcessResult } from "../src/types.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const baseCommit = "1".repeat(40);
const resultCommit = "2".repeat(40);
const installationToken = `ghs_1234567890.${"a-b_".repeat(80)}`;

interface CommandCall {
  command: string;
  args: readonly string[];
  options: Parameters<GitHubDeliveryCommandRunner>[2];
}

function fixture() {
  const workOrder = loadWorkOrder(
    resolve(repositoryRoot, ".coga/work-orders/cedar-status/work-order.yaml"),
  );
  const configured = workOrder.spec.targets[0];
  if (!configured) throw new Error("Expected a Work Order target.");
  const target: PlannedTarget = {
    application: configured.application,
    factoryDefinitionPath: configured.factoryDefinition,
    definition: loadApplicationFactory(
      resolve(repositoryRoot, configured.factoryDefinition),
    ),
    proposalReceiptPath: configured.proposal.receipt.path,
    proposalReceipt: loadAgentProposalReceipt(
      resolve(repositoryRoot, configured.proposal.receipt.path),
    ),
    delivery: configured.delivery,
  };
  return { workOrder, target };
}

function result(stdout = "", stderr = "", exitCode = 0): ProcessResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

function restPullRequest(author: string, number = 43) {
  const { target } = fixture();
  return {
    number,
    html_url: `https://github.com/kayz/coga-core/pull/${number}`,
    state: "open",
    draft: true,
    merged_at: null,
    user: { login: author },
    base: {
      sha: baseCommit,
      ref: "main",
      repo: { full_name: "kayz/coga-core" },
    },
    head: {
      sha: resultCommit,
      ref: target.delivery.branch,
      repo: { full_name: "kayz/coga-core" },
    },
  };
}

function fakeRunner(options: {
  accessibleRepository?: string;
  existingAuthor?: string;
  createdAuthor?: string;
  preflightFailure?: string;
  urlRewrite?: { key: string; value: string };
  localHead?: string;
  localBranch?: string;
}) {
  const calls: CommandCall[] = [];
  const runner: GitHubDeliveryCommandRunner = async (
    command,
    args,
    commandOptions,
  ) => {
    calls.push({ command, args, options: commandOptions });
    if (
      command === "gh" &&
      args[0] === "api" &&
      String(args[1]).startsWith("/installation/repositories?")
    ) {
      if (options.preflightFailure) {
        return result("", options.preflightFailure, 1);
      }
      return result(
        JSON.stringify({
          total_count: 1,
          repositories: [
            { full_name: options.accessibleRepository ?? "kayz/coga-core" },
          ],
        }),
      );
    }
    if (command === "git" && args[0] === "remote") {
      return result("https://github.com/kayz/coga-core.git\n");
    }
    if (command === "git" && args[0] === "config") {
      return options.urlRewrite
        ? result(`${options.urlRewrite.key}\n${options.urlRewrite.value}\0`)
        : result("", "", 1);
    }
    if (command === "git" && args[0] === "rev-parse") {
      return result(`${options.localHead ?? resultCommit}\n`);
    }
    if (command === "git" && args[0] === "branch") {
      return result(
        `${options.localBranch ?? fixture().target.delivery.branch}\n`,
      );
    }
    if (command === "git" && args[0] === "ls-remote") {
      return String(args.at(-1)).endsWith("/main")
        ? result(`${baseCommit}\trefs/heads/main\n`)
        : result();
    }
    if (command === "git" && args[0] === "push") return result();
    if (
      command === "gh" &&
      args[0] === "api" &&
      String(args[1]).startsWith("repos/kayz/coga-core/pulls?")
    ) {
      if (String(args[1]).includes("page=2")) return result("[]");
      return result(
        options.existingAuthor
          ? JSON.stringify([restPullRequest(options.existingAuthor, 42)])
          : "[]",
      );
    }
    if (
      command === "gh" &&
      args[0] === "api" &&
      args[1] === "--method" &&
      args[2] === "POST"
    ) {
      return result(
        JSON.stringify(
          restPullRequest(options.createdAuthor ?? "coga-factory-kayz[bot]"),
        ),
      );
    }
    if (
      command === "gh" &&
      args[0] === "api" &&
      args[1] === "repos/kayz/coga-core/pulls/43"
    ) {
      return result(
        JSON.stringify(
          restPullRequest(options.createdAuthor ?? "coga-factory-kayz[bot]"),
        ),
      );
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, runner };
}

function deliver(
  runner: GitHubDeliveryCommandRunner,
  environment: NodeJS.ProcessEnv,
  token?: string,
) {
  const { workOrder, target } = fixture();
  return deliverGitHubDraft(
    {
      workspace: repositoryRoot,
      workOrder,
      target,
      baseCommit,
      resultCommit,
      evidencePath: `.coga/evidence/${"3".repeat(64)}.json`,
      evidenceDigest: `sha256:${"3".repeat(64)}`,
    },
    { runner, environment, ...(token ? { token } : {}) },
  );
}

describe("GitHub App Draft delivery", () => {
  it("fails before any command when the installation token is absent", async () => {
    const fake = fakeRunner({});
    await expect(deliver(fake.runner, {})).rejects.toThrow(
      /COGA_FACTORY_GITHUB_TOKEN installation token/iu,
    );
    expect(fake.calls).toEqual([]);
  });

  it("uses an in-memory lease instead of process-global credentials", async () => {
    const fake = fakeRunner({});
    await expect(
      deliver(
        fake.runner,
        {
          COGA_FACTORY_GITHUB_TOKEN: `ghs_${"wrong".repeat(20)}`,
          COGA_FACTORY_GITHUB_APP_ID: "42",
          COGA_FACTORY_GITHUB_APP_PRIVATE_KEY: "private-key-material",
          GH_TOKEN: "human-token",
        },
        installationToken,
      ),
    ).resolves.toMatchObject({
      number: 43,
      author: "coga-factory-kayz[bot]",
    });
    for (const call of fake.calls) {
      expect(call.args.join("\0")).not.toContain(installationToken);
      expect(call.options.env?.COGA_FACTORY_GITHUB_TOKEN).toBeUndefined();
      expect(call.options.env?.COGA_FACTORY_GITHUB_APP_ID).toBeUndefined();
      expect(
        call.options.env?.COGA_FACTORY_GITHUB_APP_PRIVATE_KEY,
      ).toBeUndefined();
      if (call.command === "gh") {
        expect(call.options.env?.GH_TOKEN).toBe(installationToken);
      }
    }
  });

  it("rejects a user token at installation preflight and redacts credentials", async () => {
    const encoded = Buffer.from(
      `x-access-token:${installationToken}`,
      "utf8",
    ).toString("base64");
    const fake = fakeRunner({
      preflightFailure: `not an installation token ${installationToken} ${encoded}`,
    });
    let message = "";
    try {
      await deliver(fake.runner, {
        COGA_FACTORY_GITHUB_TOKEN: installationToken,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("GitHub App installation preflight");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(installationToken);
    expect(message).not.toContain(encoded);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls.some((entry) => entry.args[0] === "push")).toBe(false);
  });

  it("rejects an installation that cannot access the exact repository", async () => {
    const fake = fakeRunner({ accessibleRepository: "kayz/another-repo" });
    await expect(
      deliver(fake.runner, {
        COGA_FACTORY_GITHUB_TOKEN: installationToken,
      }),
    ).rejects.toThrow(/not authorized for 'kayz\/coga-core'/iu);
    expect(fake.calls.some((entry) => entry.args[0] === "push")).toBe(false);
  });

  it.each([
    ["existing", { existingAuthor: "kayz" }],
    ["created", { createdAuthor: "kayz" }],
  ])(
    "rejects a %s Draft owned by a human identity",
    async (_label, options) => {
      const fake = fakeRunner(options);
      await expect(
        deliver(fake.runner, {
          COGA_FACTORY_GITHUB_TOKEN: installationToken,
        }),
      ).rejects.toThrow(/author must be the declared delivery identity/iu);
    },
  );

  it("creates a machine-owned Draft without putting credentials in arguments or inherited auth", async () => {
    const fake = fakeRunner({});
    const delivered = await deliver(fake.runner, {
      COGA_FACTORY_GITHUB_TOKEN: installationToken,
      GH_TOKEN: "human-gh-token",
      GITHUB_TOKEN: "repository-token",
      GITHUB_PAT: "legacy-token",
      GH_DEBUG: "api",
      GH_HOST: "attacker.invalid",
      GH_CONFIG_DIR: "C:\\malicious\\gh-config",
      GCM_INTERACTIVE: "Always",
      GCM_TRACE: "C:\\malicious\\gcm-trace.log",
      GIT_ASKPASS: "C:\\malicious\\askpass.exe",
      GIT_CONFIG: "C:\\malicious\\gitconfig",
      SSH_ASKPASS: "C:\\malicious\\ssh-askpass.exe",
      GIT_CURL_VERBOSE: "1",
      GIT_DIR: "C:\\malicious\\git-dir",
      GIT_EXEC_PATH: "C:\\malicious\\git-exec",
      GIT_TERMINAL_PROMPT: "1",
      GIT_TRACE: "1",
      GIT_TRACE_CURL: "C:\\malicious\\trace.log",
      GIT_CONFIG_COUNT: "9",
      GIT_CONFIG_KEY_0: "credential.helper",
    });
    expect(delivered).toMatchObject({
      number: 43,
      draft: true,
      author: "coga-factory-kayz[bot]",
    });
    for (const call of fake.calls) {
      expect(call.args.join("\0")).not.toContain(installationToken);
      expect(call.options.env?.COGA_FACTORY_GITHUB_TOKEN).toBeUndefined();
      expect(call.options.env?.GITHUB_TOKEN).toBeUndefined();
      expect(call.options.env?.GITHUB_PAT).toBeUndefined();
      expect(call.options.env?.GH_DEBUG).toBeUndefined();
      expect(call.options.env?.GH_CONFIG_DIR).toBeUndefined();
      expect(call.options.env?.GCM_TRACE).toBeUndefined();
      expect(call.options.env?.GIT_ASKPASS).toBeUndefined();
      expect(call.options.env?.GIT_CONFIG).toBeUndefined();
      expect(call.options.env?.GIT_DIR).toBeUndefined();
      expect(call.options.env?.GIT_EXEC_PATH).toBeUndefined();
      expect(call.options.env?.SSH_ASKPASS).toBeUndefined();
      expect(call.options.env?.GIT_CURL_VERBOSE).toBeUndefined();
      expect(call.options.env?.GIT_TRACE).toBeUndefined();
      expect(call.options.env?.GIT_TRACE_CURL).toBeUndefined();
      if (call.command === "gh") {
        expect(call.options.env?.GH_TOKEN).toBe(installationToken);
        expect(call.options.env?.GH_HOST).toBe("github.com");
        expect(call.options.env?.GH_PROMPT_DISABLED).toBe("1");
        expect(call.options.env?.GH_NO_UPDATE_NOTIFIER).toBe("1");
        expect(call.options.env?.GIT_CONFIG_COUNT).toBeUndefined();
        expect(call.options.env?.GIT_CONFIG_NOSYSTEM).toBeUndefined();
        expect(call.options.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
      }
    }
    const push = fake.calls.find(
      (entry) => entry.command === "git" && entry.args[0] === "push",
    );
    expect(push?.args).toEqual([
      "push",
      "--no-verify",
      "https://github.com/kayz/coga-core.git",
      `HEAD:refs/heads/${fixture().target.delivery.branch}`,
    ]);
    expect(push?.options.env?.GH_TOKEN).toBeUndefined();
    expect(push?.options.env?.GCM_INTERACTIVE).toBe("Never");
    expect(push?.options.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(push?.options.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(push?.options.env?.GIT_CONFIG_GLOBAL).toBeTruthy();
    expect(push?.options.env?.GIT_CONFIG_COUNT).toBe("7");
    expect(push?.options.env?.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(push?.options.env?.GIT_CONFIG_VALUE_0).toBe("");
    expect(push?.options.env?.GIT_CONFIG_KEY_1).toBe("core.askPass");
    expect(push?.options.env?.GIT_CONFIG_VALUE_1).toBe("");
    expect(push?.options.env?.GIT_CONFIG_KEY_2).toBe("http.extraheader");
    expect(push?.options.env?.GIT_CONFIG_VALUE_2).toBe("");
    expect(push?.options.env?.GIT_CONFIG_KEY_3).toBe(
      "http.https://github.com/kayz/coga-core.git.extraheader",
    );
    expect(push?.options.env?.GIT_CONFIG_VALUE_3).toBe("");
    expect(push?.options.env?.GIT_CONFIG_KEY_4).toBe(
      "http.https://github.com/kayz/coga-core.git.extraheader",
    );
    expect(push?.options.env?.GIT_CONFIG_KEY_5).toBe(
      "http.https://github.com/kayz/coga-core.git.sslVerify",
    );
    expect(push?.options.env?.GIT_CONFIG_VALUE_5).toBe("true");
    expect(push?.options.env?.GIT_CONFIG_KEY_6).toBe(
      "http.https://github.com/kayz/coga-core.git.followRedirects",
    );
    expect(push?.options.env?.GIT_CONFIG_VALUE_6).toBe("initial");
  });

  it.each(["insteadOf", "pushInsteadOf"])(
    "rejects a local %s rewrite of the credentialed GitHub endpoint",
    async (kind) => {
      const fake = fakeRunner({
        urlRewrite: {
          key: `url.https://attacker.invalid/.${kind}`,
          value: "https://github.com/",
        },
      });
      await expect(
        deliver(fake.runner, {
          COGA_FACTORY_GITHUB_TOKEN: installationToken,
        }),
      ).rejects.toThrow(/URL rewrite configuration applies/iu);
      expect(fake.calls.some((entry) => entry.args[0] === "ls-remote")).toBe(
        false,
      );
      expect(fake.calls.some((entry) => entry.args[0] === "push")).toBe(false);
    },
  );

  it.each([
    ["head", { localHead: "4".repeat(40) }, /Local candidate moved/iu],
    ["branch", { localBranch: "human/other" }, /Local Factory branch/iu],
  ])(
    "rejects a mismatched local %s before credentialed Git access",
    async (_label, options, expected) => {
      const fake = fakeRunner(options);
      await expect(
        deliver(fake.runner, {
          COGA_FACTORY_GITHUB_TOKEN: installationToken,
        }),
      ).rejects.toThrow(expected);
      expect(fake.calls.some((entry) => entry.args[0] === "ls-remote")).toBe(
        false,
      );
      expect(fake.calls.some((entry) => entry.args[0] === "push")).toBe(false);
    },
  );

  it("rejects a cross-repository PR identity before attempting to view it", async () => {
    const base = fakeRunner({});
    const runner: GitHubDeliveryCommandRunner = async (
      command,
      args,
      options,
    ) => {
      if (
        command === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST"
      ) {
        base.calls.push({ command, args, options });
        return result(
          JSON.stringify({
            ...restPullRequest("coga-factory-kayz[bot]"),
            html_url: "https://github.com/attacker/other/pull/43",
          }),
        );
      }
      return base.runner(command, args, options);
    };
    await expect(
      deliver(runner, { COGA_FACTORY_GITHUB_TOKEN: installationToken }),
    ).rejects.toThrow(/invalid PR identity/iu);
    expect(
      base.calls.some(
        (entry) =>
          entry.command === "gh" &&
          entry.args[0] === "api" &&
          entry.args[1] === "repos/kayz/coga-core/pulls/43",
      ),
    ).toBe(false);
  });

  it("rejects a PR whose head repository differs from the pushed repository", async () => {
    const base = fakeRunner({});
    const runner: GitHubDeliveryCommandRunner = async (
      command,
      args,
      options,
    ) => {
      if (
        command === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST"
      ) {
        base.calls.push({ command, args, options });
        const snapshot = restPullRequest("coga-factory-kayz[bot]");
        snapshot.head.repo.full_name = "kayz/another-repo";
        return result(JSON.stringify(snapshot));
      }
      return base.runner(command, args, options);
    };
    await expect(
      deliver(runner, { COGA_FACTORY_GITHUB_TOKEN: installationToken }),
    ).rejects.toThrow(/invalid PR identity/iu);
  });
});
