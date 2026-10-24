---
feature: work-item-task-attachments
date: 2026-10-21
status: accepted
decided_by: user
tags: [azure-devops, attachments, prompts]
---

# Download work item attachments for task prompts

## Context

Azure work items expose attachment names and URLs, but private Azure URLs can require a provider credential that the agent does not have. Adding URLs to the prompt would leave some attachments unreadable.

## Decision

Download each attachment through the main process and add its local path to the task prompt. When a download fails, continue task creation and identify the missing file in the prompt and a toast.

## Consequences

Task submission waits for downloads, uses project temp storage, and must clean up files if creation fails. A failed file remains unavailable to the agent, but other work item context and attachments are preserved.
