export function parsePastedArguments(value: string): string[] | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  if (/\r?\n/.test(value)) {
    return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  return null;
}

export function parsePastedEnvironment(
  value: string,
): { key: string; value: string }[] | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((item) => typeof item === 'string')) {
        return Object.entries(parsed).map(([key, item]) => ({ key, value: item as string }));
      }
    } catch {
      return null;
    }
  }
  if (/\r?\n/.test(value)) {
    const entries = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return separator < 1 ? null : { key: line.slice(0, separator).trim(), value: line.slice(separator + 1) };
    });
    if (entries.every((entry) => entry !== null)) return entries;
  }
  return null;
}
