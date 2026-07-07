# Vibe Skills Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Jean-Claude managed skill support for Mistral Vibe using Vibe's native `~/.vibe/skills` user directory and `.vibe/skills` project directory.

**Architecture:** Vibe already supports Agent Skills via `SKILL.md`, so Jean-Claude should integrate it through the existing skill-management symlink system. Managed user skills should symlink only into `~/.vibe/skills` for Vibe, not `~/.agents/skills`, so users can enable/disable Vibe independently from other Agent Skills consumers.

**Tech Stack:** Electron main process TypeScript, Node `fs/promises`, existing `skill-management-service`, React settings UI, Vitest.

---

### Task 1: Add Vibe Skill Path Config

**Files:**
- Modify: `electron/services/skill-management-service.ts`
- Test: `electron/services/skill-management-service.test.ts`

**Step 1: Write failing tests**

Add tests covering Vibe managed skill paths:

```ts
it('creates, disables, and enables Vibe user skills via ~/.vibe skills', async () => {
  const skill = await createUserSkill({
    name: 'native vibe user skill',
    description: 'Native Vibe user skill',
    content: 'Use this with Vibe.',
    enabledBackends: ['vibe'],
  });

  const symlinkPath = path.join(os.homedir(), '.vibe', 'skills', 'native-vibe-user-skill');
  await expect(fs.realpath(symlinkPath)).resolves.toBe(skill.skillPath);

  await disableSkill({ skillPath: skill.skillPath, backendType: 'vibe' });
  await expect(fs.lstat(symlinkPath)).rejects.toMatchObject({ code: 'ENOENT' });

  await enableSkill({ skillPath: skill.skillPath, backendType: 'vibe' });
  await expect(fs.realpath(symlinkPath)).resolves.toBe(skill.skillPath);
});

it('discovers Vibe project skills from .vibe skills only for Vibe', async () => {
  const projectPath = await makeTempProject();
  await writeSkill(projectPath, '.vibe/skills/project-vibe-skill', {
    name: 'project-vibe-skill',
    description: 'Project Vibe skill',
  });

  const skills = await getAllManagedSkills({ backendType: 'vibe', projectPath });

  expect(skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'project-vibe-skill',
        source: 'project',
        enabledBackends: { vibe: true },
      }),
    ]),
  );
});
```

**Step 2: Run tests to verify failure**

Run: `pnpm test electron/services/skill-management-service.test.ts`

Expected: fails because `getSkillPathConfig('vibe')` throws `Skill management is not implemented for vibe`.

**Step 3: Implement minimal path config**

Change `SupportedSkillBackendType` so it no longer excludes Vibe:

```ts
type SupportedSkillBackendType = AgentBackendType;
```

Add Vibe config:

```ts
vibe: {
  userSkillsDir: path.join(os.homedir(), '.vibe', 'skills'),
  projectSkillsDir: '.vibe/skills',
  projectSkillsDirs: ['.vibe/skills'],
},
```

Important: do not include `~/.agents/skills` as a managed user symlink target. Vibe discovers it upstream, but Jean-Claude should use `~/.vibe/skills` for granular backend enablement.

**Step 4: Run test to verify pass**

Run: `pnpm test electron/services/skill-management-service.test.ts`

Expected: passes.

---

### Task 2: Include Vibe in Unified Skill Enablement State

**Files:**
- Modify: `electron/services/skill-management-service.ts`
- Test: `electron/services/skill-management-service.test.ts`

**Step 1: Write failing test**

Add test that unified skill discovery reports Vibe state independently:

```ts
it('reports Vibe enabled state for JC-managed skills independently', async () => {
  const skill = await createUserSkill({
    name: 'multi backend skill',
    description: 'Multi backend skill',
    content: 'Shared body.',
    enabledBackends: ['opencode', 'vibe'],
  });

  await disableSkill({ skillPath: skill.skillPath, backendType: 'opencode' });

  const skills = await getAllManagedSkillsUnified({});
  expect(skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'multi backend skill',
        enabledBackends: expect.objectContaining({
          opencode: false,
          vibe: true,
        }),
      }),
    ]),
  );
});
```

**Step 2: Run test to verify failure**

Run: `pnpm test electron/services/skill-management-service.test.ts`

Expected: Vibe missing from `enabledBackends` until config participates in unified loops.

**Step 3: Implement**

