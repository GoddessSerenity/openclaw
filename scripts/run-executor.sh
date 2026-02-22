#!/bin/bash
# Task Executor — runs hourly via cron
cd /home/serenity/workspace/openclaw
exec npx tsx src/project/executor.ts 2>&1 | tee -a /tmp/task-executor.log
