import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await execFile("git", ["-C", repoPath, "worktree", "add", "-B", branchName, worktreePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  try {
    await execFile("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    await execFile("git", ["-C", repoPath, "branch", "-D", branchName], {
      maxBuffer: 10 * 1024 * 1024,
    }).catch(() => undefined);
    await execFile("git", ["-C", repoPath, "worktree", "prune"], {
      maxBuffer: 10 * 1024 * 1024,
    }).catch(() => undefined);
  }
}

export async function mergeBranch(
  repoPath: string,
  branchName: string,
): Promise<{ success: boolean; conflict: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFile(
      "git",
      ["-C", repoPath, "merge", "--no-ff", branchName],
      {
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return { success: true, conflict: false, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.trim();
    const lower = output.toLowerCase();
    const conflict = lower.includes("conflict") || lower.includes("automatic merge failed");
    if (conflict) {
      await execFile("git", ["-C", repoPath, "merge", "--abort"], {
        maxBuffer: 10 * 1024 * 1024,
      }).catch(() => undefined);
    }
    return { success: false, conflict, output };
  }
}
