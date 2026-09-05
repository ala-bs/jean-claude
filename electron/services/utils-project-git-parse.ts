import type {
  ProjectGitCommit,
  ProjectGitGraphRow,
  ProjectGitRef,
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
  includeAllBranches?: boolean;
}): string[] {
  const args = ['log', '--graph', '--date-order', '--decorate=full'];
  if (params.includeAllBranches !== false) {
    args.push('--all');
  }
  args.push(`--max-count=${params.limit}`, `--pretty=format:${GRAPH_FORMAT}`);
  return args;
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