No extra code should be needed if Task 1 made `SKILL_PATH_CONFIGS` include Vibe and all existing `Object.entries(SKILL_PATH_CONFIGS)` loops remain generic.

If any explicit backend arrays omit Vibe, update them to derive from `Object.keys(SKILL_PATH_CONFIGS)` or include `vibe`.

**Step 4: Run test**

Run: `pnpm test electron/services/skill-management-service.test.ts`

Expected: passes.

---

### Task 3: Enable Vibe for Skill Creation UI

**Files:**
- Modify: `src/features/settings/ui-skills-settings/create-with-agent-dialog.tsx`
- Test: existing TypeScript check

**Step 1: Update install target type**

Replace:

```ts
type GeneratedSkillInstallTargetBackend = Exclude<AgentBackendType, 'vibe'>;
```

with:

```ts
type GeneratedSkillInstallTargetBackend = AgentBackendType;
```

Add Vibe to `GENERATED_SKILL_INSTALL_TARGET_BACKENDS`:

```ts
const GENERATED_SKILL_INSTALL_TARGET_BACKENDS: GeneratedSkillInstallTargetBackend[] = [
  'claude-code',
  'opencode',
  'codex',
  'copilot',
  'vibe',
];
```

**Step 2: Run TypeScript**

Run: `pnpm ts-check`

Expected: passes. If not, update downstream API types to accept Vibe.

---

### Task 4: Update Vibe Backend Settings Copy

**Files:**
- Modify: `src/features/settings/ui-backend-config-settings/index.tsx`

**Step 1: Replace obsolete warning text**

Replace copy near Vibe setup that says Vibe does not expose Jean-Claude skill configuration.

Use:

```tsx
<p className="text-ink-3 mt-3 text-xs">
  Jean-Claude managed Vibe skills are symlinked into <code>~/.vibe/skills</code>.
  Project Vibe skills are discovered from <code>.vibe/skills</code>.
</p>
```

**Step 2: Run lint and TypeScript**

Run: `pnpm ts-check && pnpm lint`

Expected: passes.

---

### Task 5: Verify Skill Content Compatibility

**Files:**
- Test: `electron/services/skill-management-service.test.ts`
- Reference: `electron/lib/skill-frontmatter.ts`

**Step 1: Add compatibility test**

Add test proving Jean-Claude-generated `SKILL.md` contains Vibe-required fields:

```ts
it('writes Vibe-compatible SKILL.md frontmatter', async () => {
  const skill = await createUserSkill({
    name: 'vibe compatible skill',
    description: 'Works with Vibe',
    content: '# Instructions\nUse this skill.',
    enabledBackends: ['vibe'],
  });

  const content = await fs.readFile(path.join(skill.skillPath, 'SKILL.md'), 'utf-8');
  expect(content).toContain('name: vibe compatible skill');
  expect(content).toContain('description: Works with Vibe');
});
```

**Step 2: Run tests**

Run: `pnpm test electron/services/skill-management-service.test.ts`

Expected: passes.

Note: Vibe optional fields `user-invocable` and `allowed-tools` default safely upstream, so do not add new frontmatter unless product explicitly needs Vibe-only controls.

---

### Task 6: Full Verification

**Files:**
- No code changes.

**Step 1: Run targeted tests**

Run:

```bash
pnpm test electron/services/skill-management-service.test.ts
```

Expected: passes.

**Step 2: Run required repo verification**

Run:

```bash
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

Expected: all pass. Existing Node engine warning is acceptable in current environment: Node `v24.14.0` while repo wants `>=20.18.0 <21`.

---

## Notes And Risks

- Use `~/.vibe/skills` for Jean-Claude managed Vibe user skills. Do not symlink into `~/.agents/skills`; that path is shared across Agent Skills consumers and reduces per-backend granularity.
- Use `.vibe/skills` for Vibe project skill creation/discovery. Do not include `.agents/skills` in Jean-Claude's Vibe-managed project path unless product wants shared project Agent Skills later.
- Vibe ACP does not expose live skill config in `set_config_option`; users may need a new Vibe session to pick up newly enabled/disabled skills.
- Vibe also supports `skill_paths`, `enabled_skills`, and `disabled_skills` in `~/.vibe/config.toml`; this plan does not edit TOML because filesystem symlinks are enough for Jean-Claude's enable/disable model.
- Vibe slash-command skill invocation is upstream behavior: user-invocable skills appear as commands and `/skill args` becomes skill prompt content before the agent run.
