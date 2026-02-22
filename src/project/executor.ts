/**
 * Task Executor — Automated task execution pipeline.
 *
 * Called by cron or manually. Picks the highest-priority queued task, spawns an
 * OpenClaw agent session with tools (read/write/exec), waits for
 * completion, parses the structured JSON response, and updates the DB.
 */

import { query, execute, getProjectPool } from "./db.js";
import type {
  TaskRow,
  TaskAttemptRow,
  ProjectRow,
  MemoryRow,
  CommandRow,
} from "./types.js";
import { callGatewayCli } from "../gateway/call.js";
import { createWorktree } from "./git.js";
import crypto from "node:crypto";
import path from "node:path";

// ─── Configuration ───────────────────────────────────────────────

const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "8bc8eefc48f92ca1cab5ac300d31647d4a0bfe2213e857ff";
const MODEL = "anthropic/claude-opus-4-6";
const AGENT_TIMEOUT_SECONDS = 600; // 10 min max per task

const TELEGRAM_BOT_TOKEN = "8585743850:AAHvyvHOLhwDUUPj47xQTqIKAHK5yC2hBD0";
const TELEGRAM_GROUP_ID = "-1003885951942";

// ─── DB Queries ──────────────────────────────────────────────────

async function isAnyTaskExecuting(): Promise<boolean> {
  const rows = await query<TaskRow>(
    "SELECT * FROM project_tasks WHERE status = 'executing'"
  );
  if (rows.length === 0) return false;

  const STALE_MS = 15 * 60 * 1000;
  for (const task of rows) {
    const updatedAt = new Date(task.updated_at).getTime();
    if (Date.now() - updatedAt > STALE_MS) {
      console.log(`[executor] Recovering stale task #${task.id} (stuck in executing)`);
      const newCount = task.attempt_count + 1;
      if (newCount >= task.max_attempts) {
        await transitionTask(task.id, "executing", "stalled", "executor", "Stale execution recovered");
      } else {
        await transitionTask(task.id, "executing", "queue", "executor", "Stale execution recovered, re-queued");
      }
      return false;
    }
  }
  return true;
}

async function pickNextTask(): Promise<TaskRow | null> {
  const rows = await query<TaskRow>(
    "SELECT * FROM project_tasks WHERE status = 'queue' ORDER BY priority DESC, created_at ASC LIMIT 1"
  );
  return rows[0] || null;
}

async function getProject(id: string): Promise<ProjectRow | null> {
  const rows = await query<ProjectRow>(
    "SELECT * FROM projects WHERE id = ?", [id]
  );
  return rows[0] || null;
}

async function getProjectMemory(projectId: string): Promise<MemoryRow[]> {
  return query<MemoryRow>(
    "SELECT * FROM project_memory WHERE project_id = ? ORDER BY id DESC LIMIT 20", [projectId]
  );
}

async function getProjectCommands(projectId: string): Promise<CommandRow[]> {
  return query<CommandRow>(
    "SELECT * FROM project_commands WHERE project_id = ? ORDER BY id", [projectId]
  );
}

async function getTaskAttempts(taskId: number): Promise<TaskAttemptRow[]> {
  return query<TaskAttemptRow>(
    "SELECT * FROM task_attempts WHERE task_id = ? ORDER BY id", [taskId]
  );
}

async function transitionTask(
  taskId: number,
  fromStatus: string,
  toStatus: string,
  actor: string,
  reason: string,
): Promise<void> {
  const result = await execute(
    "UPDATE project_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?",
    [toStatus, taskId, fromStatus]
  );
  if (result.affectedRows !== 1) {
    throw new Error(`Failed to transition task ${taskId}: ${fromStatus} → ${toStatus}`);
  }
  await execute(
    "INSERT INTO task_status_history (task_id, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)",
    [taskId, fromStatus, toStatus, actor, reason]
  );
}

