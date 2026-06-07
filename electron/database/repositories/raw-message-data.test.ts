import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  decodeRawMessageData,
  encodeRawMessageData,
  RAW_MESSAGE_ENCODING_GZIP_JSON,
} from './raw-message-data';

describe('raw message data encoding', () => {
  it('compresses repetitive raw JSON and decodes it', () => {
    const rawData = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'text',
          text: 'OpenCode raw payload '.repeat(500),
        },
      },
    };

    const encoded = encodeRawMessageData(rawData);

    expect(encoded.rawData).toBe('');
    expect(encoded.rawDataEncoding).toBe(RAW_MESSAGE_ENCODING_GZIP_JSON);
    expect(encoded.rawDataBlob).toBeInstanceOf(Buffer);
    expect(decodeRawMessageData(encoded)).toBe(JSON.stringify(rawData));
  });

  it('keeps tiny raw JSON plain when gzip is larger', () => {
    const rawData = { type: 'session.idle' };

    const encoded = encodeRawMessageData(rawData);

    expect(encoded.rawData).toBe(JSON.stringify(rawData));
    expect(encoded.rawDataEncoding).toBeNull();
    expect(encoded.rawDataBlob).toBeNull();
    expect(decodeRawMessageData(encoded)).toBe(JSON.stringify(rawData));
  });

  it('keeps marginally smaller gzip plain after encoding overhead', () => {
    const rawData = 'a'.repeat(50);

    const encoded = encodeRawMessageData(rawData);

    expect(encoded.rawData).toBe(JSON.stringify(rawData));
    expect(encoded.rawDataEncoding).toBeNull();
    expect(encoded.rawDataBlob).toBeNull();
  });

  it('throws when compressed rows are missing blob data', () => {
    expect(() =>
      decodeRawMessageData({
        rawData: '',
        rawDataBlob: null,
        rawDataEncoding: RAW_MESSAGE_ENCODING_GZIP_JSON,
      }),
    ).toThrow('Compressed raw message is missing rawDataBlob');
  });
});
