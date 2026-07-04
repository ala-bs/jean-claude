# Jean-Claude Onboarding Designer Prompt

```text
Design first-run onboarding flow for Jean-Claude, an Electron desktop app for managing coding agents across projects.

Tone:
- Didactic, clear, calm
- Explain every concept in plain language
- Short steps, no jargon without explanation
- User should understand what each setting does and why it matters
- Desktop-first, responsive enough for narrow windows

Core teaching model:
Jean-Claude has three setup parts:
1. Agent backend: local command-line tool that runs coding sessions
2. Project: repo Jean-Claude manages with tasks, worktrees, permissions, and defaults
3. Integration: Azure DevOps/Git provider connection for repos, PRs, and work items

Recommended flow:
0. Environment check
1. Select agent backend(s)
2. Choose where code is hosted
3. Optional Azure DevOps setup
4. Add project
5. Configure branch safety
6. Run first task
7. Finish with summary and next actions

Step 0: Environment check
Purpose:
- Scan common prerequisites before user makes choices
- Surface missing tools early

Check:
- Git installed
- Backend CLIs found on PATH
- Existing backend/auth state if detectable
- Existing Azure DevOps connection if configured

Copy idea:
"Jean-Claude checks your local tools first so setup does not fail later. If you install tools during setup, restart Jean-Claude so it can see updated PATH."

Step 1: Select agent backend(s)
Explain:
"Agent backend is the local command-line tool Jean-Claude uses to run coding sessions. Pick one or more installed backends."

Backends:
- Claude Code
- OpenCode
- Codex

For each backend show:
- Installed / missing status
- Select checkbox if installed
- Install guidance if missing
- Auth/login hint
- Restart Jean-Claude note if user installs backend now, because PATH may not update until app restart

Button states:
- Found: selectable
- Missing: show install guide
- Found but auth unknown: show login hint
- Selected: enabled

Step 2: Choose where code is hosted
Options:
- Local repo on this machine
- Azure DevOps
- Skip project for now

Explain:
"This helps Jean-Claude choose the right project setup path. Local repos work without Azure. Azure lets Jean-Claude clone repos and work with pull requests and work items."

Step 3: Azure DevOps setup, optional and skippable
Explain:
"Azure DevOps is not an agent backend. It connects repos, pull requests, and work items."

Use Azure for:
- Clone repositories
- Create pull requests
- Link work items to PRs
- Read/update work item states

PAT guidance:
- Go to Azure DevOps > User settings > Personal access tokens
- Create new token
- Organization must be "All accessible organizations"
- Required permissions:
  - Code: Read & Write, for clone, branches, pull requests
  - Work Items: Read & Write, for search, link, and update work items
  - Project and Team: Read, for listing projects and repos
  - Identity/Profile: Read, for current user, reviewers, and mentions
- PAT is stored locally
- User can revoke PAT anytime in Azure DevOps

UX:
- Include Skip Azure button
- If skipped, reassure user they can connect later in Settings
- If connected, show organization/project/repo picker for project setup

Step 4: Add project
Options:
- Add local repo
- Clone from Azure DevOps if connected

Explain:
"Project is the repo Jean-Claude manages. It stores tasks, worktrees, permissions, and defaults."

Need:
- Repo path or clone target
- Project name
- Git remote metadata if available
- Azure repo link if connected

Step 5: Configure branch safety
Fields:
- Default branch
- Protected branch

Definitions:
"Default branch is preselected for new tasks. Jean-Claude creates task worktrees from this branch."

"Protected branch cannot receive direct task merges. Use this for main or release branches where changes should go through review."

Mention:
"It is normal for default branch and protected branch to both be main. Tasks can start from main, but cannot merge directly into main."

Defaults:
- Remote default branch if detected
- Else current branch

Warnings:
- If no git repo found, explain project requires git-backed repo for worktrees and diffs
- If branch detection fails, let user select manually

Step 6: Run first task
Explain:
"First task verifies backend, project, permissions, and worktree setup. It should be safe and low-risk."

Use plan mode by default.

Starter prompts:
- "Summarize this project and suggest one safe first improvement."
- "Find likely setup or test commands. Do not change files."
- "Review recent changes and flag risks. Do not change files."

Teach during first run:
- Messages explain agent intent
- Tool cards show commands, file reads, and edits
- Permission bar appears when approval is needed
- Follow-up prompts can refine or correct agent work

Step 7: Finish
Show summary:
- Enabled backend(s)
- Project added
- Default branch
- Protected branch
- Azure connected or skipped
- First task started or skipped

Next actions:
- Create task
- Open project
- Review settings
- Connect Azure later if skipped

UX requirements:
- Progress sidebar or stepper
- Required vs optional labels
- Skippable Azure step
- Inline help cards: What is this? Why care? Recommended choice
- Missing backend install guide with restart note
- Compact success summary at end
- Avoid blocking app use when optional setup is skipped
```
