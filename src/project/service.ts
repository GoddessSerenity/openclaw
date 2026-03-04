/* eslint-disable @typescript-eslint/no-base-to-string */
import { execFile as execFileCb } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { getTaskRunnerService } from "../task-runner/service.js";
import { execute, getProjectPool, query } from "./db.js";
import { createWorktree, initProjectRepo, removeWorktree } from "./git.js";
import { runMigrations } from "./migrations.js";
import {
  type CommandRow,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryRow,
  type PortAssignmentRow,
  type PortMapEntry,
  PROJECT_STATE_TRANSITIONS,
  type ProjectContext,
  type ProjectEnvRow,
  type ProjectLinkRow,
  type ProjectPortRow,
  type ProjectRow,
  TASK_TYPE_DEFAULTS,
  type TaskAttemptRow,
  type TaskDependencyRow,
  type TaskDetail,
  type TaskRow,
  type TaskStatus,
  type TaskStatusHistoryRow,
  type TaskType,
} from "./types.js";

const execFile = promisify(execFileCb);

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(v)) {
      return false;
    }
  }
  return fallback;
}

// ─── Port Pool Configuration ─────────────────────────────────────
const PORT_POOL_START = 4000;
const PORT_POOL_END = 4999;

function getGatewayHost(): string {
  return process.env.OPENCLAW_HOST || "10.0.0.20";
}

/** Check if a port is bindable (not in use by another process) */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => {
      srv.close(() => resolve(true));
    });
  });
}

