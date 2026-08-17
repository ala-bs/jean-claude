import { describe, expect, it } from 'vitest';

import { redactAgentMemoryValue } from './agent-memory-redaction';

describe('agent memory redaction', () => {
  it('recursively redacts supported secret forms and reports marker paths', () => {
    const result = redactAgentMemoryValue({
      authorization: 'Bearer bearer-secret-value',
      nested: {
        assignment: 'api_key = assignment-secret',
        quotedAssignment: 'password="two word secret"',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----',
        url: 'https://alice:password123@example.com/private',
      },
      tokens: [
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
        'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
        'glpat-abcdefghijklmnopqrstuvwxyz123456',
        'sk_live_abcdefghijklmnopqrstuvwxyz123456',
      ],
    });

    expect(JSON.stringify(result.value)).not.toContain('bearer-secret-value');
    expect(JSON.stringify(result.value)).not.toContain('assignment-secret');
    expect(JSON.stringify(result.value)).not.toContain('two word secret');
    expect(JSON.stringify(result.value)).not.toContain('private-key-secret');
    expect(JSON.stringify(result.value)).not.toContain('password123');
    expect(JSON.stringify(result.value)).not.toContain('sk-ant-api03');
    expect(JSON.stringify(result.value)).not.toContain('github_pat_');
    expect(JSON.stringify(result.value)).not.toContain('glpat-');
    expect(JSON.stringify(result.value)).not.toContain('sk_live_');
    expect(result.markers).toEqual(
      expect.arrayContaining([
        { path: '$.authorization', kind: 'bearer-token', count: 1 },
        {
          path: '$.nested.assignment',
          kind: 'credential-assignment',
          count: 1,
        },
        {
          path: '$.nested.quotedAssignment',
          kind: 'credential-assignment',
          count: 1,
        },
        { path: '$.nested.privateKey', kind: 'private-key', count: 1 },
        { path: '$.nested.url', kind: 'credential-url', count: 1 },
        { path: '$.tokens[0]', kind: 'provider-token', count: 1 },
        { path: '$.tokens[1]', kind: 'provider-token', count: 1 },
        { path: '$.tokens[2]', kind: 'provider-token', count: 1 },
        { path: '$.tokens[3]', kind: 'provider-token', count: 1 },
      ]),
    );
  });

  it('aggregates matches by path and kind without retaining original secrets', () => {
    const result = redactAgentMemoryValue(
      'Bearer first-secret and Bearer second-secret',
    );

    expect(result.value).toBe(
      '[REDACTED:bearer-token] and [REDACTED:bearer-token]',
    );
    expect(result.markers).toEqual([
      { path: '$', kind: 'bearer-token', count: 2 },
    ]);
    expect(JSON.stringify(result.markers)).not.toContain('first-secret');
    expect(JSON.stringify(result.markers)).not.toContain('second-secret');
  });

  it('redacts JSON assignments, provider assignments, and npm tokens', () => {
    const secrets = {
      json: 'json-secret-value',
      aws: 'aws-secret-value',
      npm: 'npm_abcdefghijklmnopqrstuvwxyz1234567890',
    };
    const result = redactAgentMemoryValue({
      json: `{"api_key": "${secrets.json}"}`,
      escapedJson: '{"api_key":"part-one\\"part-two"}',
      environment: `AWS_SECRET_ACCESS_KEY=${secrets.aws}`,
      token: secrets.npm,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secrets.json);
    expect(serialized).not.toContain('part-two');
    expect(serialized).not.toContain(secrets.aws);
    expect(serialized).not.toContain(secrets.npm);
    expect(result.markers).toEqual([
      { path: '$.json', kind: 'credential-assignment', count: 1 },
      {
        path: '$.escapedJson',
        kind: 'credential-assignment',
        count: 1,
      },
      {
        path: '$.environment',
        kind: 'credential-assignment',
        count: 1,
      },
      { path: '$.token', kind: 'provider-token', count: 1 },
    ]);
  });

  it('preserves non-string values, null, and object shape', () => {
    const input = { count: 2, enabled: true, missing: null };
    expect(redactAgentMemoryValue(input)).toEqual({ value: input, markers: [] });
  });

  it('redacts standalone JWTs and Azure DevOps PATs without leaking markers', () => {
    const jwt =
      `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'a'.repeat(43)}`;
    const azurePat = `${'A'.repeat(75)}AZDO${'B'.repeat(5)}`;
    const legacyAzurePat = 'C'.repeat(52);
    const result = redactAgentMemoryValue({ jwt, azurePat, legacyAzurePat });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(azurePat);
    expect(serialized).not.toContain(legacyAzurePat);
    expect(result.markers).toEqual([
      { path: '$.jwt', kind: 'jwt', count: 1 },
      { path: '$.azurePat', kind: 'azure-devops-pat', count: 1 },
      { path: '$.legacyAzurePat', kind: 'azure-devops-pat', count: 1 },
    ]);
  });

  it('uses token boundaries and preserves JWT/PAT lookalikes', () => {
    const jwt =
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'a'.repeat(43)}`;
    const azurePat = `${'A'.repeat(75)}AZDO${'B'.repeat(5)}`;
    const lookalikes = [
      `prefix${jwt}`,
      `${jwt}suffix`,
      'package.namespace.member',
      `${'A'.repeat(74)}AZDO${'B'.repeat(5)}`,
      `${'A'.repeat(75)}AZDX${'B'.repeat(5)}`,
      `${azurePat}C`,
      'C'.repeat(51),
      'C'.repeat(53),
      `prefix${'C'.repeat(52)}`,
    ];

    expect(redactAgentMemoryValue(lookalikes)).toEqual({
      value: lookalikes,
      markers: [],
    });
  });
});
