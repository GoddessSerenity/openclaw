# OpenClaw Project Management Tool (`project`)

## 1. Overview

The OpenClaw `project` tool provides **structured, database-backed project management** for agents.

It exists to replace ad-hoc tracking (scattered markdown notes, manual status updates, unstructured memory) with a first-class workflow system that includes:

- Project metadata and lifecycle state
- Environment links and reusable commands
- Task planning and execution through a strict state machine
- Dependency-aware task selection
- Git worktree/branch integration for implementation workflows
- Durable project-scoped memory and learnings

The tool is invoked as:

```json
{
  "action": "<action_name>",
  "...": "other parameters"
}
```

Tool name: **`project`**

---

## 2. Prerequisites

The project runtime depends on MariaDB/MySQL.

| Requirement   | Value               |
| ------------- | ------------------- |
| DB host       | `127.0.0.1`         |
| DB port       | `3306`              |
| DB user       | `openclaw`          |
| DB password   | `openclaw`          |
| Database name | `openclaw_projects` |

Behavior on first use:

- The tool runs migrations automatically.
- `openclaw_projects` is created if missing.
- All required tables are created if missing.

---

## 3. Projects

### Actions

- `project_create`
- `project_get`
- `project_list`
- `project_update`
- `project_delete`

### Core fields

| Field             | Type           | Notes                                                  |
| ----------------- | -------------- | ------------------------------------------------------ |
| `id`              | string         | Stable project key (primary identifier)                |
| `name`            | string         | Human-readable name                                    |
| `description`     | string \| null | Project summary                                        |
| `state`           | enum           | `planning`, `active`, `paused`, `complete`, `archived` |
| `workspacePath`   | string \| null | Filesystem workspace root for project                  |
| `githubRemote`    | string \| null | Optional Git remote URL                                |
| `telegramTopicId` | number \| null | Optional topic/thread integration                      |
| `hasBuildStep`    | boolean        | Whether task flow should include build phase           |
| `hasDeployStep`   | boolean        | Whether task flow should include deploy phase          |

### Project state machine

Allowed transitions:

- `planning -> active`
- `active -> paused | complete`
- `paused -> active | archived`
- `complete -> archived`
- `archived -> active`

### `project_get` returns full context

`project_get` returns a full context payload (not just project row):

- `project`
- `links[]`
- `commands[]`
- `tasks[]`
- `task_dependencies[]`
- `recent_memory[]` (latest entries, capped)
- `running_processes[]` (placeholder in current implementation)

### Example

```json
{
  "action": "project_create",
  "id": "serenity-ui",
  "name": "Serenity UI",
  "description": "Agent-facing chat UI and integrations",
  "state": "planning",
  "workspacePath": "/home/serenity/workspace/serenityui",
  "githubRemote": "git@github.com:org/serenity-ui.git",
  "telegramTopicId": 12345,
  "hasBuildStep": true,
  "hasDeployStep": true
}
```

```json
{
  "action": "project_get",
  "projectId": "serenity-ui"
}
```

---

## 4. Links

Links store important project URLs (environments, docs, admin pages, APIs).

### Actions

- `link_add`
- `link_remove`
- `link_list`

### Fields

- `projectId`
- `label`
- `url`
- `category`

### Categories

- `dev`
- `prod`
- `docs`
- `admin`
- `api`
- `other`

### Example

```json
{
  "action": "link_add",
  "projectId": "serenity-ui",
  "label": "dev-ui",
  "url": "http://localhost:3100",
  "category": "dev"
}
```

---

## 5. Commands

Commands are reusable per-project operations (build/test/lint/dev/deploy/etc.).

### Actions

- `cmd_add`
- `cmd_list`
- `cmd_remove`
- `cmd_update`
- `cmd_lock`
- `cmd_unlock`
- `cmd_run`

### Categories

- `dev`
- `build`
- `test`
- `deploy`
- `lint`
- `db`
- `other`

