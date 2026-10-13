import {
  isMissingGithubRefError,
  resolveBackupBranch,
  type GithubBackupBranchDependencies,
} from "./branch.ts";

Deno.test("recognizes GitHub's empty-repository conflict as a missing ref", () => {
  const error = Object.assign(new Error("Git Repository is empty."), { status: 409 });
  assertEquals(isMissingGithubRefError(error), true);
});

Deno.test("does not treat unrelated ref conflicts as an empty repository", () => {
  const error = Object.assign(new Error("Reference update failed"), { status: 409 });
  assertEquals(isMissingGithubRefError(error), false);
});

Deno.test("recognizes a not-found ref response", () => {
  const error = Object.assign(new Error("Reference not found"), { status: 404 });
  assertEquals(isMissingGithubRefError(error), true);
});

Deno.test("initializes an empty repository and follows its configured default branch", async () => {
  const calls: string[] = [];
  let initialized = false;
  const dependencies: GithubBackupBranchDependencies = {
    getBranch: async (branchName) => {
      calls.push(`getBranch:${branchName}`);
      if (!initialized || branchName !== "trunk") return null;
      return { commitSha: "bootstrap-commit", treeSha: "bootstrap-tree" };
    },
    initializeEmptyRepository: async (file) => {
      calls.push(`initialize:${file.path}`);
      initialized = true;
    },
    getDefaultBranch: async () => {
      calls.push("getDefaultBranch");
      return "trunk";
    },
  };

  const result = await resolveBackupBranch(
    "main",
    { path: "users/user-123/README.md", content: "# RevNote backup\n" },
    dependencies,
  );

  assertEquals(result, {
    branch: "trunk",
    parent: { commitSha: "bootstrap-commit", treeSha: "bootstrap-tree" },
  });
  assertEquals(calls, [
    "getBranch:main",
    "initialize:users/user-123/README.md",
    "getDefaultBranch",
    "getBranch:trunk",
  ]);
});

Deno.test("keeps the existing branch and parent commit when the repository is initialized", async () => {
  const calls: string[] = [];
  const dependencies: GithubBackupBranchDependencies = {
    getBranch: async (branchName) => {
      calls.push(`getBranch:${branchName}`);
      return { commitSha: "existing-commit", treeSha: "existing-tree" };
    },
    initializeEmptyRepository: async () => {
      throw new Error("An initialized repository must not be bootstrapped");
    },
    getDefaultBranch: async () => {
      throw new Error("The existing branch already identifies the default branch");
    },
  };

  const result = await resolveBackupBranch(
    "main",
    { path: "users/user-123/README.md", content: "# RevNote backup\n" },
    dependencies,
  );

  assertEquals(result, {
    branch: "main",
    parent: { commitSha: "existing-commit", treeSha: "existing-tree" },
  });
  assertEquals(calls, ["getBranch:main"]);
});

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}
