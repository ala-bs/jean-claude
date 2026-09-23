/**
 * Adds `-o BatchMode=yes` to an ssh command line.
 *
 * Inserted right after the program name rather than appended: ssh honours the
 * *first* occurrence of a repeated option, so a user whose GIT_SSH_COMMAND
 * already contains `-o BatchMode=no` would otherwise keep their value and the
 * command could still block on a prompt.
 *
 * The user's existing command is preserved rather than replaced — it may carry
 * an identity file, port, or proxy without which the fetch cannot authenticate
 * at all.
 */
export function withBatchMode(sshCommand: string | undefined): string {
  const command = sshCommand?.trim() || 'ssh';
  const firstSpace = command.indexOf(' ');
  if (firstSpace === -1) return `${command} -o BatchMode=yes`;
  return `${command.slice(0, firstSpace)} -o BatchMode=yes${command.slice(firstSpace)}`;
}

/**
 * Environment overrides that make git and ssh fail immediately rather than
 * block on a credential prompt.
 *
 * `SSH_ASKPASS_REQUIRE` alone is not enough: it only disables the askpass
 * helper, and ssh will still open /dev/tty directly — which succeeds when the
 * app was launched from a terminal (pnpm dev), leaving the command blocked on
 * an invisible prompt. BatchMode is the actual fail-fast switch. Callers that
 * need to prompt use the askpass broker instead.
 *
 * Returned as overrides only, so each caller merges them onto whichever base
 * environment it already uses.
 */
export function getNonInteractiveGitEnv({
  configuredSshCommand,
}: {
  /**
   * The repo's `core.sshCommand`, when the caller can afford to read it.
   *
   * Setting GIT_SSH_COMMAND takes precedence over `core.sshCommand`, so
   * ignoring it would silently drop a custom identity file, alternate ssh
   * config, or ProxyCommand — and the resulting auth failure surfaces only as
   * a fetch that never succeeds.
   */
  configuredSshCommand?: string;
} = {}): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: withBatchMode(
      process.env.GIT_SSH_COMMAND || configuredSshCommand,
    ),
  };
}
