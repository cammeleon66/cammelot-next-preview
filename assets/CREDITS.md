# V2 asset provenance

| Asset | Author / source | Licence | Date |
|---|---|---|---|
| Procedural 64×64 resident portraits and ID-seeded appearance helpers in `src/render/sprites.js` | Original Cammelot project contributors, `site/minister.html` lines 2874–2882 and 3467–3621; extracted read-only, drawing preserved; removed global portrait cache | MIT (original project's `package.json` licence declaration) | 2026-10-28 |
| Theme palette | Original Cammelot project contributors; `docs/VISUAL_DIRECTION.md`, extracted from Minister | MIT | 2026-10-28 |
| Isometric tile polygons, Dutch houses, care buildings, trees, market stalls, bikes and walkers in `src/render/city.js`; hand-authored `src/world/neighbourhood.json` | Cammelot V2 contributors; original procedural pixel art and fictional layout, palette tokens only | MIT | 2026-10-28 |

No third-party game assets, remote fonts, generated AI images or shipped atlas images.
Font names are local preferences with system fallbacks; no font files are bundled or fetched.
The test-only atlas is a procedurally drawn palette-colour square, not a game asset.
Future atlases belong in `assets/atlas/` with PNG + JSON, source art in `assets/src/`;
add author, licence and date here before shipping. The loader rejects off-palette opaque pixels.
Legacy portraits intentionally retain their original skin/hair colours and are not atlas assets.
