import mysql from "mysql2/promise";

export const PROJECT_SCHEMA_SQL = `CREATE DATABASE IF NOT EXISTS openclaw_projects CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
) ENGINE=InnoDB;`;

const CREATE_DATABASE_SQL = `CREATE DATABASE IF NOT EXISTS openclaw_projects CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;

const CREATE_TABLES_SQL = PROJECT_SCHEMA_SQL.replace(CREATE_DATABASE_SQL, "")
  .replace("USE openclaw_projects;", "")
  .trim();

const CREATE_TABLE_STATEMENTS = CREATE_TABLES_SQL.split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)
  .map((statement) => `${statement};`);

export async function runMigrations(): Promise<void> {
  const adminConnection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: "openclaw",
    password: "openclaw",
    multipleStatements: true,
  });

  try {
    await adminConnection.execute(CREATE_DATABASE_SQL);
  } finally {
    await adminConnection.end();
  }

  const projectConnection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: "openclaw",
    password: "openclaw",
    database: "openclaw_projects",
  });

  try {
    for (const statement of CREATE_TABLE_STATEMENTS) {
      await projectConnection.execute(statement);
    }
  } finally {
    await projectConnection.end();
  }
}
