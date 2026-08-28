---
name: Amanat
description: One ivory Beaufort plate on a night sea; the only red is the band the contract pays on.
colors:
  sea: "#0b1f2e"
  sea-2: "#10293b"
  sea-3: "#163448"
  on-sea: "#e9eef0"
  on-sea-2: "#a9bcc7"
  plate: "#f2ece0"
  plate-2: "#e6dcc7"
  plate-3: "#d9ccb2"
  ink: "#14110c"
  ink-2: "#3d3a33"
  ink-3: "#575349"
  key: "#8fa9b8"
  key-2: "#b9c9d2"
  trigger: "#c8341e"
  trigger-ink: "#ffffff"
  trigger-tint: "#f1cfc5"
  calm: "#2a5d4e"
  calm-tint: "#cfe0d6"
typography:
  display:
    fontFamily: "Big Shoulders Display, Big Shoulders, Impact, Arial Narrow, sans-serif"
    fontSize: "clamp(2.8rem, 6.6vw, 5.2rem)"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Big Shoulders Display, Big Shoulders, Impact, Arial Narrow, sans-serif"
    fontSize: "clamp(2rem, 5vw, 3.6rem)"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Big Shoulders Display, Big Shoulders, Impact, Arial Narrow, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "0.01em"
  figure:
    fontFamily: "Big Shoulders Display, Big Shoulders, Impact, Arial Narrow, sans-serif"
    fontSize: "1.55rem"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.01em"
  body:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Azeret Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.92em"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
rounded:
  none: "0"
  glyph: "7px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  plate: "36px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.plate}"
    typography: "{typography.title}"
    rounded: "{rounded.none}"
    padding: "13px 22px"
  button-primary-hover:
    backgroundColor: "{colors.sea}"
    textColor: "{colors.plate}"
  button-primary-disabled:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.plate}"
  button-preset:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "7px 12px"
  button-preset-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.plate}"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "13px 14px"
  plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "{spacing.plate}"
  tag-pays:
    backgroundColor: "{colors.trigger}"
    textColor: "{colors.trigger-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 9px"
  tag-declined:
    backgroundColor: "{colors.plate-2}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 9px"
  tag-active:
    backgroundColor: "{colors.calm}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 9px"
---

# Design System: Amanat

## Overview

**Creative North Star: "The Beaufort Plate"**

Amanat's surface is a reference plate, the kind a mariner memorises: a scale down the left with what reaches each band, the live readings pinned against it, and one band printed in red where the contract pays. The plate is ivory stock with black ink and chart blue-grey keylines, and it sits on a night sea. Nothing on the page is a card, a gradient, or a shadow; depth is made only by one flat colour overlapping another, the way a papercut gains depth by layers.

The personality is that of an instrument: dense where the numbers are, quiet everywhere else, and precise about units. Numbers are set in a heavy condensed grotesk so they read at a glance and at a distance; prose is set in a plain workhorse grotesk and never shouts. Red appears exactly once in meaning, the trigger, and every red element on the page is that meaning restated: the band from 0.75, a pin past it, a figure over it, a tag that says pays.

Confirmed rejections: the dark protocol landing page with a headline, three feature cards, and a stats row; cream-and-serif editorial paper; ruled-paper backgrounds; glassmorphism; gradients; drop shadows; kickers or eyebrows above headings.

**Key Characteristics:**
- One plate per idea, edge to edge, numbered in its own margin
- The scale is the hero: eleven bands, 0.0 at the foot, red from 0.75
- Readings are pins on tracks with a needle that swings in, not bars
- Exactly one red, and it always means "the cover pays"
- Flat colour, 2px ink rules, no radius, no shadow, no gradient
- Every figure is set in the display face with tabular numerals

## Colors

A night-sea ground with one ivory plate on it; ink, chart blue-grey and sea green do the work, and one red is reserved.

