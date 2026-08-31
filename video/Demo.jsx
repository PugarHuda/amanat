// The demo film: title, five real sessions, and a closing card.
//
// Every clip under this is footage of the live miner, recorded by
// scripts/record-demo.mjs against amanat-miner.vercel.app. Nothing is a mockup
// and nothing is re-timed — a clip is as long as the page took to answer, which
// is why the durations come out of the file rather than out of a constant.
//
// The palette is the site's: ivory plate on a night sea, and the only red is
// the band from 0.75 up, the line the contract pays on.

import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const FPS = 30;
export const WIDTH = 1600;
export const HEIGHT = 900;

const SEA = "#0b1f2e";
const SEA_2 = "#10293b";
const SEA_3 = "#163448";
const ON_SEA = "#e9eef0";
const ON_SEA_2 = "#a9bcc7";
const PLATE = "#f2ece0";
const INK = "#14110c";
const INK_3 = "#575349";
const TRIGGER = "#b3271e";

const DISPLAY = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** What each clip is, and why it is in the film. */
export const CAPTIONS = {
  reading: {
    title: "A place in, a risk out",
    body: "Typed into the live site. The band is 51 ECMWF ensemble members; the trigger is the line the contract pays on.",
  },
  route: {
    title: "Risk along a route, at the hour you arrive",
    body: "Cebu to Manila. Each leg is read at the hour a vessel reaches it — not one lookup for the whole voyage.",
  },
  ledger: {
    title: "The book, read from the chain at load",
    body: "Two policies, both answered by the protocol, both declined. The reason is the interesting part.",
  },
  jobable: {
    title: "Every auditable intent is closed to on-chain jobs",
    body: "A job is routed by rank, and nothing checks whether that miner can receive one. Where the leader's registration can be read, all of them are shut.",
  },
  slides: {
    title: "Three tracks, one codebase",
    body: "The whole argument in nine slides, at /slides.",
  },
};

const TITLE_SECONDS = 4;
const OUTRO_SECONDS = 5;

/** Frames for a clip, from its measured length. */
export const framesFor = (seconds) => Math.max(1, Math.round(seconds * FPS));

export const totalFrames = (clips) =>
  framesFor(TITLE_SECONDS) +
  clips.reduce((sum, c) => sum + framesFor(c.seconds), 0) +
  framesFor(OUTRO_SECONDS);

/** Fade a value in over `len` frames, and out over the last `len`. */
const inOut = (frame, duration, len = 12) =>
  Math.min(
    interpolate(frame, [0, len], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(frame, [duration - len, duration], [1, 0], { extrapolateLeft: "clamp" }),
  );

function TitleCard({ durationInFrames }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  return (
    <AbsoluteFill style={{ backgroundColor: PLATE, padding: 96, justifyContent: "center" }}>
      <div style={{ opacity: inOut(frame, durationInFrames, 15), transform: `translateY(${(1 - rise) * 18}px)` }}>
        <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: 3, textTransform: "uppercase", color: INK_3 }}>
          Telegraph Hackathon — Season I
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: 84, lineHeight: 1.04, color: INK, marginTop: 28, maxWidth: 1180 }}>
          A contract that buys its own evidence and pays itself.
        </div>
        <div style={{ fontFamily: MONO, fontSize: 22, color: INK_3, marginTop: 34 }}>
          amanat-miner.vercel.app · every frame below is the live miner
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Clip({ name, durationInFrames }) {
  const frame = useCurrentFrame();
  const caption = CAPTIONS[name];
  // The caption holds for four seconds and then clears the footage, because a
  // strip that never leaves stops being read and starts being furniture.
  const hold = Math.min(durationInFrames, 4 * FPS);
  const captionOpacity = interpolate(frame, [8, 20, hold - 12, hold], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: SEA }}>
      <OffthreadVideo src={staticFile(`${name}.webm`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {caption ? (
        <AbsoluteFill style={{ justifyContent: "flex-end", padding: 56, opacity: captionOpacity }}>
          <div
            style={{
              backgroundColor: SEA,
              border: `1px solid ${SEA_3}`,
              borderLeft: `4px solid ${name === "jobable" ? TRIGGER : ON_SEA_2}`,
              padding: "22px 28px",
              maxWidth: 1080,
            }}
          >
            <div style={{ fontFamily: DISPLAY, fontSize: 38, lineHeight: 1.1, color: ON_SEA }}>{caption.title}</div>
            <div style={{ fontFamily: MONO, fontSize: 19, lineHeight: 1.5, color: ON_SEA_2, marginTop: 12 }}>
              {caption.body}
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
}

function OutroCard({ durationInFrames }) {
  const frame = useCurrentFrame();
  const rows = [
    ["curl amanat-miner.vercel.app/api/jobable", "the on-chain rail, audited live"],
    ["curl amanat-miner.vercel.app/api/survey", "measured bar vs displayed score"],
    ["curl amanat-miner.vercel.app/api/board", "ten lanes, screened through Telegraph"],
    ['node app/storm.mjs "Cebu" --telegraph', "ask the network, not us"],
  ];
  return (
    <AbsoluteFill style={{ backgroundColor: SEA, padding: 96, justifyContent: "center" }}>
      <div style={{ opacity: inOut(frame, durationInFrames, 15) }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 62, color: ON_SEA, maxWidth: 1100, lineHeight: 1.08 }}>
          Nothing here is a claim you have to take.
        </div>
        <div style={{ marginTop: 40, backgroundColor: SEA_2, border: `1px solid ${SEA_3}`, padding: "26px 30px" }}>
          {rows.map(([cmd, note], i) => (
            <div key={cmd} style={{ display: "flex", gap: 24, marginTop: i ? 14 : 0, alignItems: "baseline" }}>
              <code style={{ fontFamily: MONO, fontSize: 21, color: ON_SEA, minWidth: 620 }}>{cmd}</code>
              <span style={{ fontFamily: MONO, fontSize: 18, color: ON_SEA_2 }}>{note}</span>
            </div>
          ))}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 19, color: ON_SEA_2, marginTop: 32 }}>
          github.com/PugarHuda/amanat · 0x39D2bae5…5Cd7E
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function Demo({ clips }) {
  let at = framesFor(TITLE_SECONDS);
  const title = framesFor(TITLE_SECONDS);
  const outro = framesFor(OUTRO_SECONDS);
  return (
    <AbsoluteFill style={{ backgroundColor: SEA }}>
      <Sequence durationInFrames={title}>
        <TitleCard durationInFrames={title} />
      </Sequence>
      {clips.map((clip) => {
        const len = framesFor(clip.seconds);
        const from = at;
        at += len;
        return (
          <Sequence key={clip.name} from={from} durationInFrames={len}>
            <Clip name={clip.name} durationInFrames={len} />
          </Sequence>
        );
      })}
      <Sequence from={at} durationInFrames={outro}>
        <OutroCard durationInFrames={outro} />
      </Sequence>
    </AbsoluteFill>
  );
}
