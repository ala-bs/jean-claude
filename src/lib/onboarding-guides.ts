import type { OverlayType } from '@/stores/overlays';

export type GuideAction = {
  label: string;
  type: 'route' | 'overlay';
  target: string;
};

export type GuideCard = {
  id: string;
  version: number;
  title: string;
  summary: string;
  body: string;
  featureTag: 'start' | 'tasks' | 'review' | 'settings' | 'power' | 'updates';
  audience: 'new' | 'active' | 'power';
  action?: GuideAction;
};

export const guideCards: GuideCard[] = [
  {
    id: 'setup-wizard',
    version: 1,
    title: 'Run guided setup',
    summary: 'Add project, choose backend, and start a first task in order.',
    body: 'Use this when you want the shortest path through first-run setup without learning every Jean-Claude feature at once.',
    featureTag: 'start',
    audience: 'new',
    action: {
      label: 'Open setup wizard',
      type: 'route',
      target: '/onboarding/setup',
    },
  },
  {
    id: 'start-project-backend',
    version: 1,
    title: 'Set up one project and one agent',
    summary:
      'Fastest path to value: add a repo, choose backend, stay in plan mode.',
    body: 'Projects keep tasks, permissions, worktrees, and defaults together. Pick one coding backend first; defaults are fine until you know what you want to tune.',
    featureTag: 'start',
    audience: 'new',
    action: { label: 'Add project', type: 'route', target: '/projects/new' },
  },
  {
    id: 'first-task',
    version: 1,
    title: 'Create your first task',
    summary: 'Describe outcome, attach context, run agent from Cmd+N.',
    body: 'Start with a narrow prompt such as "summarize this repo" or "fix failing test". Use worktrees when you want agent changes isolated from your main checkout.',
    featureTag: 'tasks',
    audience: 'new',
    action: { label: 'New task', type: 'overlay', target: 'new-task' },
  },
  {
    id: 'read-agent-run',
    version: 1,
    title: 'Read an agent run',
    summary:
      'Messages explain intent. Tool cards show files, commands, and edits.',
    body: 'If agent needs approval, permission bar appears inline. You can allow once, for session, for project, or globally. If agent is running, follow-up prompts queue safely.',
    featureTag: 'tasks',
    audience: 'new',
  },
  {
    id: 'review-loop',
    version: 1,
    title: 'Review before shipping',
    summary: 'Open changed files, leave comments, send comments back to agent.',
    body: 'Review view is where Jean-Claude becomes collaborative: inspect diffs, select lines, leave feedback, then send review comments back as context for another pass.',
    featureTag: 'review',
    audience: 'active',
  },
  {
    id: 'feature-maps',
    version: 1,
    title: 'Use feature maps for better context',
    summary:
      'Generate a project feature tree, then reference features in prompts.',
    body: 'Feature maps make large repos easier for agents. After generation, use #Feature Name in prompts instead of manually pasting project context.',
    featureTag: 'power',
    audience: 'active',
  },
  {
    id: 'stay-current',
    version: 1,
    title: "Stay current with What's New",
    summary:
      'Jean-Claude changes often. Changelog teaches new features as they land.',
    body: "Use What's New when it opens after updates, or return from header menu. New feature entries should explain why they matter and where to try them.",
    featureTag: 'updates',
    audience: 'active',
    action: { label: 'Open changelog', type: 'overlay', target: 'changelog' },
  },
];

export function isOverlayTarget(target: string): target is OverlayType {
  return [
    'new-task',
    'command-palette',
    'project-switcher',
    'keyboard-help',
    'activity-center',
    'settings',
    'backlog',
    'pipelines',
    'running-commands',
    'calendar',
    'usage',
    'learning-center',
  ].includes(target);
}
