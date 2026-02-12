export type TaskStatus =
  | "pending"
  | "running"
  | "stopped"
  | "failed"
  | "killed"
  | "timeout"
  | "lost";

export type TaskSignal = NodeJS.Signals | number | string;

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
