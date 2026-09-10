import type {
  ProjectCommitDiffFile,
  ProjectGitCommit,
  ProjectGitGraphRow,
  ProjectGitRef,
  ProjectWorkingTreeFile,
} from '@shared/types';

/**
 * Git writes commit subjects and ref names verbatim, so the record separators
 * have to be bytes that cannot appear in them. NUL marks the start of a
 * commit's data (everything before it on the line is graph drawing), and unit
 * separator splits the fields.
 */
const RECORD_MARKER = String.fromCharCode(0);
const FIELD_SEPARATOR = String.fromCharCode(31);

/** `--pretty=format` string whose output `parseGraphLine` expects. */
export const GRAPH_FORMAT = ['%x00%H', '%h', '%P', '%an', '%aI', '%D', '%s'].join(
  '%x1f',
);

/**
 * Builds the `git log` arguments `parseGraphLine` is written against.
 *
 * Kept next to the parser so the two cannot drift: `--decorate=full` in
 * particular is invisible to the type system but is what lets refs be
 * classified by namespace instead of guessed from their name.
 */
export function buildGraphArgs(params: {
  limit: number;
  /** Commits to skip before the window, for paging older history. */
  skip?: number;
  includeAllBranches?: boolean;
  /** Free-text query matched against commit subjects. */
  query?: string;
  /**
   * Refs to walk instead of every branch. Callers must have validated these
   * against the repository's real refs first — they reach git as revision
   * arguments.
   */
  branches?: string[];
}): string[] {
  const branches = params.branches ?? [];
  const query = params.query?.trim() ?? '';
  const isFiltered = branches.length > 0 || query.length > 0;

  // The lane art only describes an unfiltered walk. Once commits are being
  // selected out of the middle of the history, `--graph` would draw edges
  // between commits that are not actually parent and child, so the filtered
  // view drops it and renders flat rows instead.
  const args = ['log', '--date-order', '--decorate=full'];
  if (!isFiltered) {
    args.splice(1, 0, '--graph');
  }

  // Explicit branches replace the ref set rather than adding to it; passing
  // both `--all` and a branch list would silently walk everything.
  if (branches.length === 0 && params.includeAllBranches !== false) {
    args.push('--all');
  }

  if (query.length > 0) {
    // `--fixed-strings` matters: without it a query containing `(` or `[` is a
    // malformed regex and git exits non-zero, turning a typo into an error.
    args.push(
      `--grep=${query}`,
      '--fixed-strings',
      '--regexp-ignore-case',
    );
  }

  // `--skip` counts commits, not output lines, so it pages consistently even
  // though `--graph` interleaves connector rows between them.
  if (params.skip && params.skip > 0) {
    args.push(`--skip=${params.skip}`);
  }
  args.push(`--max-count=${params.limit}`, `--pretty=format:${GRAPH_FORMAT}`);

  if (branches.length > 0) {
    args.push(...branches);
  }

  // Terminates revision parsing so a ref named like a path cannot be read as
  // one, and vice versa.
  args.push('--');
  return args;
}

/** Matches a commit-hash prefix long enough to be worth resolving as one. */
const HASH_PREFIX_PATTERN = /^[0-9a-f]{4,40}$/i;

/**
 * Whether a search query should be treated as a commit hash rather than text.
 *
 * Short hex strings are ambiguous — `dead` and `face` are words as well as
 * valid prefixes — so the caller resolves the candidate against the object
 * database and falls back to a text search when it does not name a commit.
 */
export function looksLikeCommitHash(query: string): boolean {
  return HASH_PREFIX_PATTERN.test(query.trim());
}

/** `--pretty=format` string whose output `parseCommitDetail` expects. */
export const COMMIT_DETAIL_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%D',
  '%s',
  '%b',
].join('%x1f');

export interface ParsedCommitDetail {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: string;
  refs: ProjectGitRef[];
  subject: string;
  body: string;
}

