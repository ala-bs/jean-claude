import { describe, expect, it } from 'vitest';

import { parseGitUrl, toCloneUrl } from './git-url-utils';

describe('parseGitUrl', () => {
  it('parses an https GitHub url', () => {
    const parsed = parseGitUrl('https://github.com/owner/repo.git');
    expect(parsed).toMatchObject({
      host: 'github.com',
      repoPath: 'owner/repo',
      owner: 'owner',
      repoName: 'repo',
      detectedProtocol: 'https',
      httpsUrl: 'https://github.com/owner/repo.git',
      sshUrl: 'git@github.com:owner/repo.git',
    });
  });

  it('parses an https url without the .git suffix or with a trailing slash', () => {
    expect(parseGitUrl('https://github.com/owner/repo')?.sshUrl).toBe(
      'git@github.com:owner/repo.git',
    );
    expect(parseGitUrl('https://github.com/owner/repo/')?.repoPath).toBe(
      'owner/repo',
    );
  });

  it('parses scp-style ssh urls', () => {
    const parsed = parseGitUrl('git@github.com:owner/repo.git');
    expect(parsed).toMatchObject({
      host: 'github.com',
      repoPath: 'owner/repo',
      detectedProtocol: 'ssh',
      httpsUrl: 'https://github.com/owner/repo.git',
      sshUrl: 'git@github.com:owner/repo.git',
    });
  });

  it('parses ssh:// urls', () => {
    expect(parseGitUrl('ssh://git@github.com/owner/repo.git')).toMatchObject({
      host: 'github.com',
      repoPath: 'owner/repo',
      detectedProtocol: 'ssh',
    });
  });

  it('treats owner/repo shorthand as GitHub', () => {
    expect(parseGitUrl('anthropics/claude-code')).toMatchObject({
      host: 'github.com',
      repoPath: 'anthropics/claude-code',
      repoName: 'claude-code',
      sshUrl: 'git@github.com:anthropics/claude-code.git',
    });
  });

  it('supports non-GitHub and self-hosted hosts', () => {
    expect(parseGitUrl('https://gitlab.com/group/sub/repo.git')).toMatchObject({
      host: 'gitlab.com',
      repoPath: 'group/sub/repo',
      owner: 'sub',
      repoName: 'repo',
    });
    expect(parseGitUrl('git@git.internal.corp:team/repo.git')).toMatchObject({
      host: 'git.internal.corp',
      sshUrl: 'git@git.internal.corp:team/repo.git',
    });
  });

  it('strips web-UI suffixes from copied browser urls', () => {
    expect(parseGitUrl('https://github.com/owner/repo/tree/main')?.repoPath).toBe(
      'owner/repo',
    );
    expect(parseGitUrl('https://github.com/owner/repo/pull/42')?.repoPath).toBe(
      'owner/repo',
    );
    expect(
      parseGitUrl('https://gitlab.com/group/repo/-/tree/main')?.repoPath,
    ).toBe('group/repo');
  });

  it('drops credentials embedded in the url', () => {
    expect(
      parseGitUrl('https://user:token@github.com/owner/repo.git')?.httpsUrl,
    ).toBe('https://github.com/owner/repo.git');
  });

  it('builds Azure DevOps ssh urls in the v3 form rather than scp-style', () => {
    const parsed = parseGitUrl('https://dev.azure.com/myorg/My Project/_git/repo');
    expect(parsed?.sshUrl).toBe('git@ssh.dev.azure.com:v3/myorg/My%20Project/repo');
    expect(parsed?.repoName).toBe('repo');
  });

  it('rejects garbage input', () => {
    expect(parseGitUrl('')).toBeNull();
    expect(parseGitUrl('   ')).toBeNull();
    expect(parseGitUrl('not a url')).toBeNull();
    expect(parseGitUrl('ftp://example.com/repo.git')).toBeNull();
  });

  it('preserves a non-default port in both forms', () => {
    expect(parseGitUrl('https://git.corp.com:8443/team/repo.git')).toMatchObject(
      {
        port: '8443',
        httpsUrl: 'https://git.corp.com:8443/team/repo.git',
        // scp-style cannot express a port, so the ssh:// form is required.
        sshUrl: 'ssh://git@git.corp.com:8443/team/repo.git',
      },
    );
    expect(parseGitUrl('ssh://git@github.com:2222/owner/repo.git')).toMatchObject(
      { port: '2222', sshUrl: 'ssh://git@github.com:2222/owner/repo.git' },
    );
  });

  it('round-trips an Azure ssh remote without corrupting it', () => {
    expect(
      parseGitUrl('git@ssh.dev.azure.com:v3/myorg/MyProject/myrepo'),
    ).toMatchObject({
      // No .git suffix, and the https form must not point at the ssh host.
      sshUrl: 'git@ssh.dev.azure.com:v3/myorg/MyProject/myrepo',
      httpsUrl: 'https://dev.azure.com/myorg/MyProject/_git/myrepo',
      repoName: 'myrepo',
    });
  });

  it('handles the Azure short form where project and repo share a name', () => {
    expect(parseGitUrl('https://dev.azure.com/myorg/_git/myrepo')).toMatchObject({
      sshUrl: 'git@ssh.dev.azure.com:v3/myorg/myrepo/myrepo',
      repoName: 'myrepo',
    });
  });

  it('keeps percent-encoded path segments encoded in clone urls', () => {
    const spaced = parseGitUrl('https://github.com/owner/my%20repo.git');
    expect(spaced?.httpsUrl).toBe('https://github.com/owner/my%20repo.git');
    expect(spaced?.repoName).toBe('my repo');

    // %2F must not decay into a path separator — that is a different repo.
    const encodedSlash = parseGitUrl('https://github.com/owner/sub%2Frepo.git');
    expect(encodedSlash?.httpsUrl).toBe(
      'https://github.com/owner/sub%2Frepo.git',
    );
  });

  it('does not reuse https userinfo as the ssh login', () => {
    expect(parseGitUrl('https://user@github.com/owner/repo.git')?.sshUrl).toBe(
      'git@github.com:owner/repo.git',
    );
    // An ssh URL's explicit login is meaningful and is kept.
    expect(parseGitUrl('ssh://deploy@github.com/owner/repo.git')?.sshUrl).toBe(
      'deploy@github.com:owner/repo.git',
    );
  });

  it('does not mistake a repo named like a web-UI route for a suffix', () => {
    expect(parseGitUrl('https://github.com/owner/issues')?.repoPath).toBe(
      'owner/issues',
    );
    expect(parseGitUrl('https://github.com/owner/releases')?.repoPath).toBe(
      'owner/releases',
    );
    // Still trimmed when it really is a suffix after owner/repo.
    expect(parseGitUrl('https://github.com/owner/repo/issues')?.repoPath).toBe(
      'owner/repo',
    );
  });

  it('accepts a scheme-less host url', () => {
    expect(parseGitUrl('github.com/owner/repo')).toMatchObject({
      host: 'github.com',
      repoPath: 'owner/repo',
    });
    expect(parseGitUrl('gitlab.com/group/sub/repo')).toMatchObject({
      host: 'gitlab.com',
      repoPath: 'group/sub/repo',
    });
  });

  it('does not double up .git on a trailing slash', () => {
    expect(parseGitUrl('https://github.com/owner/repo.git/')?.httpsUrl).toBe(
      'https://github.com/owner/repo.git',
    );
    // A repo genuinely named `foo.git` keeps one suffix.
    expect(parseGitUrl('https://github.com/owner/foo.git.git')?.repoName).toBe(
      'foo.git',
    );
  });

  it('an explicit .git suffix suppresses web-UI trimming', () => {
    // Without the suffix rule this would truncate to `group/sub`.
    expect(parseGitUrl('https://gitlab.com/group/sub/wiki.git')?.repoPath).toBe(
      'group/sub/wiki',
    );
  });

  it('does not let a web-UI suffix leak into the Azure repo name', () => {
    expect(
      parseGitUrl('https://dev.azure.com/org/proj/_git/repo/commit/abc123'),
    ).toMatchObject({
      repoName: 'repo',
      sshUrl: 'git@ssh.dev.azure.com:v3/org/proj/repo',
    });
  });

  it('rejects an authority that would inject a git/ssh argument', () => {
    // A leading dash in the ssh login becomes an option to ssh.
    expect(
      parseGitUrl('ssh://-oProxyCommand=touch%20pwned@example.com/a/b'),
    ).toBeNull();
    expect(parseGitUrl('ssh://git@-evil.com/a/b')).toBeNull();
  });

  it('strips .git after trimming, not before', () => {
    // Both a .git suffix and a web-UI route: the `.git` must not be doubled.
    expect(
      parseGitUrl('https://github.com/owner/repo.git/tree/main'),
    ).toMatchObject({
      repoName: 'repo',
      httpsUrl: 'https://github.com/owner/repo.git',
    });
  });

  it('never applies web-UI trimming to Azure structural paths', () => {
    // `wiki` here is the repository name, not a web-UI route.
    expect(
      parseGitUrl('https://dev.azure.com/org/proj/_git/wiki'),
    ).toMatchObject({
      repoName: 'wiki',
      sshUrl: 'git@ssh.dev.azure.com:v3/org/proj/wiki',
    });
  });

  it('accepts an IPv6 self-hosted remote', () => {
    expect(parseGitUrl('https://[::1]:3000/owner/repo.git')).toMatchObject({
      host: '[::1]',
      port: '3000',
      httpsUrl: 'https://[::1]:3000/owner/repo.git',
    });
  });

  it('rejects inputs that are not a repository', () => {
    // An owner page, not a repo.
    expect(parseGitUrl('https://github.com/owner')).toBeNull();
    // A hostname plus one segment is an org page, not `owner/repo`.
    expect(parseGitUrl('gitlab.com/group')).toBeNull();
  });
});

describe('toCloneUrl', () => {
  it('selects the requested protocol', () => {
    const parsed = parseGitUrl('https://github.com/owner/repo.git')!;
    expect(toCloneUrl(parsed, 'ssh')).toBe('git@github.com:owner/repo.git');
    expect(toCloneUrl(parsed, 'https')).toBe('https://github.com/owner/repo.git');
  });
});
