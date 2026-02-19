import { Type } from "@sinclair/typebox";
import { getProjectService } from "../../project/service.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const PROJECT_ACTIONS = [
  "project_create",
  "project_get",
  "project_list",
  "project_update",
  "project_delete",
  "link_add",
  "link_remove",
  "link_list",
  "cmd_add",
  "cmd_list",
  "cmd_remove",
  "cmd_update",
  "cmd_lock",
  "cmd_unlock",
  "cmd_run",
  "task_add",
  "task_get",
  "task_list",
  "task_update",
  "task_next",
  "task_start",
  "task_request_review",
  "task_approve",
  "task_request_changes",
  "task_merge",
  "task_resolve_conflict",
  "task_build",
  "task_deploy",
  "task_complete",
  "task_cancel",
  "task_block",
  "task_unblock",
  "task_dep_add",
  "task_dep_remove",
  "task_dep_list",
  "memory_add",
  "memory_list",
  "memory_remove",
] as const;

const ProjectToolSchema = Type.Object({
  action: stringEnum(PROJECT_ACTIONS),

  id: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  workspacePath: Type.Optional(Type.String()),
  githubRemote: Type.Optional(Type.String()),
  telegramTopicId: Type.Optional(Type.Number()),
  hasBuildStep: Type.Optional(Type.Boolean()),
  hasDeployStep: Type.Optional(Type.Boolean()),

  linkId: Type.Optional(Type.Number()),
  label: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),

  commandId: Type.Optional(Type.Number()),
  command: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runMode: Type.Optional(Type.String()),
  taskRunnerId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.Number()),
  force: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
  lockedBy: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),

  title: Type.Optional(Type.String()),
  taskType: Type.Optional(Type.String()),
  requiresBranching: Type.Optional(Type.Boolean()),
  requiresHumanReview: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Number()),
  phase: Type.Optional(Type.String()),
  assignedModel: Type.Optional(Type.String()),
  reviewNotes: Type.Optional(Type.String()),
  reviewFeedback: Type.Optional(Type.String()),
  devServerUrl: Type.Optional(Type.String()),
  actor: Type.Optional(Type.String()),

  dependsOnId: Type.Optional(Type.Number()),

  memoryId: Type.Optional(Type.Number()),
  content: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),

  tags: Type.Optional(Type.Array(Type.String())),
  items: Type.Optional(Type.Array(Type.String())),
});

export function createProjectTool(): AnyAgentTool {
  const svc = getProjectService();

  return {
    label: "Project",
    name: "project",
    description:
      "Project management runtime: projects, links, commands, tasks, workflow transitions, dependencies, and memory.",
    parameters: ProjectToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const normalized: Record<string, unknown> = { ...params };
      const asString = [
        "id",
        "projectId",
        "name",
        "description",
        "state",
        "workspacePath",
        "githubRemote",
        "label",
        "url",
        "category",
        "command",
        "cwd",
        "runMode",
        "taskRunnerId",
        "reason",
        "lockedBy",
        "title",
        "taskType",
        "phase",
        "assignedModel",
        "reviewNotes",
        "reviewFeedback",
        "devServerUrl",
        "actor",
        "content",
      ] as const;
      for (const key of asString) {
        const value = readStringParam(params, key, { trim: false });
        if (value !== undefined) {
          normalized[key] = value;
        }
      }

      const asNumber = [
        "telegramTopicId",
        "linkId",
        "commandId",
        "taskId",
        "timeoutMs",
        "priority",
        "dependsOnId",
        "memoryId",
        "limit",
      ] as const;
      for (const key of asNumber) {
        const value = readNumberParam(params, key);
        if (value !== undefined) {
          normalized[key] = value;
        }
      }

      const tags = readStringArrayParam(params, "tags", { allowEmpty: true });
      if (tags) {
        normalized.tags = tags;
      }
      const items = readStringArrayParam(params, "items", { allowEmpty: true });
      if (items) {
        normalized.items = items;
      }

      switch (action) {
        case "project_create":
        case "project_get":
        case "project_list":
        case "project_update":
        case "project_delete":
        case "link_add":
        case "link_remove":
        case "link_list":
        case "cmd_add":
        case "cmd_list":
        case "cmd_remove":
        case "cmd_update":
        case "cmd_lock":
        case "cmd_unlock":
        case "cmd_run":
        case "task_add":
        case "task_get":
        case "task_list":
        case "task_update":
        case "task_next":
        case "task_start":
        case "task_request_review":
        case "task_approve":
        case "task_request_changes":
        case "task_merge":
        case "task_resolve_conflict":
        case "task_build":
        case "task_deploy":
        case "task_complete":
        case "task_cancel":
        case "task_block":
        case "task_unblock":
        case "task_dep_add":
        case "task_dep_remove":
        case "task_dep_list":
        case "memory_add":
        case "memory_list":
        case "memory_remove": {
          return jsonResult(await svc.executeAction(action, normalized));
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
