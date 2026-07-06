export type DetectedAzureRemote = {
  remoteUrl: string;
  orgName: string;
  projectName: string;
  repoName: string;
};

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseAzureRemoteUrl(
  remoteUrl: string,
): DetectedAzureRemote | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/i,
  );
  if (sshMatch) {
    return {
      remoteUrl: trimmed,
      orgName: decodePart(sshMatch[1]),
      projectName: decodePart(sshMatch[2]),
      repoName: decodePart(sshMatch[3]),
    };
  }

  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/(.+)$/i,
  );
  if (sshUrlMatch) {
    return {
      remoteUrl: trimmed,
      orgName: decodePart(sshUrlMatch[1]),
      projectName: decodePart(sshUrlMatch[2]),
      repoName: decodePart(sshUrlMatch[3]),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map(decodePart);

  if (host === 'dev.azure.com' && parts.length >= 4 && parts[2] === '_git') {
    return {
      remoteUrl: trimmed,
      orgName: parts[0],
      projectName: parts[1],
      repoName: parts.slice(3).join('/'),
    };
  }

  if (
    host.endsWith('.visualstudio.com') &&
    parts.length >= 3 &&
    parts[1] === '_git'
  ) {
    return {
      remoteUrl: trimmed,
      orgName: host.slice(0, -'.visualstudio.com'.length),
      projectName: parts[0],
      repoName: parts.slice(2).join('/'),
    };
  }

  return null;
}
