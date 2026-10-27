/**
 * The one-or-two-line excerpt shown under a card's title when the
 * "description preview" field is visible.
 *
 * Every Item the plugin creates starts its body with `# {title}` (see
 * `createTask`), so the obvious implementation — strip markdown, take the first
 * 120 characters — repeats the title the card is already showing. The preview
 * is clamped to two lines, so for a freshly created Item that repetition is the
 * entire preview and it carries no information at all. A leading heading is
 * therefore dropped when it only restates the title; a heading that says
 * something else is genuine content and is kept.
 *
 * Export already applies the same rule when writing a task out as markdown, so
 * this keeps the two readings of "the body minus its redundant title" aligned.
 */

const FRONTMATTER = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/;
const MARKDOWN_NOISE = /[#`*_>[\]]/g;

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

export function descriptionPreview(
  body: string | null | undefined,
  title: string | null | undefined,
  max = 120,
): string {
  if (!body) return "";
  const lines = body.replace(FRONTMATTER, "").split(/\r?\n/);

  // Drop leading blanks, then the redundant title heading if that's what the
  // first line of real content turns out to be.
  while (lines.length && !lines[0].trim()) lines.shift();
  const heading = lines[0]?.match(/^#{1,6}\s+(.*)$/);
  if (heading && title && normalize(heading[1]) === normalize(title)) lines.shift();

  // Whitespace is collapsed so the character budget buys visible text rather
  // than the blank lines that separate paragraphs in the source.
  const text = normalize(lines.join(" ").replace(MARKDOWN_NOISE, ""));
  return text.slice(0, max);
}
