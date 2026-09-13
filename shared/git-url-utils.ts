import { parseAzureRemoteUrl } from './azure-remote-utils';

export type GitCloneProtocol = 'ssh' | 'https';

export type ParsedGitUrl = {
  /** Hostname of the remote, lowercased (e.g. `github.com`). */
  host: string;
  /** Non-default port, or null. Preserved so self-hosted remotes stay clonable. */
  port: string | null;
  /** Human-readable repository path, percent-decoded (e.g. `owner/repo`). */
  repoPath: string;
  /** Owner/organization segment, when the path has more than one segment. */
  owner: string | null;
  /** Last path segment, percent-decoded — the natural default folder name. */
  repoName: string;
  /** Protocol the user originally pasted. */
  detectedProtocol: GitCloneProtocol;
  /** Canonical `https://` clone URL. */
  httpsUrl: string;
  /** Canonical SSH clone URL (scp-style, `ssh://` when a port is set, or Azure's `v3/` form). */
  sshUrl: string;
};

const DEFAULT_HOST = 'github.com';

/**
 * `git@host:path` / `host:path` — scp-style. The host must contain a dot so
 * that `C:\repo` and `owner:thing` do not match. Rejects a leading `/` in the
 * path, which would make it an `ssh://`-style authority instead.
 */
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/@]+\.[^:/@]+):(?!\/)(.+)$/;

/**
 * Path segments that belong to a forge's web UI rather than the repository
 * path. A browser URL like `.../owner/repo/tree/main` must be trimmed back to
 * `owner/repo` — but only *after* the owner/repo pair, so a repository
 * genuinely named `issues` or `releases` survives.
 */
const WEB_UI_MARKERS = new Set([
  '-',
  'actions',
  'blame',
  'blob',
  'branches',
  'commit',
  'commits',
  'compare',
  'issues',
  'merge_requests',
  'pull',
  'pullrequest',
  'pullrequests',
  'pulls',
  'raw',
  'releases',
  'tags',
  'tree',
  'wiki',
]);

function stripDotGit(value: string): string {
  return value.replace(/\.git$/i, '');
}

/**
 * Characters permitted in a host or ssh login that we splice into an argv.
 * A leading `-` is excluded specifically: that is what turns the value into an
 * option rather than a hostname once git forwards it to ssh.
 */
const SAFE_AUTHORITY = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** Bracketed IPv6 literal, e.g. `[::1]` — legitimate for a self-hosted remote. */
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]+\]$/;

