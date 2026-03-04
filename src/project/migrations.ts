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
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  status ENUM('planning','queue','executing','review_requested','changes_requested','stalled','done','cancelled','blocked','requirements','implementing','approved','merging','merge_conflict','building','deploying') NOT NULL DEFAULT 'planning',
  status_before_blocked VARCHAR(32) NULL COMMENT 'Saved when entering blocked state',
  task_type ENUM('feature','bugfix','iteration','hotfix','chore') NOT NULL DEFAULT 'feature',
  requires_branching BOOLEAN NOT NULL DEFAULT TRUE,
  requires_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 0,
  phase VARCHAR(64) NULL,
  git_branch VARCHAR(255) NULL,
  worktree_path VARCHAR(512) NULL,
  dev_server_url VARCHAR(512) NULL,
  review_notes TEXT NULL,
  review_feedback TEXT NULL,
  block_reason TEXT NULL,
  max_attempts INT NOT NULL DEFAULT 3,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at DATETIME NULL,
  execution_notes TEXT NULL COMMENT 'Accumulated learnings across attempts',
  estimated_complexity ENUM('trivial','small','medium','large') NULL,
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
  error_log TEXT NULL COMMENT 'Structured error output from agent',
  files_changed TEXT NULL COMMENT 'JSON array of file paths modified',
  duration_ms INT NULL,
  git_branch VARCHAR(255) NULL,
  git_diff_summary TEXT NULL COMMENT 'Short diff stat output',
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
    // Create env tables
    for (const statement of ENV_TABLE_STATEMENTS) {
      await projectConnection.execute(statement);
    }
    // Create port tables
    for (const statement of PORT_TABLE_STATEMENTS) {
      await projectConnection.execute(statement);
    }
    // Run ALTER migrations for existing databases
    for (const alt of ALTER_MIGRATIONS) {
      try {
        await projectConnection.execute(alt);
      } catch {
        // Ignore errors (column already exists, etc.)
      }
    }
  } finally {
    await projectConnection.end();
  }
}

const PORT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS project_ports (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  label VARCHAR(64) NOT NULL,
  description VARCHAR(255) NULL,
  UNIQUE KEY uq_project_port_label (project_id, label),
  INDEX idx_project_ports_project (project_id),
  CONSTRAINT fk_ports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS port_assignments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  port INT NOT NULL,
  task_id BIGINT NOT NULL,
  project_port_id BIGINT NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at DATETIME NULL,
  UNIQUE KEY uq_task_port_label (task_id, project_port_id),
  INDEX idx_port_assignments_task (task_id),
  INDEX idx_port_assignments_port (port),
  CONSTRAINT fk_pa_task FOREIGN KEY (task_id) REFERENCES project_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pa_port FOREIGN KEY (project_port_id) REFERENCES project_ports(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pa_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
`;

const ENV_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS project_env (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  \`key\` VARCHAR(128) NOT NULL,
  value TEXT NOT NULL,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  description VARCHAR(255) NULL,
  UNIQUE KEY uq_project_env_key (project_id, \`key\`),
  INDEX idx_project_env_project (project_id),
  CONSTRAINT fk_env_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
`;

const ENV_TABLE_STATEMENTS = ENV_TABLES_SQL.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => `${s};`);

const PORT_TABLE_STATEMENTS = PORT_TABLES_SQL.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => `${s};`);

/** Idempotent ALTER statements for upgrading existing schemas */
const ALTER_MIGRATIONS: string[] = [
  // Add new task statuses to ENUM
  `ALTER TABLE project_tasks MODIFY COLUMN status ENUM('planning','queue','executing','review_requested','changes_requested','stalled','done','cancelled','blocked','requirements','implementing','approved','merging','merge_conflict','building','deploying') NOT NULL DEFAULT 'planning'`,
  // Widen status_before_blocked to VARCHAR to support all statuses
  `ALTER TABLE project_tasks MODIFY COLUMN status_before_blocked VARCHAR(32) NULL`,
  // New task columns
  `ALTER TABLE project_tasks ADD COLUMN max_attempts INT NOT NULL DEFAULT 3`,
  `ALTER TABLE project_tasks ADD COLUMN attempt_count INT NOT NULL DEFAULT 0`,
  `ALTER TABLE project_tasks ADD COLUMN last_attempt_at DATETIME NULL`,
  `ALTER TABLE project_tasks ADD COLUMN execution_notes TEXT NULL COMMENT 'Accumulated learnings across attempts'`,
  `ALTER TABLE project_tasks ADD COLUMN estimated_complexity ENUM('trivial','small','medium','large') NULL`,
  // New attempt columns
  `ALTER TABLE task_attempts ADD COLUMN error_log TEXT NULL`,
  `ALTER TABLE task_attempts ADD COLUMN files_changed TEXT NULL`,
  `ALTER TABLE task_attempts ADD COLUMN duration_ms INT NULL`,
  `ALTER TABLE task_attempts ADD COLUMN git_branch VARCHAR(255) NULL`,
  `ALTER TABLE task_attempts ADD COLUMN git_diff_summary TEXT NULL`,
  // Migrate old statuses to new ones
  `UPDATE project_tasks SET status = 'planning' WHERE status = 'requirements'`,
  `UPDATE project_tasks SET status = 'queue' WHERE status IN ('implementing', 'approved')`,
  `UPDATE project_tasks SET status = 'executing' WHERE status IN ('merging', 'merge_conflict', 'building', 'deploying')`,
];
