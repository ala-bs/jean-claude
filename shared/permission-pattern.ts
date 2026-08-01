/** Returns true when pattern contains supported digit-regex syntax. */
export function containsDigitRegex(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '\\') continue;
    if (pattern[index + 1] === '\\') {
      index += 1;
      continue;
    }
    if (pattern[index + 1] === 'd') return true;
  }
  return false;
}

function globToRegex(pattern: string, isBash: boolean): string {
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && pattern[index + 1] === 'd') {
      regex += '\\d';
      index += 1;
      if (pattern[index + 1] === '+') {
        regex += '+';
        index += 1;
      } else if (pattern[index + 1] === '{') {
        const quantifier = pattern.slice(index + 1).match(/^\{\d+\}/)?.[0];
        if (quantifier) {
          regex += quantifier;
          index += quantifier.length;
        }
      }
    } else if (char === '\\' && index + 1 < pattern.length) {
      regex += pattern[index + 1].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      index += 1;
    } else if (char === '*') {
      regex += isBash ? '.*' : '[^/]*';
    } else if (char === '?') {
      regex += isBash ? '.' : '[^/]';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return regex;
}

function replaceDigitRegexTokens(pattern: string): {
  pattern: string;
  replacements: Array<{ marker: string; replacement: string }>;
} {
  let result = '';
  const replacements: Array<{ marker: string; replacement: string }> = [];

  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '\\' || pattern[index + 1] !== 'd') {
      result += pattern[index];
      continue;
    }

    let replacement = '\\d';
    index += 1;
    if (pattern[index + 1] === '+') {
      replacement += '+';
      index += 1;
    } else if (pattern[index + 1] === '{') {
      const quantifier = pattern.slice(index + 1).match(/^\{\d+\}/)?.[0];
      if (quantifier) {
        replacement += quantifier;
        index += quantifier.length;
      }
    }

    let markerSuffix = 0;
    let marker = '';
    do {
      marker = `__JEAN_CLAUDE_DIGIT_${replacements.length}_${markerSuffix}__`;
      markerSuffix += 1;
    } while (pattern.includes(marker));
    result += marker;
    replacements.push({ marker, replacement });
  }

  return { pattern: result, replacements };
}

/** Match glob patterns, with optional digit-regex tokens. */
export function matchPermissionPattern(
  pattern: string,
  value: string,
  isBash: boolean,
): boolean {
  if (pattern === '*') return true;
  if (!containsDigitRegex(pattern)) return false;
  if (isBash) {
    return new RegExp(`^${globToRegex(pattern, true)}$`).test(value);
  }

  const tokenized = replaceDigitRegexTokens(pattern);
  let regexSource = picomatch.makeRe(tokenized.pattern, { dot: true }).source;
  tokenized.replacements.forEach(({ marker, replacement }) => {
    regexSource = regexSource.replaceAll(marker, replacement);
  });
  return new RegExp(regexSource).test(value);
}
import picomatch from 'picomatch';
