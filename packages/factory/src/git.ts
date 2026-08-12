import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { EvidenceFile, FileReference } from "./types.js";
import {
  normalizeRelativePath,
  readBoundedFile,
  resolveWithin,
  runChecked,
  runProcess,
  sha256,
  verifyFileReference,
} from "./utils.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_PATTERN = /^codex\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

function nulList(value: string): string[] {
  return value
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function pathAllowed(path: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

function patchPaths(source: string): string[] {
  if (source.includes("\0")) throw new Error("Patch contains a NUL byte.");
  const paths = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (/^(?:rename|copy) (?:from|to) /u.test(line)) {
      throw new Error("Patch rename and copy operations are not supported.");
    }
    if (
      /^(?:deleted file mode|(?:new file mode|new mode|old mode) (?:120000|160000))/u.test(
        line,
      )
    ) {
      throw new Error(
        "Patch deletion, symlink, and submodule operations are forbidden.",
      );
    }
    if (line === "+++ /dev/null") {
      throw new Error("Patch deletion is forbidden.");
    }
    const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line);
    if (!match) continue;
    const left = normalizeRelativePath(match[1] ?? "", "patch source path");
    const right = normalizeRelativePath(match[2] ?? "", "patch target path");
    if (left !== right) throw new Error("Patch path changes are forbidden.");
    paths.add(right);
  }
  if (paths.size === 0) throw new Error("Patch has no diff entries.");
  return [...paths].sort();
}

