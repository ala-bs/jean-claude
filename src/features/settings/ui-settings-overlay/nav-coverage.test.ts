import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Guards against a settings panel becoming an orphan.
 *
 * This has happened twice. `BackendsSettings` (the enable/disable backend
 * control) was only ever rendered inside the global model-presets panel; when
 * that panel was deleted the control silently vanished from the app while
 * still compiling, still exported, and still passing lint. The same class of
 * bug stranded the profile switcher and the rate-limit banner earlier.
 *
 * A source-level check is the right shape here: the failure mode is "declared
 * but never rendered", which type-checking and lint cannot see.
 */
const OVERLAY = new URL('./index.tsx', import.meta.url);

function overlaySource() {
  return readFileSync(OVERLAY, 'utf8');
}

describe('settings overlay navigation', () => {
  it.each([
    ['BackendsSettings', 'coding-agents:backends'],
    ['ModelProfilesSettings', 'coding-agents:profiles'],
    ['ModelFallbackOrderSettings', 'coding-agents:rate-limit-swap'],
  ])('renders %s from a reachable nav entry', (component, route) => {
    const source = overlaySource();

    // the route renders the component
    expect(source).toContain(`case '${route}':`);
    expect(source).toMatch(
      new RegExp(`case '${route}':\\s*\\n\\s*return <${component}\\s*/>`),
    );

    // and the nav actually offers that route
    const [, sub] = route.split(':');
    expect(source).toMatch(new RegExp(`id: '${sub}'`));
  });
});