function isSafeHost(host: string): boolean {
  return SAFE_AUTHORITY.test(host) || IPV6_LITERAL.test(host);
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAzureHost(host: string): boolean {
  return (
    host === 'dev.azure.com' ||
    host === 'ssh.dev.azure.com' ||
    host.endsWith('.visualstudio.com')
  );
}

/**
 * Split a URL path into percent-encoded segments.
 *
 * Segments are deliberately left encoded: they are substituted straight back
 * into the canonical clone URLs, and decoding them there would corrupt any
 * repo whose name contains an encoded `/` or space. The `.git` suffix is
 * stripped later, in `finalize`, because it must happen *after* web-UI
 * trimming has decided which segment is actually the repository.
 */
function toEncodedSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/** Drop a single trailing `.git` from the final segment. */
function stripDotGitSuffix(segments: string[]): string[] {
  if (segments.length === 0) return segments;
  const out = [...segments];
  out[out.length - 1] = stripDotGit(out[out.length - 1]);
  return out.filter(Boolean);
}

/**
 * Azure paths are structural rather than route-like: the repository is always
 * the segment immediately after `_git`, and anything beyond it is web UI
 * (`/commit/abc`, `/pullrequest/5`).
 *
 * Truncating positionally means a repo legitimately named `wiki` or `tags` is
 * kept, which the generic marker-based trimmer would have thrown away.
 */
function trimAzurePath(segments: string[]): string[] {
  const gitIndex = segments.indexOf('_git');
  if (gitIndex === -1) return segments;
  return segments.slice(0, gitIndex + 2);
}

/**
 * Trim forge web-UI suffixes, but only from index 2 onward so that a repo
 * actually named `issues`, `pull`, or `releases` is not mistaken for one.
 *
 * `hasExplicitGitSuffix` suppresses trimming entirely: if the user pasted a
 * URL ending in `.git` they gave us the repository path verbatim, so a segment
 * that merely looks like a web-UI route is part of the repo path.
 */
function trimWebUiSuffix(
  segments: string[],
  hasExplicitGitSuffix: boolean,
): string[] {
  if (hasExplicitGitSuffix) return segments;
  for (let i = 2; i < segments.length; i++) {
    if (WEB_UI_MARKERS.has(segments[i].toLowerCase())) {
      return segments.slice(0, i);
    }
  }
  return segments;
}

/**
 * Azure DevOps does not follow the `git@host:owner/repo.git` convention — its
 * SSH endpoint is `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` with no
 * `.git` suffix. Rewriting an Azure URL with the generic scp rule would
 * produce a remote that cannot be cloned, so Azure is resolved separately.
 */
function buildAzureUrls(
  segments: string[],
  host: string,
): { httpsUrl: string; sshUrl: string; repoPath: string } | null {
  // Rebuilt from the already-trimmed segments rather than the caller's raw
  // input: handing parseAzureRemoteUrl the untrimmed original would let a web
  // UI suffix (`/commit/abc`) leak into the repository name.
  const canonical =
    host === 'ssh.dev.azure.com'
      ? `git@ssh.dev.azure.com:${segments.join('/')}`
      : `https://${host}/${segments.join('/')}`;
  const azure = parseAzureRemoteUrl(canonical);

  let orgName: string;
  let projectName: string;
  let repoName: string;

  if (azure) {
    ({ orgName, projectName, repoName } = azure);
  } else if (
    host === 'dev.azure.com' &&
    segments.length === 3 &&
    segments[1] === '_git'
  ) {
    // `dev.azure.com/{org}/_git/{repo}` — the short form Azure serves when the
    // project and repository share a name. parseAzureRemoteUrl requires four
    // segments and rejects it.
    orgName = decodePart(segments[0]);
    repoName = decodePart(segments[2]);
    projectName = repoName;
  } else {
    return null;
  }

  return {
    repoPath: `${orgName}/${projectName}/${repoName}`,
    sshUrl: `git@ssh.dev.azure.com:v3/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/${encodeURIComponent(repoName)}`,
    httpsUrl: `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`,
  };
}

function finalize(params: {
  host: string;
  port: string | null;
  segments: string[];
  detectedProtocol: GitCloneProtocol;
  sshUser: string;
  hasExplicitGitSuffix: boolean;
}): ParsedGitUrl | null {
  const { host, port, detectedProtocol, sshUser } = params;

  // Azure paths are structural (`{org}/{project}/_git/{repo}`), not web-UI
  // routes, so trimming must not run on them: a repo at index 3 named `wiki`
  // or `tags` would otherwise be mistaken for a suffix and truncated away.
  // `.git` is stripped only after trimming has settled which segment is the
  // repository — doing it first turns `/owner/repo.git/tree/main` into
  // `repo.git.git`.
  const segments = stripDotGitSuffix(
    isAzureHost(host)
      ? trimAzurePath(params.segments)
      : trimWebUiSuffix(params.segments, params.hasExplicitGitSuffix),
  );

  // Host and login are spliced into an argv element handed to git, which
  // forwards `user@host` to ssh. Rejecting anything outside this charset stops
  // a pasted `ssh://-oProxyCommand=…@host/x/y` from producing a leading-dash
  // argument.
  if (!isSafeHost(host)) return null;
  if (!SAFE_AUTHORITY.test(sshUser)) return null;
  if (port !== null && !/^\d+$/.test(port)) return null;

  const azureUrls = isAzureHost(host) ? buildAzureUrls(segments, host) : null;

  // A single path segment is an owner or org page, not a repository. Azure is
  // exempt because its resolver has already produced a full triple.
  if (!azureUrls && segments.length < 2) return null;

  const encodedPath = segments.join('/');
  const decoded = segments.map(decodePart);
  const repoName = decoded[decoded.length - 1];
  const owner = decoded.length > 1 ? decoded[decoded.length - 2] : null;

  const authority = port ? `${host}:${port}` : host;

  return {
    host,
    port,
    repoPath: azureUrls?.repoPath ?? decoded.join('/'),
    owner,
    repoName,
    detectedProtocol,
    httpsUrl: azureUrls?.httpsUrl ?? `https://${authority}/${encodedPath}.git`,
    // scp-style syntax cannot express a port, so a ported remote must use the
    // full ssh:// form instead.
    sshUrl:
      azureUrls?.sshUrl ??
      (port
        ? `ssh://${sshUser}@${host}:${port}/${encodedPath}.git`
        : `${sshUser}@${host}:${encodedPath}.git`),
  };
}

/**
 * Parse any common git remote spelling into its canonical HTTPS and SSH forms.
 *
 * Accepts:
 *   - `https://github.com/owner/repo(.git)` (credentials in the URL are dropped)
 *   - `git@github.com:owner/repo.git`
 *   - `ssh://git@github.com:2222/owner/repo.git`
 *   - `github.com/owner/repo` (scheme-less)
 *   - `owner/repo` shorthand (assumes github.com)
 *
 * Returns `null` when the input cannot be understood as a git remote.
 */
export function parseGitUrl(input: string): ParsedGitUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // A trailing slash is tolerated so `.../repo.git/` still counts as explicit.
  const hasExplicitGitSuffix = /\.git\/?$/i.test(trimmed);

  if (!hasScheme) {
    // scp-style `git@host:path` — checked before URL parsing, since `new URL()`
    // reads it as a `git@host:` scheme.
    const scp = trimmed.match(SCP_LIKE);
    if (scp) {
      const [, user, host, path] = scp;
      return finalize({
        host: host.toLowerCase(),
        port: null,
        segments: toEncodedSegments(path),
        detectedProtocol: 'ssh',
        sshUser: user || 'git',
        hasExplicitGitSuffix,
      });
    }

    // Scheme-less input. A first segment containing a dot is a hostname
    // (`github.com/owner/repo`); otherwise it is `owner/repo` shorthand.
    const segments = toEncodedSegments(trimmed);
    if (segments.length >= 2 && !/[\s@:]/.test(trimmed)) {
      const looksLikeHost = segments[0].includes('.');
      if (looksLikeHost && segments.length >= 3) {
        return finalize({
          host: segments[0].toLowerCase(),
          port: null,
          segments: segments.slice(1),
          detectedProtocol: 'ssh',
          sshUser: 'git',
          hasExplicitGitSuffix,
        });
      }
      if (!looksLikeHost && segments.length === 2) {
        return finalize({
          host: DEFAULT_HOST,
          port: null,
          segments,
          detectedProtocol: 'ssh',
          sshUser: 'git',
          hasExplicitGitSuffix,
        });
      }
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = url.protocol.replace(/:$/, '').toLowerCase();
  if (!['http', 'https', 'ssh', 'git'].includes(protocol)) return null;

  const isSshLike = protocol === 'ssh' || protocol === 'git';

  return finalize({
    host: url.hostname.toLowerCase(),
    port: url.port || null,
    segments: toEncodedSegments(url.pathname),
    detectedProtocol: isSshLike ? 'ssh' : 'https',
    // Only an ssh-style URL carries a meaningful login. Reusing the userinfo
    // from an https URL would produce an ssh remote that authenticates as the
    // wrong user (forges expect the literal `git`).
    sshUser: isSshLike && url.username ? url.username : 'git',
    hasExplicitGitSuffix,
  });
}

/** Pick the clone URL for the requested protocol. */
export function toCloneUrl(
  parsed: ParsedGitUrl,
  protocol: GitCloneProtocol,
): string {
  return protocol === 'ssh' ? parsed.sshUrl : parsed.httpsUrl;
}
