export type TeamsMeetingJoinTarget = 'web' | 'app';

export function isValidTeamsHost(hostname: string): boolean {
  return (
    hostname === 'teams.microsoft.com' ||
    hostname.endsWith('.teams.microsoft.com') ||
    hostname === 'teams.live.com' ||
    hostname.endsWith('.teams.live.com') ||
    hostname === 'teams.cloud.microsoft' ||
    hostname.endsWith('.teams.cloud.microsoft')
  );
}

export function isValidTeamsJoinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'msteams:') &&
      isValidTeamsHost(url.hostname)
    );
  } catch {
    return false;
  }
}

export function getTeamsJoinUrl(
  teamsUrl: string,
  target: TeamsMeetingJoinTarget | undefined,
): string {
  if (target !== 'app') return teamsUrl;

  try {
    const url = new URL(teamsUrl);
    if (url.protocol === 'https:' && isValidTeamsHost(url.hostname)) {
      // NOTE: `url.protocol = 'msteams:'` is a silent no-op — the WHATWG URL
      // spec forbids switching a "special" scheme (https) to a non-special one.
      // Rewrite the string prefix instead.
      return `msteams://${url.toString().slice('https://'.length)}`;
    }
  } catch {
    // fall back to original URL
  }

  return teamsUrl;
}
