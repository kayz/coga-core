import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitRepository } from "../src/git.js";
import { sha256 } from "../src/utils.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

describe("bounded Patch adapter", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coga-factory-git-"));
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Factory Test");
    git(root, "config", "user.email", "factory@example.invalid");
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".gitignore"), ".local/\n");
    writeFileSync(join(root, "allowed.txt"), "before\n");
    writeFileSync(join(root, "other.txt"), "unchanged\n");
    git(root, "add", "--all");
    git(root, "commit", "-m", "base");
  });

  it("applies an authorized patch once and resumes idempotently", async () => {
    const patch = [
      "diff --git a/allowed.txt b/allowed.txt",
      "--- a/allowed.txt",
      "+++ b/allowed.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const path = join(root, ".local", "allowed.patch");
    writeFileSync(path, patch);
    const repository = await GitRepository.open(root);
    const reference = { path: ".local/allowed.patch", digest: sha256(patch) };
    await expect(
      repository.applyPatch(root, reference, ["allowed.txt"], "test patch"),
    ).resolves.toMatchObject({ alreadyApplied: false, paths: ["allowed.txt"] });
    await expect(
      repository.applyPatch(root, reference, ["allowed.txt"], "test patch"),
    ).resolves.toMatchObject({ alreadyApplied: true, paths: ["allowed.txt"] });
  });

  it("does not duplicate an already applied zero-context addition", async () => {
    const patch = [
      "diff --git a/allowed.txt b/allowed.txt",
      "--- a/allowed.txt",
      "+++ b/allowed.txt",
      "@@ -1,0 +2 @@",
      "+after",
      "",
    ].join("\n");
    const path = join(root, ".local", "zero-context.patch");
    writeFileSync(path, patch);
    const repository = await GitRepository.open(root);
    const reference = {
      path: ".local/zero-context.patch",
      digest: sha256(patch),
    };
    await expect(
      repository.applyPatch(root, reference, ["allowed.txt"], "zero patch"),
    ).resolves.toMatchObject({ alreadyApplied: false });
    await expect(
      repository.applyPatch(root, reference, ["allowed.txt"], "zero patch"),
    ).resolves.toMatchObject({ alreadyApplied: true });
    expect(
      readFileSync(join(root, "allowed.txt"), "utf8").replaceAll("\r\n", "\n"),
    ).toBe("before\nafter\n");
  });

  it("rejects disallowed, escaping, symlink, mode-conversion, and deletion patches", async () => {
    const repository = await GitRepository.open(root);
    const cases = [
      {
        name: "disallowed",
        source:
          "diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-unchanged\n+changed\n",
      },
      {
        name: "escape",
        source:
          "diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+bad\n",
      },
      {
        name: "symlink",
        source:
          "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+outside\n",
      },
      {
        name: "symlink-conversion",
        source:
          "diff --git a/allowed.txt b/allowed.txt\nold mode 100644\nnew mode 120000\n--- a/allowed.txt\n+++ b/allowed.txt\n@@ -1 +1 @@\n-before\n+outside\n",
      },
      {
        name: "delete",
        source:
          "diff --git a/allowed.txt b/allowed.txt\ndeleted file mode 100644\n--- a/allowed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n",
      },
    ];
    for (const item of cases) {
      const path = join(root, ".local", `${item.name}.patch`);
      writeFileSync(path, item.source);
      await expect(
        repository.applyPatch(
          root,
          { path: `.local/${item.name}.patch`, digest: sha256(item.source) },
          ["allowed.txt"],
          `${item.name} patch`,
        ),
      ).rejects.toThrow();
    }
  });
});
