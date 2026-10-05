// ゲームパッドのボタンの絵。特定の製品名やロゴは使わず、形だけを単色の線で描く
// type1: ✕ ○ □ △ の記号の配置 / type2: A B X Y の文字の配置

const FONT = "system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', sans-serif";
const svg = (w, body) =>
  `<svg class="g" viewBox="0 0 ${w} 24" width="${w}" height="24" aria-hidden="true" focusable="false">${body}</svg>`;
const ring = '<circle cx="12" cy="12" r="10.4" fill="none" stroke="currentColor" stroke-width="1.3"/>';
const line = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const letter = (t, x = 12, size = 11.5) =>
  `<text x="${x}" y="12.7" text-anchor="middle" dominant-baseline="middle" font-size="${size}" font-family="${FONT}" font-weight="600" fill="currentColor">${t}</text>`;
const pill = (w, inner) =>
  svg(w, `<rect x="1" y="5" width="${w - 2}" height="14" rx="7" fill="none" stroke="currentColor" stroke-width="1.3"/>${inner}`);
const stick = (t) =>
  svg(
    24,
    `${ring}<circle cx="12" cy="12" r="6.8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55"/>${letter(t, 12, 9.5)}`,
  );

const TYPE1 = {
  south: svg(24, `${ring}<path d="M8.3 8.3 L15.7 15.7 M15.7 8.3 L8.3 15.7" ${line}/>`),
  east: svg(24, `${ring}<circle cx="12" cy="12" r="4.7" ${line}/>`),
  west: svg(24, `${ring}<rect x="7.9" y="7.9" width="8.2" height="8.2" ${line}/>`),
  north: svg(24, `${ring}<path d="M12 7.1 L16.7 15.3 L7.3 15.3 Z" ${line}/>`),
  start: pill(
    60,
    `<text x="30" y="12.7" text-anchor="middle" dominant-baseline="middle" font-size="8.4" letter-spacing="0.35" font-family="${FONT}" font-weight="600" fill="currentColor">OPTIONS</text>`,
  ),
  ls: stick('L'),
  rs: stick('R'),
};

const TYPE2 = {
  south: svg(24, ring + letter('A')),
  east: svg(24, ring + letter('B')),
  west: svg(24, ring + letter('X')),
  north: svg(24, ring + letter('Y')),
  start: pill(32, `<path d="M11 9.3 H21 M11 12 H21 M11 14.7 H21" ${line}/>`),
  ls: stick('L'),
  rs: stick('R'),
};

export function glyph(name, type) {
  return (type === 'type1' ? TYPE1 : TYPE2)[name] ?? '';
}

// 文字列の {south} などをボタンの絵に置き換える
export function withGlyphs(text, type) {
  return text.replace(/\{(south|east|west|north|start|ls|rs)\}/g, (_, k) => glyph(k, type));
}

// ゲームパッドの名前から、どちらの配置に近いかを推測する
export function detectPadType(id = '') {
  const s = id.toLowerCase();
  if (/xbox|xinput|045e/.test(s)) return 'type2';
  if (/054c|sony|playstation|dualshock|dualsense|wireless controller/.test(s)) return 'type1';
  return 'type2';
}
