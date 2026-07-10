import { nanoid } from 'nanoid';

import type {
  AgentBackend,
  AgentBackendType,
  AgentTaskContext,
} from '@shared/agent-backend-types';
import {
  type AgentBackendCapabilities,
  type AgentBackendProvider,
  type AgentRunHandle,
  type BackendAgentCapability,
  type BackendConfigCapability,
  type BackendSkillCapability,
  type Capability,
  type McpCapability,
  type ModelDiscoveryCapability,
  type PermissionCapability,
  type PromptInputCapability,
  type QuestionCapability,
  type ResourceTrackingCapability,
  type ResumeSessionCapability,
  type RunAgentCapability,
  type RuntimeModeSwitchCapability,
  type SessionAllowedToolsCapability,
  type SlashCommandCapability,
  UnsupportedBackendCapabilityError,
} from '@shared/agent-backend-provider-types';
import { getAgentBackendBadge } from '@shared/agent-backend-metadata';

import { createGenerationCapabilities } from './provider-generation';

type AgentBackendClass = new (context: AgentTaskContext) => AgentBackend;
type LoadAgentBackendClass = () => Promise<AgentBackendClass>;

type RunBinding = {
  backend: AgentBackend;
  backendType: AgentBackendType;
  adapterSessionId: string;
};

const runBindings = new WeakMap<AgentRunHandle, RunBinding>();

function supported<Implementation>(
  implementation: Implementation,
): Capability<Implementation> {
  return { supported: true, implementation };
}

function unsupported<Implementation>(
  reason: string,
): Capability<Implementation> {
  return { supported: false, reason };
}

function getRunBinding({
  handle,
  backend,
  capability,
}: {
  handle: AgentRunHandle;
  backend: AgentBackendType;
  capability: string;
}): RunBinding {
  const binding = runBindings.get(handle);
  if (!binding || binding.backendType !== backend) {
    throw new UnsupportedBackendCapabilityError({
      backend,
      capability,
      reason: 'run handle was not created by this backend provider',
    });
  }

  return binding;
}

export function createRunCapability({
  backendType,
  loadBackendClass,
}: {
  backendType: AgentBackendType;
  loadBackendClass: LoadAgentBackendClass;
}): RunAgentCapability {
  return {
    async start(input) {
      const BackendClass = await loadBackendClass();
      const backend = new BackendClass(input.context);
      let session: Awaited<ReturnType<AgentBackend['start']>>;
      try {
        session = await backend.start(input.config, input.parts);
      } catch (error) {
        await backend.dispose().catch(() => {});
        throw error;
      }
      let stopPromise: Promise<void> | null = null;
      let disposePromise: Promise<void> | null = null;
      const handle: AgentRunHandle = {
        runId: nanoid(),
        events: session.events,
        rootPid: session.rootPid,
        stop: () => {
          stopPromise ??= backend.stop(session.sessionId);
          return stopPromise;
        },
        dispose: () => {
          disposePromise ??= backend.dispose();
          return disposePromise;
        },
      };

      runBindings.set(handle, {
        backend,
        backendType,
        adapterSessionId: session.sessionId,
      });

      return handle;
    },
  };
}

function createPermissionCapability(
  backend: AgentBackendType,
): PermissionCapability {
  return {
    async respond({ handle, requestId, response }) {
      const binding = getRunBinding({
        handle,
        backend,
        capability: 'agent.permissions',
      });
      await binding.backend.respondToPermission(
        binding.adapterSessionId,
        requestId,
        response,
      );
    },
  };
}

function createQuestionCapability(backend: AgentBackendType): QuestionCapability {
  return {
    async respond({ handle, requestId, answer, metadata }) {
      const binding = getRunBinding({
        handle,
        backend,
        capability: 'agent.questions',
      });
      await binding.backend.respondToQuestion(
        binding.adapterSessionId,
        requestId,
        answer,
        metadata,
      );
    },
  };
}

function createRuntimeModeSwitchCapability(
  backend: AgentBackendType,
): RuntimeModeSwitchCapability {
  return {
    async setMode({ handle, mode }) {
      const binding = getRunBinding({
        handle,
        backend,
        capability: 'agent.runtimeModeSwitch',
      });
      await binding.backend.setMode(binding.adapterSessionId, mode);
    },
  };
}

function createSessionAllowedToolsCapability(
  backend: AgentBackendType,
): SessionAllowedToolsCapability {
  return {
    list({ handle }) {
      const binding = getRunBinding({
        handle,
        backend,
        capability: 'agent.sessionAllowedTools',
      });
      return binding.backend.getSessionAllowedTools?.(
        binding.adapterSessionId,
      ) ?? [];
    },
  };
}

const resourceTrackingCapability: ResourceTrackingCapability = {
  getRootPid: ({ handle }) => handle.rootPid ?? null,
};

function createConfigurationCapabilities(): AgentBackendCapabilities['configuration'] {
  return {
    models: unsupported<ModelDiscoveryCapability>(
      'model discovery is still handled by legacy services',
    ),
    nativeConfig: unsupported<BackendConfigCapability>(
      'native backend configuration is still handled by legacy services',
    ),
  };
}

function createResourcesCapabilities(): AgentBackendCapabilities['resources'] {
  return {
    skills: unsupported<BackendSkillCapability>(
      'backend skill discovery is still handled by legacy services',
    ),
    agents: unsupported<BackendAgentCapability>(
      'backend agent discovery is still handled by legacy services',
    ),
    slashCommands: unsupported<SlashCommandCapability>(
      'slash command discovery is still handled by legacy services',
    ),
    mcp: unsupported<McpCapability>(
      'MCP resource discovery is still handled by legacy services',
    ),
  };
}

