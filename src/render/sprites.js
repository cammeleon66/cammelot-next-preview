// Portrait drawing and seeded helpers: original Cammelot contributors, MIT.
// Read-only extraction from site/minister.html; see ../../assets/CREDITS.md.
export const PALETTE_TOKENS = ['--m-blue', '--m-blue2', '--m-blue3', '--m-gold', '--m-amber', '--m-white', '--m-paper', '--m-paperink', '--m-green', '--m-red', '--m-cyan', '--bg', '--frame', '--parchment'];

export function validatePalette(pixels, palette) {
  if (pixels.length % 4 !== 0) throw new TypeError('Expected RGBA pixel data');
  const allowed = new Set(palette.map(hex => hex.toLowerCase()));
  if (!allowed.size || [...allowed].some(hex => !/^#[0-9a-f]{6}$/.test(hex))) throw new TypeError('Expected six-digit palette colours');
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const hex = '#' + Array.from(pixels.slice(i, i + 3), n => n.toString(16).padStart(2, '0')).join('');
    if (pixels[i + 3] !== 255 || !allowed.has(hex)) throw new Error(`Atlas pixel ${i / 4} violates palette lock: ${hex}`);
  }
}

// JSON: { image: "town.png", frames: { name: { x, y, w, h } } }.
// Explicit palettes support headless fixtures; browsers default to the theme tokens.
export async function loadAtlas(url, { palette } = {}) {
  const manifestURL = new URL(url, document.baseURI);
  const response = await fetch(manifestURL);
  if (!response.ok) throw new Error(`Atlas manifest HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest || typeof manifest.image !== 'string' || !manifest.image || !manifest.frames ||
      typeof manifest.frames !== 'object' || Array.isArray(manifest.frames) || !Object.keys(manifest.frames).length) {
    throw new TypeError('Atlas requires an image and named frames');
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = new URL(manifest.image, manifestURL).href;
  await image.decode();
  const frames = Object.create(null);
  for (const [name, frame] of Object.entries(manifest.frames)) {
    if (!frame || !['x', 'y', 'w', 'h'].every(key => Number.isSafeInteger(frame[key])) ||
        frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0 ||
        frame.x + frame.w > image.naturalWidth || frame.y + frame.h > image.naturalHeight) {
      throw new RangeError(`Invalid atlas frame: ${name}`);
    }
    frames[name] = Object.freeze({ x: frame.x, y: frame.y, w: frame.w, h: frame.h });
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  validatePalette(context.getImageData(0, 0, canvas.width, canvas.height).data,
    palette ?? PALETTE_TOKENS.map(token => styles.getPropertyValue(token).trim()));
  return Object.freeze({ image, frames: Object.freeze(frames), draw(context, name, x, y, scale = 1) {
    if (!Object.hasOwn(frames, name)) throw new RangeError(`Unknown atlas frame: ${name}`);
    if (![x, y, scale].every(Number.isSafeInteger) || scale < 1) throw new RangeError('Atlas drawing requires integer positions and positive integer scale');
    const f = frames[name];
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(image, f.x, f.y, f.w, f.h, x, y, f.w * scale, f.h * scale);
    context.restore();
  } });
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function seededRandom(seed) {
  let s = seed || 1;
  return () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };
}

export function generatePortrait(id, looks, age, gender, hp) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const isDead = hp <= 0;
  const isCritical = hp > 0 && hp < 20;
  const isSick = hp >= 20 && hp < 50;

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16), gr = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return [r, gr, b];
  }
  function rgbToHex(r, gr, b) {
    return '#' + [r,gr,b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
  }

  let skinRgb = hexToRgb(looks.skin);
  let skinColor = looks.skin;
  if (isSick) {
    skinRgb = skinRgb.map(v => Math.min(255, v + 30));
    skinColor = rgbToHex(...skinRgb);
  } else if (isCritical) {
    skinRgb = skinRgb.map(v => Math.min(255, v + 55));
    skinColor = rgbToHex(...skinRgb);
  }

  const skinDark = rgbToHex(skinRgb[0] - 35, skinRgb[1] - 35, skinRgb[2] - 30);
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

  // ── GBC-style portrait: big round head, huge eyes ──
  // Face shape — round, GBC proportions (head fills most of 64×64)
  px(12, 10, 40, 44, skinColor);   // core face
  px(8, 14, 48, 36, skinColor);    // wider middle
  px(16, 6, 32, 8, skinColor);     // forehead
  px(16, 50, 32, 8, skinColor);    // chin
  // Rounded corners
  px(10, 12, 4, 4, skinColor);
  px(50, 12, 4, 4, skinColor);
  px(10, 48, 4, 4, skinColor);
  px(50, 48, 4, 4, skinColor);

  // ── Eyes — BIG Pokemon-style (dominant feature) ──
  // Left eye
  px(14, 24, 14, 12, '#FFFFFF');    // white
  px(14, 24, 14, 3, '#1A1A2A');    // eyelid top
  px(20, 28, 6, 8, '#1A1A2A');     // pupil
  px(22, 28, 3, 3, '#FFFFFF');     // highlight
  // Right eye
  px(36, 24, 14, 12, '#FFFFFF');    // white
  px(36, 24, 14, 3, '#1A1A2A');    // eyelid top
  px(40, 28, 6, 8, '#1A1A2A');     // pupil
  px(42, 28, 3, 3, '#FFFFFF');     // highlight

  // Nose — subtle, just a shadow pixel
  px(30, 38, 4, 3, skinDark);

  // Mouth
  if (isSick || isCritical) {
    px(24, 44, 16, 2, '#C08070');
    px(22, 43, 4, 2, '#C08070');   // droopy
  } else {
    px(24, 44, 16, 2, '#C08070');
    px(26, 46, 12, 2, '#C08070');  // slight smile
  }

  // Critical: reddish cheeks
  if (isCritical) {
    g.fillStyle = 'rgba(229, 57, 53, 0.3)';
    g.fillRect(10, 36, 10, 6);
    g.fillRect(44, 36, 10, 6);
  }

  // Elderly: wrinkle lines + glasses chance
  if (age >= 65) {
    const wrinkleColor = rgbToHex(skinRgb[0] - 25, skinRgb[1] - 25, skinRgb[2] - 20);
    px(16, 34, 8, 1, wrinkleColor);  // under left eye
    px(40, 34, 8, 1, wrinkleColor);  // under right eye
    px(22, 48, 4, 1, wrinkleColor);  // laugh line left
    px(38, 48, 4, 1, wrinkleColor);  // laugh line right
    // Glasses for some elderly
    const rng = seededRandom(hashCode(id) + 99);
    if (rng() < 0.4) {
      g.strokeStyle = '#3A3A5A';
      g.lineWidth = 2;
      g.strokeRect(12, 22, 18, 16);
      g.strokeRect(34, 22, 18, 16);
      g.beginPath(); g.moveTo(30, 30); g.lineTo(34, 30); g.stroke();
    }
  }

  // ── Hair — GBC 8-type system ──
  const hc = looks.hair;
  switch(looks.hType) {
    case 0: // Short crop
      px(10, 4, 44, 12, hc);
      px(8, 8, 6, 16, hc);
      px(50, 8, 6, 16, hc);
      break;
    case 1: // Medium with bangs
      px(8, 2, 48, 14, hc);
      px(6, 8, 8, 18, hc);
      px(50, 8, 8, 18, hc);
      px(14, 12, 16, 6, hc); // bangs over forehead
      break;
    case 2: // Buzz/bald
      px(14, 4, 36, 10, hc);
      px(10, 6, 6, 8, hc);
      px(48, 6, 6, 8, hc);
      break;
    case 3: // Long straight (female)
      px(8, 2, 48, 12, hc);
      px(4, 6, 10, 36, hc);
      px(50, 6, 10, 36, hc);
      px(4, 42, 10, 12, hc);
      px(50, 42, 10, 12, hc);
      break;
    case 4: // Cap/hat
      px(6, 0, 52, 14, hc);
      px(4, 12, 56, 4, hc); // brim
      px(8, 2, 48, 6, rgbToHex(...hexToRgb(hc).map(v => Math.min(255, v + 30))));
      break;
    case 5: // Ponytail
      px(10, 2, 44, 12, hc);
      px(6, 8, 8, 16, hc);
      px(50, 8, 8, 16, hc);
      px(50, 14, 10, 6, hc); // ponytail bump
      px(56, 18, 6, 14, hc); // ponytail tail
      break;
    case 6: // Curly/afro
      px(4, 0, 56, 16, hc);
      px(2, 6, 8, 28, hc);
      px(54, 6, 8, 28, hc);
      px(6, -2, 52, 6, hc); // extra volume top
      break;
    case 7: // Elderly/thin
      px(14, 4, 36, 8, hc);
      px(10, 6, 8, 8, hc);
      px(46, 6, 8, 8, hc);
      break;
  }

  // Dead: apply greyscale
  if (isDead) {
    const imgData = g.getImageData(0, 0, 64, 64);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const avg = d[i] * 0.3 + d[i+1] * 0.59 + d[i+2] * 0.11;
      d[i] = d[i+1] = d[i+2] = avg;
    }
    g.putImageData(imgData, 0, 0);
  }

  return c;
}
