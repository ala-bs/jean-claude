// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { getDropdownMenuItems } from '@/common/ui/dropdown';

describe('getDropdownMenuItems', () => {
  it('includes checked and radio menu items in keyboard navigation', () => {
    const menu = document.createElement('div');
    menu.innerHTML = `
      <button role="menuitem" tabindex="-1">Action</button>
      <button role="menuitemcheckbox" tabindex="-1">Column</button>
      <button role="menuitemradio" tabindex="-1">Choice</button>
      <div role="menuitemcheckbox">Disabled current value</div>
    `;

    expect(getDropdownMenuItems(menu).map((item) => item.textContent)).toEqual([
      'Action',
      'Column',
      'Choice',
    ]);
  });
});