### Run modes

- `exec`: synchronous command execution
- `task`: background execution via `task_runner`

### Locking behavior

Locked commands are protected from mutation/removal.

- `cmd_update` and `cmd_remove` fail on locked commands unless:
  - `force: true`
  - a non-empty `reason` is provided

### Token replacement

When running commands, the tool replaces:

- `{project_id}`
- `{task_id}`
- `{label}`

in command text and `task_runner_id` template.

### Example

```json
{
  "action": "cmd_add",
  "projectId": "serenity-ui",
  "label": "dev",
  "command": "pnpm dev --port 3100",
  "cwd": "/home/serenity/workspace/serenityui",
  "category": "dev",
  "runMode": "task",
  "taskRunnerId": "{project_id}-{label}"
}
```

```json
{
  "action": "cmd_run",
  "projectId": "serenity-ui",
  "label": "dev",
  "taskId": 42
}
```

---

## 6. Tasks

Tasks are the core execution unit and include workflow state, dependency handling, optional branching, and review/build/deploy gates.

### Actions

- `task_add`
- `task_get`
- `task_list`
- `task_update`
- `task_next`
- `task_start`
- `task_request_review`
- `task_approve`
- `task_request_changes`
- `task_merge`
- `task_resolve_conflict`
- `task_build`
- `task_deploy`
- `task_complete`
- `task_cancel`
- `task_block`
- `task_unblock`

### Task types and defaults

| Task type   | `requires_branching` | `requires_human_review` | Uses build | Uses deploy |
| ----------- | -------------------: | ----------------------: | ---------: | ----------: |
| `feature`   |                 true |                    true |       true |        true |
| `bugfix`    |                 true |                   false |       true |        true |
| `iteration` |                false |                    true |      false |       false |
| `hotfix`    |                false |                   false |       true |        true |
| `chore`     |                 true |                   false |      false |       false |

> "Uses build/deploy" defaults influence post-merge flow expectations; project-level `hasBuildStep`/`hasDeployStep` determine actual transitions.

### Statuses

- `requirements`
- `implementing`
- `review_requested`
- `approved`
- `changes_requested`
- `merging`
- `merge_conflict`
- `building`
- `deploying`
- `done`
- `cancelled`
- `blocked`

### Full state transitions

Standard transitions:

- `requirements -> implementing`
- `implementing -> review_requested | approved`
- `review_requested -> approved | changes_requested`
- `changes_requested -> review_requested`
- `approved -> merging`
- `merging -> merge_conflict | building | deploying | done`
- `merge_conflict -> merging`
- `building -> deploying | done`
- `deploying -> done`

Special transitions:

- Any active status (`requirements`, `implementing`, `review_requested`, `approved`, `changes_requested`, `merging`, `merge_conflict`, `building`, `deploying`) -> `blocked`
- `blocked -> <status_before_blocked>` (restores saved previous status, defaults to `requirements` if absent)
- `task_complete` can force transition to `done` from almost any non-terminal active status
- `task_cancel` can force transition to `cancelled` from most statuses (including `done` and `blocked`)

### ASCII state diagram

```text
requirements
    |
    v
implementing ----------------------> approved -----------------> merging -----> merge_conflict
    |                                 ^                            |                 |
    |                                 |                            |                 |
    +--> review_requested ----> changes_requested -----------------+                 |
            |                                                                           |
            +----------------------------> approved ------------------------------------+

merging --> building --> deploying --> done
    |           |            |
    +---------->+------------+

(active statuses) --task_block--> blocked --task_unblock--> previous active status

(almost any active status) --task_complete--> done
(almost any status) --task_cancel--> cancelled
```

### Git integration and worktrees

For tasks with `requires_branching=true`, `task_start`:

