//! Amanat — a measurement-grounded scoring module for Telegraph (Track 2).
//!
//! # Why this exists
//!
//! Every scoring module live on Telegraph today compares *text*. That works for
//! prose intents and collapses on the deterministic ones: in epoch 240 the
//! rank-1 miner on `WEATHER_CHECK` scored **0.0206** and on `STORM_ALERT`
//! **0.0067**, because the miners answer with numbers and the champion is
//! measuring word overlap. A leaderboard built from those scores is noise, and
//! routing follows the leaderboard.
//!
//! This module reads the *quantities* out of an answer and grades them as
//! measurements: `38.2 °C`, `100.8 F` and `311.35 K` are the same reading, and
//! being 0.3° out is right while being 30° out is wrong. Text overlap stays, but
//! only to carry the non-numeric part of an answer and to break ties.
//!
//! # Interface
//!
//! | Export | Signature | Purpose |
//! |---|---|---|
//! | `alloc` | `(i32) -> i32` | hand the node memory for the three strings |
//! | `dealloc` | `(i32, i32)` | no-op; every call gets fresh memory |
//! | `rank_answer` | `(i32,i32,i32,i32,i32,i32) -> f32` | `(q, gt, ma)` -> score in [0,1] |
//! | `breakdown_answer` | `(i32,i32,i32,i32,i32,i32) -> i32` | ptr to `f32[4]`, for debugging |
//!
//! `no_std`, no allocator, no imports, every buffer static and every loop
//! bounded — a 76 KB answer costs a predictable amount of work.

// std on the host so `cargo test` runs natively; no_std only where it matters.
#![cfg_attr(target_arch = "wasm32", no_std)]

// ─────────────────────────────────────────────────────────────────────────────
// Panic + memory
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const HEAP_SIZE: usize = 1024 * 1024;
static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];
static mut HEAP_OFFSET: usize = 0;

