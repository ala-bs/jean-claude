import type { AgentMemoryRedactionMarker } from '@shared/agent-memory-types';

type RedactionKind = AgentMemoryRedactionMarker['kind'];

const PRIVATE_KEY_PATTERN =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g;
const CREDENTIAL_URL_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /((?:["']?)(?:(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|secret[_-]?access[_-]?key|client[_-]?secret))(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&,;]+)/gi;
const PROVIDER_TOKEN_PATTERN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g;
// The legacy 52-char form is base32, so it is restricted to the base32 alphabet
// (a-z / A-Z plus 2-7) rather than `[A-Za-z0-9]{52}`. The looser form matched
// ANY 52-character alphanumeric run — hashes, ids, base64 fragments — which
// both over-redacts real content and, now that object keys are redacted too,
// could rewrite a legitimate map key.
const AZURE_DEVOPS_PAT_PATTERN =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{75}AZDO[A-Za-z0-9]{5}|[a-z2-7]{52}|[A-Z2-7]{52})(?![A-Za-z0-9])/g;

function isJwt(value: string): boolean {
  try {
    const [encodedHeader, encodedPayload, signature] = value.split('.');
    const header = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as unknown;
    JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!(
      !!header &&
      typeof header === 'object' &&
      ('alg' in header || 'typ' in header)
    )) return false;
    const algorithm = 'alg' in header ? header.alg : undefined;
    const expectedSignatureLengths: Record<string, number[]> = {
      HS256: [43],
      HS384: [64],
      HS512: [86],
      ES256: [86],
      ES384: [128],
      ES512: [176],
    };
    return typeof algorithm === 'string' && expectedSignatureLengths[algorithm]
      ? expectedSignatureLengths[algorithm].includes(signature.length)
      : signature.length >= 20;
  } catch {
    return false;
  }
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function redactString({
  value,
  path,
  counts,
}: {
  value: string;
  path: string;
  counts: Map<string, AgentMemoryRedactionMarker>;
}): string {
  function record(kind: RedactionKind, count = 1): void {
    const key = `${path}\0${kind}`;
    const current = counts.get(key);
    counts.set(key, { path, kind, count: (current?.count ?? 0) + count });
  }

  let redacted = value.replace(PRIVATE_KEY_PATTERN, () => {
    record('private-key');
    return '[REDACTED:private-key]';
  });
  redacted = redacted.replace(
    CREDENTIAL_URL_PATTERN,
    (_match, scheme: string) => {
      record('credential-url');
      return `${scheme}[REDACTED:credential-url]@`;
    },
  );
  redacted = redacted.replace(BEARER_TOKEN_PATTERN, () => {
    record('bearer-token');
    return '[REDACTED:bearer-token]';
  });
  redacted = redacted.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    (match, prefix: string) => {
      record('credential-assignment');
      const assignedValue = match.slice(prefix.length);
      const quote = assignedValue.startsWith('"')
        ? '"'
        : assignedValue.startsWith("'")
          ? "'"
          : '';
      return `${prefix}${quote}[REDACTED:credential-assignment]${quote}`;
    },
  );
  redacted = redacted.replace(PROVIDER_TOKEN_PATTERN, () => {
    record('provider-token');
    return '[REDACTED:provider-token]';
  });
  redacted = redacted.replace(JWT_PATTERN, (match, token: string) => {
    if (!isJwt(token)) return match;
    record('jwt');
    return '[REDACTED:jwt]';
  });
  return redacted.replace(AZURE_DEVOPS_PAT_PATTERN, () => {
    record('azure-devops-pat');
    return '[REDACTED:azure-devops-pat]';
  });
}

export function redactAgentMemoryValue<T>(value: T): {
  value: T;
  markers: AgentMemoryRedactionMarker[];
} {
  const counts = new Map<string, AgentMemoryRedactionMarker>();

  function visit(current: unknown, currentPath: string): unknown {
    if (typeof current === 'string') {
      return redactString({ value: current, path: currentPath, counts });
    }
    if (Array.isArray(current)) {
      return current.map((entry, index) =>
        visit(entry, childPath(currentPath, index)),
      );
    }
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [
          // Keys can carry secrets too — a record keyed by a token would
          // otherwise survive redaction untouched.
          redactString({ value: key, path: childPath(currentPath, key), counts }),
          visit(entry, childPath(currentPath, key)),
        ]),
      );
    }
    return current;
  }

  return {
    value: visit(value, '$') as T,
    markers: [...counts.values()],
  };
}

export function redactAgentMemoryText(value: string): {
  value: string;
  markers: AgentMemoryRedactionMarker[];
} {
  return redactAgentMemoryValue(value);
}
