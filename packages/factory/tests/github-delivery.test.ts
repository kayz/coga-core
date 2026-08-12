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
const installationToken = `ghs_${"a".repeat(40)}`;

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
  return {
    number,
    html_url: `https://github.com/kayz/coga-core/pull/${number}`,
    state: "open",
    draft: true,
    merged_at: null,
    user: { login: author },
    base: { sha: baseCommit },
    head: { sha: resultCommit },
  };
}

function fakeRunner(options: {
  accessibleRepository?: string;
  existingAuthor?: string;
  createdAuthor?: string;
  preflightFailure?: string;
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
    { runner, environment },
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
      if (call.command === "gh") {
        expect(call.options.env?.GH_TOKEN).toBe(installationToken);
        expect(call.options.env?.GIT_CONFIG_COUNT).toBeUndefined();
      }
    }
    const push = fake.calls.find(
      (entry) => entry.command === "git" && entry.args[0] === "push",
    );
    expect(push?.args[1]).toBe("https://github.com/kayz/coga-core.git");
    expect(push?.options.env?.GH_TOKEN).toBeUndefined();
    expect(push?.options.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(push?.options.env?.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
  });

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
});
