import { describe, expect, it } from 'vitest';

import {
  sanitizeHar,
  sanitizeHeaders,
  sanitizePayload,
  sanitizeUrl,
  sanitizeWebSocketEvents,
} from './sanitize-capture.mjs';

describe('Eurecia capture sanitizer', () => {
  it('redacts credentials while preserving useful URL parameters', () => {
    expect(
      sanitizeUrl(
        'https://tenant.eurecia.com/api/time?id=42&token=secret-value&view=week',
      ),
    ).toBe(
      'https://tenant.eurecia.com/api/time?id=42&token=%5BREDACTED%5D&view=week',
    );
  });

  it('redacts OAuth and SAML credentials from query strings and fragments', () => {
    expect(
      sanitizeUrl(
        'https://tenant.eurecia.com/callback?code=oauth-code&SAMLResponse=assertion#access_token=fragment-token&view=week',
      ),
    ).toBe(
      'https://tenant.eurecia.com/callback?code=%5BREDACTED%5D&SAMLResponse=%5BREDACTED%5D#access_token=%5BREDACTED%5D&view=week',
    );
  });

  it('redacts opaque fragments and credentials in URL path segments', () => {
    expect(
      sanitizeUrl(
        'https://tenant.eurecia.com/session/opaque-secret/dashboard#opaque-fragment',
      ),
    ).toBe(
      'https://tenant.eurecia.com/session/[REDACTED]/dashboard#[REDACTED]',
    );
  });

  it('redacts sensitive headers', () => {
    expect(
      sanitizeHeaders([
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Cookie', value: 'session=secret' },
      ]),
    ).toEqual([
      { name: 'Authorization', value: '[REDACTED]' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: '[REDACTED]' },
    ]);
  });

  it('sanitizes credentials embedded in redirect and referrer headers', () => {
    expect(
      sanitizeHeaders([
        {
          name: 'Location',
          value: 'https://tenant.eurecia.com/callback?code=oauth-code',
        },
        {
          name: 'Referer',
          value: 'https://login.example.com/#access_token=secret',
        },
      ]),
    ).toEqual([
      {
        name: 'Location',
        value: 'https://tenant.eurecia.com/callback?code=%5BREDACTED%5D',
      },
      {
        name: 'Referer',
        value: 'https://login.example.com/#access_token=%5BREDACTED%5D',
      },
    ]);
  });

  it('keeps scalar samples but redacts sensitive JSON fields and emails', () => {
    expect(
      sanitizePayload(
        JSON.stringify({
          operation: 'SaveTimesheet',
          employeeId: 123,
          code: 'oauth-code',
          accessToken: 'secret',
          contact: 'person@example.com',
          nested: { duration: 420 },
        }),
        'application/json',
      ),
    ).toEqual({
      operation: 'SaveTimesheet',
      employeeId: 123,
      code: '[REDACTED]',
      accessToken: '[REDACTED]',
      contact: '[REDACTED_EMAIL]',
      nested: { duration: 420 },
    });
  });

  it('redacts credentials in unstructured form-like and XML payloads', () => {
    expect(
      sanitizePayload(
        'action=save&sessionId=opaque-secret&label=week',
        'text/plain',
      ),
    ).toBe('action=save&sessionId=[REDACTED]&label=week');
    expect(
      sanitizePayload(
        '<request><token>opaque-secret</token><action>save</action></request>',
        'application/xml',
      ),
    ).toBe(
      '<request><token>[REDACTED]</token><action>save</action></request>',
    );
  });

  it.each([
    ['text/html; charset=utf-8', '<input type="hidden" name="csrf" value="secret-csrf"><input type="hidden" name="idOfForm" value="secret-form">'],
    ['application/xhtml+xml', Buffer.from('<input name="csrf" value="base64-secret">').toString('base64')],
  ])('omits %s response bodies from sanitized reports', (mimeType, text) => {
    const report = sanitizeHar({
      log: {
        entries: [{ response: { content: { mimeType, text, encoding: mimeType.startsWith('application/') ? 'base64' : undefined } } }],
      },
    });

    expect(report.entries[0].response.content.payload).toBe('[HTML_BODY_OMITTED]');
    expect(JSON.stringify(report)).not.toMatch(/secret-csrf|secret-form|base64-secret|idOfForm/);
  });

  it('sanitizes JSON WebSocket frames and omits binary payloads', () => {
    expect(
      sanitizeWebSocketEvents([
        {
          type: 'frame-sent',
          url: 'wss://tenant.eurecia.com/socket?token=secret',
          payload: JSON.stringify({ action: 'subscribe', sessionId: 'secret' }),
        },
        {
          type: 'frame-received',
          url: 'wss://tenant.eurecia.com/socket',
          payloadBase64: 'AAEC',
        },
      ]),
    ).toEqual([
      {
        type: 'frame-sent',
        url: 'wss://tenant.eurecia.com/socket?token=%5BREDACTED%5D',
        payload: { action: 'subscribe', sessionId: '[REDACTED]' },
      },
      {
        type: 'frame-received',
        url: 'wss://tenant.eurecia.com/socket',
        payload: '[BINARY_PAYLOAD_OMITTED]',
      },
    ]);
  });
});
