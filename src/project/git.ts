import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export async function initProjectRepo(
  workspacePath: string,
  githubRemote?: string | null,
): Promise<void> {
  const mainPath = path.join(workspacePath, "main");
  const worktreesPath = path.join(workspacePath, "worktrees");

  await fs.mkdir(mainPath, { recursive: true });
  await fs.mkdir(worktreesPath, { recursive: true });

  await execFile("git", ["-C", mainPath, "init"]);
  await execFile("git", ["-C", mainPath, "checkout", "-b", "main"]);

  await fs.writeFile(path.join(mainPath, "README.md"), `# Project\n`);
  await execFile("git", ["-C", mainPath, "add", "."]);
  await execFile("git", ["-C", mainPath, "commit", "-m", "Initial commit"]);

  if (githubRemote) {
    await execFile("git", ["-C", mainPath, "remote", "add", "origin", githubRemote]);
  }
}

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