function createInputCapabilities(): AgentBackendCapabilities['input'] {
  return {
    text: unsupported<PromptInputCapability>(
      'text input is still passed through agent.run',
    ),
    images: unsupported<PromptInputCapability>(
      'image input is still passed through agent.run',
    ),
    files: unsupported<PromptInputCapability>(
      'file input is still passed through agent.run',
    ),
  };
}

function createCapabilities({
  backend,
  run,
  supportsPermissions,
  supportsQuestions,
  supportsRuntimeModeSwitch,
  supportsSessionAllowedTools,
}: {
  backend: AgentBackendType;
  run: RunAgentCapability;
  supportsPermissions: boolean;
  supportsQuestions: boolean;
  supportsRuntimeModeSwitch: boolean;
  supportsSessionAllowedTools: boolean;
}): AgentBackendCapabilities {
  return {
    agent: {
      run: supported(run),
      resume: supported<ResumeSessionCapability>(run),
      permissions: supportsPermissions
        ? supported(createPermissionCapability(backend))
        : unsupported<PermissionCapability>(
            'runtime permission responses are not integrated for this backend yet',
          ),
      questions: supportsQuestions
        ? supported(createQuestionCapability(backend))
        : unsupported<QuestionCapability>(
            'runtime question responses are not integrated for this backend yet',
          ),
      runtimeModeSwitch: supportsRuntimeModeSwitch
        ? supported(createRuntimeModeSwitchCapability(backend))
        : unsupported<RuntimeModeSwitchCapability>(
            'runtime mode switching is not supported by this backend',
          ),
      sessionAllowedTools: supportsSessionAllowedTools
        ? supported(createSessionAllowedToolsCapability(backend))
        : unsupported<SessionAllowedToolsCapability>(
            'session-allowed tool tracking is not supported by this backend',
          ),
      resourceTracking: supported(resourceTrackingCapability),
    },
    generation: createGenerationCapabilities(backend),
    configuration: createConfigurationCapabilities(),
    resources: createResourcesCapabilities(),
    input: createInputCapabilities(),
  };
}

export const claudeCodeProvider: AgentBackendProvider = {
  id: 'claude-code',
  label: 'Claude Code',
  badge: getAgentBackendBadge('claude-code'),
  capabilities: createCapabilities({
    backend: 'claude-code',
    run: createRunCapability({
      backendType: 'claude-code',
      loadBackendClass: async () =>
        (await import('./claude/claude-code-backend')).ClaudeCodeBackend,
    }),
    supportsPermissions: true,
    supportsQuestions: true,
    supportsRuntimeModeSwitch: true,
    supportsSessionAllowedTools: true,
  }),
};

export const openCodeProvider: AgentBackendProvider = {
  id: 'opencode',
  label: 'OpenCode',
  badge: getAgentBackendBadge('opencode'),
  capabilities: createCapabilities({
    backend: 'opencode',
    run: createRunCapability({
      backendType: 'opencode',
      loadBackendClass: async () =>
        (await import('./opencode/opencode-backend')).OpenCodeBackend,
    }),
    supportsPermissions: true,
    supportsQuestions: true,
    supportsRuntimeModeSwitch: false,
    supportsSessionAllowedTools: false,
  }),
};

export const codexProvider: AgentBackendProvider = {
  id: 'codex',
  label: 'Codex',
  badge: getAgentBackendBadge('codex'),
  capabilities: createCapabilities({
    backend: 'codex',
    run: createRunCapability({
      backendType: 'codex',
      loadBackendClass: async () =>
        (await import('./codex/codex-backend')).CodexBackend,
    }),
    supportsPermissions: false,
    supportsQuestions: false,
    supportsRuntimeModeSwitch: false,
    supportsSessionAllowedTools: false,
  }),
};

export const copilotProvider: AgentBackendProvider = {
  id: 'copilot',
  label: 'GitHub Copilot',
  badge: getAgentBackendBadge('copilot'),
  capabilities: createCapabilities({
    backend: 'copilot',
    run: createRunCapability({
      backendType: 'copilot',
      loadBackendClass: async () =>
        (await import('./copilot/copilot-backend')).CopilotBackend,
    }),
    supportsPermissions: true,
    supportsQuestions: true,
    supportsRuntimeModeSwitch: false,
    supportsSessionAllowedTools: true,
  }),
};

export const vibeProvider: AgentBackendProvider = {
  id: 'vibe',
  label: 'Mistral Vibe',
  badge: getAgentBackendBadge('vibe'),
  capabilities: createCapabilities({
    backend: 'vibe',
    run: createRunCapability({
      backendType: 'vibe',
      loadBackendClass: async () =>
        (await import('./vibe/vibe-backend')).VibeBackend,
    }),
    supportsPermissions: true,
    supportsQuestions: false,
    supportsRuntimeModeSwitch: true,
    supportsSessionAllowedTools: false,
  }),
};

export const AGENT_BACKEND_PROVIDERS: Record<
  AgentBackendType,
  AgentBackendProvider
> = {
  'claude-code': claudeCodeProvider,
  opencode: openCodeProvider,
  codex: codexProvider,
  copilot: copilotProvider,
  vibe: vibeProvider,
};

export function getAgentBackendProvider(
  type: AgentBackendType,
): AgentBackendProvider {
  return AGENT_BACKEND_PROVIDERS[type];
}
