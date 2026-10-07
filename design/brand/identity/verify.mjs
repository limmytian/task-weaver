import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8'));
const css = readFileSync(new URL('tokens.css', root), 'utf8');
function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
    .map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return values.reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
}
const checks = [];
for (const mode of ['light', 'dark']) {
  const t = tokens[mode];
  for (const [name, value] of Object.entries(t)) {
    assert.match(value, /^#[0-9a-f]{6}$/);
    assert.ok(css.includes(`--${name.replace(/[A-Z]/g, x => `-${x.toLowerCase()}`)}: ${value};`));
  }
  for (const [fg, bg, minimum] of [
    ['foreground', 'background', 4.5], ['cardForeground', 'card', 4.5],
    ['mutedForeground', 'muted', 4.5], ['primaryForeground', 'primary', 4.5],
    ['primaryForeground', 'primaryHover', 4.5], ['accentForeground', 'accent', 4.5],
    ['link', 'background', 4.5], ['link', 'card', 4.5],
    ['brandSecondary', 'background', 3], ['ring', 'background', 3], ['ring', 'card', 3],
    ['input', 'background', 3], ['input', 'card', 3],
    ['sidebarForeground', 'sidebar', 4.5], ['sidebarPrimaryForeground', 'sidebarPrimary', 4.5],
    ['sidebarAccentForeground', 'sidebarAccent', 4.5], ['sidebarRing', 'sidebar', 3],
  ]) {
    const [low, high] = [luminance(t[fg]), luminance(t[bg])].sort((a, b) => a - b);
    const ratio = (high + 0.05) / (low + 0.05);
    assert.ok(ratio >= minimum, `${mode} ${fg}/${bg}: ${ratio} < ${minimum}`);
    checks.push({ mode, foreground: fg, background: bg, minimum, ratio: Number(ratio.toFixed(2)) });
  }
}
const report = { method: 'WCAG relative luminance for opaque sRGB pairs; no complete UI conformance claim', checks };
if (process.argv.includes('--write')) writeFileSync(new URL('contrast.json', root), JSON.stringify(report, null, 2) + '\n');
else assert.deepEqual(JSON.parse(readFileSync(new URL('contrast.json', root), 'utf8')), report);
console.log(`${checks.length} contrast pairs and CSS token mappings verified (${fileURLToPath(root)}).`);
