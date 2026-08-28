// The social preview card, drawn as a PNG from the live board.
//
// A quarter of the hackathon score is engagement on X, and every link posted
// there rendered as a bare URL: no title, no description, no image. A card is
// not decoration in that context, it is most of what a reader sees before
// deciding whether to click.
//
// It is generated rather than committed because the interesting version is the
// real one — today's lanes, at today's risk, against the line that pays. A
// static image would be a picture of the product; this is the product.
//
// PNG by hand, with node:zlib for the one compressed part. The alternative was
// a headless browser or an image library, and neither belongs in a miner whose
// whole deployment story is "no dependencies, nothing to break".

import { deflateSync } from "node:zlib";


/**
 * A 5x7 bitmap font, five columns per glyph, bit 0 at the top.
 *
 * Carried here because there is no font on a serverless instance and no image
 * library in this project, and a card with a black bar where the name should be
 * reads as a placeholder — worse than no card. Thirty-nine glyphs is all the
 * text this card ever needs, and it costs a kilobyte.
 */
const GLYPHS = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x40, 0x00, 0x00],
  ",": [0x00, 0x50, 0x30, 0x00, 0x00],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08],
  "/": [0x20, 0x10, 0x08, 0x04, 0x02],
  ":": [0x00, 0x36, 0x36, 0x00, 0x00],
  "0": [0x3e, 0x51, 0x49, 0x45, 0x3e],
  "1": [0x00, 0x42, 0x7f, 0x40, 0x00],
  "2": [0x42, 0x61, 0x51, 0x49, 0x46],
  "3": [0x21, 0x41, 0x45, 0x4b, 0x31],
  "4": [0x18, 0x14, 0x12, 0x7f, 0x10],
  "5": [0x27, 0x45, 0x45, 0x45, 0x39],
  "6": [0x3c, 0x4a, 0x49, 0x49, 0x30],
  "7": [0x01, 0x71, 0x09, 0x05, 0x03],
  "8": [0x36, 0x49, 0x49, 0x49, 0x36],
  "9": [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
};

/** Width of a string at a given scale, so callers can centre without guessing. */
export function textWidth(text, scale, tracking = 1) {
  return text.length * (5 + tracking) * scale - tracking * scale;
}

const W = 1200;
const H = 630;

// The barograph palette, matching the page.
// The page's own world, as DESIGN.md records it: one ivory plate on a night
// sea, black ink, chart blue-grey keylines, sea green below the trigger, and
// the band from 0.75 in the only red.
const SEA = [0x0b, 0x1f, 0x2e];
const ON_SEA = [0xe9, 0xee, 0xf0];
const ON_SEA_2 = [0xa9, 0xbc, 0xc7];
const PLATE = [0xf2, 0xec, 0xe0];
const KEY = [0x8f, 0xa9, 0xb8];
const INK = [0x14, 0x11, 0x0c];
const INK_3 = [0x57, 0x53, 0x49];
const CALM = [0x2a, 0x5d, 0x4e];
const TRIGGER = [0xc8, 0x34, 0x1e];
const TRIGGER_TINT = [0xf1, 0xcf, 0xc5];

/** A canvas of raw RGB pixels, and the few shapes this card is made of. */
function canvas(width, height, fill) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = fill[0];
    px[i + 1] = fill[1];
    px[i + 2] = fill[2];
  }

  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };

  return {
    px,
    rect(x, y, w, h, c) {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(x + dx, y + dy, c);
    },
    disc(cx, cy, r, c) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) set(cx + dx, cy + dy, c);
        }
      }
    },

    /**
     * Draw a string. Unknown characters are skipped rather than substituted:
     * a missing glyph should leave a gap, not a box that looks like a bug.
     */
    text(x, y, str, scale, colour, tracking = 1) {
      let cursor = x;
      for (const ch of str.toUpperCase()) {
        const glyph = GLYPHS[ch];
        if (glyph) {
          for (let col = 0; col < 5; col++) {
            for (let row = 0; row < 7; row++) {
              if (!(glyph[col] & (1 << row))) continue;
              for (let sy = 0; sy < scale; sy++) {
                for (let sx = 0; sx < scale; sx++) {
                  set(cursor + col * scale + sx, y + row * scale + sy, colour);
                }
              }
            }
          }
        }
        cursor += (5 + tracking) * scale;
      }
      return cursor;
    },
  };
}

