import type { PromptImagePart } from './agent-backend-types';

/**
 * Pasted images are attached to a separate list, so the text alone cannot say
 * *where* in the prompt an image belongs. When a user writes a numbered list
 * and pastes one screenshot per item, that association is the whole point.
 *
 * The composer therefore inserts a placeholder at the caret:
 *
 *     ![shot.png](jc-image://a3f9k2 =420x)
 *
 * The placeholder lives in the prompt text (the single source of truth for
 * ordering) and the matching `PromptImagePart` carries the same
 * `placeholderToken`. Consumers that can interleave content — the Claude and
 * Codex backends, the timeline markdown — split the text on placeholders and
 * drop the real image in that exact slot. Consumers that only take flat text
 * degrade to a readable `[image: shot.png]` marker, which still preserves the
 * position.
 */

/** URL scheme used by unresolved local image placeholders. */
export const PROMPT_IMAGE_PLACEHOLDER_SCHEME = 'jc-image://';

/** Cheap pre-check so marker-free prompts skip parsing entirely. */
export function hasPromptImagePlaceholder(text: string): boolean {
  return text.includes(PROMPT_IMAGE_PLACEHOLDER_SCHEME);
}

/**
 * One source of truth for the marker shape, as a string so the line-local
 * remover can embed it in a larger pattern. Identity-escaped `\/` is legal
 * under `g` alone — adding the `u` or `v` flag to any regex built from this
 * would throw.
 */
const PLACEHOLDER_SOURCE =
  String.raw`!\[([^\]]*)\]\(jc-image:\/\/([A-Za-z0-9_-]+)(?:\s+=\d+x\d*)?\)`;

/**
 * Built fresh per call rather than shared at module scope: a global regex
 * carries `lastIndex` between callers, so one early `break` in any consumer
 * would silently corrupt the next parse.
 */
const placeholderRe = () => new RegExp(PLACEHOLDER_SOURCE, 'g');

/** Characters that would break out of a markdown image label or target. */
function sanitizeLabel(value: string): string {
  return value.replace(/[[\]()\\]/g, '_');
}

/**
 * Opaque token. Kept short because users read it in the composer, but drawn
 * from a CSPRNG and re-rolled against `taken` — a collision would make two
 * images resolve to the same slot and silently drop one of them.
 */
export function createPromptImageToken(taken?: Iterable<string>): string {
  const used = new Set(taken ?? []);
  for (let attempt = 0; attempt < 10; attempt++) {
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    if (!used.has(token)) return token;
  }
  // Astronomically unlikely; fall back to the full uuid rather than colliding.
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Remove every image placeholder, whatever its token. For plain-text surfaces
 * derived from a raw draft (task titles, step names) where no image list is at
 * hand to resolve tokens against.
 */
export function stripPromptImagePlaceholders(text: string): string {
  return text.replace(placeholderRe(), '');
}

/**
 * Rendered width for an image of these proportions: portrait images are capped
 * narrow and panoramas wide, so a column of attachments reads evenly.
 * Re-exported by `src/lib/markdown-image-size.ts` — single source of truth.
 */
export function getPromptImageDisplayWidth(
  width: number,
  height: number,
): number {
  const aspectRatio = width / Math.max(height, 1);
  if (aspectRatio < 0.75) return Math.min(width, 280);
  if (aspectRatio > 1.6) return Math.min(width, 640);
  return Math.min(width, 420);
}

/** Markdown viewers render `=WIDTHx` as a display-size hint. */
function displaySizeSuffix(image: { width?: number; height?: number }): string {
  const { width, height } = image;
  if (!width || !height) return '';
  return ` =${getPromptImageDisplayWidth(width, height)}x`;
}

export function buildPromptImagePlaceholder({
  token,
  filename,
  width,
  height,
}: {
  token: string;
  filename?: string;
  width?: number;
  height?: number;
}): string {
  const label = sanitizeLabel(filename || 'image');
  return `![${label}](${PROMPT_IMAGE_PLACEHOLDER_SCHEME}${token}${displaySizeSuffix({ width, height })})`;
}

/** Matches exactly one token's placeholder, for removal from a draft. */
export function promptImagePlaceholderPattern(token: string): RegExp {
  return new RegExp(placeholderSource(token), 'g');
}

/** Tokens are generated hex, but this is exported — never trust the input. */
function placeholderSource(token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `!\\[[^\\]]*\\]\\(jc-image:\\/\\/${escaped}(?:\\s+=\\d+x\\d*)?\\)`;
}

/**
 * Drop one image's placeholder from a draft, collapsing the blank line it may
 * have occupied so removing an image does not leave a hole in the prompt.
 */
export function removePromptImagePlaceholder(
  text: string,
  token: string,
): string {
  const placeholder = placeholderSource(token);
  return (
    text
      // Alone on its own line: take the line with it, otherwise removing an
      // image leaves a hole between two list items.
      .replace(new RegExp(`\\n[ \\t]*${placeholder}[ \\t]*(?=\\n|$)`, 'g'), '')
      .replace(new RegExp(`^[ \\t]*${placeholder}[ \\t]*\\n`), '')
      // Inline with other text: drop just the placeholder.
      .replace(promptImagePlaceholderPattern(token), '')
  );
}

/**
 * Remove every placeholder, taking the whole line when a marker sits alone on
 * one. The token-agnostic counterpart of `removePromptImagePlaceholder`, and
 * the one to use when the result is text the user will see and keep editing —
 * a persisted draft — rather than a throwaway preview.
 *
 * `stripPromptImagePlaceholders` is the wrong tool there: it leaves the marker's
 * line behind as blank, which invites a follow-up whole-string tidy
 * (`trim`, collapsing blank runs) that silently rewrites bytes the user typed
 * far away from any image.
 */
export function removePromptImagePlaceholderLines(text: string): string {
  return text
    // Alone on its own line: take the line with it, matching what removing a
    // single image from the composer already does.
    .replace(new RegExp(`\\n[ \\t]*${PLACEHOLDER_SOURCE}[ \\t]*(?=\\n|$)`, 'g'), '')
    .replace(new RegExp(`^[ \\t]*${PLACEHOLDER_SOURCE}[ \\t]*\\n`), '')
    // Inline with other text: drop just the placeholder.
    .replace(placeholderRe(), '');
}

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: PromptImagePart };

