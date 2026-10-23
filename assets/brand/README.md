# nightgem brand assets

Name: **nightgem** (always lowercase, one word). The idea: a night shift. A foreman hands rough stones to parallel specialists; in the morning there are cut gems (verified branches and a report).

All SVGs are hand-authored (generated once, then kept as plain files), pure SVG, no fonts, scripts or embedded images. Open `preview.html` to see everything on dark and light backgrounds.

## Palette (Dracula)

| Name | Hex | Used for |
|---|---|---|
| Background | `#282A36` | factory wall, page background |
| Darker | `#21222C` | night sky |
| Darkest | `#191A21` | sky edge, floor |
| Current Line | `#44475A` | belts, machines |
| Foreground | `#F8F8F2` | text, moon, diamond highlights |
| Comment | `#6272A4` | raw stones, details |
| Cyan | `#8BE9FD` | diamond, sapphire, explorer |
| Green | `#50FA7B` | emerald, logo, approval |
| Orange | `#FFB86C` | topaz, dawn, fixer |
| Pink | `#FF79C6` | ruby accents, designer |
| Purple | `#BD93F9` | amethyst, oracle reviewer |
| Red | `#FF5555` | ruby |
| Yellow | `#F1FA8C` | lights, topaz, hard hats |

Facet tints and shades are derived from these (for example emerald runs `#B6FFCC` to `#1B8A42`).

## Gems

| Gem | Cut | Colour |
|---|---|---|
| Emerald | step cut (the logo) | Green |
| Ruby | round brilliant | Red / Pink |
| Diamond | classic profile | Foreground / Cyan |
| Sapphire | oval brilliant | Cyan / Purple blend |
| Amethyst | hexagon | Purple |
| Topaz | princess | Orange / Yellow |

Roles: foreman (orchestrator) yellow hat, fixer orange, designer pink, explorer cyan, oracle reviewer purple with a loupe.

## Usage

- Minimum size: mark 16 px (use `favicon.svg` below 32 px), wordmark 120 px wide.
- Clear space: keep at least a quarter of the mark's width free on every side.
- The mark works on dark and light. Use `logo-wordmark.svg` on dark, `logo-wordmark-light.svg` on light.
- Do: use the files as is, scale proportionally, use the mono mark for one-colour contexts.
- Don't: recolour the emerald, stretch, add shadows or outlines, rotate, put the full-colour mark on busy or green backgrounds, or re-typeset the wordmark (the letters are drawn paths; the dot of the "i" is a tiny emerald).
- The name can change: only `logo-wordmark*.svg`, `hero.svg` (title and tagline) and `social-card.svg` carry it.

## Files

| File | Purpose |
|---|---|
| `logo-mark.svg` | Emerald mark, transparent |
| `logo-mark-mono.svg` | One colour, uses `currentColor` (inline it or set `color`; as `<img>` it renders black) |
| `logo-wordmark.svg` / `logo-wordmark-light.svg` | Mark and name, for dark / light backgrounds |
| `hero.svg`, `hero.png`, `hero@2x.png` | README banner, 1600 x 560 |
| `social-card.svg`, `social-card.png` | GitHub social preview, 1280 x 640 |
| `favicon.svg`, `favicon-32.png`, `favicon-16.png` | Simplified mark for small sizes |
| `logo-mark-512.png`, `logo-mark-256.png` | Raster marks |
| `preview.html` | Review page |

PNGs were rendered with `@resvg/resvg-js-cli`. The hero tagline and the social card text use the system font stack `ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`, so they vary slightly by platform; `social-card.png` is the fixed rendering.

## Alt text

- Mark: "nightgem logo, a green emerald-cut gem"
- Wordmark: "nightgem"
- Hero: "A night-shift factory: a foreman places rough stones on a conveyor that splits into three lanes, where workers turn them into cut gems, checked by an inspector with a loupe"
- Social card: "nightgem: write the spec, sleep, wake up to reviewed branches"