/** Parses the header emitted by `COMMIT_DETAIL_FORMAT`. */
export function parseCommitDetail(stdout: string): ParsedCommitDetail | null {
  const fields = stdout.split(FIELD_SEPARATOR);
  if (fields.length < 9) return null;

  return {
    hash: fields[0].trim(),
    shortHash: fields[1].trim(),
    parents: fields[2].split(' ').filter((value) => value.length > 0),
    author: fields[3],
    authorEmail: fields[4],
    date: fields[5].trim(),
    refs: fields[6]
      .split(', ')
      .map(parseRef)
      .filter((ref): ref is ProjectGitRef => ref !== null),
    subject: fields[7],
    // The body is last and may itself contain the separator byte.
    body: fields.slice(8).join(FIELD_SEPARATOR).trim(),
  };
}

/**
 * Merges `--name-status` and `--numstat` output into one file list.
 *
 * They are two passes over the same diff, keyed by path. A path missing from
 * the numstat side is a binary file, which git reports as `-`/`-`; zero counts
 * are the honest answer there rather than a guess.
 */
export function parseCommitDiffFiles(params: {
  nameStatus: string;
  numstat: string;
}): ProjectCommitDiffFile[] {
  const counts = new Map<string, { additions: number; deletions: number }>();

  for (const line of params.numstat.split('\n')) {
    if (!line.trim()) continue;
    const [adds, dels, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;
    counts.set(path, {
      additions: adds === '-' ? 0 : (Number.parseInt(adds, 10) || 0),
      deletions: dels === '-' ? 0 : (Number.parseInt(dels, 10) || 0),
    });
  }

  const files: ProjectCommitDiffFile[] = [];
  for (const line of params.nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [statusCode, ...pathParts] = line.split('\t');
    // A rename arrives as `R100\t<old>\t<new>`; the new path is what the diff
    // viewer needs to read content for.
    const path =
      statusCode.startsWith('R') || statusCode.startsWith('C')
        ? (pathParts[1] ?? pathParts[0])
        : pathParts.join('\t');
    if (!path) continue;

    const status: ProjectCommitDiffFile['status'] = statusCode.startsWith('A')
      ? 'added'
      : statusCode.startsWith('D')
        ? 'deleted'
        : 'modified';

    files.push({
      path,
      status,
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
    });
  }

  return files;
}

export interface ParsedGitStatus {
  branch: string;
  isDetached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/**
 * Reads `git status --porcelain=v2 --branch` and turns it into counts plus
 * upstream divergence.
 *
 * Note that the `# branch.ab` header is only emitted when the branch has an
 * upstream, so ahead/behind stay null for unpublished branches rather than
 * being reported as a misleading 0/0.
 */
export function parseStatus(stdout: string): ParsedGitStatus {
  let branch = '';
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('? ')) {
      untracked += 1;
      continue;
    }
    if (line.startsWith('u ')) {
      conflicted += 1;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Field 2 is the two-character XY code: X is the staged state and Y the
      // unstaged one, with '.' meaning unmodified. A file edited both in the
      // index and the working tree counts once on each side.
      const xy = line.split(' ')[1] ?? '..';
      if (xy[0] && xy[0] !== '.') staged += 1;
      if (xy[1] && xy[1] !== '.') unstaged += 1;
    }
  }

  return {
    branch,
    // git reports a detached HEAD as the literal string "(detached)".
    isDetached: branch === '(detached)',
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

/**
 * Reads the same `--porcelain=v2` output as `parseStatus`, but keeps the paths.
 *
 * Split from `parseStatus` because the panel polls counts every few seconds
 * and only needs paths when the user opens the working-tree popover.
 *
 * Field layouts (space separated, path last):
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>\t<origPath>`
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *   `? <path>`
 */
export function parseStatusFiles(stdout: string): ProjectWorkingTreeFile[] {
  const files: ProjectWorkingTreeFile[] = [];

  const fieldsAfter = (line: string, count: number): string =>
    line.split(' ').slice(count).join(' ');

  for (const line of stdout.split('\n')) {
    if (line.startsWith('? ')) {
      files.push({ path: line.slice(2).trim(), state: 'untracked' });
      continue;
    }
    if (line.startsWith('u ')) {
      files.push({ path: fieldsAfter(line, 10).trim(), state: 'conflicted' });
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      // A rename's path field is `<new>\t<old>`; only the new path is shown.
      const raw =
        line.startsWith('2 ') ? fieldsAfter(line, 9) : fieldsAfter(line, 8);
      const path = raw.split('\t')[0].trim();
      if (path.length === 0) continue;
      if (xy[0] && xy[0] !== '.') files.push({ path, state: 'staged' });
      if (xy[1] && xy[1] !== '.') files.push({ path, state: 'unstaged' });
    }
  }

  return files;
}

/**
 * Resolves the remote an upstream ref points at, so push/pull act on the
 * branch's real remote rather than assuming `origin`.
 */
export function remoteFromUpstream(
  upstream: string | null,
): string | undefined {
  if (!upstream) return undefined;
  const slashIndex = upstream.indexOf('/');
  return slashIndex === -1 ? undefined : upstream.slice(0, slashIndex);
}

/** Ref namespaces git emits under `--decorate=full`, longest prefix first. */
const REF_NAMESPACES: { prefix: string; kind: ProjectGitRef['kind'] }[] = [
  { prefix: 'refs/remotes/', kind: 'remote' },
  { prefix: 'refs/heads/', kind: 'branch' },
  { prefix: 'refs/tags/', kind: 'tag' },
];

/**
 * Turns one `%D` decoration into a typed ref.
 *
 * The checked-out branch arrives as `HEAD -> refs/heads/main`, and a detached
 * HEAD arrives as a bare `HEAD`.
 */
function parseRef(decoration: string): ProjectGitRef | null {
  const trimmed = decoration.trim();
  if (trimmed.length === 0) return null;

  const headArrow = 'HEAD -> ';
  const isHead = trimmed.startsWith(headArrow);
  let raw = isHead ? trimmed.slice(headArrow.length).trim() : trimmed;

  if (raw === 'HEAD') {
    return { name: 'HEAD', kind: 'other', isHead: true };
  }

  // Even under `--decorate=full` git prefixes tags with a literal `tag: `,
  // so the namespace match below would otherwise never see `refs/tags/`.
  const tagMarker = 'tag: ';
  if (raw.startsWith(tagMarker)) {
    raw = raw.slice(tagMarker.length).trim();
    return { name: raw.replace(/^refs\/tags\//, ''), kind: 'tag', isHead };
  }

  for (const { prefix, kind } of REF_NAMESPACES) {
    if (raw.startsWith(prefix)) {
      return { name: raw.slice(prefix.length), kind, isHead };
    }
  }

  // `refs/stash`, `refs/notes/*`, or a decoration style we do not recognise.
  return { name: raw.replace(/^refs\//, ''), kind: 'other', isHead };
}

/**
 * Parses one line of `git log --graph` output into lane characters plus the
 * commit they belong to.
 *
 * Rows git emits purely to route merge edges contain no NUL marker and yield a
 * null commit; they must be kept so the lanes still line up vertically.
 */
export function parseGraphLine(line: string): ProjectGitGraphRow | null {
  const markerIndex = line.indexOf(RECORD_MARKER);

  if (markerIndex === -1) {
    const graph = line.trimEnd();
    return graph.length > 0 ? { graph, commit: null } : null;
  }

  const graph = line.slice(0, markerIndex).trimEnd();
  const fields = line.slice(markerIndex + 1).split(FIELD_SEPARATOR);

  // Keep the lane art even if the record is unreadable: dropping the row
  // entirely would misalign every row below it, which is exactly what the
  // connector-row handling above exists to prevent.
  if (fields.length < 7) return { graph, commit: null };

  const commit: ProjectGitCommit = {
    hash: fields[0],
    shortHash: fields[1],
    parents: fields[2].split(' ').filter((value) => value.length > 0),
    author: fields[3],
    date: fields[4],
    refs: fields[5]
      .split(', ')
      .map(parseRef)
      .filter((ref): ref is ProjectGitRef => ref !== null),
    // The subject is last and free-form. A commit message may itself contain
    // the separator byte, so re-join the tail rather than truncating at it.
    subject: fields.slice(6).join(FIELD_SEPARATOR),
  };

  return { graph, commit };
}
