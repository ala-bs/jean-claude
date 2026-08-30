import { describe, expect, it } from 'vitest';

import { getLanAddress, pickLanAddress } from './mobile-preview-lan-address';

type Info = { address: string; family: string | number; internal: boolean };

function ipv4(address: string, internal = false): Info {
  return { address, family: 'IPv4', internal };
}

function ipv6(address: string, internal = false): Info {
  return { address, family: 'IPv6', internal };
}

describe('pickLanAddress', () => {
  it('returns null for an empty interface table', () => {
    expect(pickLanAddress({})).toBeNull();
  });

  it('returns null when only loopback exists', () => {
    expect(
      pickLanAddress({
        lo0: [ipv4('127.0.0.1', true), ipv6('::1', true)],
      }),
    ).toBeNull();
  });

  it('returns null when only link-local addresses exist', () => {
    expect(pickLanAddress({ en0: [ipv4('169.254.12.9')] })).toBeNull();
  });

  it('ignores IPv6 addresses', () => {
    expect(
      pickLanAddress({ en0: [ipv6('fe80::1'), ipv6('2001:db8::1')] }),
    ).toBeNull();
  });

  it('picks the single routable IPv4 address', () => {
    expect(
      pickLanAddress({
        lo0: [ipv4('127.0.0.1', true)],
        en0: [ipv6('fe80::1'), ipv4('192.168.1.24')],
      }),
    ).toBe('192.168.1.24');
  });

  it('accepts the legacy numeric family value', () => {
    expect(
      pickLanAddress({
        en0: [{ address: '192.168.1.24', family: 4, internal: false }],
      }),
    ).toBe('192.168.1.24');
  });

  it('prefers en0 over other en interfaces regardless of key order', () => {
    expect(
      pickLanAddress({
        en5: [ipv4('10.1.1.5')],
        en0: [ipv4('192.168.1.24')],
      }),
    ).toBe('192.168.1.24');
    expect(
      pickLanAddress({
        en0: [ipv4('192.168.1.24')],
        en5: [ipv4('10.1.1.5')],
      }),
    ).toBe('192.168.1.24');
  });

  it('orders en interfaces numerically, not lexicographically', () => {
    expect(
      pickLanAddress({
        en10: [ipv4('10.0.0.10')],
        en2: [ipv4('10.0.0.2')],
      }),
    ).toBe('10.0.0.2');
  });

  it('prefers an en interface over a non-en physical interface', () => {
    expect(
      pickLanAddress({
        eth0: [ipv4('10.9.9.9')],
        en3: [ipv4('192.168.0.7')],
      }),
    ).toBe('192.168.0.7');
  });

  it('falls back to a non-en interface when no en interface qualifies', () => {
    expect(pickLanAddress({ eth0: [ipv4('10.9.9.9')] })).toBe('10.9.9.9');
  });

  it.each([
    ['vnic0', '10.211.55.2'],
    ['bridge100', '192.168.64.1'],
    ['utun4', '10.8.0.2'],
    ['awdl0', '169.254.1.1'],
    ['llw0', '10.20.30.40'],
    ['docker0', '172.17.0.1'],
    ['vboxnet0', '192.168.56.1'],
  ])('skips virtual interface %s', (name, address) => {
    expect(pickLanAddress({ [name]: [ipv4(address)] })).toBeNull();
    expect(
      pickLanAddress({ [name]: [ipv4(address)], en0: [ipv4('192.168.1.24')] }),
    ).toBe('192.168.1.24');
  });

  it('skips internal non-loopback entries', () => {
    expect(pickLanAddress({ en0: [ipv4('192.168.1.24', true)] })).toBeNull();
  });

  it('is deterministic when one interface has several IPv4 addresses', () => {
    const result = pickLanAddress({
      en0: [ipv4('192.168.1.99'), ipv4('192.168.1.24')],
    });
    expect(result).toBe('192.168.1.24');
    expect(
      pickLanAddress({ en0: [ipv4('192.168.1.24'), ipv4('192.168.1.99')] }),
    ).toBe(result);
  });

  it('tolerates undefined interface entries', () => {
    expect(
      pickLanAddress({ en0: undefined, en1: [ipv4('192.168.5.5')] }),
    ).toBe('192.168.5.5');
  });
});

describe('getLanAddress', () => {
  it('returns a string or null for the live interface table', () => {
    const address = getLanAddress();
    expect(address === null || typeof address === 'string').toBe(true);
  });
});
