import { describe, expect, it } from 'vitest';

import {
  decodeLocalImageUrl,
  encodeLocalImageUrl,
} from './local-image-protocol-service';

describe('local image protocol service', () => {
  it('round-trips image paths without exposing raw file paths in the URL', () => {
    const filePath = '/Users/test/project logos/My Logo.png';

    const url = encodeLocalImageUrl(filePath);

    expect(url).toMatch(/^jc-local-image:\/\/image\//);
    expect(url).not.toContain(filePath);
    expect(decodeLocalImageUrl(url ?? '')).toBe(filePath);
  });

  it('rejects non-image paths', () => {
    expect(encodeLocalImageUrl('/Users/test/secrets.txt')).toBeNull();
  });
});