export class GitRepository {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(path: string): Promise<GitRepository> {
    const result = await runChecked(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: resolve(path), timeoutMs: 30_000 },
      "git repository discovery",
    );
    return new GitRepository(resolve(result.stdout.trim()));
  }

  async git(args: readonly string[], cwd = this.root): Promise<string> {
    const result = await runChecked(
      "git",
      args,
      { cwd, timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 },
      `git ${args[0] ?? "command"}`,
    );
    return result.stdout.trim();
  }

  async resolveWorkOrderBase(
    workOrderPath: string,
    requested: string,
  ): Promise<string> {
    const relativePath = relative(this.root, resolve(workOrderPath)).replaceAll(
      "\\",
      "/",
    );
    normalizeRelativePath(relativePath, "Work Order repository path");
    const commit =
      requested === "work-order-commit"
        ? await this.git(["rev-parse", "HEAD^{commit}"])
        : requested;
    if (!COMMIT_PATTERN.test(commit))
      throw new Error(
        "Base commit must resolve to 40 lowercase hex characters.",
      );
    await this.git(["cat-file", "-e", `${commit}^{commit}`]);
    const tracked = await runProcess(
      "git",
      ["show", `${commit}:${relativePath}`],
      { cwd: this.root, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
    );
    if (tracked.exitCode !== 0) {
      throw new Error(
        `Work Order '${relativePath}' is not tracked by base commit ${commit}.`,
      );
    }
    const local = readBoundedFile(
      resolve(workOrderPath),
      "Work Order",
    ).toString("utf8");
    if (tracked.stdout !== local) {
      throw new Error(
        "Work Order bytes differ from the exact base commit; commit it before execution.",
      );
    }
    return commit;
  }

  async assertClean(): Promise<void> {
    const status = await this.git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.length > 0)
      throw new Error(
        "Factory repository must be clean before creating a worktree.",
      );
  }

  async createWorktree(
    path: string,
    commit: string,
    branch: string,
  ): Promise<void> {
    if (!BRANCH_PATTERN.test(branch))
      throw new Error(`Unsafe factory branch '${branch}'.`);
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Factory worktree commit is malformed.");
    await this.git(["cat-file", "-e", `${commit}^{commit}`]);
    if (existsSync(path)) {
      const [actualCommit, actualBranch, actualRoot, actualCommon, rootCommon] =
        await Promise.all([
          this.git(["rev-parse", "HEAD^{commit}"], path),
          this.git(["branch", "--show-current"], path),
          this.git(["rev-parse", "--show-toplevel"], path),
          this.git(["rev-parse", "--git-common-dir"], path),
          this.git(["rev-parse", "--git-common-dir"], this.root),
        ]);
      if (
        actualCommit !== commit ||
        actualBranch !== branch ||
        resolve(actualRoot) !== resolve(path) ||
        resolve(path, actualCommon) !== resolve(this.root, rootCommon)
      ) {
        throw new Error(
          `Existing factory workspace '${path}' does not match commit ${commit}, branch '${branch}', and repository '${this.root}'.`,
        );
      }
      return;
    }
    const existing = await runProcess(
      "git",
      ["show-ref", "--verify", `refs/heads/${branch}`],
      { cwd: this.root, timeoutMs: 30_000 },
    );
    if (existing.exitCode === 0) {
      throw new Error(
        `Factory branch '${branch}' already exists; refusing to overwrite it.`,
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    await this.git(["worktree", "add", "--detach", path, commit]);
    try {
      await this.git(["switch", "-c", branch], path);
    } catch (error) {
      await runProcess("git", ["worktree", "remove", "--force", path], {
        cwd: this.root,
        timeoutMs: 30_000,
      });
      throw error;
    }
  }

  async applyPatch(
    workspace: string,
    reference: FileReference,
    allowedPaths: readonly string[],
    label: string,
  ): Promise<{ paths: string[]; alreadyApplied: boolean }> {
    const normalizedAllowed = allowedPaths.map((entry) =>
      normalizeRelativePath(entry, `${label} allowed path`),
    );
    const patchPath = verifyFileReference(workspace, reference, label);
    const source = readBoundedFile(patchPath, label).toString("utf8");
    const paths = patchPaths(source);
    for (const path of paths) {
      if (!pathAllowed(path, normalizedAllowed)) {
        throw new Error(
          `${label} attempts to change disallowed path '${path}'.`,
        );
      }
      const target = resolveWithin(workspace, path, `${label} target`);
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error(`${label} cannot modify symbolic link '${path}'.`);
      }
    }

    const check = await runProcess(
      "git",
      [
        "apply",
        "--check",
        "--unidiff-zero",
        "--whitespace=error-all",
        patchPath,
      ],
      { cwd: workspace, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
    );
    if (check.exitCode !== 0) {
      const reverse = await runProcess(
        "git",
        ["apply", "--reverse", "--check", "--unidiff-zero", patchPath],
        { cwd: workspace, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
      );
      if (reverse.exitCode === 0) return { paths, alreadyApplied: true };
      throw new Error(
        `${label} cannot be applied: ${check.stderr.trim() || check.stdout.trim()}.`,
      );
    }
    await this.git(
      ["apply", "--unidiff-zero", "--whitespace=error-all", patchPath],
      workspace,
    );
    return { paths, alreadyApplied: false };
  }

  async changedPaths(workspace: string, baseCommit: string): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.git(["diff", "--name-only", "-z", baseCommit, "--"], workspace),
      this.git(["ls-files", "--others", "--exclude-standard", "-z"], workspace),
    ]);
    return [...new Set([...nulList(tracked), ...nulList(untracked)])].sort();
  }

  async assertOnlyAllowedChanges(
    workspace: string,
    baseCommit: string,
    allowedPaths: readonly string[],
  ): Promise<string[]> {
    const normalized = allowedPaths.map((entry) =>
      normalizeRelativePath(entry, "allowed path"),
    );
    const changed = await this.changedPaths(workspace, baseCommit);
    for (const path of changed) {
      if (!pathAllowed(path, normalized)) {
        throw new Error(
          `Workspace contains a change outside the authorized paths: '${path}'.`,
        );
      }
    }
    return changed;
  }

  evidenceFiles(workspace: string, paths: readonly string[]): EvidenceFile[] {
    return paths.map((path) => {
      const absolute = resolveWithin(workspace, path, "changed file");
      const value = readBoundedFile(
        absolute,
        `changed file '${path}'`,
        10 * 1024 * 1024,
      );
      return { path, digest: sha256(value), bytes: value.byteLength };
    });
  }

  async stageAndWriteTree(workspace: string): Promise<string> {
    await this.git(["add", "--all", "--"], workspace);
    const tree = await this.git(["write-tree"], workspace);
    if (!COMMIT_PATTERN.test(tree))
      throw new Error("git write-tree returned an invalid tree identifier.");
    return tree;
  }

  async commit(workspace: string, message: string): Promise<string> {
    await this.git(["add", "--all", "--"], workspace);
    const result = await runChecked(
      "git",
      [
        "-c",
        "user.name=COGA Factory",
        "-c",
        "user.email=coga-factory@users.noreply.github.com",
        "commit",
        "--no-gpg-sign",
        "-m",
        message,
      ],
      { cwd: workspace, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
      "factory commit",
    );
    void result;
    const commit = await this.git(["rev-parse", "HEAD^{commit}"], workspace);
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Factory result commit is invalid.");
    return commit;
  }

  async removeWorktree(workspace: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", workspace]);
  }
}
