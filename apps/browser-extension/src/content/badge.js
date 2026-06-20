function mountBadgeHost() {
  return document.body || document.documentElement;
}

export function showBadge(text) {
  let badge = document.getElementById('privacyai-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'privacyai-badge';
    badge.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
      'z-index:2147483647',
      'padding:6px 10px',
      'border-radius:6px',
      'background:#111',
      'color:#fff',
      'font:12px/1.4 sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)'
    ].join(';');
    mountBadgeHost().appendChild(badge);
  }
  badge.textContent = text;
}