async function recordAttempt(
  taskId: number,
  outcome: string,
  summary: string,
  model: string,
  durationMs: number,
  errorLog: string | null,
  filesChanged: string | null,
  learnings: string | null,
): Promise<void> {
  await execute(
    `INSERT INTO task_attempts (task_id, outcome, summary, model, duration_ms, error_log, files_changed, learnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, outcome, summary, model, durationMs, errorLog, filesChanged, learnings]
  );
  await execute(
    "UPDATE project_tasks SET attempt_count = attempt_count + 1, last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?",
    [taskId]
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notify(html: string, topicId?: number | null): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      chat_id: TELEGRAM_GROUP_ID,
      text: html,
      parse_mode: "HTML",
    };
    if (topicId) body.message_thread_id = topicId;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error("[executor] Telegram notification failed");
  }
}

// ─── Prompt Builder ──────────────────────────────────────────────

function buildTaskPrompt(
  project: ProjectRow,
  task: TaskRow,
  memory: MemoryRow[],
  commands: CommandRow[],
  attempts: TaskAttemptRow[],
): string {
  const sections: string[] = [];

  sections.push(`# Task Execution Brief\n`);
  sections.push(`## Project`);
  sections.push(`- **Name:** ${project.name}`);
  if (project.description) sections.push(`- **Description:** ${project.description}`);
  if (project.workspace_path) sections.push(`- **Workspace:** ${project.workspace_path}`);
  if (project.github_remote) sections.push(`- **GitHub:** ${project.github_remote}`);
  sections.push("");

  if (memory.length > 0) {
    sections.push(`## Project Knowledge`);
    for (const m of memory) {
      sections.push(`- **[${m.category}]** ${m.content}`);
    }
    sections.push("");
  }

  if (commands.length > 0) {
    sections.push(`## Available Commands`);
    for (const cmd of commands) {
      sections.push(`- **${cmd.label}** (${cmd.category}): \`${cmd.command}\`${cmd.cwd ? ` (cwd: ${cmd.cwd})` : ""}${cmd.description ? ` — ${cmd.description}` : ""}`);
    }
    sections.push("");
  }

  sections.push(`## Task`);
  sections.push(`- **Title:** ${task.title}`);
  sections.push(`- **Description:** ${task.description || "No description provided."}`);
  sections.push(`- **Type:** ${task.task_type}`);
  sections.push(`- **Priority:** ${task.priority}/5`);
  if (task.review_feedback) {
    sections.push(`\n### Previous Review Feedback\n${task.review_feedback}`);
  }
  if (task.execution_notes) {
    sections.push(`\n### Accumulated Learnings\n${task.execution_notes}`);
  }
  sections.push("");

  if (attempts.length > 0) {
    sections.push(`## Previous Attempts (${attempts.length}/${task.max_attempts})`);
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      sections.push(`### Attempt ${i + 1} — ${a.outcome} (${a.model || "unknown"})`);
      sections.push(a.summary);
      if (a.error_log) sections.push(`**Error:** ${a.error_log}`);
      if (a.files_changed) sections.push(`**Files changed:** ${a.files_changed}`);
      sections.push("");
    }
  }

  const workDir = task.worktree_path || (project.workspace_path ? `${project.workspace_path}main` : "current directory");

  sections.push(`## Instructions`);
  sections.push(`You are an autonomous task executor. You have access to tools: read files, write files, execute shell commands.`);
  sections.push(`1. Work within this directory: ${workDir}`);
  if (task.worktree_path) {
    sections.push(`   - This is an isolated git worktree on branch \`${task.git_branch}\`. Commit your changes frequently.`);
    sections.push(`   - The main branch is at: ${project.workspace_path}main`);
  }
  sections.push(`2. Make the required code changes.`);
  sections.push(`3. Run build/test commands to verify your changes work.`);
  sections.push(`4. When done, output your final result as a JSON block in this EXACT format:`);
  sections.push("");
  sections.push("```json");
  sections.push(JSON.stringify({
    status: "success | failure",
    summary: "Concise description of what was done",
    files_changed: ["path/to/file1.ts"],
    error_log: "Only on failure — what went wrong",
    learnings: "What future attempts should know",
  }, null, 2));
  sections.push("```");
  sections.push("");
  sections.push(`IMPORTANT: Your very last message MUST contain this JSON block. The system parses it automatically.`);

  return sections.join("\n");
}

// ─── Agent Session ───────────────────────────────────────────────