1. Transitions `requirements|changes_requested -> implementing`
2. Requires project `workspacePath`
3. Uses repo path: `<workspacePath>/main`
4. Creates branch: `task/{id}`
5. Creates worktree path: `<workspacePath>/worktrees/task-{id}`
6. Stores `git_branch` and `worktree_path` on the task

### `task_next` behavior

`task_next` returns the **highest-priority runnable task** that is:

- In active pre-done statuses (`requirements`, `implementing`, `changes_requested`, `review_requested`, `approved`, `merge_conflict`)
- Not blocked
- Not waiting on unfinished dependencies

Selection order:

1. `priority` DESC
2. `created_at` ASC
3. `id` ASC

### Auto-approval behavior

If `requires_human_review=false`, calling `task_request_review` **auto-advances** directly to `approved` (via `task_approve`) rather than entering `review_requested`.

### Smart merge flow (`task_merge`)

`task_merge` handles both branching and non-branching tasks:

- **Non-branching tasks**: skip git merge; advance directly based on project pipeline:
  - `building` if `hasBuildStep=true`
  - else `deploying` if `hasDeployStep=true`
  - else `done`

- **Branching tasks**:
  1. Transition to `merging`
  2. Merge `task/{id}` into main repo
  3. On conflict -> `merge_conflict`
  4. On success -> auto-advance to `building` / `deploying` / `done` depending on project settings

### Examples

```json
{
  "action": "task_add",
  "projectId": "serenity-ui",
  "title": "Implement project dashboard",
  "taskType": "feature",
  "priority": 100,
  "phase": "mvp",
  "assignedModel": "codex"
}
```

```json
{
  "action": "task_start",
  "taskId": 42,
  "actor": "agent:main:...",
  "reason": "Begin implementation"
}
```

```json
{
  "action": "task_request_review",
  "taskId": 42,
  "actor": "agent:main:..."
}
```

```json
{
  "action": "task_merge",
  "taskId": 42,
  "actor": "agent:main:..."
}
```

---

## 7. Dependencies

Dependencies model task ordering constraints.

### Actions

- `task_dep_add`
- `task_dep_remove`
- `task_dep_list`

### Behavior

- A task cannot depend on itself.
- Tasks with unfinished dependencies are excluded from `task_next`.
- Dependency rows are `(task_id, depends_on_id)` pairs.

### Example

```json
{
  "action": "task_dep_add",
  "taskId": 43,
  "dependsOnId": 42
}
```

---

## 8. Memory

Project memory stores reusable learnings and decisions tied to a project.

### Actions

- `memory_add`
- `memory_list`
- `memory_remove`

### Categories

- `mistake`
- `learning`
- `convention`
- `gotcha`
- `decision`

### Behavior

- Memory is project-scoped and durable across sessions.
- Useful for preserving lessons, standards, and operational gotchas.

### Example

```json
{
  "action": "memory_add",
  "projectId": "serenity-ui",
  "category": "convention",
  "content": "Use dev port 3100; production remains 3000."
}
```

---

## 9. Database Schema (Reference)

Below are the migration DDL statements used by the project tool.