/**
 * Split prompt text into ordered blocks, substituting each placeholder for its
 * image. Images with no placeholder in the text (pasted before this feature,
 * restored from an old draft, or whose placeholder the user deleted) are
 * returned in `trailing` so callers can append them the legacy way.
 *
 * A placeholder with no matching image — the user duplicated a list item, or
 * pasted a previous prompt's text into a new task — is replaced by its label
 * (`[image: a.png]`). Leaving the literal `jc-image://` URL would ship a dead
 * link to the model and render as a broken image in the timeline; dropping it
 * outright would delete a line the user wrote around.
 */
export function splitPromptTextByImages({
  text,
  images,
}: {
  text: string;
  images: PromptImagePart[];
}): { blocks: PromptBlock[]; trailing: PromptImagePart[] } {
  const byToken = new Map<string, PromptImagePart>();
  for (const image of images) {
    if (image.placeholderToken) byToken.set(image.placeholderToken, image);
  }

  const blocks: PromptBlock[] = [];
  const placed = new Set<string>();
  let lastIndex = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const previous = blocks[blocks.length - 1];
    // Adjacent text runs (e.g. around an unknown placeholder) must stay one
    // block so consumers do not inject separators inside a sentence.
    if (previous?.type === 'text') previous.text += value;
    else blocks.push({ type: 'text', text: value });
  };

  const re = placeholderRe();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [marker, label, token] = match;
    const image = byToken.get(token);
    pushText(text.slice(lastIndex, match.index));
    if (!image || placed.has(token)) {
      // Unresolvable: swap the dead link for its label so neither the model
      // nor the timeline ever sees a `jc-image://` URL.
      pushText(`[image: ${label || 'image'}]`);
      lastIndex = match.index + marker.length;
      continue;
    }
    blocks.push({ type: 'image', image });
    placed.add(token);
    lastIndex = match.index + marker.length;
  }
  pushText(text.slice(lastIndex));

  return {
    blocks,
    trailing: images.filter(
      (image) => !image.placeholderToken || !placed.has(image.placeholderToken),
    ),
  };
}

/**
 * Name the images a multimodal prompt sends as bare content blocks.
 *
 * An image block carries only bytes and a media type — not the filename, and
 * not any ordinal. Position alone tells the model *where* an image was
 * referenced, but gives neither side a handle to name one: the user cannot
 * write "the padding in a.png is wrong" and the model cannot answer "in the
 * second image". A short text block before each image restores that, and
 * mirrors what the flat-text backends already emit as `[image: a.png]`.
 *
 * Returns a labeller rather than a transformed list because callers place
 * images from several passes (inline placeholders first, then unanchored
 * trailing images) and the numbering has to run unbroken across all of them.
 * Numbers are positional per message and recomputed on every send, so they are
 * never persisted and never have to be kept in sync with anything.
 */
export function createPromptImageLabeller(): (
  image: PromptImagePart,
) => { type: 'text'; text: string } {
  let count = 0;
  return (image) => {
    count += 1;
    const name = labelFilename(image.filename);
    return {
      type: 'text',
      text: name ? `[Image #${count}: ${name}]` : `[Image #${count}]`,
    };
  };
}

/** Longest filename echoed into a label; the rest is elided. */
const MAX_LABEL_FILENAME_LENGTH = 80;

/**
 * A filename is not trusted input. Work-item images take theirs from the
 * `fileName` query param of a URL scraped out of work-item HTML, so whoever
 * can write to the board chooses this string — and the label is a text block
 * in the user turn of a prompt to an agent that can run tools.
 *
 * So: drop control and bidi characters, flatten newlines so one label can
 * never look like two, `sanitizeLabel` the bracket characters that would
 * otherwise close the label early, and cap the length.
 */
function labelFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const flattened = filename
    // Control characters become a space rather than vanishing, so a newline
    // cannot silently fuse two words into one.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // Bidi overrides are zero-width; drop them outright.
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return undefined;
  const safe = sanitizeLabel(flattened);
  return safe.length > MAX_LABEL_FILENAME_LENGTH
    ? `${safe.slice(0, MAX_LABEL_FILENAME_LENGTH - 1)}\u2026`
    : safe;
}

/**
 * Replace every resolved placeholder with `render(image)` and return plain
 * text. Used by consumers that cannot carry image blocks (Copilot) and by the
 * markdown builders.
 */
export function renderPromptImagePlaceholders({
  text,
  images,
  render,
}: {
  text: string;
  images: PromptImagePart[];
  render: (image: PromptImagePart) => string;
}): { text: string; trailing: PromptImagePart[] } {
  const { blocks, trailing } = splitPromptTextByImages({ text, images });
  return {
    text: blocks
      .map((block) =>
        block.type === 'text' ? block.text : render(block.image),
      )
      .join(''),
    trailing,
  };
}
