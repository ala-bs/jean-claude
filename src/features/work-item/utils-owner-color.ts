const OWNER_COLORS = [
  'oklch(0.78 0.15 15)',
  'oklch(0.78 0.15 30)',
  'oklch(0.8 0.14 45)',
  'oklch(0.82 0.14 60)',
  'oklch(0.82 0.14 75)',
  'oklch(0.8 0.14 90)',
  'oklch(0.78 0.14 105)',
  'oklch(0.77 0.14 120)',
  'oklch(0.77 0.14 135)',
  'oklch(0.77 0.14 150)',
  'oklch(0.77 0.13 165)',
  'oklch(0.78 0.12 180)',
  'oklch(0.79 0.12 195)',
  'oklch(0.79 0.13 210)',
  'oklch(0.78 0.14 225)',
  'oklch(0.77 0.15 240)',
  'oklch(0.76 0.16 255)',
  'oklch(0.76 0.16 270)',
  'oklch(0.77 0.16 285)',
  'oklch(0.77 0.16 300)',
  'oklch(0.77 0.16 315)',
  'oklch(0.77 0.16 330)',
  'oklch(0.77 0.15 345)',
  'oklch(0.72 0.11 205)',
  'oklch(0.72 0.12 290)',
] as const;

export const OWNER_COLOR_COUNT = OWNER_COLORS.length;

export function normalizeOwnerName(ownerName: string) {
  return ownerName.trim().normalize('NFKC').toLowerCase();
}

export function getOwnerColor(ownerName: string) {
  const normalized = normalizeOwnerName(ownerName);
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return OWNER_COLORS[(hash >>> 0) % OWNER_COLORS.length];
}
