import { networkInterfaces } from 'node:os';

/**
 * A physical device cannot reach Metro on the Mac's loopback address, so the
 * launch URL has to advertise the Mac's LAN address instead. This module picks
 * that address.
 *
 * {@link pickLanAddress} is deliberately pure (the interface table is injected)
 * so the selection rules can be unit-tested without real hardware.
 */

/**
 * Interfaces that are never a route to a phone on the same Wi-Fi/Ethernet:
 * - `vnic`/`bridge`/`vboxnet`/`docker`: VM and container host-only networks
 * - `utun`: VPN / iCloud Private Relay tunnels
 * - `awdl`/`llw`: Apple Wireless Direct Link (AirDrop/AirPlay peer-to-peer)
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'awdl',
  'bridge',
  'docker',
  'llw',
  'utun',
  'vboxnet',
  'vnic',
];

const LINK_LOCAL_IPV4_PREFIX = '169.254.';

function isIpv4(info: { family: string | number }): boolean {
  // Node <18.0 reported the numeric family; both shapes are still typed.
  return info.family === 'IPv4' || info.family === 4;
}

/**
 * Lower is better. `null` means "never use this interface".
 *
 * On macOS `en0` is the built-in Wi-Fi (or Ethernet on desktops) and is the
 * interface a phone on the same network can actually reach, so it wins over
 * `en1`+ (Thunderbolt/USB adapters) and over anything non-`en*`.
 */
function rankInterfaceName(name: string): number | null {
  const lower = name.toLowerCase();
  if (VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return null;
  }
  if (lower === 'en0') return 0;
  if (/^en\d+$/.test(lower)) return 1;
  return 2;
}

/** Numeric suffix of `en5` -> 5, so `en2` sorts before `en10`. */
function interfaceOrdinal(name: string): number {
  const match = /(\d+)$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Picks the Mac's routable IPv4 LAN address, or `null` when there is none.
 *
 * Pure: pass the result of `os.networkInterfaces()`. Ordering is fully
 * deterministic (rank, then numeric suffix, then name, then address) and never
 * relies on the enumeration order of the input object.
 */
export function pickLanAddress(
  interfaces: NodeJS.Dict<
    Array<{
      address: string;
      family: string | number;
      internal: boolean;
    }>
  >,
): string | null {
  const candidates: Array<{
    rank: number;
    ordinal: number;
    name: string;
    address: string;
  }> = [];

  for (const [name, infos] of Object.entries(interfaces)) {
    if (!Array.isArray(infos)) continue;
    const rank = rankInterfaceName(name);
    if (rank === null) continue;
    for (const info of infos) {
      if (!info || typeof info.address !== 'string' || !info.address) continue;
      if (!isIpv4(info)) continue;
      if (info.internal) continue;
      if (info.address.startsWith(LINK_LOCAL_IPV4_PREFIX)) continue;
      candidates.push({
        rank,
        ordinal: interfaceOrdinal(name),
        name,
        address: info.address,
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.ordinal - b.ordinal ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  );
  return candidates[0].address;
}

/** {@link pickLanAddress} against this machine's live interface table. */
export function getLanAddress(): string | null {
  return pickLanAddress(networkInterfaces());
}
