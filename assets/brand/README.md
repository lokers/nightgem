# nightgem brand assets

Name: the logotype is uppercase, **NIGHTGEM**, as in the wordmark, the hero and the social card. In running text (README, docs, commands, release notes) the name is written `nightgem`: lowercase, one word, never "NightGem" or "Nightgem". The uppercase form belongs to the drawn logo only; do not type it in prose.

The idea: a night shift. Robot workers cut rough stones in an isometric gem factory, under a night sky that turns into dawn. Spec at dusk, gems at dawn: in the morning there are cut gems (verified local branches and a report).

All SVGs are hand-authored (generated once, then kept as plain files), pure SVG with no fonts or scripts. The README hero is a raster illustration (`hero.jpg`), stored with its metadata stripped, and it is the reference for everything here. Open `preview.html` to see every asset on dark and light backgrounds.

## Palette

Sampled from `hero.jpg`.

| Name | Hex | Used for |
|---|---|---|
| Night | `#141A32` | sky on the left, dark page and card background, darkening gradient |
| Night deep | `#101528` | card gradient edge |
| Indigo | `#3C3560` | sky mid-tone, borders |
| Dusk purple | `#5B4065` | sky towards the dawn |
| Plum | `#78516C` | lower sky, transition to dawn |
| Dawn peach | `#E0976C` | sunrise haze |
| Dawn orange | `#FDBB6F` | sunrise accent (use sparingly) |
| Dawn glow | `#FDF0C4` | brightest sunrise, the pitch line on the social card |
| Title grey | `#E3E3F0` | NIGHTGEM letters and tagline on dark |
| Slate | `#232842` | NIGHTGEM letters on light backgrounds |
| Robot light | `#5B6681` | lit metal on the robot workers |
| Robot mid | `#4B5364` | robot body |
| Robot dark | `#364057` | robot shadow, machines |
| Deck | `#292D44` | factory floor |
| Emerald light | `#9AF0B2` | top-left highlight facet |
| Emerald | `#4BE07A` | emerald table (centre), accent rule, "verified" green |
| Emerald mid | `#2F9A5A` | side facets |
| Emerald shadow | `#1A7A45` | shadow facets |
| Emerald outline | `#14583A` | outline of the mark |

The emerald is the only saturated green. Everything else is a cool night tone with warm dawn accents on the right.

## The mark

A faceted step-cut (octagonal) emerald with a table in the centre. The table has one cut corner at the lower right, the top-left bevel catches the light, and the right and lower-right facets are in shadow, as in the hero. `favicon.svg` has fewer facets and a thicker outline so it reads at 16 px. `logo-mark-mono.svg` is a one-colour version (ring, gap and table) that uses `currentColor`.

## Usage

- Minimum size: mark 16 px (use `favicon.svg` below 32 px), wordmark 120 px wide.
- Clear space: keep at least a quarter of the mark's width free on every side.
- The mark works on dark and light. Use `logo-wordmark.svg` on dark (light grey letters), `logo-wordmark-light.svg` on light (dark slate letters). In both, the emerald comes after the word.
- Do: use the files as is, scale proportionally, use the mono mark for one-colour contexts.
- Don't: recolour the emerald, stretch, add shadows or outlines, rotate, put the full-colour mark on busy or green backgrounds, or re-typeset the wordmark (the letters are drawn as SVG paths, not text, so they look the same everywhere).
- The name can change: `logo-wordmark*.svg` and `social-card.svg` carry it, and so does `hero.jpg` (title and tagline drawn into the image), which would need replacing.
- Tagline: "Spec at dusk. Gems at dawn." (uppercase in the hero, sentence case elsewhere).

## Files

| File | Purpose |
|---|---|
| `logo-mark.svg` | Emerald mark, transparent, 100 x 100 viewBox |
| `logo-mark-mono.svg` | One colour, uses `currentColor` (inline it or set `color`; as `<img>` it renders black) |
| `logo-wordmark.svg` / `logo-wordmark-light.svg` | Name (drawn letters) and mark, for dark / light backgrounds |
| `hero.jpg` | README banner, 1720 x 608 |
| `social-card.png` | GitHub social preview, 1280 x 640, under 1 MB, no metadata |
| `social-card.svg` | Source of the card. **It embeds a raster**: a cropped, resized part of `hero.jpg` as a base64 JPEG (about 190 KB). The only SVG here that does |
| `favicon.svg`, `favicon-32.png`, `favicon-16.png` | Simplified mark for small sizes |
| `logo-mark-512.png`, `logo-mark-256.png` | Raster marks |
| `preview.html` | Review page |

PNGs were rendered with `@resvg/resvg-js-cli` (`--fit-width` 512, 256, 32, 16 for the marks and favicons, 1280 for the card), then re-saved with Pillow to drop extra chunks. Check metadata with `strings -n 6 <file> | grep -ciE "exif|xmp|c2pa|jumb"`, which must print 0 for every PNG and JPG. The social card text (tagline and pitch) uses the system font stack `Avenir Next, Nunito, Helvetica Neue, Arial, sans-serif`, so re-rendering `social-card.svg` on another machine can differ slightly; `social-card.png` is the fixed rendering. The wordmark letters are paths and do not vary.

## Alt text

- Mark: "nightgem logo, a faceted green emerald"
- Wordmark: "nightgem" (the image reads NIGHTGEM; alt text uses the prose spelling)
- Hero: "nightgem, spec at dusk, gems at dawn: a night-shift gem factory. A foreman robot takes rough stones from a crate and sends them along conveyor lanes to cutting, grinding and polishing, through a central machine with robotic arms, to an inspector robot who checks a finished emerald under a loupe, next to screens showing a verified branch and a project report."
- Social card: "nightgem: spec at dusk, gems at dawn. Write a spec at dusk. Wake up to verified local branches."