export class ProjectService {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await runMigrations();
    this.initialized = true;
  }

  private async ensureProject(projectId: string): Promise<ProjectRow> {
    const rows = await query<ProjectRow>("SELECT * FROM projects WHERE id=?", [projectId]);
    if (!rows[0]) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return rows[0];
  }

  private async ensureTask(taskId: number): Promise<TaskRow> {
    const rows = await query<TaskRow>("SELECT * FROM project_tasks WHERE id=?", [taskId]);
    if (!rows[0]) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return rows[0];
  }

  private async ensureCommand(commandId: number): Promise<CommandRow> {
    const rows = await query<CommandRow>("SELECT * FROM project_commands WHERE id=?", [commandId]);
    if (!rows[0]) {
      throw new Error(`Command not found: ${commandId}`);
    }
    return rows[0];
  }

  private async transitionTaskStatus(params: {
    taskId: number;
    toStatus: TaskStatus;
    allowedFrom: TaskStatus[];
    actor?: string;
    reason?: string;
  }): Promise<TaskRow> {
    const task = await this.ensureTask(params.taskId);
    const result = await execute(
      `UPDATE project_tasks SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN (${params.allowedFrom
        .map(() => "?")
        .join(",")})`,
      [params.toStatus, params.taskId, ...params.allowedFrom],
    );
    if (result.affectedRows !== 1) {
      throw new Error(
        `Task status transition failed for ${params.taskId}: ${task.status} -> ${params.toStatus}`,
      );
    }
    await execute(
      "INSERT INTO task_status_history (task_id, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)",
      [params.taskId, task.status, params.toStatus, params.actor ?? null, params.reason ?? null],
    );
    return await this.ensureTask(params.taskId);
  }

  private ensureCmdUnlocked(command: CommandRow, force = false, reason?: string): void {
    if (!command.locked) {
      return;
    }
    if (!force) {
      throw new Error(`Command ${command.id} is locked`);
    }
    if (!reason?.trim()) {
      throw new Error("force reason required when mutating locked command");
    }
  }

  async project_create(input: Record<string, unknown>) {
    await this.init();
    const id = String(input.id ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!id || !name) {
      throw new Error("id and name required");
    }
    const description = input.description == null ? null : String(input.description);
    const workspace_path = `/home/serenity/pm-workspaces/${id}/`;
    const github_remote = input.githubRemote == null ? null : String(input.githubRemote);
    const telegram_topic_id =
      input.telegramTopicId == null ? null : Number.parseInt(String(input.telegramTopicId), 10);
    const has_build_step = asBool(input.hasBuildStep, true);
    const has_deploy_step = asBool(input.hasDeployStep, true);

    // Initialize project repo and workspace directories
    await initProjectRepo(workspace_path, github_remote);

    await execute(
      `INSERT INTO projects
      (id, name, description, workspace_path, github_remote, telegram_topic_id, has_build_step, has_deploy_step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        description,
        workspace_path,
        github_remote,
        Number.isFinite(telegram_topic_id) ? telegram_topic_id : null,
        has_build_step,
        has_deploy_step,
      ],
    );
    return await this.project_get({ projectId: id });
  }

  async project_get(input: Record<string, unknown>): Promise<ProjectContext> {
    await this.init();
    const projectId = String(input.projectId ?? input.id ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    const project = await this.ensureProject(projectId);
    const [links, commands, tasks, task_dependencies, recent_memory, ports] = await Promise.all([
      query<ProjectLinkRow>("SELECT * FROM project_links WHERE project_id=? ORDER BY id DESC", [
        projectId,
      ]),
      query<CommandRow>("SELECT * FROM project_commands WHERE project_id=? ORDER BY id DESC", [
        projectId,
      ]),
      query<TaskRow>(
        "SELECT * FROM project_tasks WHERE project_id=? ORDER BY priority DESC, id ASC",
        [projectId],
      ),
      query<TaskDependencyRow>(
        `SELECT d.* FROM project_task_dependencies d
         JOIN project_tasks t ON t.id=d.task_id
         WHERE t.project_id=?
         ORDER BY d.task_id ASC, d.depends_on_id ASC`,
        [projectId],
      ),
      query<MemoryRow>(
        "SELECT * FROM project_memory WHERE project_id=? ORDER BY id DESC LIMIT 50",
        [projectId],
      ),
      query<ProjectPortRow>("SELECT * FROM project_ports WHERE project_id=? ORDER BY label ASC", [
        projectId,
      ]),
    ]);
    return {
      project,
      links,
      commands,
      tasks,
      task_dependencies,
      recent_memory,
      ports,
      running_processes: [],
    };
  }

  async project_list(): Promise<ProjectRow[]> {
    await this.init();
    return await query<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC");
  }

  async project_update(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? input.id ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    const project = await this.ensureProject(projectId);
    const nextState = input.state == null ? project.state : String(input.state);
    if (nextState !== project.state) {
      const allowed = PROJECT_STATE_TRANSITIONS[project.state] ?? [];
      if (!allowed.includes(nextState as ProjectRow["state"])) {
        throw new Error(`Invalid project state transition: ${project.state} -> ${nextState}`);
      }
    }
    await execute(
      `UPDATE projects
       SET name=?, description=?, state=?, workspace_path=?, github_remote=?, telegram_topic_id=?,
           has_build_step=?, has_deploy_step=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [
        String(input.name ?? project.name),
        input.description == null ? project.description : String(input.description),
        nextState,
        input.workspacePath == null ? project.workspace_path : String(input.workspacePath),
        input.githubRemote == null ? project.github_remote : String(input.githubRemote),
        input.telegramTopicId == null
          ? project.telegram_topic_id
          : Number.parseInt(String(input.telegramTopicId), 10),
        input.hasBuildStep == null ? project.has_build_step : asBool(input.hasBuildStep),
        input.hasDeployStep == null ? project.has_deploy_step : asBool(input.hasDeployStep),
        projectId,
      ],
    );
    return await this.project_get({ projectId });
  }

  async project_delete(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? input.id ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    const result = await execute("DELETE FROM projects WHERE id=?", [projectId]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async link_add(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const label = String(input.label ?? "").trim();
    const url = String(input.url ?? "").trim();
    const category = String(input.category ?? "other").trim();
    if (!projectId || !label || !url) {
      throw new Error("projectId, label, url required");
    }
    await this.ensureProject(projectId);
    const result = await execute(
      "INSERT INTO project_links (project_id, label, url, category) VALUES (?, ?, ?, ?)",
      [projectId, label, url, category],
    );
    const rows = await query("SELECT * FROM project_links WHERE id=?", [result.insertId]);
    return rows[0];
  }

  async link_remove(input: Record<string, unknown>) {
    await this.init();
    const id = Number.parseInt(String(input.linkId ?? input.id ?? ""), 10);
    if (!Number.isFinite(id)) {
      throw new Error("linkId required");
    }
    const result = await execute("DELETE FROM project_links WHERE id=?", [id]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async link_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    return await query("SELECT * FROM project_links WHERE project_id=? ORDER BY id DESC", [
      projectId,
    ]);
  }

  async cmd_add(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const label = String(input.label ?? "").trim();
    const command = String(input.command ?? "").trim();
    if (!projectId || !label || !command) {
      throw new Error("projectId, label, command required");
    }
    await this.ensureProject(projectId);
    const result = await execute(
      `INSERT INTO project_commands
       (project_id, label, command, cwd, description, category, run_mode, task_runner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        label,
        command,
        input.cwd == null ? null : String(input.cwd),
        input.description == null ? null : String(input.description),
        String(input.category ?? "other"),
        String(input.runMode ?? "exec"),
        input.taskRunnerId == null ? null : String(input.taskRunnerId),
      ],
    );
    return (await query("SELECT * FROM project_commands WHERE id=?", [result.insertId]))[0];
  }

  async cmd_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    return await query<CommandRow>(
      "SELECT * FROM project_commands WHERE project_id=? ORDER BY id DESC",
      [projectId],
    );
  }

  async cmd_remove(input: Record<string, unknown>) {
    await this.init();
    const commandId = Number.parseInt(String(input.commandId ?? input.id ?? ""), 10);
    const force = asBool(input.force, false);
    const reason = input.reason == null ? undefined : String(input.reason);
    const command = await this.ensureCommand(commandId);
    this.ensureCmdUnlocked(command, force, reason);
    const result = await execute("DELETE FROM project_commands WHERE id=?", [commandId]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async cmd_update(input: Record<string, unknown>) {
    await this.init();
    const commandId = Number.parseInt(String(input.commandId ?? input.id ?? ""), 10);
    const force = asBool(input.force, false);
    const reason = input.reason == null ? undefined : String(input.reason);
    const command = await this.ensureCommand(commandId);
    this.ensureCmdUnlocked(command, force, reason);

    await execute(
      `UPDATE project_commands
       SET label=?, command=?, cwd=?, description=?, category=?, run_mode=?, task_runner_id=?
       WHERE id=?`,
      [
        input.label == null ? command.label : String(input.label),
        input.command == null ? command.command : String(input.command),
        input.cwd == null ? command.cwd : String(input.cwd),
        input.description == null ? command.description : String(input.description),
        input.category == null ? command.category : String(input.category),
        input.runMode == null ? command.run_mode : String(input.runMode),
        input.taskRunnerId == null ? command.task_runner_id : String(input.taskRunnerId),
        commandId,
      ],
    );

    return await this.ensureCommand(commandId);
  }

  async cmd_lock(input: Record<string, unknown>) {
    await this.init();
    const commandId = Number.parseInt(String(input.commandId ?? input.id ?? ""), 10);
    const lockedBy = String(input.lockedBy ?? input.actor ?? "unknown");
    await this.ensureCommand(commandId);
    await execute(
      "UPDATE project_commands SET locked=1, locked_by=?, locked_at=CURRENT_TIMESTAMP WHERE id=?",
      [lockedBy, commandId],
    );
    return await this.ensureCommand(commandId);
  }

  async cmd_unlock(input: Record<string, unknown>) {
    await this.init();
    const commandId = Number.parseInt(String(input.commandId ?? input.id ?? ""), 10);
    await this.ensureCommand(commandId);
    await execute(
      "UPDATE project_commands SET locked=0, locked_by=NULL, locked_at=NULL WHERE id=?",
      [commandId],
    );
    return await this.ensureCommand(commandId);
  }

  async cmd_run(input: Record<string, unknown>) {
    await this.init();
    let command: CommandRow;
    const label = input.label as string | undefined;
    const projectId = input.projectId as string | undefined;
    if (label && projectId) {
      const rows = await query<CommandRow>(
        "SELECT * FROM project_commands WHERE project_id=? AND label=?",
        [projectId, label],
      );
      if (rows.length === 0) {
        throw new Error(`Command not found: ${projectId}/${label}`);
      }
      command = rows[0];
    } else {
      const commandId = Number.parseInt(String(input.commandId ?? input.id ?? ""), 10);
      command = await this.ensureCommand(commandId);
    }
    const taskId = input.taskId == null ? undefined : Number.parseInt(String(input.taskId), 10);

    const replaceTokens = (text: string) =>
      text
        .replaceAll("{project_id}", command.project_id)
        .replaceAll("{task_id}", Number.isFinite(taskId) ? String(taskId) : "")
        .replaceAll("{label}", command.label);

    // Build env vars: project env + port assignments
    const projectEnv = await this.getProjectEnv(command.project_id);
    let portEnv: Record<string, string> = {};
    let portMap: PortMapEntry[] = [];
    if (Number.isFinite(taskId)) {
      portMap = await this.getPortMapForTask(taskId!);
      portEnv = this.portMapToEnv(portMap);
    }
    const spawnEnv = { ...process.env, ...projectEnv, ...portEnv };

    if (command.run_mode === "task") {
      const taskRunner = getTaskRunnerService();
      const id = replaceTokens(
        command.task_runner_id ?? `project-${command.project_id}-${command.id}`,
      );
      const started = await taskRunner.start({
        id,
        command: "bash",
        args: ["-lc", replaceTokens(command.command)],
        cwd: command.cwd ?? undefined,
        tags: ["project", command.project_id, command.label],
        projectId: command.project_id,
        env: { ...projectEnv, ...portEnv },
      });
      return { mode: "task", ...started, ports: portMap };
    }

    const { stdout, stderr } = await execFile("bash", ["-lc", replaceTokens(command.command)], {
      cwd: command.cwd ?? undefined,
      env: spawnEnv,
      maxBuffer: 20 * 1024 * 1024,
      timeout: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : undefined,
    });
    return { mode: "exec", stdout, stderr, ports: portMap };
  }

  async task_add(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const title = String(input.title ?? "").trim();
    if (!projectId || !title) {
      throw new Error("projectId and title required");
    }
    await this.ensureProject(projectId);
    const taskType = String(input.taskType ?? "feature") as TaskType;
    const defaults = TASK_TYPE_DEFAULTS[taskType] ?? TASK_TYPE_DEFAULTS.feature;
    const result = await execute(
      `INSERT INTO project_tasks
      (project_id, title, description, task_type, requires_branching, requires_human_review, priority, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        title,
        input.description == null ? null : String(input.description),
        taskType,
        input.requiresBranching == null
          ? defaults.requires_branching
          : asBool(input.requiresBranching),
        input.requiresHumanReview == null
          ? defaults.requires_human_review
          : asBool(input.requiresHumanReview),
        Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
        input.phase == null ? null : String(input.phase),
      ],
    );
    await execute(
      "INSERT INTO task_status_history (task_id, from_status, to_status, actor, reason) VALUES (?, NULL, 'planning', ?, ?)",
      [result.insertId, input.actor == null ? null : String(input.actor), "task created"],
    );
    return await this.ensureTask(result.insertId);
  }

  async task_get(input: Record<string, unknown>): Promise<TaskDetail> {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    if (!Number.isFinite(taskId)) {
      throw new Error("taskId required");
    }
    const task = await this.ensureTask(taskId);
    const [dependencies, attempts, status_history, port_assignments] = await Promise.all([
      query<TaskDependencyRow>(
        "SELECT * FROM project_task_dependencies WHERE task_id=? ORDER BY depends_on_id",
        [taskId],
      ),
      query<TaskAttemptRow>("SELECT * FROM task_attempts WHERE task_id=? ORDER BY id DESC", [
        taskId,
      ]),
      query<TaskStatusHistoryRow>(
        "SELECT * FROM task_status_history WHERE task_id=? ORDER BY id DESC",
        [taskId],
      ),
      query<PortAssignmentRow>(
        "SELECT * FROM port_assignments WHERE task_id=? AND released_at IS NULL ORDER BY id",
        [taskId],
      ),
    ]);
    return { task, dependencies, attempts, status_history, port_assignments };
  }

  async task_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    return await query<TaskRow>(
      "SELECT * FROM project_tasks WHERE project_id=? ORDER BY priority DESC, created_at ASC, id ASC",
      [projectId],
    );
  }

  async task_update(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    await execute(
      `UPDATE project_tasks
       SET title=?, description=?, priority=?, phase=?, review_notes=?, review_feedback=?, dev_server_url=?
       WHERE id=?`,
      [
        input.title == null ? task.title : String(input.title),
        input.description == null ? task.description : String(input.description),
        input.priority == null ? task.priority : Number(input.priority),
        input.phase == null ? task.phase : String(input.phase),
        input.reviewNotes == null ? task.review_notes : String(input.reviewNotes),
        input.reviewFeedback == null ? task.review_feedback : String(input.reviewFeedback),
        input.devServerUrl == null ? task.dev_server_url : String(input.devServerUrl),
        taskId,
      ],
    );
    return await this.ensureTask(taskId);
  }

  async task_next(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }

    const rows = await query<TaskRow>(
      `SELECT t.*
       FROM project_tasks t
       WHERE t.project_id=?
         AND t.status = 'queue'
         AND NOT EXISTS (
           SELECT 1
           FROM project_task_dependencies d
           JOIN project_tasks dep ON dep.id=d.depends_on_id
           WHERE d.task_id=t.id AND dep.status <> 'done'
         )
       ORDER BY t.priority DESC, t.created_at ASC, t.id ASC
       LIMIT 1`,
      [projectId],
    );
    return rows[0] ?? null;
  }

  async task_start(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);

    // If branching is required, create the worktree BEFORE transitioning
    if (task.requires_branching) {
      const project = await this.ensureProject(task.project_id);
      if (!project.workspace_path) {
        throw new Error("Project workspace_path required for branching tasks");
      }
      const branchName = `task/${task.id}`;
      const repoPath = path.join(project.workspace_path, "main");
      const worktreePath = path.join(project.workspace_path, "worktrees", `task-${task.id}`);
      try {
        await createWorktree(repoPath, worktreePath, branchName);
      } catch (err) {
        throw new Error(`Failed to create worktree for task ${task.id}: ${String(err)}`, {
          cause: err,
        });
      }
      await execute("UPDATE project_tasks SET git_branch=?, worktree_path=? WHERE id=?", [
        branchName,
        worktreePath,
        task.id,
      ]);
    }

    // Only transition to executing after worktree is successfully created
    const updated = await this.transitionTaskStatus({
      taskId,
      toStatus: "executing",
      allowedFrom: ["queue"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "task started" : String(input.reason),
    });

    // Eagerly allocate ports from the project's declared port labels
    const portMap = await this.allocatePortsForTask(taskId, task.project_id);

    return { ...updated, port_map: portMap };
  }

  async task_request_review(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    if (!task.requires_human_review) {
      return await this.task_complete({
        ...input,
        taskId,
        reason: "auto-approved (no human review required)",
      });
    }
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "review_requested",
      allowedFrom: ["executing"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "review requested" : String(input.reason),
    });
  }

  async task_approve(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    return await this.task_complete({
      ...input,
      taskId,
      reason: input.reason == null ? "approved" : String(input.reason),
    });
  }

  async task_request_changes(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const feedback = input.reviewFeedback == null ? null : String(input.reviewFeedback);
    if (feedback) {
      await execute("UPDATE project_tasks SET review_feedback=? WHERE id=?", [feedback, taskId]);
    }
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "changes_requested",
      allowedFrom: ["review_requested"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "changes requested" : String(input.reason),
    });
  }

  /** Promote a task from planning to queue (human action) */
  async task_enqueue(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "queue",
      allowedFrom: ["planning", "changes_requested", "stalled"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "promoted to queue" : String(input.reason),
    });
  }

  /** Record an attempt result and transition accordingly (called by executor code, not LLM) */
  async task_record_attempt(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    const outcome = String(input.outcome ?? "failed") as
      | "success"
      | "partial"
      | "failed"
      | "abandoned";
    const summary = String(input.summary ?? "");
    const errorLog = input.errorLog == null ? null : String(input.errorLog);
    const filesChanged = input.filesChanged == null ? null : String(input.filesChanged);
    const durationMs = Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null;
    const gitBranch = input.gitBranch == null ? null : String(input.gitBranch);
    const gitDiffSummary = input.gitDiffSummary == null ? null : String(input.gitDiffSummary);
    const learnings = input.learnings == null ? null : String(input.learnings);

    // Record the attempt
    await execute(
      `INSERT INTO task_attempts (task_id, session_key, model, summary, outcome, error_log, files_changed, duration_ms, git_branch, git_diff_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        input.sessionKey == null ? null : String(input.sessionKey),
        input.model == null ? null : String(input.model),
        summary,
        outcome,
        errorLog,
        filesChanged,
        durationMs,
        gitBranch,
        gitDiffSummary,
      ],
    );

    // Update task attempt tracking
    const newCount = task.attempt_count + 1;
    const notes = learnings
      ? task.execution_notes
        ? task.execution_notes + "\n---\n" + learnings
        : learnings
      : task.execution_notes;

    await execute(
      `UPDATE project_tasks SET attempt_count=?, last_attempt_at=CURRENT_TIMESTAMP, execution_notes=? WHERE id=?`,
      [newCount, notes, taskId],
    );

    // Transition based on outcome
    if (outcome === "success") {
      if (task.requires_human_review) {
        return await this.transitionTaskStatus({
          taskId,
          toStatus: "review_requested",
          allowedFrom: ["executing"],
          actor: "executor",
          reason: summary,
        });
      } else {
        return await this.task_complete({
          taskId,
          actor: "executor",
          reason: "auto-approved: " + summary,
        });
      }
    } else {
      // Failed / partial / abandoned
      if (newCount >= task.max_attempts) {
        return await this.transitionTaskStatus({
          taskId,
          toStatus: "stalled",
          allowedFrom: ["executing"],
          actor: "executor",
          reason: `stalled after ${newCount}/${task.max_attempts} attempts: ${summary}`,
        });
      } else {
        return await this.transitionTaskStatus({
          taskId,
          toStatus: "queue",
          allowedFrom: ["executing"],
          actor: "executor",
          reason: `attempt ${newCount}/${task.max_attempts} failed: ${summary}`,
        });
      }
    }
  }

  async task_complete(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const updated = await this.transitionTaskStatus({
      taskId,
      toStatus: "done",
      allowedFrom: [
        "planning",
        "queue",
        "executing",
        "review_requested",
        "changes_requested",
        "stalled",
      ],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "completed" : String(input.reason),
    });
    await execute("UPDATE project_tasks SET completed_at=CURRENT_TIMESTAMP WHERE id=?", [taskId]);
    // Release allocated ports
    await this.releasePortsForTask(taskId);
    return updated;
  }

  async task_cancel(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    const project = await this.ensureProject(task.project_id);

    const updated = await this.transitionTaskStatus({
      taskId,
      toStatus: "cancelled",
      allowedFrom: [
        "planning",
        "queue",
        "executing",
        "review_requested",
        "changes_requested",
        "stalled",
        "blocked",
        "done",
      ],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "cancelled" : String(input.reason),
    });

    // Release allocated ports
    await this.releasePortsForTask(taskId);

    if (
      task.requires_branching &&
      project.workspace_path &&
      task.worktree_path &&
      task.git_branch
    ) {
      const repoPath = path.join(project.workspace_path, "main");
      await removeWorktree(repoPath, task.worktree_path, task.git_branch).catch(() => undefined);
    }

    return updated;
  }

  async task_block(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    if (task.status === "blocked") {
      return task;
    }
    await execute("UPDATE project_tasks SET status_before_blocked=?, block_reason=? WHERE id=?", [
      task.status,
      input.reason == null ? null : String(input.reason),
      taskId,
    ]);
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "blocked",
      allowedFrom: [
        "planning",
        "queue",
        "executing",
        "review_requested",
        "changes_requested",
        "stalled",
      ],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "blocked" : String(input.reason),
    });
  }

  async task_unblock(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    if (task.status !== "blocked") {
      throw new Error("task is not blocked");
    }
    const restore = task.status_before_blocked ?? "planning";
    await execute(
      "UPDATE project_tasks SET status_before_blocked=NULL, block_reason=NULL WHERE id=?",
      [taskId],
    );
    return await this.transitionTaskStatus({
      taskId,
      toStatus: restore,
      allowedFrom: ["blocked"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "unblocked" : String(input.reason),
    });
  }

  async task_dep_add(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? ""), 10);
    const dependsOnId = Number.parseInt(String(input.dependsOnId ?? ""), 10);
    if (!Number.isFinite(taskId) || !Number.isFinite(dependsOnId)) {
      throw new Error("taskId and dependsOnId required");
    }
    if (taskId === dependsOnId) {
      throw new Error("A task cannot depend on itself");
    }
    await this.ensureTask(taskId);
    await this.ensureTask(dependsOnId);
    await execute(
      "INSERT IGNORE INTO project_task_dependencies (task_id, depends_on_id) VALUES (?, ?)",
      [taskId, dependsOnId],
    );
    return await this.task_dep_list({ taskId });
  }

  async task_dep_remove(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? ""), 10);
    const dependsOnId = Number.parseInt(String(input.dependsOnId ?? ""), 10);
    const result = await execute(
      "DELETE FROM project_task_dependencies WHERE task_id=? AND depends_on_id=?",
      [taskId, dependsOnId],
    );
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async task_dep_list(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? ""), 10);
    if (!Number.isFinite(taskId)) {
      throw new Error("taskId required");
    }
    return await query<TaskDependencyRow>(
      "SELECT * FROM project_task_dependencies WHERE task_id=? ORDER BY depends_on_id",
      [taskId],
    );
  }

  async memory_add(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const content = String(input.content ?? "").trim();
    const categoryRaw = String(input.category ?? "learning") as MemoryCategory;
    const category = MEMORY_CATEGORIES.includes(categoryRaw) ? categoryRaw : "learning";
    if (!projectId || !content) {
      throw new Error("projectId and content required");
    }
    await this.ensureProject(projectId);
    const result = await execute(
      "INSERT INTO project_memory (project_id, category, content) VALUES (?, ?, ?)",
      [projectId, category, content],
    );
    return (
      await query<MemoryRow>("SELECT * FROM project_memory WHERE id=?", [result.insertId])
    )[0];
  }

  async memory_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Number(input.limit)) : 100;
    return await query<MemoryRow>(
      "SELECT * FROM project_memory WHERE project_id=? ORDER BY id DESC LIMIT ?",
      [projectId, limit],
    );
  }

  async memory_remove(input: Record<string, unknown>) {
    await this.init();
    const id = Number.parseInt(String(input.memoryId ?? input.id ?? ""), 10);
    const result = await execute("DELETE FROM project_memory WHERE id=?", [id]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  // ─── Environment Variables ────────────────────────────────────────

  async env_set(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const key = String(input.key ?? input.label ?? "").trim();
    const value = String(input.value ?? "");
    if (!projectId || !key) {
      throw new Error("projectId and key required");
    }
    if (value === "") {
      throw new Error("value required");
    }
    await this.ensureProject(projectId);
    const isSecret = asBool(input.secret ?? input.isSecret, false);
    const description = input.description == null ? null : String(input.description);
    await execute(
      "INSERT INTO project_env (project_id, `key`, value, is_secret, description) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value), is_secret=VALUES(is_secret), description=VALUES(description)",
      [projectId, key, value, isSecret, description],
    );
    // Return with value redacted if secret
    return {
      project_id: projectId,
      key,
      value: isSecret ? "[REDACTED]" : value,
      is_secret: isSecret,
      description,
    };
  }

  async env_remove(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const key = String(input.key ?? input.label ?? "").trim();
    if (!projectId || !key) {
      throw new Error("projectId and key required");
    }
    const result = await execute("DELETE FROM project_env WHERE project_id=? AND `key`=?", [
      projectId,
      key,
    ]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async env_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId required");
    }
    const rows = await query<ProjectEnvRow>(
      "SELECT * FROM project_env WHERE project_id=? ORDER BY `key` ASC",
      [projectId],
    );
    // Redact secret values
    return rows.map((r) => ({
      ...r,
      value: r.is_secret ? "[REDACTED]" : r.value,
    }));
  }

  /** Get all env vars for a project (with actual values, for injection) */
  async getProjectEnv(projectId: string): Promise<Record<string, string>> {
    const rows = await query<ProjectEnvRow>(
      "SELECT `key`, value FROM project_env WHERE project_id=? ORDER BY `key`",
      [projectId],
    );
    const env: Record<string, string> = {};
    for (const row of rows) {
      env[row.key] = row.value;
    }
    return env;
  }

  /** Get env var names for agent briefings (no secret values) */
  async getProjectEnvBriefing(
    projectId: string,
  ): Promise<Array<{ key: string; is_secret: boolean; description: string | null }>> {
    const rows = await query<ProjectEnvRow>(
      "SELECT `key`, is_secret, description FROM project_env WHERE project_id=? ORDER BY `key`",
      [projectId],
    );
    return rows.map((r) => ({
      key: r.key,
      is_secret: asBool(r.is_secret),
      description: r.description,
    }));
  }

  // ─── Port Management ──────────────────────────────────────────────

  async port_declare(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const label = String(input.label ?? "")
      .trim()
      .toUpperCase();
    if (!projectId || !label) {
      throw new Error("projectId and label required");
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(label)) {
      throw new Error("Label must match [A-Z][A-Z0-9_]*");
    }
    await this.ensureProject(projectId);
    const description = input.description == null ? null : String(input.description);
    await execute(
      `INSERT INTO project_ports (project_id, label, description) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE description=VALUES(description)`,
      [projectId, label, description],
    );
    return (
      await query<ProjectPortRow>("SELECT * FROM project_ports WHERE project_id=? AND label=?", [
        projectId,
        label,
      ])
    )[0];
  }

  async port_undeclare(input: Record<string, unknown>) {
    await this.init();
    const projectId = String(input.projectId ?? "").trim();
    const label = String(input.label ?? "")
      .trim()
      .toUpperCase();
    if (!projectId || !label) {
      throw new Error("projectId and label required");
    }
    // Check for active assignments
    const active = await query<PortAssignmentRow>(
      `SELECT pa.* FROM port_assignments pa
       JOIN project_ports pp ON pp.id = pa.project_port_id
       WHERE pp.project_id=? AND pp.label=? AND pa.released_at IS NULL`,
      [projectId, label],
    );
    if (active.length > 0) {
      throw new Error(
        `Cannot undeclare port label "${label}" — ${active.length} active assignment(s)`,
      );
    }
    const result = await execute("DELETE FROM project_ports WHERE project_id=? AND label=?", [
      projectId,
      label,
    ]);
    return { ok: result.affectedRows > 0, deleted: result.affectedRows };
  }

  async port_list(input: Record<string, unknown>) {
    await this.init();
    const projectId = input.projectId ? String(input.projectId).trim() : undefined;
    const taskId = input.taskId != null ? Number(input.taskId) : undefined;
    const host = getGatewayHost();

    let sql = "SELECT * FROM port_assignments WHERE released_at IS NULL";
    const params: unknown[] = [];
    if (projectId) {
      sql += " AND project_id=?";
      params.push(projectId);
    }
    if (Number.isFinite(taskId)) {
      sql += " AND task_id=?";
      params.push(taskId);
    }
    sql += " ORDER BY port ASC";

    const assignments = await query<PortAssignmentRow>(sql, params);

    // Enrich with labels
    if (assignments.length === 0) {
      return [];
    }
    const portIds = assignments.map((a) => a.project_port_id);
    const ports = await query<ProjectPortRow>(
      `SELECT * FROM project_ports WHERE id IN (${portIds.map(() => "?").join(",")})`,
      portIds,
    );
    const portMap = new Map(ports.map((p) => [p.id, p]));

    return assignments.map((a) => ({
      ...a,
      label: portMap.get(a.project_port_id)?.label ?? "UNKNOWN",
      url: `http://${host}:${a.port}`,
    }));
  }

  async port_release(input: Record<string, unknown>) {
    await this.init();
    const taskId = input.taskId != null ? Number(input.taskId) : undefined;
    const port = input.port != null ? Number(input.port) : undefined;

    if (Number.isFinite(taskId)) {
      const result = await execute(
        "UPDATE port_assignments SET released_at=CURRENT_TIMESTAMP WHERE task_id=? AND released_at IS NULL",
        [taskId],
      );
      return { ok: true, released: result.affectedRows };
    }
    if (Number.isFinite(port)) {
      const result = await execute(
        "UPDATE port_assignments SET released_at=CURRENT_TIMESTAMP WHERE port=? AND released_at IS NULL",
        [port],
      );
      return { ok: true, released: result.affectedRows };
    }
    throw new Error("taskId or port required");
  }

  async port_status(_input: Record<string, unknown>) {
    await this.init();
    const active = await query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM port_assignments WHERE released_at IS NULL",
    );
    const byProject = await query<{ project_id: string; cnt: number }>(
      "SELECT project_id, COUNT(*) as cnt FROM port_assignments WHERE released_at IS NULL GROUP BY project_id",
    );
    const total = PORT_POOL_END - PORT_POOL_START + 1;
    const used = active[0]?.cnt ?? 0;
    return {
      pool: { start: PORT_POOL_START, end: PORT_POOL_END, total },
      active: used,
      available: total - used,
      by_project: byProject,
    };
  }

  /**
   * Allocate all declared ports for a task from the global pool.
   * Uses a transaction to prevent races. Skips labels already allocated.
   */
  async allocatePortsForTask(taskId: number, projectId: string): Promise<PortMapEntry[]> {
    const declaredPorts = await query<ProjectPortRow>(
      "SELECT * FROM project_ports WHERE project_id=? ORDER BY id",
      [projectId],
    );
    if (declaredPorts.length === 0) {
      return [];
    }

    const host = getGatewayHost();
    const conn = await getProjectPool().getConnection();
    try {
      await conn.beginTransaction();

      // Get all currently active ports
      const [activeRows] = await conn.execute(
        "SELECT port FROM port_assignments WHERE released_at IS NULL",
      );
      const usedPorts = new Set((activeRows as Array<{ port: number }>).map((r) => r.port));

      // Check existing assignments for this task
      const [existingRows] = await conn.execute(
        "SELECT project_port_id, port FROM port_assignments WHERE task_id=? AND released_at IS NULL",
        [taskId],
      );
      const existingMap = new Map(
        (existingRows as Array<{ project_port_id: number; port: number }>).map((r) => [
          r.project_port_id,
          r.port,
        ]),
      );

      const result: PortMapEntry[] = [];

      for (const pp of declaredPorts) {
        // Already allocated for this task
        if (existingMap.has(pp.id)) {
          result.push({
            label: pp.label,
            port: existingMap.get(pp.id)!,
            url: `http://${host}:${existingMap.get(pp.id)}`,
          });
          continue;
        }

        // Find next free port with bind probe
        let assigned = false;
        for (let p = PORT_POOL_START; p <= PORT_POOL_END; p++) {
          if (usedPorts.has(p)) {
            continue;
          }
          const bindable = await probePort(p);
          if (!bindable) {
            continue;
          }

          await conn.execute(
            "INSERT INTO port_assignments (port, task_id, project_port_id, project_id) VALUES (?, ?, ?, ?)",
            [p, taskId, pp.id, projectId],
          );
          usedPorts.add(p);
          result.push({ label: pp.label, port: p, url: `http://${host}:${p}` });
          assigned = true;
          break;
        }
        if (!assigned) {
          await conn.rollback();
          throw new Error(
            `PORT_POOL_EXHAUSTED: No free ports in ${PORT_POOL_START}-${PORT_POOL_END} for label "${pp.label}"`,
          );
        }
      }

      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Release all ports for a task (on completion/cancellation) */
  async releasePortsForTask(taskId: number): Promise<number> {
    const result = await execute(
      "UPDATE port_assignments SET released_at=CURRENT_TIMESTAMP WHERE task_id=? AND released_at IS NULL",
      [taskId],
    );
    return result.affectedRows;
  }

  /** Get port map for a task (label -> port + url) */
  async getPortMapForTask(taskId: number): Promise<PortMapEntry[]> {
    const host = getGatewayHost();
    const rows = await query<PortAssignmentRow & { label: string }>(
      `SELECT pa.*, pp.label FROM port_assignments pa
       JOIN project_ports pp ON pp.id = pa.project_port_id
       WHERE pa.task_id=? AND pa.released_at IS NULL
       ORDER BY pp.label`,
      [taskId],
    );
    return rows.map((r) => ({ label: r.label, port: r.port, url: `http://${host}:${r.port}` }));
  }

  /** Build env vars object from port map */
  portMapToEnv(portMap: PortMapEntry[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of portMap) {
      env[`PORT_${entry.label}`] = String(entry.port);
    }
    return env;
  }

  async executeAction(action: string, params: Record<string, unknown>) {
    await this.init();
    const handler = (
      this as unknown as Record<string, (input: Record<string, unknown>) => Promise<unknown>>
    )[action];
    if (typeof handler !== "function") {
      throw new Error(`Unknown action: ${action}`);
    }
    return await handler.call(this, params);
  }
}

let singleton: ProjectService | null = null;

export function getProjectService(): ProjectService {
  singleton ??= new ProjectService();
  return singleton;
}
