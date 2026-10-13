# CraveCorner — Brand Guide (Stage 1)

> "Find your craving. Support someone local."
> Modern, cheerful, premium — never childish. No mascots, no emoji icons, no invented data.

## 1. Color

| Token | Hex | Role |
|---|---|---|
| `--cc-pink` (Crave Pink) | `#F45B83` | Brand primary — icons, large display type, graphics, decorative fills |
| `--cc-pink-deep` | `#D3315C` | **All text-bearing pink fills**: primary buttons, active pills, New badge (white on it = 4.8:1) |
| `--cc-pink-50` | `#FDE9EF` | Pale pink — backgrounds only, **never text on white** |
| `--cc-mango` | `#FFC65B` | Ratings, highlights, Warn badge (cocoa text on it = 8.8:1) |
| `--cc-mint` | `#A8DDB5` | Ready Today badge, success fills (`--cc-mint-ink #1E5A2E` text = 5.4:1) |
| `--cc-lilac` | `#B9A6E8` | Info accents, category tints (`--cc-lilac-ink #4A3D7A` text) |
| `--cc-cream` | `#FFF9F3` | Page background |
| `--cc-cocoa` | `#342B32` | Primary text (15.9:1 on cream) |

**Usage ratio:** ~70% neutrals (cream/white/cocoa) · ~20% pink · ~10% mango/mint/lilac accents.

**Contrast law (enforced in `design-system.css`):**
- White text on `#F45B83` is only 3.1:1 — it **fails** WCAG AA. That is why `--cc-pink-deep`
  (`#D3315C`, 4.8:1) exists and is what primary buttons, active pills, and the New badge actually use.
  `#F45B83` itself is reserved for icons, large display type (≥24px), borders, and artwork.
- Small pink text on white/cream always uses `--cc-pink-deep` or `--cc-pink-ink`, never `#F45B83`.
- **Never** pale-pink text on white. **Never** white text on pale yellow (mango badges use cocoa text).

## 2. Fonts

- **Headings:** Plus Jakarta Sans (400–800). Display/wordmark weight is 800.
- **Body, buttons, forms:** Inter (400–700). Base body is 16px on mobile.
- Loaded in `assets/partials/head.html` via Google Fonts with `preconnect` + `display=swap`.
  System-font fallbacks are declared in `--cc-font-head` / `--cc-font-body` so layout never breaks offline.
- The SVG wordmarks are **outlined paths** (converted from Plus Jakarta Sans ExtraBold with
  HarfBuzz shaping + kerning, −0.02em tracking) — they render identically with no webfont needed.

## 3. Logo

The mark is a **thick, rounded, hand-drawn-style capital C** (custom vector arc, round caps)
with a **bite cutout of 3 rounded scallops** on the upper-right edge (true knockout via SVG mask,
so it works on any background). No chef hat, cupcake, fork, spoon, scooter, or food mascot — ever.

| File | Use where |
|---|---|
| `img/logo-horizontal.svg` | Default. Website header, top nav, email footers, partner pages |
| `img/logo-stacked.svg` | Square-ish slots: splash screens, app icons, social avatars, packaging stickers |
| `img/logo-icon.svg` | The bitten-C alone: **favicon**, bottom-nav home glyph, loading spinner mark, avatar fallback |
| `img/logo-white-on-pink.svg` | On `#F45B83` only: app-store art, promo banners, pink buttons that need the full lockup |
| `img/logo-mono.svg` | Single-color `#342B32`: receipts, print, fax-era forms, one-color embroidery |
| `img/logo-dark-bg.svg` | Cream mark for **dark backgrounds only** (photo overlays, dark mode headers) |

**Do:**
- Give the logo clear space (≥ the height of the bite on all sides) and keep it ≥24px tall digital.
- Use `logo-icon.svg` as the favicon (already wired in `head.html`).

**Don't:**
- Don't recolor the C (pink stays pink; use the mono/dark variants instead).
- Don't put `logo-horizontal` on pink, or `logo-white-on-pink` on anything but `#F45B83`.
- Don't add shadows, outlines, gradients, or rotation to the mark.
- Don't redraw the C as a font letter — the symbol must stay custom vector paths.
- Don't pair it with food clip-art or mascots.

## 4. Icons — `assets/js/icons.js`

One Lucide-style family: 24×24 viewBox, 2px stroke, round caps/joins, `stroke="currentColor"`,
`fill="none"`. Color via CSS: pink (`var(--cc-pink-deep)`) for active/selected, cocoa/neutral for inactive.

```html
<script src="../assets/js/icons.js" defer></script>
<script>
  // returns an inline <svg> string; extra class merged on
  document.querySelector('#save-btn').innerHTML = CC.icon('heart', 'my-size-class');
  CC.iconNames(); // → ['home','search','compass', …] (24 total)
</script>
```

Available names: `home` `search` `compass` `location` `heart` `message` `bell` `calendar`
`plus` `user` `store` `shopping-bag` `clipboard` `settings` `shield` `star` `filter`
`edit` `delete` `share` `upload` `clock` `check` `warning`.

- Unknown names `console.warn` and render the `warning` triangle as a visible fallback — fix the name.
- Icons are `aria-hidden="true"`; if an icon is a button's only content, put `aria-label` on the button.
- Never use emoji as icons. Never mix in a second icon style.

## 5. Component notes (see `css/design-system.css` for the full API)

- **Buttons** (`.cc-btn` + `-primary/-secondary/-outline/-ghost/-danger`): fully rounded pills,
  ≥48px targets, visible `:focus-visible` ring. Primary uses `--cc-pink-deep`, not `#F45B83`.
- **Filter pills** (`.cc-pill`, `aria-pressed`): selected = deep-pink fill + white text; unselected = outlined.
- **Badges**: `.cc-badge-ready` (mint) = Ready Today · `.cc-badge-new` (pink) = New ·
  `.cc-badge-soldout` (neutral) = Sold Out.
- **Cards** (20px radius, hairline border, whisper shadow): `.cc-product-card` (square media),
  `.cc-shop-card` (horizontal), `.cc-post-card` (community post).
- **Nav:** mobile = fixed bottom nav (`.cc-bottomnav`, add `cc-has-bottomnav` to `<body>`);
  desktop ≥1024px = sticky top nav (`.cc-topnav`). They swap automatically.
- **Motion:** transitions are subtle; `prefers-reduced-motion` disables all animation.
- **Decorative art** (`.cc-blob-*`, `.cc-dots-*`, `.cc-wave`, `.cc-hero`) is for heroes/banners/empty
  states only — never behind important text.
