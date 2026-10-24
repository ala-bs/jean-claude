# Work item attachments in task prompts

Tasks created from Azure DevOps work items include the selected items' text, embedded images, and files attached through Azure `AttachedFile` relations. Before submitting the task, the app downloads each related file with the configured provider credential and adds its local path to the prompt's `<attached_files>` block. This works in the main new task overlay and the legacy project task screen.

The main process accepts only HTTPS Azure attachment URLs in the provider's organization, checks authenticated redirects, and stores up to 50 MB per file under the project's `.jean-claude/tmp` directory. Each download has a 60 second timeout. The agent receives file paths, not the provider credential.

## Edge cases

- A failed attachment does not block task creation. The task prompt and an error toast name the missing file.
- Failed task creation removes the files downloaded for that attempt. Files for a created task remain available to its agent.
- The task creation controls show preparation progress and prevent repeated submissions while downloads are in flight.

## Key files

- `electron/services/work-item-attachment-download-service.ts` — authenticated, bounded download and local storage.
- `electron/services/azure-image-proxy-service.ts` — credential handling and redirect validation.
- `src/lib/work-item-prompt-attachments.ts` — collects files and per-item failures.
- `src/features/new-task/ui-new-task-overlay/index.tsx` — main creation flow.
- `src/routes/projects/$projectId/tasks/new.tsx` — legacy creation flow.
