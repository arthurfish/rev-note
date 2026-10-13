export interface GithubBackupBranch {
  commitSha: string;
  treeSha: string;
}

export interface GithubBackupBranchDependencies {
  getBranch(branchName: string): Promise<GithubBackupBranch | null>;
  initializeEmptyRepository(file: { path: string; content: string }): Promise<void>;
  getDefaultBranch(): Promise<string | null>;
}

export function isMissingGithubRefError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  return status === 404 || (status === 409 && /repository is empty/i.test(error.message));
}

export async function resolveBackupBranch(
  initialBranch: string,
  initialFile: { path: string; content: string },
  dependencies: GithubBackupBranchDependencies,
) {
  let branch = initialBranch;
  let parent = await dependencies.getBranch(branch);

  if (!parent) {
    await dependencies.initializeEmptyRepository(initialFile);
    branch = await dependencies.getDefaultBranch() ?? initialBranch;
    parent = await dependencies.getBranch(branch);
    if (!parent) throw new Error("GitHub repository remained empty after initialization");
  }

  return {
    branch,
    parent,
  };
}