### Primary
- **Trigger red** (#c8341e): the band from 0.75, the pin and figure of any reading at or over it, the "pays" tag, the stale-board warning, error copy, and focus rings on the sea. Never decorative; it appears only where a claim would pay or something has gone wrong.
- **Trigger tint** (#f1cfc5): the red zone at the right of every track, 0.75 to 1, so a pin's position reads against it before the number does.

### Secondary
- **Calm green** (#2a5d4e): the pin and large figure of any reading below the trigger, the "active" tag, and the lower half of the mark. Green means "nothing is owed".

### Tertiary
- **Chart key** (#8fa9b8) and **Key light** (#b9c9d2): the keylines of the plate — track borders, wave glyph strokes, row dividers, table rules. Blue-grey like a nautical chart's soundings, never black, so the ink stays for text and the 2px structural rules.

### Neutral
- **Night sea** (#0b1f2e): the page ground. **Sea 2/3** (#10293b, #163448): header and footer rules on the sea.
- **On sea** (#e9eef0) and **On sea, quiet** (#a9bcc7): text on the ground; the wordmark and nav.
- **Plate** (#f2ece0): the surface of every plate. **Plate 2** (#e6dcc7): track fill, the near-gale band, declined tags, sticky table heads' neighbour. **Plate 3** (#d9ccb2): reserved for a third layer where two already overlap.
- **Ink** (#14110c): text and every structural rule on the plate. **Ink 2** (#3d3a33): body prose on the plate. **Ink 3** (#575349): labels, captions and notes; the darkest value that still reads as secondary, and 5.1:1 on Plate 2.

### Named Rules
**The One Red Rule.** Red is the trigger and nothing else. A new element may be red only if its meaning is "the contract pays" or "this is wrong".
**The Overlap Rule.** Depth is made by one flat colour over another. No gradient, no shadow, no blur, no tone — if a region needs to sit forward, it gets a 2px ink rule or a flat band.
**The Ink-on-Plate Rule.** Ink text lives on the plate; on the sea, text is On-sea. Ink is never placed on the sea and On-sea is never placed on the plate.

## Typography

**Display Font:** Big Shoulders Display (with Big Shoulders, Impact, Arial Narrow)
**Body Font:** Archivo (with Helvetica Neue, Arial)
**Label/Mono Font:** Azeret Mono, for hashes, addresses and timestamps only

**Character:** a heavy condensed grotesk carries every number and heading, so the plate reads like stamped instrument lettering; a plain grotesk carries the prose without competing. Tabular numerals everywhere, so columns of figures align.

### Hierarchy
- **Display** (900, clamp(2.8rem, 6.6vw, 5.2rem), 0.95): the page title only, uppercase, balanced.
- **Headline** (900, clamp(2rem, 5vw, 3.6rem), 0.95): one per plate, uppercase.
- **Title** (900, 1.35rem, 0.95): step headings and the plate caption heading, uppercase; also the button face at 1.15rem.
- **Figure** (900, 1.55rem, 1): a lane's risk on the plate; the band numerals at 1.9rem; a reading's verdict figure at clamp(3.4rem, 9vw, 5.6rem) with line-height 0.85.
- **Body** (400, 17px, 1.55): prose, max 62–78ch.
- **Label** (600, 0.78rem, 0.06em, uppercase): table heads, tags and band names; never longer than a few words.
- **Mono** (400, 0.92em): code spans, contract addresses, the board stamp. Not for inputs and not for prose.

### Named Rules
**The Number Rule.** Every number a reader might act on is set in the display face; body-face numbers are only allowed inside running prose.
**The Short-Caps Rule.** Uppercase is for headings, tags and labels under about twenty characters. Sentences are never uppercased, and nothing is tracked wider than 0.06em.
**The No-Kicker Rule.** Nothing sits above a heading. A plate's number is printed in its top-right margin, absolutely positioned, and reads as marginalia.

## Layout

A single 1180px column on the sea with 24px side padding. Each plate is a full-width `section` with a 2px ink border, stacked with 28px between plates; a plate carries its own 36px inner padding (18px under 640px). Plate I is a grid: a head row (title left, lede right, aligned to the baseline of the head at 900px and up), then a two-column body of the scale (1.15fr) and the side column (1fr) that holds the lanes and the question; the columns are divided by a 2px ink rule. Below 900px the body is one column and the side column comes first, so a phone shows the lanes and the question before the scale.

The scale is a `column-reverse` list so 0.0 sits at the foot and 1.0 at the head; each band is a three-column grid (numeral 5.4rem, description, glyph 4.6rem) with 9px vertical padding and a 1px key-light rule between bands. Tracks are 26px tall; a reading row is place (12.5rem), track, figure (3.9rem) with a 10px gap. Tables sit inside a white `tablewrap` with a 1px ink border and 14px side padding; the survey's wrap is capped at 520px and scrolls with a sticky head. Spacing steps observed: 4, 8, 12, 18, 24, 36. More space above a heading than below it, always.

## Elevation & Depth

No shadows anywhere, and no tonal layering by opacity. Depth is stated by overlap of flat colour: a plate on the sea, a band on the plate, a tint zone on a track, a pin on a tint. Structure is drawn with rules: 2px ink for the edges of things (plate border, column divider, section rules, buttons, inputs), 1px key-light for rows inside a thing. The sticky survey head is the only element that ever overlaps content, and it does so with a flat white ground and no shadow.

### Named Rules
**The Flat-Overlap Rule.** If it needs to come forward, give it a flat colour or a 2px ink rule. Never a shadow, never a gradient, never a blur.

## Shapes

Square. Every plate, track, input, button, tag and table corner is 0 radius. The only rounded things are the pin head (a circle, 11px) and the mark's plate glyph (7px). Waves in the band glyphs are open quadratic strokes, 1.5px, layered two deep with short whitecap ticks above them as force rises. Rules are always full width of their container.

## Components

### Buttons
- **Shape:** square (0)
- **Primary:** ink ground, plate text, 2px ink border, display face 1.15rem uppercase with 0.06em tracking, 13px 22px padding
- **Hover / Focus:** ground turns Night sea; focus is a 2px ring, red on the sea, ink on the plate, 3px offset
- **Disabled:** Ink 3 ground and border, `cursor: wait`, label reads "Reading…"
- **Preset (secondary):** transparent ground, ink text, 1px Ink-3 border, body face 0.86rem, 7px 12px; hover inverts to ink ground and plate text

### Chips
- **Style:** `tag`, label face, uppercase, 3px 9px, square; pays = red ground with white text; declined = Plate 2 ground with Ink 2 text and a 1px key border; active = calm green ground with white text
- **State:** the tag's colour is its meaning; there is no neutral tag

### Cards / Containers
- **Corner Style:** square
- **Background:** Plate; a white `tablewrap` inside a plate for tables
- **Shadow Strategy:** none (see Elevation)
- **Border:** 2px ink on a plate, 1px ink on a tablewrap, 1px key on a track
- **Internal Padding:** 36px on a plate head or sheet, 22px on the lanes block, 14px inside a tablewrap; 18px on phones

### Inputs / Fields
- **Style:** white ground, 2px ink border, square, body face 1.02rem, 13px 14px; placeholder in Ink 3
- **Focus:** 2px ink ring at 3px offset on the plate
- **Error:** the result panel shows `err` copy in trigger red; the field itself is never recoloured

### Navigation
- **Style:** a masthead strip on the sea: the mark (34px glyph + display-face wordmark, uppercase, 0.06em) and a wrapping row of body-face links at 0.9rem in On-sea-quiet; hover turns the link On-sea and draws a 2px key underline; on phones the links wrap into two rows and the tagline hides under 560px

### The Plate
A full-width `section.plate` with a 2px ink border, containing a `plate-head` (title, lede, and the plate number in the top-right margin), then either a `plate-body` grid or a single `sheet`. Every plate is one idea; the page is a sequence of plates on the sea.

### The Scale and the Pin
The scale: eleven `band` rows, numeral and force name on the left, what reaches the band in the middle, a layered wave glyph on the right; bands at 0.75 and above are red with white ink, the 0.7 band is Plate 2. The pin: a 3px bar with an 11px round head on a 26px track whose right quarter is the tint zone bordered in red; the pin starts at 0 and is moved to its value on the next frame, transitioning `left` over 0.55s with `cubic-bezier(.34,1.56,.64,1)` so it overshoots and settles; green below the trigger, red at or over it; motion is removed under `prefers-reduced-motion`.

### The Reading
Three fixed positions: the figure (display face, calm green or red), the verdict line beside it (display face, uppercase), then the summary sentence, then a `figures` row of label-over-value pairs separated from the sentence by a 1px key rule.

## Do's and Don'ts

### Do:
- **Do** put every new idea on its own plate, numbered in the margin, with a 2px ink border and 36px padding.
- **Do** set every actionable number in Big Shoulders Display 900 with tabular numerals, and every sentence in Archivo.
- **Do** make depth with flat overlap and rules only: 2px ink for edges, 1px key for rows.
- **Do** reserve red for the trigger and for errors, and tint the track's top quarter so a pin's position reads before its number.
- **Do** keep functional text at or above 11px, uppercase to short labels, and tracking at or under 0.06em.
- **Do** say what is missing in place: "no reading", "stale", "could not read the archive", in words, never as a zero.

### Don't:
- **Don't** put a label, kicker or eyebrow above a heading; the plate number lives in the margin.
- **Don't** use shadows, gradients, blur, glass, or rounded corners beyond the pin head and the mark.
- **Don't** use monospace for inputs or prose; it is for hashes, addresses, code and timestamps.
- **Don't** introduce a second accent; if it is not the trigger or an error, it is ink, key, plate or sea.
- **Don't** render readings as bars, sparklines or rings; a reading is a pin on a track against the red quarter.
- **Don't** use a card grid, a stats row, or a hero metric; the scale and the pins are the hero.
