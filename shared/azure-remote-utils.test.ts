import { describe, expect, it } from 'vitest';

import { parseAzureRemoteUrl } from './azure-remote-utils';

describe('parseAzureRemoteUrl', () => {
  it('parses dev.azure.com HTTPS remotes', () => {
    expect(
      parseAzureRemoteUrl('https://dev.azure.com/my-org/My%20Project/_git/app'),
    ).toMatchObject({
      orgName: 'my-org',
      projectName: 'My Project',
      repoName: 'app',
    });
  });

  it('parses visualstudio.com HTTPS remotes', () => {
    expect(
      parseAzureRemoteUrl('https://my-org.visualstudio.com/MyProject/_git/app'),
    ).toMatchObject({
      orgName: 'my-org',
      projectName: 'MyProject',
      repoName: 'app',
    });
  });

  it('parses Azure DevOps SSH remotes', () => {
    expect(
      parseAzureRemoteUrl('git@ssh.dev.azure.com:v3/my-org/My%20Project/app'),
    ).toMatchObject({
      orgName: 'my-org',
      projectName: 'My Project',
      repoName: 'app',
    });
  });

  it('parses Azure DevOps SSH URL remotes', () => {
    expect(
      parseAzureRemoteUrl(
        'ssh://git@ssh.dev.azure.com/v3/my-org/My%20Project/app',
      ),
    ).toMatchObject({
      orgName: 'my-org',
      projectName: 'My Project',
      repoName: 'app',
    });
  });

  it('ignores non-Azure remotes', () => {
    expect(parseAzureRemoteUrl('git@github.com:owner/repo.git')).toBeNull();
  });
});
