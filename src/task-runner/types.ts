export type TaskStatus =
  | "pending"
  | "running"
  | "stopped"
  | "failed"
  | "killed"
  | "timeout"
  | "lost";

export type TaskSignal = NodeJS.Signals | number;

export type TaskRecord = {
  id: string;
  status: TaskStatus;
  pid?: number;

  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  tags?: string[];

  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;

  exitCode?: number | null;
  exitSignal?: TaskSignal | null;

  logPath: string;
  pidPath?: string;

  /** True if stdin is available for task_write (only while gateway instance is alive). */
  stdinAttached?: boolean;
};

export type TaskRunnerConfig = {
  maxConcurrentTasks: number;
  maxLogSizeBytes: number;
  allowedCwds: string[];
  blockedEnvVars: string[];
};

export type TaskRunnerStateFile = {
  version: 1;
  updatedAt: number;
  tasks: Record<string, TaskRecord>;
};

export type TaskStartRequest = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  tags?: string[];
  id?: string;

  /**
   * If true and a task with the same id exists in a terminal state,
   * remove it and start a new one. If the existing task is still running,
   * also stop it first when `force` is true.
   */
  replace?: boolean;

  /**
   * If true, force-stop any running/pending task with the same id before
   * replacing it. Requires `replace` to also be true (or is implied).
   */
  force?: boolean;

  /**
   * If true and `tags` contains at least one tag, stop all running/pending
   * tasks that share any of those tags before starting the new task.
   * This is the "force-start by label" feature.
   */
  forceByTags?: boolean;

  /** Timeout in ms for stopping tasks during force/replace (default 5000). */
  stopTimeoutMs?: number;
};

export type TaskLogsRequest = {
  id: string;
  tailBytes?: number;
  sinceBytes?: number;
  maxBytes?: number;
};

export type TaskLogsResponse = {
  id: string;
  logPath: string;
  text: string;
  nextSinceBytes: number;
  truncated: boolean;
};