async function spawnAgentSession(
  taskPrompt: string,
): Promise<{ sessionKey: string; runId: string }> {
  const sessionKey = `agent:main:executor:${crypto.randomUUID()}`;

  await callGatewayCli({
    url: GATEWAY_URL,
    token: GATEWAY_TOKEN,
    method: "sessions.patch",
    params: { key: sessionKey, model: MODEL },
    timeoutMs: 10_000,
  });

  const idemKey = crypto.randomUUID();
  const response = await callGatewayCli<{ runId: string }>({
    url: GATEWAY_URL,
    token: GATEWAY_TOKEN,
    method: "agent",
    params: {
      message: taskPrompt,
      sessionKey,
      idempotencyKey: idemKey,
      deliver: false,
      timeout: AGENT_TIMEOUT_SECONDS,
      lane: "subagent",
    },
    timeoutMs: 15_000,
  });

  return { sessionKey, runId: response.runId };
}

async function waitForAgent(
  runId: string,
  timeoutMs = AGENT_TIMEOUT_SECONDS * 1000 + 30_000,
): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await callGatewayCli<{ status: string; error?: string }>({
        url: GATEWAY_URL,
        token: GATEWAY_TOKEN,
        method: "agent.status",
        params: { runId },
        timeoutMs: 10_000,
      });
      if (result.status === "done" || result.status === "error") return result;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { status: "timeout", error: "Agent execution timed out" };
}

async function getAgentResponse(sessionKey: string): Promise<string | null> {
  try {
    const result = await callGatewayCli<{ messages?: Array<{ role: string; content: string }> }>({
      url: GATEWAY_URL,
      token: GATEWAY_TOKEN,
      method: "chat.history",
      params: { sessionKey, limit: 5 },
      timeoutMs: 10_000,
    });
    const messages = result.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].content;
    }
    console.log("[executor] chat.history: no messages, keys:", Object.keys(result || {}));
  } catch (err) {
    console.error("[executor] chat.history error:", err);
  }
  return null;
}

function parseAgentResult(text: string): {
  status: string;
  summary: string;
  files_changed: string[];
  error_log: string | null;
  learnings: string | null;
} | null {
  const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      status: parsed.status || "unknown",
      summary: parsed.summary || "",
      files_changed: parsed.files_changed || [],
      error_log: parsed.error_log || null,
      learnings: parsed.learnings || null,
    };
  } catch { return null; }
}

// ─── Main Executor ───────────────────────────────────────────────

export interface ExecutorResult {
  action: "executed" | "skipped" | "error";
  taskId?: number;
  projectId?: string;
  outcome?: string;
  message: string;
}

