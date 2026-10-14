import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The mascot geometry lives in src/brand/mascot.json, shared with the inline
// <BrandMark /> component. Shapes use a 1024 × 1024 canvas; the app tile
// follows the macOS 824px icon grid.
const tauri = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
const { tile: box, body, notch, eyes: eyeList, blush } = JSON.parse(readFileSync('src/brand/mascot.json', 'utf8'));
const eyes = eyeList.map(e => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" transform="rotate(${e.rotate} ${e.cx} ${e.cy})"/>`).join('');
const glints = eyeList.map(e => `<circle cx="${e.glint[0]}" cy="${e.glint[1]}" r="${e.glint[2]}"/>`).join('');

// Raster icons get a blurred drop shadow; SVGs shown in the WebView use an
// offset shape instead because WebKit rasterises filtered SVG images at 1x.
const tile = (id = '', blur = true) => `<defs>
    <linearGradient id="tile${id}" x1="0" y1="0" x2="0.35" y2="1"><stop stop-color="${box.from}"/><stop offset="1" stop-color="${box.to}"/></linearGradient>
    <linearGradient id="body${id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFE6D6"/></linearGradient>
    <mask id="notch${id}"><rect width="1024" height="1024" fill="#fff"/><path d="${notch}" fill="#000"/></mask>${blur ? `
    <filter id="lift${id}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#8A2200" flood-opacity=".32"/></filter>` : ''}
  </defs>
  <rect x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" rx="${box.radius}" fill="url(#tile${id})"/>${blur
    ? `<g filter="url(#lift${id})"><path mask="url(#notch${id})" fill="url(#body${id})" d="${body}"/></g>`
    : `<path mask="url(#notch${id})" transform="translate(0 18)" fill="#A82E08" opacity=".22" d="${body}"/><path mask="url(#notch${id})" fill="url(#body${id})" d="${body}"/>`}
  <g fill="#FF8A5C" opacity=".35">${blush.map(([cx, cy]) => `<ellipse cx="${cx}" cy="${cy}" rx="40" ry="22"/>`).join('')}</g>
  <g fill="#1B1D22">${eyes}</g>
  <g fill="#fff">${glints}</g>`;

const run = (...args) => {
  const result = spawnSync(process.execPath, [tauri, 'icon', ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Menu bar icons use only the silhouette with the eyes cut out; macOS supplies the tint.
const trayDirectory = 'src-tauri/icons-tray';
mkdirSync(trayDirectory, { recursive: true });
writeFileSync(`${trayDirectory}/icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="196 190 632 632">
  <mask id="face"><rect width="1024" height="1024" fill="#fff"/><path d="${notch}" fill="#000"/><g fill="#000">${eyes}</g></mask>
  <path mask="url(#face)" fill="#000" d="${body}"/>
</svg>\n`);
run(`${trayDirectory}/icon.svg`, '--output', trayDirectory, '--png', '44');
if (process.argv.includes('--tray-only')) process.exit(0);

// In-app mark and favicon: the tile cropped to its own bounds.
writeFileSync('public/logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 824 824" role="img" aria-labelledby="title">
  <title id="title">AutoJev</title>
  ${tile('', false)}
</svg>\n`);

writeFileSync('public/brand/autojev-logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" role="img" aria-labelledby="title">
  <title id="title">AutoJev</title>
  <svg x="12" y="12" width="72" height="72" viewBox="100 100 824 824">${tile('-mark', false)}</svg>
  <text x="98" y="62" fill="#10131A" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="49" font-weight="700" letter-spacing="-2.2">AutoJev</text>
</svg>\n`);

// Desktop icons share the tile; development builds add a DEV badge.
for (const dev of [false, true]) {
  const directory = dev ? 'src-tauri/icons-dev' : 'src-tauri/icons';
  mkdirSync(directory, { recursive: true });
  const badge = dev ? `
  <rect x="648" y="738" width="290" height="160" rx="44" fill="#FFF4EA"/>
  <rect x="660" y="750" width="266" height="136" rx="34" fill="#1B1D22"/>
  <g transform="translate(690 785)" fill="none" stroke="#FFF8EF" stroke-width="13" stroke-linejoin="round">
    <path d="M0 0v66h20q26 0 26-33T20 0Z"/><path d="M110 0H69v66h41M69 32h34"/><path d="m131 0 24 66 24-66"/>
  </g>` : '';
  writeFileSync(`${directory}/icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${tile()}${badge}
</svg>\n`);
  run(`${directory}/icon.svg`, '--output', directory);
  const keep = new Set(['icon.svg', 'icon.png', 'icon.icns', 'icon.ico', '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png']);
  for (const file of readdirSync(directory)) {
    if (!keep.has(file)) rmSync(`${directory}/${file}`, { recursive: true, force: true });
  }
}
// README and the About panel use the release icon as a PNG.
copyFileSync('src-tauri/icons/icon.png', 'public/brand/app-icon.png');