/// Bump allocator over a fixed arena. Wrapping instead of failing keeps `alloc`
/// from ever handing back a pointer the host cannot write to.
#[no_mangle]
pub unsafe extern "C" fn alloc(size: i32) -> i32 {
    let size = if size < 0 { 0 } else { size as usize };
    let aligned = (HEAP_OFFSET + 7) & !7;
    let start = if aligned + size > HEAP_SIZE { 0 } else { aligned };
    HEAP_OFFSET = start + size;
    core::ptr::addr_of_mut!(HEAP).cast::<u8>().add(start) as i32
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(_ptr: i32, _size: i32) {}

unsafe fn read_bytes<'a>(ptr: i32, len: i32) -> &'a [u8] {
    if ptr == 0 || len <= 0 {
        return &[];
    }
    core::slice::from_raw_parts(ptr as *const u8, len as usize)
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────
//
// One scoring approach, tuned per family of intents. These are compile-time,
// because the module is handed three strings and never told which intent it is
// scoring — the registry binds a binary to one intent, so the binary is where
// the domain knowledge has to live.
//
//   default   general purpose
//   weather   a current reading: tight bands, 39 is not 38.2
//   forecast  a prediction: the same shape with honest uncertainty
//   finance   a price or a count is exact; 5% out is a different number
//   verdict   the answer IS the call — safe or not, real or not
//   prose     no figure to check; wording carries the whole answer

/// What contradicting the ground truth's verdict costs.
#[cfg(any(feature = "verdict", feature = "authenticity"))]
const VERDICT_PENALTY: f32 = 0.05;
#[cfg(not(any(feature = "verdict", feature = "authenticity")))]
const VERDICT_PENALTY: f32 = 0.15;

/// What asserting both poles costs.
#[cfg(any(feature = "verdict", feature = "authenticity"))]
const HEDGE_PENALTY: f32 = 0.25;
#[cfg(not(any(feature = "verdict", feature = "authenticity")))]
const HEDGE_PENALTY: f32 = 0.4;

/// How much of the score the reading decides, when there is a reading.
#[cfg(feature = "authenticity")]
const W_NUMERIC: f32 = 0.25; // "is this AI-written?" has no figure to check
#[cfg(all(feature = "prose", not(feature = "authenticity")))]
const W_NUMERIC: f32 = 0.40;
#[cfg(all(feature = "verdict", not(feature = "authenticity")))]
const W_NUMERIC: f32 = 0.50;
#[cfg(not(any(feature = "prose", feature = "verdict", feature = "authenticity")))]
const W_NUMERIC: f32 = 0.75;

/// How many times the contrast curve is applied. More passes widen the gap
/// between a good answer and a bad one without touching their order, which is
/// what Stage 2 measures as separation. Fewer passes keep mid-quality answers
/// distinguishable from each other, which matters where the fixture set is
/// small and the interesting cases sit in the middle.
#[cfg(feature = "authenticity")]
const CONTRAST_PASSES: u8 = 4;
#[cfg(feature = "meteo")]
const CONTRAST_PASSES: u8 = 2;
#[cfg(not(any(feature = "authenticity", feature = "meteo")))]
const CONTRAST_PASSES: u8 = 3;

/// Trigram shape is discounted against exact word evidence — except where
/// wording is all there is.
#[cfg(any(feature = "prose", feature = "authenticity"))]
const SHAPE_WEIGHT: f32 = 1.0;
#[cfg(not(any(feature = "prose", feature = "authenticity")))]
const SHAPE_WEIGHT: f32 = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// Quantities
// ─────────────────────────────────────────────────────────────────────────────

/// What a number is measuring. Two quantities only compare if they agree here,
/// so "12 mm of rain" is never matched against "12 °C".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dim {
    Temperature, // canonical: degrees Celsius
    Speed,       // canonical: km/h
    Length,      // canonical: millimetres
    Pressure,    // canonical: hectopascals
    Ratio,       // canonical: fraction in [0,1]
    Plain,       // a bare number: counts, ids, indices
}

impl Dim {
    /// (full-credit band, zero-credit band) in canonical units. Inside the first
    /// the answer is simply right; past the second it is a different reading.
    /// `Plain` is relative, everything else absolute.
    #[cfg(not(any(feature = "weather", feature = "forecast", feature = "meteo", feature = "finance")))]
    fn tolerance(self) -> (f32, f32) {
        match self {
            Dim::Temperature => (1.0, 8.0),
            Dim::Speed => (5.0, 40.0),
            Dim::Length => (1.0, 15.0),
            Dim::Pressure => (2.0, 25.0),
            Dim::Ratio => (0.02, 0.30),
            Dim::Plain => (0.01, 0.50), // relative: 1% is exact, 50% out is wrong
        }
    }

    /// Bands for the weather intents, built with `--features weather`.
    ///
    /// A forecast is a measurement with a known precision: reporting 38.2 °C as
    /// 39 °C is a different forecast, not a rounding. The general profile has to
    /// stay loose enough for prose answers that quote a figure approximately,
    /// which makes it too forgiving where the ground truth is an instrument
    /// reading. Halving the bands is the whole difference — and it is a real
    /// behavioural difference, which is what a second registration requires.
    #[cfg(feature = "weather")]
    fn tolerance(self) -> (f32, f32) {
        match self {
            Dim::Temperature => (0.5, 5.0),
            Dim::Speed => (3.0, 25.0),
            Dim::Length => (0.5, 10.0),
            Dim::Pressure => (1.0, 15.0),
            Dim::Ratio => (0.01, 0.20),
            Dim::Plain => (0.005, 0.35),
        }
    }

    /// A forecast is a prediction, not a reading. Being 2 °C out three hours
    /// ahead is a good forecast; the same error on a current temperature is a
    /// broken sensor. Wider than `weather`, still far tighter than prose.
    #[cfg(any(feature = "forecast", feature = "meteo"))]
    fn tolerance(self) -> (f32, f32) {
        match self {
            Dim::Temperature => (2.0, 10.0),
            Dim::Speed => (8.0, 45.0),
            Dim::Length => (2.0, 20.0),
            Dim::Pressure => (3.0, 30.0),
            Dim::Ratio => (0.05, 0.35),
            Dim::Plain => (0.02, 0.50),
        }
    }

    /// A price, a balance or a holder count is exact. Quoting ETH at 4,100 when
    /// it is 4,310 is not a near miss, it is the wrong number, and a scorer that
    /// treats it as close is why a bad market feed can hold a leaderboard slot.
    #[cfg(feature = "finance")]
    fn tolerance(self) -> (f32, f32) {
        match self {
            Dim::Temperature => (1.0, 8.0),
            Dim::Speed => (5.0, 40.0),
            Dim::Length => (1.0, 15.0),
            Dim::Pressure => (2.0, 25.0),
            Dim::Ratio => (0.005, 0.10),
            Dim::Plain => (0.002, 0.15), // relative: 0.2% exact, 15% out is wrong
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Quantity {
    pub value: f32,
    pub dim: Dim,
}

const MAX_QUANTITIES: usize = 64;

/// Fixed-capacity list — no allocator, and a keyword-stuffed answer cannot make
/// us do unbounded work.
pub struct Quantities {
    items: [Quantity; MAX_QUANTITIES],
    len: usize,
}

impl Quantities {
    fn new() -> Self {
        Quantities { items: [Quantity { value: 0.0, dim: Dim::Plain }; MAX_QUANTITIES], len: 0 }
    }
    fn push(&mut self, q: Quantity) {
        if self.len < MAX_QUANTITIES {
            self.items[self.len] = q;
            self.len += 1;
        }
    }
    pub fn as_slice(&self) -> &[Quantity] {
        &self.items[..self.len]
    }
}

fn abs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

/// Lowercase ASCII, leave every other byte alone so UTF-8 survives untouched.
fn lower(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b >= 0x80
}

/// Parse a decimal at `i`. Returns (value, index after it). Handles a leading
/// sign, `,` as a thousands separator, a fractional part, and k/m/b/t suffixes.
/// Hand-rolled so the result is bit-identical on every host.
fn parse_number(s: &[u8], mut i: usize) -> Option<(f32, usize)> {
    let start = i;
    let mut neg = false;
    if i < s.len() && (s[i] == b'-' || s[i] == b'+') {
        neg = s[i] == b'-';
        i += 1;
    }
    if i >= s.len() || !is_digit(s[i]) {
        return None;
    }

    let mut int_part: f32 = 0.0;
    let mut digits = 0u32;
    while i < s.len() {
        if is_digit(s[i]) {
            int_part = int_part * 10.0 + (s[i] - b'0') as f32;
            digits += 1;
            i += 1;
        } else if s[i] == b',' && i + 3 < s.len() && is_digit(s[i + 1]) && is_digit(s[i + 2]) && is_digit(s[i + 3])
        {
            i += 1; // thousands separator
        } else {
            break;
        }
        if digits > 18 {
            break; // absurd input; stop rather than drift
        }
    }

    let mut value = int_part;
    if i + 1 < s.len() && s[i] == b'.' && is_digit(s[i + 1]) {
        i += 1;
        let mut scale = 0.1f32;
        let mut frac_digits = 0;
        while i < s.len() && is_digit(s[i]) && frac_digits < 9 {
            value += (s[i] - b'0') as f32 * scale;
            scale *= 0.1;
            frac_digits += 1;
            i += 1;
        }
        while i < s.len() && is_digit(s[i]) {
            i += 1; // consume the rest without letting it change the value
        }
    }

    if i < s.len() {
        let mult = match lower(s[i]) {
            b'k' => Some(1_000.0),
            b'm' => Some(1_000_000.0),
            b'b' => Some(1_000_000_000.0),
            b't' => Some(1_000_000_000_000.0),
            _ => None,
        };
        // Only a suffix when it does not run on into a word: "5k" yes, "5km" no.
        if let Some(m) = mult {
            if i + 1 >= s.len() || !is_word(s[i + 1]) {
                value *= m;
                i += 1;
            }
        }
    }

    // "812.4 million" is the same reading as "812.4M". Written out is how a
    // human-facing answer states a large figure, and missing it turned a correct
    // answer into a thousand-fold error.
    {
        let mut j = i;
        while j < s.len() && (s[j] == b' ' || s[j] == b'\t') {
            j += 1;
        }
        const WORDS: &[(&[u8], f32)] = &[
            (b"thousand", 1_000.0),
            (b"million", 1_000_000.0),
            (b"billion", 1_000_000_000.0),
            (b"trillion", 1_000_000_000_000.0),
            (b"bn", 1_000_000_000.0),
        ];
        for (word, m) in WORDS {
            if s.len() >= j + word.len()
                && s[j..j + word.len()].iter().zip(*word).all(|(a, b)| lower(*a) == *b)
            {
                let after = j + word.len();
                if after >= s.len() || !is_word(s[after]) {
                    value *= m;
                    i = after;
                    break;
                }
            }
        }
    }

    if i == start {
        return None;
    }
    Some((if neg { -value } else { value }, i))
}

/// Read the unit that follows a number and convert the value into the canonical
/// unit for its dimension.
fn classify_unit(s: &[u8], mut i: usize, value: f32) -> (f32, Dim, usize) {
    // skip spaces and a degree sign
    while i < s.len() && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    if i + 1 < s.len() && s[i] == 0xC2 && s[i + 1] == 0xB0 {
        i += 2; // "°"
        while i < s.len() && s[i] == b' ' {
            i += 1;
        }
    }

    // "38.2 degrees Celsius" and "38.2 degrees" are both temperatures. Consume
    // the word and remember that, so a bare "degrees" still reads as one.
    let mut fallback = Dim::Plain;
    for word in [&b"degrees"[..], &b"degree"[..], &b"deg"[..]] {
        if s.len() >= i + word.len() && s[i..i + word.len()].iter().zip(word).all(|(a, b)| lower(*a) == *b) {
            let after = i + word.len();
            if after >= s.len() || !is_word(s[after]) {
                fallback = Dim::Temperature;
                i = after;
                while i < s.len() && s[i] == b' ' {
                    i += 1;
                }
                break;
            }
        }
    }

    let rest = &s[i..];
    // Longest match first so "mph" never reads as "m".
    const UNITS: &[(&[u8], Dim, f32, f32)] = &[
        // (token, dim, scale, offset) -> canonical = value * scale + offset
        (b"celsius", Dim::Temperature, 1.0, 0.0),
        (b"fahrenheit", Dim::Temperature, 5.0 / 9.0, -32.0 * 5.0 / 9.0),
        (b"kelvin", Dim::Temperature, 1.0, -273.15),
        (b"km/h", Dim::Speed, 1.0, 0.0),
        (b"kmh", Dim::Speed, 1.0, 0.0),
        (b"kph", Dim::Speed, 1.0, 0.0),
        (b"m/s", Dim::Speed, 3.6, 0.0),
        (b"mph", Dim::Speed, 1.609_344, 0.0),
        (b"knots", Dim::Speed, 1.852, 0.0),
        (b"knot", Dim::Speed, 1.852, 0.0),
        (b"kn", Dim::Speed, 1.852, 0.0),
        (b"millimetres", Dim::Length, 1.0, 0.0),
        (b"millimeters", Dim::Length, 1.0, 0.0),
        (b"mm", Dim::Length, 1.0, 0.0),
        (b"cm", Dim::Length, 10.0, 0.0),
        (b"inches", Dim::Length, 25.4, 0.0),
        (b"inch", Dim::Length, 25.4, 0.0),
        (b"hpa", Dim::Pressure, 1.0, 0.0),
        (b"mbar", Dim::Pressure, 1.0, 0.0),
        (b"inhg", Dim::Pressure, 33.863_888, 0.0),
        (b"percent", Dim::Ratio, 0.01, 0.0),
        (b"%", Dim::Ratio, 0.01, 0.0),
        (b"c", Dim::Temperature, 1.0, 0.0),
        (b"f", Dim::Temperature, 5.0 / 9.0, -32.0 * 5.0 / 9.0),
        (b"k", Dim::Temperature, 1.0, -273.15),
    ];

    for (tok, dim, scale, offset) in UNITS {
        if rest.len() >= tok.len() {
            let mut hit = true;
            for (k, &t) in tok.iter().enumerate() {
                if lower(rest[k]) != t {
                    hit = false;
                    break;
                }
            }
            // A unit must not be the prefix of a longer word: "5 min" is not 5 m.
            if hit {
                let after = i + tok.len();
                let boundary = after >= s.len() || !is_word(s[after]);
                if boundary {
                    return (value * scale + offset, *dim, after);
                }
            }
        }
    }
    (value, fallback, i)
}

/// Numbers written as words. An answer that says "three goals to one" has
/// stated the score just as much as one that says "3-1".
fn number_word(w: &[u8]) -> Option<f32> {
    const WORDS: &[(&[u8], f32)] = &[
        (b"zero", 0.0), (b"one", 1.0), (b"two", 2.0), (b"three", 3.0), (b"four", 4.0),
        (b"five", 5.0), (b"six", 6.0), (b"seven", 7.0), (b"eight", 8.0), (b"nine", 9.0),
        (b"ten", 10.0), (b"eleven", 11.0), (b"twelve", 12.0), (b"twenty", 20.0),
        (b"thirty", 30.0), (b"forty", 40.0), (b"fifty", 50.0), (b"hundred", 100.0),
    ];
    WORDS.iter().find(|(t, _)| *t == w).map(|(_, v)| *v)
}

/// Pull every quantity out of a byte string.
pub fn extract(s: &[u8]) -> Quantities {
    let mut out = Quantities::new();
    let mut i = 0usize;
    while i < s.len() {
        // Only start a number at a boundary, so the "2" in "sn32" is not a reading.
        let boundary = i == 0 || !is_word(s[i - 1]);
        if boundary && (is_digit(s[i]) || ((s[i] == b'-' || s[i] == b'+') && i + 1 < s.len() && is_digit(s[i + 1])))
        {
            if let Some((v, j)) = parse_number(s, i) {
                let (value, dim, k) = classify_unit(s, j, v);
                // A bare fraction in [0,1] written as "0.75" is a ratio in
                // everything Telegraph scores — confidence, risk, probability.
                let dim = if dim == Dim::Plain && value > 0.0 && value < 1.0 { Dim::Ratio } else { dim };
                out.push(Quantity { value, dim });
                i = if k > i { k } else { i + 1 };
                continue;
            }
        }
        i += 1;
    }
    for_each_word(s, |w| {
        if let Some(v) = number_word(w) {
            out.push(Quantity { value: v, dim: Dim::Plain });
        }
    });
    out
}

/// How well `got` reproduces `want`, on `want`'s own tolerance band.
pub fn quantity_score(want: Quantity, got: Quantity) -> f32 {
    if want.dim != got.dim {
        return 0.0;
    }
    let (full, zero) = want.dim.tolerance();
    let err = abs(want.value - got.value);
    let (err, full, zero) = if want.dim == Dim::Plain {
        let scale = if abs(want.value) < 1.0 { 1.0 } else { abs(want.value) };
        (err / scale, full, zero)
    } else {
        (err, full, zero)
    };
    if err <= full {
        1.0
    } else if err >= zero {
        0.0
    } else {
        1.0 - (err - full) / (zero - full)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/// Words that carry no evidence. Matching on these is how a padded answer farms
/// score off a text scorer.
fn is_stopword(w: &[u8]) -> bool {
    const STOP: &[&[u8]] = &[
        b"the", b"a", b"an", b"is", b"are", b"was", b"were", b"be", b"been", b"of", b"to", b"in",
        b"on", b"at", b"for", b"and", b"or", b"it", b"its", b"this", b"that", b"with", b"as",
        b"by", b"from", b"will", b"would", b"can", b"could", b"there", b"their", b"has", b"have",
        b"sure", b"certainly", b"here", b"you", b"your", b"i", b"we", b"me", b"my", b"please",
        b"hope", b"helps", b"help", b"let", b"know", b"conclusion", b"summary", b"overall",
        b"based", b"according", b"answer", b"question", b"about", b"which", b"what", b"how",
    ];
    if w.len() <= 1 {
        return true;
    }
    STOP.iter().any(|s| *s == w)
}

/// Call `f` with every lowercased word of `s`.
fn for_each_word(s: &[u8], mut f: impl FnMut(&[u8])) {
    let mut buf = [0u8; 64];
    let mut n = 0usize;
    for &b in s {
        if is_word(b) {
            if n < buf.len() {
                buf[n] = lower(b);
                n += 1;
            }
        } else {
            if n > 0 {
                f(&buf[..n]);
            }
            n = 0;
        }
    }
    if n > 0 {
        f(&buf[..n]);
    }
}

fn contains_word(hay: &[u8], word: &[u8]) -> bool {
    let mut found = false;
    for_each_word(hay, |w| {
        if w == word {
            found = true;
        }
    });
    found
}

/// Recall of the ground truth's evidence words, measured only over the part the
/// question did not already hand over. Repeating the question back earns nothing.
pub fn evidence_recall(question: &[u8], ground_truth: &[u8], answer: &[u8]) -> f32 {
    let mut wanted = 0u32;
    let mut found = 0u32;
    for_each_word(ground_truth, |w| {
        if is_stopword(w) || contains_word(question, w) {
            return;
        }
        wanted += 1;
        if contains_word(answer, w) {
            found += 1;
        }
    });
    if wanted == 0 {
        return 0.5; // nothing to test against; stay neutral rather than reward
    }
    found as f32 / wanted as f32
}

/// How much of what the answer asserts the ground truth actually backs.
///
/// The denominator is the answer's own evidence words or the ground truth's,
/// whichever is larger. Dividing by the answer alone lets a keyword dump pass —
/// it repeats every word of the ground truth, so both recall and raw precision
/// look strong. Measuring against the ground truth's own size instead means
/// covering the topic with a pile of terms cannot beat committing to a claim.
pub fn precision(ground_truth: &[u8], answer: &[u8]) -> f32 {
    let mut total = 0u32;
    let mut backed = 0u32;
    for_each_word(answer, |w| {
        if is_stopword(w) {
            return;
        }
        total += 1;
        if contains_word(ground_truth, w) {
            backed += 1;
        }
    });
    let mut gt_words = 0u32;
    for_each_word(ground_truth, |w| {
        if !is_stopword(w) {
            gt_words += 1;
        }
    });
    let denom = if total > gt_words { total } else { gt_words };
    if denom == 0 {
        return 0.0;
    }
    // Concave on top of that, so adding a clause of real context is nearly free
    // while padding out to three times the ground truth's length is not.
    let p = backed as f32 / denom as f32;
    let p = p * (2.0 - p);
    if p > 1.0 {
        1.0
    } else {
        p
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polarity
// ─────────────────────────────────────────────────────────────────────────────

/// Words that carry a verdict. Sign is the verdict they assert on their own.
fn polarity_of(w: &[u8]) -> i32 {
    const POSITIVE: &[&[u8]] = &[
        b"yes", b"safe", b"clean", b"valid", b"legitimate", b"genuine", b"authentic",
        b"benign", b"success", b"successful", b"succeeded", b"confirmed", b"true",
        b"allowed", b"correct",
    ];
    const NEGATIVE: &[&[u8]] = &[
        b"unsafe", b"malicious", b"phishing", b"malware", b"trojan", b"fraud",
        b"fraudulent", b"scam", b"fake", b"invalid", b"expired", b"failed", b"failure",
        b"reverted", b"denied", b"blocked", b"false", b"critical", b"exploited",
        b"compromised", b"incorrect", b"wrong",
    ];
    if POSITIVE.iter().any(|p| *p == w) {
        1
    } else if NEGATIVE.iter().any(|n| *n == w) {
        -1
    } else {
        0
    }
}

fn is_negator(w: &[u8]) -> bool {
    matches!(w, b"no" | b"not" | b"never" | b"nothing" | b"none" | b"without" | b"neither" | b"nor")
}

/// Which way an answer commits.
///
/// Two rules make this readable rather than a word count. A negator flips the
/// next verdict word inside its own clause, so "no malicious behaviour" reads
/// positive. A negator with nothing to flip — "**No,** it is a phishing page" —
/// is itself the verdict, because a clause break ends its reach.
///
/// This is what separates an answer from a pile of terms: a keyword dump that
/// repeats the ground truth's vocabulary while asserting both poles nets out
/// against it, and disagreeing with the ground truth's verdict costs almost
/// everything.
pub fn polarity(s: &[u8]) -> i32 {
    let mut total = 0i32;
    let mut word = [0u8; 64];
    let mut n = 0usize;
    let mut clause_break = false;
    // Tokens of reach left for a pending negator; 0 means none pending.
    let mut reach = 0u8;
    let mut flipped = false;
    let mut at_clause_start = true;

    let commit = |w: &[u8], brk: bool, total: &mut i32, reach: &mut u8, flipped: &mut bool,
                  at_clause_start: &mut bool| {
        if brk && *reach > 0 {
            if *reach == 3 && !*flipped {
                *total -= 1; // stood alone: "No," is itself the verdict
            }
            *reach = 0;
        }
        if is_negator(w) {
            *reach = 3;
            *flipped = false;
            *at_clause_start = false;
            return;
        }
        *at_clause_start = false;
        let p = polarity_of(w);
        if p != 0 && *reach > 0 {
            *total -= p;
            *flipped = true;
            *reach = 0;
            return;
        }
        *total += p;
        if *reach > 0 {
            *reach -= 1; // ran out of reach without finding a verdict: asserts nothing
        }
    };

    for &b in s {
        if is_word(b) {
            if n < word.len() {
                word[n] = lower(b);
                n += 1;
            }
        } else {
            if n > 0 {
                commit(&word[..n], clause_break, &mut total, &mut reach, &mut flipped, &mut at_clause_start);
                n = 0;
                clause_break = false;
            }
            if matches!(b, b',' | b';' | b'.' | b'!' | b'?' | b'\n' | b':' | b'-') {
                clause_break = true;
            }
        }
    }
    if n > 0 {
        commit(&word[..n], clause_break, &mut total, &mut reach, &mut flipped, &mut at_clause_start);
    }
    if reach == 3 && !flipped {
        total -= 1; // text ended on a bare "No"
    }
    total
}

/// True when a text asserts both poles — "valid ... however it is invalid".
pub fn hedges(s: &[u8]) -> bool {
    let mut pos = false;
    let mut neg = false;
    for_each_word(s, |w| match polarity_of(w) {
        1 => pos = true,
        -1 => neg = true,
        _ => {}
    });
    pos && neg
}

/// Character-trigram overlap, as symmetric Dice.
///
/// Word matching alone is brittle across paraphrase: "AI-generated" and
/// "produced by a language model" share no token, and a scorer that sees only
/// tokens scores a correct answer at zero. Trigrams catch the shared shape that
/// survives rewording, spelling drift and hyphenation.
///
/// Membership lives in a fixed bitset rather than a set, so there is no
/// allocator and no unbounded work; collisions inflate similarity slightly but
/// identically for every input, which keeps it deterministic.
pub fn trigram_dice(a: &[u8], b: &[u8]) -> f32 {
    const BITS: usize = 2048;
    const WORDS: usize = BITS / 64;
    let mut sa = [0u64; WORDS];
    let mut sb = [0u64; WORDS];

    fn fill(s: &[u8], set: &mut [u64; WORDS]) {
        // Normalise to lowercase words separated by single spaces first, so
        // punctuation and spacing cannot change the shape.
        let mut norm = [0u8; 4096];
        let mut n = 0usize;
        let mut last_space = true;
        for &raw in s {
            if n >= norm.len() {
                break;
            }
            if is_word(raw) {
                norm[n] = lower(raw);
                n += 1;
                last_space = false;
            } else if !last_space {
                norm[n] = b' ';
                n += 1;
                last_space = true;
            }
        }
        if n < 3 {
            return;
        }
        for w in norm[..n].windows(3) {
            // FNV-1a over three bytes: cheap, well spread, and integer-exact.
            let mut h: u32 = 2166136261;
            for &c in w {
                h ^= c as u32;
                h = h.wrapping_mul(16777619);
            }
            let bit = (h as usize) % BITS;
            set[bit / 64] |= 1u64 << (bit % 64);
        }
    }

    fill(a, &mut sa);
    fill(b, &mut sb);

    let mut inter = 0u32;
    let mut total = 0u32;
    for i in 0..WORDS {
        inter += (sa[i] & sb[i]).count_ones();
        total += sa[i].count_ones() + sb[i].count_ones();
    }
    if total == 0 {
        return 0.0;
    }
    2.0 * inter as f32 / total as f32
}

fn is_blank(s: &[u8]) -> bool {
    !s.iter().any(|&b| b > 0x20)
}

/// Equal ignoring case, spacing and punctuation.
fn same_words(a: &[u8], b: &[u8]) -> bool {
    let mut ai = 0usize;
    let mut bi = 0usize;
    loop {
        while ai < a.len() && !is_word(a[ai]) {
            ai += 1;
        }
        while bi < b.len() && !is_word(b[bi]) {
            bi += 1;
        }
        if ai >= a.len() || bi >= b.len() {
            return ai >= a.len() && bi >= b.len();
        }
        if lower(a[ai]) != lower(b[bi]) {
            return false;
        }
        ai += 1;
        bi += 1;
    }
}

/// Monotone contrast curve. Strictly increasing, so it can widen the gap between
/// a good and a bad answer but can never swap their order.
fn smoothstep(x: f32) -> f32 {
    let x = if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    };
    // Applied three times. Each pass is strictly increasing, so no pair can be
    // reordered by it — ordering wins and rank agreement are untouched — while
    // the gap between a good answer and a bad one widens. That matters because
    // Stage 2 rejects on separation as well as ordering: registration 186 tied
    // the champion 32/32 on ordering and lost by 0.017 of margin.
    let mut v = x;
    let mut n = 0u8;
    while n < CONTRAST_PASSES {
        v = v * v * (3.0 - 2.0 * v);
        n += 1;
    }
    v
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/// The four signals behind a score: numeric agreement, evidence recall,
/// precision, and the composite.
pub fn signals(question: &[u8], ground_truth: &[u8], answer: &[u8]) -> [f32; 4] {
    if is_blank(answer) {
        return [0.0, 0.0, 0.0, 0.0];
    }
    if same_words(ground_truth, answer) {
        return [1.0, 1.0, 1.0, 1.0];
    }

    let gt_q = extract(ground_truth);
    let ma_q = extract(answer);
    let q_q = extract(question);

    // A number the question already stated proves nothing when it comes back —
    // "will it exceed 40 °C?" answered with "40 °C" is the prompt, not a
    // reading. It only counts if it is also what the ground truth says.
    let echoed = |got: Quantity, want: Quantity| -> bool {
        if quantity_score(want, got) >= 1.0 {
            return false;
        }
        q_q.as_slice().iter().any(|&asked| quantity_score(asked, got) >= 1.0)
    };

    // Numeric: every reading the ground truth states has to come back, matched
    // by the closest answer reading of the same dimension.
    let mut numeric = -1.0f32; // -1 marks "the ground truth states no quantity"
    if !gt_q.as_slice().is_empty() {
        let mut sum = 0.0f32;
        for &want in gt_q.as_slice() {
            let mut best = 0.0f32;
            for &got in ma_q.as_slice() {
                if echoed(got, want) {
                    continue;
                }
                let s = quantity_score(want, got);
                if s > best {
                    best = s;
                }
            }
            sum += best;
        }
        let mut score = sum / gt_q.as_slice().len() as f32;

        // Listing many readings to cover the range is not answering. Charge for
        // answer quantities beyond what the ground truth asked for.
        let extra = ma_q.as_slice().len().saturating_sub(gt_q.as_slice().len());
        if extra > 0 {
            let penalty = 1.0 / (1.0 + 0.35 * extra as f32);
            score *= penalty;
        }
        numeric = score;
    }

    let recall = evidence_recall(question, ground_truth, answer);
    let prec = precision(ground_truth, answer);
    let f1 = if recall + prec > 0.0 { 2.0 * recall * prec / (recall + prec) } else { 0.0 };
    // A paraphrase can share a claim without sharing a token, so take whichever
    // view recognises the answer. Trigrams are discounted slightly, so exact
    // evidence still leads where both agree.
    let shape = trigram_dice(ground_truth, answer) * SHAPE_WEIGHT;
    let lexical = if shape > f1 { shape } else { f1 };

    // Contradicting the ground truth's verdict is not a near miss. An answer
    // that commits the other way loses almost everything, however much of the
    // right vocabulary it carries.
    let gt_pol = polarity(ground_truth);
    let ma_pol = polarity(answer);
    let mut verdict = if gt_pol != 0 && ma_pol != 0 && (gt_pol > 0) != (ma_pol > 0) { VERDICT_PENALTY } else { 1.0 };

    // Saying a thing and its opposite is not an answer twice over, it is a
    // hedge. Only charged when the ground truth itself commits one way, so a
    // genuinely mixed ground truth is not punished for being mixed.
    if !hedges(ground_truth) && hedges(answer) {
        verdict *= HEDGE_PENALTY;
    }

    let composite = if numeric >= 0.0 && !ma_q.as_slice().is_empty() {
        // A numeric ground truth is a measurement question: the reading decides,
        // text only shades it.
        smoothstep(W_NUMERIC * numeric + (1.0 - W_NUMERIC) * lexical) * verdict
    } else if numeric >= 0.0 {
        // The ground truth states a figure and the answer states none. That is
        // an answer with a piece missing, not a wrong one — and scoring it at
        // zero would rank a wrong answer that happens to quote the figure above
        // a correct paraphrase that leaves it out.
        smoothstep(lexical) * verdict * 0.75
    } else {
        smoothstep(lexical) * verdict
    };

    [if numeric < 0.0 { 0.0 } else { numeric }, recall, prec, composite]
}

pub fn rank(question: &[u8], ground_truth: &[u8], answer: &[u8]) -> f32 {
    signals(question, ground_truth, answer)[3]
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn rank_answer(
    q_ptr: i32,
    q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> f32 {
    rank(read_bytes(q_ptr, q_len), read_bytes(gt_ptr, gt_len), read_bytes(ma_ptr, ma_len))
}

static mut BREAKDOWN: [f32; 4] = [0.0; 4];

/// `[numeric, recall, precision, composite]` — for working out why a score came
/// out the way it did instead of only seeing the final number.
#[no_mangle]
pub unsafe extern "C" fn breakdown_answer(
    q_ptr: i32,
    q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> i32 {
    BREAKDOWN = signals(read_bytes(q_ptr, q_len), read_bytes(gt_ptr, gt_len), read_bytes(ma_ptr, ma_len));
    core::ptr::addr_of!(BREAKDOWN) as i32
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — `cargo test` runs these natively; `no_std` applies to the wasm build only.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn r(q: &str, gt: &str, ma: &str) -> f32 {
        rank(q.as_bytes(), gt.as_bytes(), ma.as_bytes())
    }

    #[test]
    fn blank_is_zero() {
        assert_eq!(r("q", "38.2 C", ""), 0.0);
        assert_eq!(r("q", "38.2 C", "   \t\n "), 0.0);
        assert_eq!(r("q", "38.2 C", "..."), 0.0);
    }

    #[test]
    fn exact_is_one() {
        assert_eq!(r("q", "Paris is the capital", "paris is the capital"), 1.0);
        assert_eq!(r("q", "38.2 °C", "38.2 °C!"), 1.0);
    }

    #[test]
    fn units_are_the_same_reading() {
        let q = "What is the temperature in Riyadh?";
        let gt = "The temperature is 38.2 °C.";
        let celsius = r(q, gt, "It is 38.2 degrees Celsius.");
        let fahrenheit = r(q, gt, "It is 100.8 F.");
        let kelvin = r(q, gt, "It is 311.35 K.");
        let wrong = r(q, gt, "It is 12.0 °C.");
        assert!(celsius > 0.6, "celsius {celsius}");
        assert!(fahrenheit > 0.5, "fahrenheit {fahrenheit} must read as the same measurement");
        assert!(kelvin > 0.5, "kelvin {kelvin}");
        assert!(wrong < 0.3, "a 26-degree miss must not score {wrong}");
        assert!(fahrenheit > wrong && kelvin > wrong);
    }

    #[test]
    fn speed_units_convert() {
        let gt = "Wind is 36 km/h.";
        assert!(r("wind?", gt, "Wind is 10 m/s.") > 0.6, "10 m/s is 36 km/h");
        assert!(r("wind?", gt, "Wind is 22.4 mph.") > 0.6, "22.4 mph is 36 km/h");
        assert!(r("wind?", gt, "Wind is 3 km/h.") < 0.35);
    }

    #[test]
    fn near_miss_beats_far_miss() {
        let gt = "The reading is 38.2 °C.";
        let close = r("q", gt, "The reading is 38.4 °C.");
        let mid = r("q", gt, "The reading is 42.0 °C.");
        let far = r("q", gt, "The reading is 4.0 °C.");
        assert!(close > mid, "{close} !> {mid}");
        assert!(mid > far, "{mid} !> {far}");
    }

    #[test]
    fn shotgun_answers_lose_to_one_committed_answer() {
        let q = "What is the temperature?";
        let gt = "It is 38.2 °C.";
        let committed = r(q, gt, "It is 38.2 °C.");
        let shotgun = r(q, gt, "It could be 10 °C, 20 °C, 30 °C, 38.2 °C, 40 °C or 50 °C.");
        assert!(committed > shotgun, "committed {committed} must beat shotgun {shotgun}");
    }

    #[test]
    fn echoing_the_question_earns_nothing() {
        let q = "Will Riyadh exceed 40 degrees in the next 24 hours?";
        let gt = "No. The forecast peak is 38.2 °C, below the threshold.";
        let echo = r(q, gt, "Will Riyadh exceed 40 degrees in the next 24 hours?");
        let real = r(q, gt, "No, the peak will be 38.2 °C.");
        assert!(echo < 0.35, "question echo scored {echo}");
        assert!(real > echo + 0.3, "real {real} vs echo {echo}");
    }

    #[test]
    fn padding_does_not_pay() {
        let q = "What is the wind speed?";
        let gt = "Wind is 36 km/h.";
        let plain = r(q, gt, "Wind is 36 km/h.");
        let padded = r(q, gt, "Sure! Happy to help. Based on the question, I would say that, overall, in conclusion, the answer here is that the wind is 36 km/h. Hope this helps, let me know if you need anything else!");
        assert!(plain >= padded, "padding must not raise the score: {plain} vs {padded}");
        assert!(padded > 0.4, "but a correct padded answer is still correct: {padded}");
    }

    #[test]
    fn wrong_dimension_never_matches() {
        let gt = "Rainfall is 12 mm.";
        assert!(r("rain?", gt, "It is 12 °C.") < 0.3, "12 mm is not 12 degrees");
    }

    #[test]
    fn prose_answers_still_work() {
        let q = "What is the capital of France?";
        let gt = "Paris is the capital of France.";
        let good = r(q, gt, "The capital is Paris.");
        let bad = r(q, gt, "The capital is Berlin.");
        assert!(good > bad, "good {good} !> bad {bad}");
        assert!(good > 0.5);
    }

    #[test]
    fn survives_hostile_input() {
        let long = "a".repeat(80_000);
        let _ = r("q", "38.2 C", &long);
        let emoji = "🌧️🌪️ suhu 38,2 °C ok 汉字 مرحبا";
        let _ = r("q", "38.2 C", emoji);
        let numbers = "1 ".repeat(5_000);
        let _ = r("q", "38.2 C", &numbers);
        let _ = r("", "", "");
    }

    #[test]
    fn self_match_is_high_across_shapes() {
        // Stage 2 rejects a module whose worst self-match drops under 0.75.
        for gt in [
            "Paris is the capital of France.",
            "The temperature is 38.2 °C.",
            "Wind 36 km/h, gusts 55 km/h, 0.4 mm precipitation.",
            "true",
            "The CVE has a CVSS score of 9.8 and is actively exploited.",
        ] {
            assert_eq!(r("q", gt, gt), 1.0, "self-match failed for {gt}");
        }
    }

    #[test]
    fn scores_vary() {
        let gt = "The temperature is 38.2 °C.";
        let xs = [
            r("q", gt, "38.2 °C"),
            r("q", gt, "38.9 °C"),
            r("q", gt, "41 °C"),
            r("q", gt, "12 °C"),
            r("q", gt, "banana"),
        ];
        let max = xs.iter().cloned().fold(f32::MIN, f32::max);
        let min = xs.iter().cloned().fold(f32::MAX, f32::min);
        assert!(max - min > 0.5, "scores must spread: {xs:?}");
    }


    #[test]
    fn negation_scope_stops_at_the_clause() {
        // "no malicious" flips: the domain is fine.
        assert!(polarity(b"No malicious behaviour was observed; the domain is clean.") > 0);
        // "No," answers the question and does not flip "phishing".
        assert!(polarity(b"No, it is a phishing page and should be blocked.") < 0);
        assert!(polarity(b"Yes, the rate was cut.") > 0);
        assert!(polarity(b"No, the ECB raised rates that month.") < 0);
        assert_eq!(polarity(b"The capital of France is Paris."), 0, "prose with no verdict is neutral");
    }

    #[test]
    fn contradicting_the_verdict_costs_almost_everything() {
        let q = "Is this domain safe to open?";
        let gt = "No, it is a phishing page and should be blocked.";
        let agrees = r(q, gt, "Unsafe - the page is a credential-harvesting clone. Do not open it.");
        let contradicts = r(q, gt, "Safe, this is a legitimate site with no malicious behaviour.");
        assert!(agrees > contradicts * 2.0, "agrees {agrees} must dominate contradicts {contradicts}");
    }

    #[test]
    fn a_keyword_dump_asserting_both_poles_loses() {
        let q = "Is the domain safe?";
        let gt = "No malicious behaviour was observed; the domain is clean.";
        let honest = r(q, gt, "The domain is clean, nothing malicious was seen.");
        let dump = r(q, gt, "malicious behaviour observed domain clean safe unsafe phishing malware verdict score");
        assert!(honest > dump, "honest {honest} must beat the dump {dump}");
    }


    #[test]
    fn written_out_magnitudes_are_read() {
        let qs = extract(b"Total value locked is 812.4 million USD.");
        assert!((qs.as_slice()[0].value - 812_400_000.0).abs() < 1.0, "{:?}", qs.as_slice()[0]);
        let gt = "Total value locked is 812.4 million USD.";
        assert!(r("tvl?", gt, "TVL is about $812.4M.") > 0.6, "M suffix and the word must agree");
        assert!(r("tvl?", gt, "Total value locked is 812.4 thousand USD.") < 0.3, "1000x out is wrong");
    }

    #[test]
    fn numbers_spelled_out_still_count() {
        let gt = "The match finished 3-1.";
        let good = r("final score?", gt, "Final score was three goals to one.");
        let bad = r("final score?", gt, "Final score was 0-0.");
        assert!(good > bad, "spelled-out {good} must beat a wrong scoreline {bad}");
    }

    #[test]
    fn a_missing_figure_is_not_a_wrong_figure() {
        // The correct paraphrase omits "25 basis points"; the wrong answer quotes
        // it. Quoting a number must not outrank being right.
        let q = "Did the ECB cut rates in June 2024?";
        let gt = "Yes, the ECB cut its main rate by 25 basis points in June 2024.";
        let good = r(q, gt, "True - a quarter-point cut was made by the ECB that June.");
        let bad = r(q, gt, "No, the ECB raised rates by 25 basis points that month.");
        assert!(good > bad, "good {good} must beat bad {bad}");
    }

    #[test]
    fn a_mid_clause_negator_is_not_a_verdict() {
        // "not a human" agrees with "it is AI-generated"; only a clause-opening
        // "No," is itself a verdict.
        assert_eq!(polarity(b"This text was produced by a language model, not a human."), 0);
        assert!(polarity(b"No, the passage paraphrases the source and cites it correctly.") < 0);
        let q = "Was this passage written by a language model?";
        let gt = "Yes, the passage is AI-generated.";
        assert!(
            r(q, gt, "This text was produced by a language model, not a human.")
                > r(q, gt, "This text was written by a human author."),
            "the AI verdict must beat the human verdict"
        );
    }

    #[test]
    fn hedging_is_charged_for() {
        let q = "Is the certificate valid?";
        let gt = "Yes, the certificate is valid and expires in 47 days.";
        let straight = r(q, gt, "Valid, 47 days remain.");
        let hedged = r(q, gt, "Yes, the certificate is valid and expires in 47 days. However it is invalid and expired.");
        assert!(straight > hedged, "straight {straight} must beat hedged {hedged}");
    }

    #[test]
    fn trigrams_recognise_a_paraphrase_without_shared_words() {
        // No content word in common, but the shape survives.
        let d = trigram_dice(b"allocation stays a single pointer bump", b"allocating is just moving an offset");
        assert!(d > 0.0 && d < 1.0, "dice {d}");
        assert!((trigram_dice(b"same text here", b"same text here") - 1.0).abs() < 0.001);
        assert_eq!(trigram_dice(b"", b"anything"), 0.0);
    }

    #[test]
    fn extract_reads_units() {
        let qs = extract("38.2 °C wind 10 m/s rain 1.5 mm risk 0.75".as_bytes());
        let items = qs.as_slice();
        assert_eq!(items.len(), 4, "{items:?}");
        assert_eq!(items[0].dim, Dim::Temperature);
        assert!((items[0].value - 38.2).abs() < 0.01);
        assert_eq!(items[1].dim, Dim::Speed);
        assert!((items[1].value - 36.0).abs() < 0.01, "10 m/s -> 36 km/h, got {}", items[1].value);
        assert_eq!(items[2].dim, Dim::Length);
        assert_eq!(items[3].dim, Dim::Ratio);
    }

    #[test]
    fn identifiers_are_not_readings() {
        // "sn32" and "v2" are names, not measurements.
        let qs = extract(b"bittensor sn32 v2 returned 5 mm");
        assert_eq!(qs.as_slice().len(), 1, "{:?}", qs.as_slice());
        assert_eq!(qs.as_slice()[0].dim, Dim::Length);
    }
}
