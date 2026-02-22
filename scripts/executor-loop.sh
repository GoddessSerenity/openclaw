#!/bin/bash
# Task executor loop — runs executor every hour
# Managed by task_runner as a persistent background task
cd /home/serenity/workspace/openclaw

while true; do
  echo "$(date -Iseconds) [executor-loop] Running executor..."
  npx tsx src/project/executor.ts 2>&1
  echo "$(date -Iseconds) [executor-loop] Sleeping 60 minutes..."
  sleep 3600
done
