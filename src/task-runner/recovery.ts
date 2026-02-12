import fs from "node:fs/promises";
import path from "node:path";
import type { TaskRunnerStateFile, TaskStatus } from "./types.js";

function isRunningPid(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function now() {
  return Date.now();
}

function isTerminal(status: TaskStatus) {
  return (
    status === "stopped" ||
    status === "failed" ||
    status === "killed" ||
    status === "timeout" ||
    status === "lost"
  );
}

export async function recoverTaskRunnerState(params: {
  statePath: string;
}): Promise<{ state: TaskRunnerStateFile; changed: boolean }> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(params.statePath, "utf8");
  } catch {
    // no state file
  }

  const empty: TaskRunnerStateFile = { version: 1, updatedAt: now(), tasks: {} };
  if (!raw) {
    return { state: empty, changed: false };
  }

  let parsed: TaskRunnerStateFile | null = null;
  try {
    parsed = JSON.parse(raw) as TaskRunnerStateFile;
  } catch {
    return { state: empty, changed: true };
  }

  if (!parsed || parsed.version !== 1 || typeof parsed.tasks !== "object") {
    return { state: empty, changed: true };
  }

  let changed = false;
  for (const task of Object.values(parsed.tasks)) {
    if (!task || typeof task !== "object") {
      continue;
    }

    // Recompute derived paths if missing.
    if (!task.logPath) {
      task.logPath = path.join(path.dirname(params.statePath), "logs", `${task.id}.log`);
      changed = true;
    }
    if (!task.pidPath) {
      task.pidPath = path.join(path.dirname(params.statePath), "pids", `${task.id}.pid`);
      changed = true;
    }

    task.stdinAttached = false;

    if (task.status === "running" || task.status === "pending") {
      const pid = typeof task.pid === "number" ? task.pid : undefined;
      if (!pid || !isRunningPid(pid)) {
        task.status = "lost";
        task.endedAt = task.endedAt ?? now();
        task.updatedAt = now();
        changed = true;
      } else {
        // keep running
      }
    } else if (!isTerminal(task.status)) {
      task.status = "lost";
      task.endedAt = task.endedAt ?? now();
      task.updatedAt = now();
      changed = true;
    }
  }

  parsed.updatedAt = now();
  return { state: parsed, changed };
}