export async function executeNextTask(): Promise<ExecutorResult> {
  console.log("[executor] Starting run...");

  if (await isAnyTaskExecuting()) {
    console.log("[executor] Task already executing, skipping.");
    return { action: "skipped", message: "Another task is executing" };
  }

  const task = await pickNextTask();
  if (!task) {
    console.log("[executor] Queue empty.");
    return { action: "skipped", message: "No tasks in queue" };
  }

  const project = await getProject(task.project_id);
  if (!project) {
    return { action: "error", message: `Project ${task.project_id} not found` };
  }

  console.log(`[executor] Task #${task.id}: "${task.title}" (${project.name})`);

  // Create worktree if branching required
  if (task.requires_branching && project.workspace_path) {
    const refName = task.slug || `task-${task.id}`;
    const branchName = `task/${refName}`;
    const repoPath = path.join(project.workspace_path, "main");
    const worktreePath = path.join(project.workspace_path, "worktrees", refName);
    try {
      await createWorktree(repoPath, worktreePath, branchName);
      await execute("UPDATE project_tasks SET git_branch=?, worktree_path=? WHERE id=?", [
        branchName, worktreePath, task.id,
      ]);
      task.git_branch = branchName;
      task.worktree_path = worktreePath;
    } catch (err) {
      return { action: "error", taskId: task.id, message: `Worktree creation failed: ${err}` };
    }
  }

  try {
    await transitionTask(task.id, "queue", "executing", "executor", "automated pickup");
  } catch (err) {
    return { action: "error", taskId: task.id, message: `Transition failed: ${err}` };
  }

  const [memory, commands, attempts] = await Promise.all([
    getProjectMemory(task.project_id),
    getProjectCommands(task.project_id),
    getTaskAttempts(task.id),
  ]);
  const prompt = buildTaskPrompt(project, task, memory, commands, attempts);

  await notify(
    `⚙️ <b>Executing:</b> ${esc(task.title)}\n<i>${esc(project.name)} | Attempt ${task.attempt_count + 1}/${task.max_attempts}</i>`,
    project.telegram_topic_id,
  );

  const startTime = Date.now();
  let sessionKey: string | undefined;

  try {
    const spawn = await spawnAgentSession(prompt);
    sessionKey = spawn.sessionKey;
    console.log(`[executor] Agent spawned: ${spawn.runId}`);

    const waitResult = await waitForAgent(spawn.runId);
    const durationMs = Date.now() - startTime;
    console.log(`[executor] Agent finished: ${waitResult.status} (${durationMs}ms)`);

    if (waitResult.status === "error" || waitResult.status === "timeout") {
      throw new Error(waitResult.error || `Agent ${waitResult.status}`);
    }

    const response = sessionKey ? await getAgentResponse(sessionKey) : null;
    if (!response) {
      throw new Error("No response from agent");
    }

    const result = parseAgentResult(response);
    if (!result) {
      await recordAttempt(task.id, "unknown", "Agent did not produce structured output", MODEL, durationMs, null, null, null);
      if (task.requires_human_review) {
        await transitionTask(task.id, "executing", "review_requested", "executor", "Completed but no structured output");
      } else {
        await transitionTask(task.id, "executing", "done", "executor", "Completed");
      }
      await notify(
        `✅ <b>Done:</b> ${esc(task.title)}\n<i>No structured output, sent to review</i>`,
        project.telegram_topic_id,
      );
      return { action: "executed", taskId: task.id, projectId: project.id, outcome: "review", message: "Completed without structured output" };
    }

    await recordAttempt(
      task.id, result.status, result.summary, MODEL, durationMs,
      result.error_log, result.files_changed?.join(", ") || null, result.learnings,
    );

    if (result.learnings) {
      await execute(
        "UPDATE project_tasks SET execution_notes = CONCAT(COALESCE(execution_notes, ''), ?) WHERE id = ?",
        [`\n---\nAttempt ${task.attempt_count + 1}: ${result.learnings}`, task.id],
      );
    }

    if (result.status === "success") {
      if (task.requires_human_review) {
        await transitionTask(task.id, "executing", "review_requested", "executor", result.summary);
      } else {
        await transitionTask(task.id, "executing", "done", "executor", result.summary);
      }
      await notify(
        `✅ <b>Success:</b> ${esc(task.title)}\n<i>${esc(result.summary)}</i>`,
        project.telegram_topic_id,
      );
      return { action: "executed", taskId: task.id, projectId: project.id, outcome: "success", message: result.summary };
    } else {
      const newCount = task.attempt_count + 1;
      if (newCount >= task.max_attempts) {
        await transitionTask(task.id, "executing", "stalled", "executor", `Failed after ${newCount} attempts: ${result.summary}`);
        await notify(
          `❌ <b>Stalled:</b> ${esc(task.title)}\n<i>Failed after ${newCount} attempts</i>`,
          project.telegram_topic_id,
        );
      } else {
        await transitionTask(task.id, "executing", "queue", "executor", `Attempt failed, re-queued: ${result.summary}`);
        await notify(
          `🔄 <b>Retry:</b> ${esc(task.title)}\n<i>Attempt ${newCount}/${task.max_attempts} failed, re-queued</i>`,
          project.telegram_topic_id,
        );
      }
      return { action: "executed", taskId: task.id, projectId: project.id, outcome: "failure", message: result.summary };
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    await recordAttempt(task.id, "abandoned", `Agent error: ${errMsg}`, MODEL, durationMs, errMsg, null, null);

    const newCount = task.attempt_count + 1;
    if (newCount >= task.max_attempts) {
      await transitionTask(task.id, "executing", "stalled", "executor", `Agent error: ${errMsg}`);
    } else {
      await transitionTask(task.id, "executing", "queue", "executor", `Agent error, will retry`);
    }

    await notify(
      `⚠️ <b>Error:</b> ${esc(task.title)}\n<i>${esc(errMsg).slice(0, 200)}</i>`,
      project.telegram_topic_id,
    );

    return { action: "error", taskId: task.id, projectId: project.id, message: errMsg };
  }
}

// ─── CLI Entry ───────────────────────────────────────────────────

const isDirectRun =
  process.argv[1]?.endsWith("executor.js") ||
  process.argv[1]?.endsWith("executor.ts");

if (isDirectRun) {
  executeNextTask()
    .then((result) => {
      console.log("[executor] Done:", JSON.stringify(result));
      return getProjectPool().end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[executor] Fatal:", err);
      getProjectPool().end().catch(() => {}).then(() => process.exit(1));
    });
}
