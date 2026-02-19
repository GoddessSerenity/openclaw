/* eslint-disable @typescript-eslint/no-base-to-string */
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getTaskRunnerService } from "../task-runner/service.js";
import { execute, query } from "./db.js";
import { createWorktree, mergeBranch, removeWorktree } from "./git.js";
import { runMigrations } from "./migrations.js";
import {
  type CommandRow,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryRow,
  PROJECT_STATE_TRANSITIONS,
  type ProjectContext,
  type ProjectLinkRow,
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

function pickPostMergeStatus(task: TaskRow, project: ProjectRow): TaskStatus {
  if (!task.requires_branching) {
    if (project.has_build_step) {
      return "building";
    }
    if (project.has_deploy_step) {
      return "deploying";
    }
    return "done";
  }
  if (project.has_build_step) {
    return "building";
  }
  if (project.has_deploy_step) {
    return "deploying";
  }
  return "done";
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
    const workspace_path = input.workspacePath == null ? null : String(input.workspacePath);
    const github_remote = input.githubRemote == null ? null : String(input.githubRemote);
    const telegram_topic_id =
      input.telegramTopicId == null ? null : Number.parseInt(String(input.telegramTopicId), 10);
    const has_build_step = asBool(input.hasBuildStep, true);
    const has_deploy_step = asBool(input.hasDeployStep, true);

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
    const [links, commands, tasks, task_dependencies, recent_memory] = await Promise.all([
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
    ]);
    return {
      project,
      links,
      commands,
      tasks,
      task_dependencies,
      recent_memory,
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
      });
      return { mode: "task", ...started };
    }

    const { stdout, stderr } = await execFile("bash", ["-lc", replaceTokens(command.command)], {
      cwd: command.cwd ?? undefined,
      maxBuffer: 20 * 1024 * 1024,
      timeout: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : undefined,
    });
    return { mode: "exec", stdout, stderr };
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
      (project_id, title, description, task_type, requires_branching, requires_human_review, priority, phase, assigned_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.assignedModel == null ? null : String(input.assignedModel),
      ],
    );
    await execute(
      "INSERT INTO task_status_history (task_id, from_status, to_status, actor, reason) VALUES (?, NULL, 'requirements', ?, ?)",
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
    const [dependencies, attempts, status_history] = await Promise.all([
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
    ]);
    return { task, dependencies, attempts, status_history };
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
       SET title=?, description=?, priority=?, phase=?, assigned_model=?, review_notes=?, review_feedback=?, dev_server_url=?
       WHERE id=?`,
      [
        input.title == null ? task.title : String(input.title),
        input.description == null ? task.description : String(input.description),
        input.priority == null ? task.priority : Number(input.priority),
        input.phase == null ? task.phase : String(input.phase),
        input.assignedModel == null ? task.assigned_model : String(input.assignedModel),
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
         AND t.status IN ('requirements','implementing','changes_requested','review_requested','approved','merge_conflict')
         AND t.status <> 'blocked'
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
    let task = await this.transitionTaskStatus({
      taskId,
      toStatus: "implementing",
      allowedFrom: ["requirements", "changes_requested"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "task started" : String(input.reason),
    });

    if (task.requires_branching) {
      const project = await this.ensureProject(task.project_id);
      if (!project.workspace_path) {
        throw new Error("Project workspace_path required for branching tasks");
      }
      const branchName = `task/${task.id}`;
      const repoPath = path.join(project.workspace_path, "main");
      const worktreePath = path.join(project.workspace_path, "worktrees", `task-${task.id}`);
      await createWorktree(repoPath, worktreePath, branchName);
      await execute("UPDATE project_tasks SET git_branch=?, worktree_path=? WHERE id=?", [
        branchName,
        worktreePath,
        task.id,
      ]);
      task = await this.ensureTask(task.id);
    }

    return task;
  }

  async task_request_review(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    if (!task.requires_human_review) {
      return await this.task_approve({ ...input, taskId, reason: "auto-approved" });
    }
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "review_requested",
      allowedFrom: ["implementing", "changes_requested"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "review requested" : String(input.reason),
    });
  }

  async task_approve(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    const allowedFrom: TaskStatus[] = ["review_requested"];
    if (!task.requires_human_review) {
      allowedFrom.push("implementing", "changes_requested");
    }
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "approved",
      allowedFrom,
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "approved" : String(input.reason),
    });
  }

  async task_request_changes(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "changes_requested",
      allowedFrom: ["review_requested"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "changes requested" : String(input.reason),
    });
  }

  async task_merge(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    let task = await this.ensureTask(taskId);
    const project = await this.ensureProject(task.project_id);

    if (!task.requires_branching) {
      const next = pickPostMergeStatus(task, project);
      if (next === "done") {
        return await this.task_complete({ ...input, taskId, reason: "completed without merge" });
      }
      return await this.transitionTaskStatus({
        taskId,
        toStatus: next,
        allowedFrom: ["approved", "implementing"],
        actor: input.actor == null ? undefined : String(input.actor),
        reason: "advanced without merge",
      });
    }

    task = await this.transitionTaskStatus({
      taskId,
      toStatus: "merging",
      allowedFrom: ["approved", "merge_conflict"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "merging" : String(input.reason),
    });

    if (!project.workspace_path || !task.git_branch) {
      throw new Error("workspace_path and git_branch required for merge");
    }

    const repoPath = path.join(project.workspace_path, "main");
    const merged = await mergeBranch(repoPath, task.git_branch);
    if (!merged.success) {
      if (merged.conflict) {
        return await this.transitionTaskStatus({
          taskId,
          toStatus: "merge_conflict",
          allowedFrom: ["merging"],
          actor: input.actor == null ? undefined : String(input.actor),
          reason: merged.output,
        });
      }
      throw new Error(`Merge failed: ${merged.output}`);
    }

    const next = pickPostMergeStatus(task, project);
    if (next === "done") {
      await this.transitionTaskStatus({
        taskId,
        toStatus: "done",
        allowedFrom: ["merging"],
        actor: input.actor == null ? undefined : String(input.actor),
        reason: merged.output,
      });
      await execute("UPDATE project_tasks SET completed_at=CURRENT_TIMESTAMP WHERE id=?", [taskId]);
      return await this.ensureTask(taskId);
    }

    return await this.transitionTaskStatus({
      taskId,
      toStatus: next,
      allowedFrom: ["merging"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: merged.output,
    });
  }

  async task_resolve_conflict(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "merging",
      allowedFrom: ["merge_conflict"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "conflict resolved" : String(input.reason),
    });
  }

  async task_build(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const task = await this.ensureTask(taskId);
    const project = await this.ensureProject(task.project_id);
    if (!project.has_build_step) {
      throw new Error("project has_build_step is false");
    }
    return await this.transitionTaskStatus({
      taskId,
      toStatus: project.has_deploy_step ? "deploying" : "done",
      allowedFrom: ["building", "merging", "approved"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "build complete" : String(input.reason),
    });
  }

  async task_deploy(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    return await this.transitionTaskStatus({
      taskId,
      toStatus: "done",
      allowedFrom: ["deploying", "building", "merging", "approved"],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "deploy complete" : String(input.reason),
    });
  }

  async task_complete(input: Record<string, unknown>) {
    await this.init();
    const taskId = Number.parseInt(String(input.taskId ?? input.id ?? ""), 10);
    const updated = await this.transitionTaskStatus({
      taskId,
      toStatus: "done",
      allowedFrom: [
        "requirements",
        "implementing",
        "review_requested",
        "approved",
        "changes_requested",
        "merging",
        "building",
        "deploying",
        "merge_conflict",
      ],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "completed" : String(input.reason),
    });
    await execute("UPDATE project_tasks SET completed_at=CURRENT_TIMESTAMP WHERE id=?", [taskId]);
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
        "requirements",
        "implementing",
        "review_requested",
        "approved",
        "changes_requested",
        "merging",
        "merge_conflict",
        "building",
        "deploying",
        "blocked",
        "done",
      ],
      actor: input.actor == null ? undefined : String(input.actor),
      reason: input.reason == null ? "cancelled" : String(input.reason),
    });

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
        "requirements",
        "implementing",
        "review_requested",
        "approved",
        "changes_requested",
        "merging",
        "merge_conflict",
        "building",
        "deploying",
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
    const restore = task.status_before_blocked ?? "requirements";
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
