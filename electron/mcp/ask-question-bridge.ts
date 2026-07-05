import { z } from 'zod';

const QUESTION_OPTION_SCHEMA = z
  .object({
    id: z
      .string()
      .min(1)
      .refine((id) => id === id.trim(), {
        message: 'Option id must not contain leading or trailing whitespace',
      })
      .optional(),
    label: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

const QUESTION_BASE_SCHEMA = {
  id: z
    .string()
    .min(1)
    .refine((id) => id === id.trim(), {
      message: 'Question id must not contain leading or trailing whitespace',
    }),
  label: z.string().refine((label) => label.trim().length > 0, {
    message: 'Question label is required',
  }),
  header: z.string().optional(),
  required: z.boolean().optional(),
};

const CHOICE_QUESTION_SCHEMA = z
  .object({
    ...QUESTION_BASE_SCHEMA,
    type: z.enum(['single_choice', 'multi_choice']),
    options: z.array(QUESTION_OPTION_SCHEMA).optional(),
  })
  .strict();

const TEXT_QUESTION_SCHEMA = z
  .object({
    ...QUESTION_BASE_SCHEMA,
    type: z.literal('text'),
    options: z.array(QUESTION_OPTION_SCHEMA).optional(),
  })
  .strict();

const QUESTION_SCHEMA = z.discriminatedUnion('type', [
  CHOICE_QUESTION_SCHEMA,
  TEXT_QUESTION_SCHEMA,
]);

export const ASK_QUESTION_TOOL_SCHEMA = {
  stepId: z
    .string()
    .min(1)
    .describe(
      'Task step id. Optional when the Jean-Claude bridge can infer a single active route; required when multiple app-scoped routes are active.',
    )
    .optional(),
  questions: z
    .array(QUESTION_SCHEMA)
    .min(1)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.id)).size ===
        questions.length,
      {
        message: 'Question ids must be unique',
      },
    )
    .describe('Questions to ask the user'),
};

const ASK_QUESTION_INPUT_SCHEMA = z.object(ASK_QUESTION_TOOL_SCHEMA).strict();
const ASK_QUESTION_RESPONSE_SCHEMA = z.union([
  z.object({ summary: z.string() }),
  z.object({ requestId: z.string().min(1) }),
]);
const QUESTION_RESULT_RESPONSE_SCHEMA = z.object({ summary: z.string() });
const QUESTION_BRIDGE_CONFIG_SCHEMA = z
  .object({
    serverUrl: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    stepId: z.string().min(1).optional(),
    registrationId: z.string().min(1).optional(),
    token: z.string().min(1),
  })
  .strict();

export type AskQuestionInput = z.infer<typeof ASK_QUESTION_INPUT_SCHEMA>;

export class AskQuestionBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskQuestionBridgeError';
  }
}

export async function askQuestionViaBridge({
  input,
  env = process.env,
  fetchImpl = fetch,
  pollIntervalMs = 1000,
}: {
  input: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}): Promise<string> {
  const parsedInput = ASK_QUESTION_INPUT_SCHEMA.safeParse(input);
  if (!parsedInput.success) {
    throw new AskQuestionBridgeError(
      `Invalid ask_question input: ${z.prettifyError(parsedInput.error)}`,
    );
  }

  const { serverUrl, sessionId, stepId, registrationId, token } =
    await loadQuestionBridgeConfig(env);
  const routedStepId = parsedInput.data.stepId ?? stepId;

  let url: URL;
  try {
    url = new URL(
      'ask-question',
      serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`,
    );
  } catch {
    throw new AskQuestionBridgeError('Invalid JC_MCP_BRIDGE_URL');
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(sessionId
          ? { sessionId }
          : {
              ...(routedStepId ? { stepId: routedStepId } : {}),
              ...(registrationId ? { registrationId } : {}),
            }),
        questions: parsedInput.data.questions,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AskQuestionBridgeError(`Question bridge request failed: ${message}`);
  }

  if (!response.ok) {
    const body = await readFailureBody(response);
    throw new AskQuestionBridgeError(
      `Question bridge returned ${response.status}${body ? `: ${body}` : ''}`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new AskQuestionBridgeError('Question bridge returned malformed JSON');
  }

  const parsedResponse = ASK_QUESTION_RESPONSE_SCHEMA.safeParse(json);
  if (!parsedResponse.success) {
    throw new AskQuestionBridgeError(
      `Question bridge returned malformed response: ${z.prettifyError(parsedResponse.error)}`,
    );
  }

  if ('summary' in parsedResponse.data) {
    return parsedResponse.data.summary;
  }

  return pollQuestionResult({
    serverUrl,
    token,
    requestId: parsedResponse.data.requestId,
    fetchImpl,
    pollIntervalMs,
  });
}

async function pollQuestionResult({
  serverUrl,
  token,
  requestId,
  fetchImpl,
  pollIntervalMs,
}: {
  serverUrl: string;
  token: string;
  requestId: string;
  fetchImpl: typeof fetch;
  pollIntervalMs: number;
}): Promise<string> {
  let url: URL;
  try {
    url = new URL(
      'question-result',
      serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`,
    );
  } catch {
    throw new AskQuestionBridgeError('Invalid JC_MCP_BRIDGE_URL');
  }

  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AskQuestionBridgeError(
        `Question bridge result request failed: ${message}`,
      );
    }

    if (response.status === 202) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (!response.ok) {
      const body = await readFailureBody(response);
      throw new AskQuestionBridgeError(
        `Question bridge returned ${response.status}${body ? `: ${body}` : ''}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new AskQuestionBridgeError('Question bridge returned malformed JSON');
    }

    const parsedResponse = QUESTION_RESULT_RESPONSE_SCHEMA.safeParse(json);
    if (!parsedResponse.success) {
      throw new AskQuestionBridgeError(
        `Question bridge returned malformed response: ${z.prettifyError(parsedResponse.error)}`,
      );
    }

    return parsedResponse.data.summary;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadQuestionBridgeConfig(
  env: NodeJS.ProcessEnv,
): Promise<{
  serverUrl: string;
  sessionId?: string;
  stepId?: string;
  registrationId?: string;
  token: string;
}> {
  const parsedConfig = QUESTION_BRIDGE_CONFIG_SCHEMA.safeParse({
    serverUrl: env.JC_MCP_BRIDGE_URL?.trim(),
    sessionId: env.JC_MCP_SESSION_ID?.trim() || undefined,
    stepId: env.JC_MCP_STEP_ID?.trim() || undefined,
    registrationId: env.JC_MCP_REGISTRATION_ID?.trim() || undefined,
    token: env.JC_MCP_AUTH_TOKEN?.trim(),
  });
  if (!parsedConfig.success) {
    throw new AskQuestionBridgeError(
      `Missing question bridge environment: ${z.prettifyError(parsedConfig.error)}`,
    );
  }

  return parsedConfig.data;
}

async function readFailureBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}
