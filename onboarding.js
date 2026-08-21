// Onboarding page helpers. External file because extension-page CSP
// disallows inline scripts.
(() => {
  'use strict';

  const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  if (!isMac) {
    for (const el of document.querySelectorAll('kbd[data-key="mod"]')) {
      el.textContent = 'Ctrl';
    }
    for (const el of document.querySelectorAll('kbd[data-key="copy"]')) {
      el.textContent = 'Ctrl+C';
    }
  }

  // Real version from the manifest when running as an extension page.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
    const el = document.getElementById('version');
    if (el) el.textContent = chrome.runtime.getManifest().version;
  }
})();
