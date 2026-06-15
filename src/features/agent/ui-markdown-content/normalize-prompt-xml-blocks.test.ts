import { describe, expect, it } from 'vitest';

import { splitPromptXmlSegments } from '.';

describe('splitPromptXmlSegments', () => {
  it('leaves XML inside existing fences as markdown', () => {
    const content = [
      '```xml',
      '<user_review>',
      '<comment index="1">fix</comment>',
      '</user_review>',
      '```',
    ].join('\n');

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'markdown', content },
    ]);
  });

  it('leaves XML inside indented code blocks as markdown', () => {
    const content = [
      '    <user_review>',
      '    <comment index="1">fix</comment>',
      '    </user_review>',
    ].join('\n');

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'markdown', content },
    ]);
  });

  it('leaves unknown inline XML alone', () => {
    const content = 'Use <tag>value</tag> as example.';

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'markdown', content },
    ]);
  });

  it('splits multi-comment user review prompts', () => {
    const content = [
      '<user_review>',
      '<comment index="1" type="message">',
      '  <quoted_text>',
      'Hysteresis still needed?',
      '  </quoted_text>',
      '  <instruction>',
      'what is this ?',
      '  </instruction>',
      '</comment>',
      '',
      '<comment index="2" type="message">',
      '  <quoted_text>',
      'Last entry without threshold = absolute fallback?',
      '  </quoted_text>',
      '  <instruction>',
      'yes',
      '  </instruction>',
      '</comment>',
      '',
      '</user_review>',
    ].join('\n');

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'prompt-xml', tag: 'user_review', content },
    ]);
  });

  it('treats truncated prompt XML as a block through end of content', () => {
    const content = [
      '<user_review>',
      '<comment index="1" type="message">',
      '  <quoted_text>',
      'Hysteresis still needed?',
    ].join('\n');

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'prompt-xml', tag: 'user_review', content },
    ]);
  });

  it('splits prompt XML from surrounding markdown', () => {
    const content = [
      'Before',
      '<user_review>',
      '<comment>yes</comment>',
      '</user_review>',
      'After',
    ].join('\n');

    expect(splitPromptXmlSegments(content)).toEqual([
      { type: 'markdown', content: 'Before' },
      {
        type: 'prompt-xml',
        tag: 'user_review',
        content: '<user_review>\n<comment>yes</comment>\n</user_review>',
      },
      { type: 'markdown', content: 'After' },
    ]);
  });
});
