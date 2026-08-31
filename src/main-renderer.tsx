// Side-effect imports: both patch localStorage on evaluation, and must stay the
// FIRST imports in this file — module bodies run after their imports, so
// anything evaluated earlier (react-scan, the persisted stores pulled in via
// ./app) would read and write localStorage before the patches are installed.
//
// Order between the two is load-bearing. Both wrap `setItem` on the
// `localStorage` instance, each capturing whatever it resolves to at install
// time, so the later install ends up outermost. Diagnostic first, guard second,
// gives caller -> guard -> diagnostic -> real write: a withheld write is
// withheld before the diagnostic reports it as written. Flip them and the guard
// would sit underneath, so the diagnostic's captured reference would still reach
// the real bucket.
// eslint-disable-next-line import/order
import './lib/debug-local-storage';
// eslint-disable-next-line import/order
import './lib/local-storage-boot-guard';

import { createRoot } from 'react-dom/client';
import { scan } from 'react-scan';
import { StrictMode } from 'react';

import App from './app';

import './index.css';

document.documentElement.dataset.reduceMotion = 'true';

function getInitialReactScanEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem('ui-store');
    if (!raw) return false;

    const parsed = JSON.parse(raw) as {
      state?: { settings?: { reactScanEnabled?: unknown } };
    };
    return parsed.state?.settings?.reactScanEnabled === true;
  } catch {
    return false;
  }
}

const reactScanEnabled = getInitialReactScanEnabled();

if (reactScanEnabled) {
  window.localStorage.removeItem('react-scan-options');

  scan({
    enabled: true,
    showToolbar: true,
    animationSpeed: 'fast',
    dangerouslyForceRunInProduction: true,
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
