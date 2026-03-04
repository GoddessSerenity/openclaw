export const PROJECT_STATES = ["planning", "active", "paused", "complete", "archived"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const LINK_CATEGORIES = ["dev", "prod", "docs", "admin", "api", "other"] as const;
export type LinkCategory = (typeof LINK_CATEGORIES)[number];

export const CMD_CATEGORIES = ["dev", "build", "test", "deploy", "lint", "db", "other"] as const;
export type CmdCategory = (typeof CMD_CATEGORIES)[number];

export const CMD_RUN_MODES = ["exec", "task"] as const;
export type CmdRunMode = (typeof CMD_RUN_MODES)[number];

export const TASK_STATUSES = [
  "planning",
  "queue",
  "executing",
  "review_requested",
  "changes_requested",
  "stalled",
  "done",
  "cancelled",
  "blocked",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = ["feature", "bugfix", "iteration", "hotfix", "chore"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_DEFAULTS: Record<
  TaskType,
  {
    requires_branching: boolean;
    requires_human_review: boolean;
    uses_build: boolean;
    uses_deploy: boolean;
  }
> = {
  feature: {
    requires_branching: true,
    requires_human_review: true,
    uses_build: true,
    uses_deploy: true,
  },
  bugfix: {
    requires_branching: true,
    requires_human_review: false,
    uses_build: true,
    uses_deploy: true,
  },
  iteration: {
    requires_branching: false,
    requires_human_review: true,
    uses_build: false,
    uses_deploy: false,
  },
  hotfix: {
    requires_branching: false,
    requires_human_review: false,
    uses_build: true,
    uses_deploy: true,
  },
  chore: {
    requires_branching: true,
    requires_human_review: false,
    uses_build: false,
    uses_deploy: false,
  },
};

export const MEMORY_CATEGORIES = [
  "mistake",
  "learning",
  "convention",
  "gotcha",
  "decision",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const PROJECT_STATE_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  planning: ["active"],
  active: ["paused", "complete"],
  paused: ["active", "archived"],
  complete: ["archived"],
  archived: ["active"],
};

export const TASK_STATUS_TRANSITIONS: Record<string, TaskStatus[]> = {
  planning: ["queue"],
  queue: ["executing"],
  executing: ["review_requested", "done", "queue", "stalled"],
  review_requested: ["done", "changes_requested"],
  changes_requested: ["queue", "cancelled"],
  stalled: ["queue", "cancelled"],
};

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: ProjectState;
  workspace_path: string | null;
  github_remote: string | null;
  telegram_topic_id: number | null;
  has_build_step: boolean;
  has_deploy_step: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectLinkRow {
  id: number;
  project_id: string;
  label: string;
  url: string;
  category: LinkCategory;
}

export interface CommandRow {
  id: number;
  project_id: string;
  label: string;
  command: string;
  cwd: string | null;
  description: string | null;
  category: CmdCategory;
  run_mode: CmdRunMode;
  task_runner_id: string | null;
  locked: boolean;
  locked_by: string | null;
  locked_at: Date | null;
}

export interface TaskRow {
  id: number;
  project_id: string;
  title: string;
  slug: string | null;
  description: string | null;
  status: TaskStatus;
  status_before_blocked: TaskStatus | null;
  task_type: TaskType;
  requires_branching: boolean;
  requires_human_review: boolean;
  priority: number;
  phase: string | null;
  git_branch: string | null;
  worktree_path: string | null;
  dev_server_url: string | null;
  review_notes: string | null;
  review_feedback: string | null;
  block_reason: string | null;
  max_attempts: number;
  attempt_count: number;
  last_attempt_at: Date | null;
  execution_notes: string | null;
  estimated_complexity: "trivial" | "small" | "medium" | "large" | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface TaskDependencyRow {
  task_id: number;
  depends_on_id: number;
}

export interface TaskStatusHistoryRow {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  actor: string | null;
  reason: string | null;
  created_at: Date;
}

export interface TaskAttemptRow {
  id: number;
  task_id: number;
  session_key: string | null;
  model: string | null;
  summary: string;
  outcome: "success" | "partial" | "failed" | "abandoned";
  error_log: string | null;
  files_changed: string | null;
  duration_ms: number | null;
  git_branch: string | null;
  git_diff_summary: string | null;
  created_at: Date;
}

export interface MemoryRow {
  id: number;
  project_id: string;
  category: MemoryCategory;
  content: string;
  created_at: Date;
}

export interface ProjectPortRow {
  id: number;
  project_id: string;
  label: string;
  description: string | null;
}

export interface PortAssignmentRow {
  id: number;
  port: number;
  task_id: number;
  project_port_id: number;
  project_id: string;
  assigned_at: Date;
  released_at: Date | null;
}

export interface PortMapEntry {
  label: string;
  port: number;
  url: string;
}

export interface ProjectEnvRow {
  id: number;
  project_id: string;
  key: string;
  value: string;
  is_secret: boolean;
  description: string | null;
}

export interface ProjectContext {
  project: ProjectRow;
  links: ProjectLinkRow[];
  commands: CommandRow[];
  tasks: TaskRow[];
  task_dependencies: TaskDependencyRow[];
  recent_memory: MemoryRow[];
  ports: ProjectPortRow[];
  running_processes: unknown[];
}

export interface TaskDetail {
  task: TaskRow;
  dependencies: TaskDependencyRow[];
  attempts: TaskAttemptRow[];
  status_history: TaskStatusHistoryRow[];
  port_assignments: PortAssignmentRow[];
}
