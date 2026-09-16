/**
 * Reconciles a replayed scrollback snapshot with the live output stream.
 *
 * `ensure` returns its snapshot over the `invoke` reply path while output
 * chunks arrive over a `send` push channel. Nothing orders those two against
 * each other, so a chunk emitted *before* the snapshot was taken can still be
 * delivered *after* it — and that chunk is already inside the snapshot's
 * backlog. Every chunk therefore has to be measured against the replay boundary
 * rather than trusted to arrive after it.
 */
export function sliceAfterReplay({
  data,
  offset,
  replayedThrough,
}: {
  data: string;
  /** Index of this chunk's first character in the session's whole stream. */
  offset: number;
  /** Stream offset one past the end of the replayed backlog. */
  replayedThrough: number;
}): string {
  // Entirely after the replay — nothing was covered.
  if (offset >= replayedThrough) return data;
  const overlap = replayedThrough - offset;
  // Entirely covered by the replay; writing any of it would duplicate output.
  if (overlap >= data.length) return '';
  // Straddles the boundary: keep only the part the replay did not cover.
  return data.slice(overlap);
}