/** PNG: signature, IHDR, one deflated IDAT, IEND. */
function png(width, height, rgb) {
  // Each scanline is prefixed with its filter type. 0 is "none", which costs a
  // little size and removes every way to get the filter maths wrong.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  // compression 0, filter 0, interlace 0 — the only combination every decoder
  // is required to support.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Draw the card.
 *
 * `lanes` is what /api/board publishes. With none, the barograph is drawn empty
 * and the ruled paper carries it — an honest picture of a board with nothing on
 * it, rather than invented columns.
 */
export function drawCard(lanes = []) {
  const c = canvas(W, H, SEA);

  // The plate: ivory on the sea, edged in ink, the same object the page is.
  const px = 90;
  const py = 150;
  const pw = W - px * 2;
  const ph = 360;
  c.rect(px - 3, py - 3, pw + 6, ph + 6, INK);
  c.rect(px, py, pw, ph, PLATE);

  // The band from 0.75 up is the only red: a field, not a line, the way the
  // plate prints it. Its lower edge is the trigger.
  const triggerY = py + Math.round(ph * (1 - 0.75));
  c.rect(px, py, pw, triggerY - py, TRIGGER_TINT);
  c.rect(px, triggerY, pw, 3, TRIGGER);
  // Keylines at 0.25 and 0.5, like the track's scale.
  for (const f of [0.25, 0.5]) c.rect(px, py + Math.round(ph * (1 - f)), pw, 1, KEY);

  const readings = lanes
    .map((l) => (l && l.worst ? l.worst.risk : null))
    .filter((r) => typeof r === "number");

  // "PAYS AT 0.75", set just above its own line so the red rule is legible as
  // a threshold rather than as decoration.
  c.text(px + 14, triggerY - 24, "PAYS AT 0.75", 2, TRIGGER);

  if (readings.length) {
    const gap = pw / (readings.length + 1);
    readings.forEach((risk, i) => {
      const x = Math.round(px + gap * (i + 1));
      const y = py + ph - Math.round(ph * Math.min(risk, 1));
      const over = risk >= 0.75;

      // The pin: a stem up from the foot of the plate and a round head at the
      // reading, green below the band and red inside it.
      // The stem stops above the caption band at the foot of the plate.
      c.rect(x - 2, y, 4, Math.max(0, py + ph - 36 - y), over ? TRIGGER : CALM);
      c.disc(x, y, 12, over ? TRIGGER : CALM);
      c.disc(x, y, 5, PLATE);

      // The figure above its own dot. A card that shows a shape without a
      // number is a mood; the number is the reason to look.
      const label = risk.toFixed(3);
      c.text(x - Math.round(textWidth(label, 2) / 2), y - 40, label, 2, over ? TRIGGER : INK);
    });
  } else {
    const none = "NO BOARD PUBLISHED YET";
    c.text(px + Math.round((pw - textWidth(none, 2)) / 2), py + Math.round(ph / 2), none, 2, INK_3);
  }

  // The plate's own caption, inside it at the foot, where a plate prints one.
  c.rect(px, py + ph - 34, pw, 1, KEY);
  c.text(px + 14, py + ph - 24, "STORM RISK ON SHIPPING LANES, WORST HOUR ON EACH", 2, INK_3);

  // On the sea: the name above, the sources below.
  c.text(px, 46, "AMANAT", 7, ON_SEA, 2);
  c.text(px, 108, "WEATHER COVER THAT PAYS ITSELF, SETTLED ON CHAIN", 2, ON_SEA_2);
  c.text(px, H - 66, "TELEGRAPH PROTOCOL", 2, ON_SEA);
  const src = "OPEN-METEO, CC BY 4.0";
  c.text(px + pw - textWidth(src, 2), H - 66, src, 2, ON_SEA_2);

  return png(W, H, c.px);
}
