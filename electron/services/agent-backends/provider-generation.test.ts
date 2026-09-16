import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('restricted claude-code generation toolset', () => {
  const options: Array<Record<string, unknown>> = [];

  async function generateWith(
    input: Partial<Parameters<
      (typeof import('./provider-generation'))['claudeCodeStructuredGenerationCapability']['generate']
    >[0]> = {},
  ) {
    const { claudeCodeStructuredGenerationCapability } = await import(
      './provider-generation'
    );
    return claudeCodeStructuredGenerationCapability.generate({
      model: 'haiku',
      prompt: 'summarize',
      cwd: '/tmp',
      outputSchema: { type: 'object' },
      abortController: new AbortController(),
      ...input,
    });
  }

  beforeEach(() => {
    options.length = 0;
    vi.resetModules();
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (input: { options: Record<string, unknown> }) => {
        options.push(input.options);
        return (async function* () {
          yield { type: 'result', structured_output: { summary: 'ok' } };
        })();
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    vi.resetModules();
  });

  it('limits the toolset to the allowed tools and denies subagent tools', async () => {
    const result = await generateWith({
      allowedTools: ['Read', 'Glob', 'Grep'],
    });

    expect(result.output).toEqual({ summary: 'ok' });
    expect(options[0].tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(options[0].disallowedTools).toEqual(
      expect.arrayContaining(['Task', 'Agent', 'AskUserQuestion']),
    );
  });

  it('keeps the Skill tool available when a skill drives the generation', async () => {
    await generateWith({ allowedTools: ['Read'], skillName: 'my-skill' });

    expect(options[0].tools).toEqual(['Read', 'Skill']);
    expect(options[0].allowedTools).toEqual(['Read', 'Skill(my-skill)']);
  });

  it('disables every built-in tool when no tools are allowed', async () => {
    await generateWith({ allowedTools: [] });

    expect(options[0].tools).toEqual([]);
  });

  it('does not constrain the toolset when the caller allows everything', async () => {
    await generateWith({});

    expect(options[0].tools).toBeUndefined();
    expect(options[0].disallowedTools).toBeUndefined();
  });
});