```sql
CREATE DATABASE IF NOT EXISTS openclaw_projects CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE openclaw_projects;

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  state ENUM('planning','active','paused','complete','archived') NOT NULL DEFAULT 'planning',
  workspace_path VARCHAR(512) NULL,
  github_remote VARCHAR(512) NULL,
  telegram_topic_id BIGINT NULL,
  has_build_step BOOLEAN NOT NULL DEFAULT TRUE,
  has_deploy_step BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_projects_state (state)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS project_links (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  label VARCHAR(64) NOT NULL,
  url VARCHAR(1024) NOT NULL,
  category ENUM('dev','prod','docs','admin','api','other') NOT NULL DEFAULT 'other',
  UNIQUE KEY uq_project_link (project_id, label),
  INDEX idx_project_links_project (project_id),
  CONSTRAINT fk_links_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS project_commands (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  label VARCHAR(64) NOT NULL,
  command TEXT NOT NULL,
  cwd VARCHAR(512) NULL,
  description VARCHAR(512) NULL,
  category ENUM('dev','build','test','deploy','lint','db','other') NOT NULL DEFAULT 'other',
  run_mode ENUM('exec','task') NOT NULL DEFAULT 'exec',
  task_runner_id VARCHAR(128) NULL COMMENT 'Template: supports {project_id}, {task_id}, {label}',
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_by VARCHAR(128) NULL,
  locked_at DATETIME NULL,
  UNIQUE KEY uq_cmd (project_id, label),
  INDEX idx_commands_project (project_id),
  INDEX idx_commands_project_category (project_id, category),
  CONSTRAINT fk_commands_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS project_tasks (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL,
  description TEXT NULL,
  status ENUM('requirements','implementing','review_requested','approved','changes_requested','merging','merge_conflict','building','deploying','done','cancelled','blocked') NOT NULL DEFAULT 'requirements',
  status_before_blocked ENUM('requirements','implementing','review_requested','approved','changes_requested','merging','merge_conflict','building','deploying') NULL COMMENT 'Saved when entering blocked state',
  task_type ENUM('feature','bugfix','iteration','hotfix','chore') NOT NULL DEFAULT 'feature',
  requires_branching BOOLEAN NOT NULL DEFAULT TRUE,
  requires_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 0,
  phase VARCHAR(64) NULL,
  assigned_model VARCHAR(64) NULL,
  git_branch VARCHAR(255) NULL,
  worktree_path VARCHAR(512) NULL,
  dev_server_url VARCHAR(512) NULL,
  review_notes TEXT NULL,
  review_feedback TEXT NULL,
  block_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  INDEX idx_tasks_project (project_id),
  INDEX idx_tasks_next (project_id, status, priority, created_at, id),
  INDEX idx_tasks_phase (project_id, phase, status),
  CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS project_task_dependencies (
  task_id BIGINT NOT NULL,
  depends_on_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, depends_on_id),
  INDEX idx_dep_depends_on (depends_on_id),
  CONSTRAINT fk_dep_task FOREIGN KEY (task_id) REFERENCES project_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_dep_depends_on FOREIGN KEY (depends_on_id) REFERENCES project_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_status_history (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NOT NULL,
  actor VARCHAR(128) NULL COMMENT 'agent session key or human',
  reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_history_task (task_id),
  INDEX idx_history_created (created_at),
  CONSTRAINT fk_history_task FOREIGN KEY (task_id) REFERENCES project_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_attempts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT NOT NULL,
  session_key VARCHAR(128) NULL COMMENT 'Session key of the agent that worked on this',
  model VARCHAR(64) NULL COMMENT 'Which model was used',
  summary TEXT NOT NULL COMMENT 'Auto-generated summary of what was tried',
  outcome ENUM('success','partial','failed','abandoned') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attempts_task (task_id),
  CONSTRAINT fk_attempts_task FOREIGN KEY (task_id) REFERENCES project_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS project_memory (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  category ENUM('mistake','learning','convention','gotcha','decision') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_memory_project (project_id),
  INDEX idx_memory_project_category (project_id, category),
  CONSTRAINT fk_memory_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
```

---

## Quick Action Index

```text
Projects:     project_create, project_get, project_list, project_update, project_delete
Links:        link_add, link_remove, link_list
Commands:     cmd_add, cmd_list, cmd_remove, cmd_update, cmd_lock, cmd_unlock, cmd_run
Tasks:        task_add, task_get, task_list, task_update, task_next, task_start,
              task_request_review, task_approve, task_request_changes,
              task_merge, task_resolve_conflict, task_build, task_deploy,
              task_complete, task_cancel, task_block, task_unblock
Dependencies: task_dep_add, task_dep_remove, task_dep_list
Memory:       memory_add, memory_list, memory_remove
```
