import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskRunnerService } from "./service.js";

let svc: TaskRunnerService;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "task-runner-test-"));
  // Patch home so service uses temp dir
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  svc = new TaskRunnerService({ allowedCwds: [tmpDir, "/tmp", os.tmpdir()] });
  await svc.init();
  // Restore after construction (baseDir already computed)
  process.env.HOME = origHome;
});

afterEach(async () => {
  // Kill any running tasks
  const tasks = svc.list();
  for (const t of tasks) {
    if (t.status === "running" || t.status === "pending") {
      try {
        await svc.stop(t.id, { timeoutMs: 1000 });
      } catch {
        /* ignore */
      }
    }
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("TaskRunnerService", () => {
  it("starts and stops a task", async () => {
    const result = await svc.start({ command: "sleep", args: ["60"], id: "test1" });
    expect(result.id).toBe("test1");
    expect(result.status).toBe("running");

    const stopped = await svc.stop("test1", { timeoutMs: 2000 });
    expect(stopped.status).toBe("killed");
  });

  it("errors on duplicate id without replace", async () => {
    await svc.start({ command: "sleep", args: ["60"], id: "dup" });
    await expect(svc.start({ command: "sleep", args: ["60"], id: "dup" })).rejects.toThrow(
      "Task already exists",
    );
    await svc.stop("dup", { timeoutMs: 1000 });
  });

  it("replace=true works for terminal tasks", async () => {
    const _r1 = await svc.start({ command: "true", id: "rep" });
    // Wait for it to exit
    await svc.wait("rep", { timeoutMs: 3000 });
    const status = await svc.status("rep");
    expect(["stopped", "failed", "killed", "lost"]).toContain(status.status);

    // Now replace
    const r2 = await svc.start({ command: "sleep", args: ["60"], id: "rep", replace: true });
    expect(r2.id).toBe("rep");
    expect(r2.status).toBe("running");
    await svc.stop("rep", { timeoutMs: 1000 });
  });

  it("replace=true errors on running task without force", async () => {
    await svc.start({ command: "sleep", args: ["60"], id: "rf" });
    await expect(
      svc.start({ command: "sleep", args: ["60"], id: "rf", replace: true }),
    ).rejects.toThrow("still running");
    await svc.stop("rf", { timeoutMs: 1000 });
  });

  it("force=true stops running task and replaces", async () => {
    await svc.start({ command: "sleep", args: ["60"], id: "force1" });
    const r2 = await svc.start({
      command: "sleep",
      args: ["60"],
      id: "force1",
      force: true,
      stopTimeoutMs: 2000,
    });
    expect(r2.id).toBe("force1");
    expect(r2.status).toBe("running");
    await svc.stop("force1", { timeoutMs: 1000 });
  });

  it("forceByTags stops tasks with matching tags", async () => {
    await svc.start({
      command: "sleep",
      args: ["60"],
      id: "tag1",
      tags: ["devserver"],
    });
    await svc.start({
      command: "sleep",
      args: ["60"],
      id: "tag2",
      tags: ["devserver"],
    });

    // Start new task with forceByTags
    const r = await svc.start({
      command: "sleep",
      args: ["60"],
      id: "tag3",
      tags: ["devserver"],
      forceByTags: true,
      stopTimeoutMs: 2000,
    });
    expect(r.id).toBe("tag3");
    expect(r.status).toBe("running");

    // Old tasks should be killed
    const s1 = await svc.status("tag1");
    const s2 = await svc.status("tag2");
    expect(s1.status).toBe("killed");
    expect(s2.status).toBe("killed");

    await svc.stop("tag3", { timeoutMs: 1000 });
  });
});
