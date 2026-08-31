// The compositions Remotion can render.
//
// The clip list is read from media/clips.json, which scripts/probe-clips.mjs
// writes by measuring the recorded files. So re-recording against a slower day
// produces a longer film without anyone editing a number here — which is the
// point, since the footage is a live miner and we do not control how long it
// takes to answer.

import React from "react";
import { Composition } from "remotion";
import { Demo, FPS, HEIGHT, WIDTH, totalFrames } from "./Demo.jsx";
import clipsFile from "../media/clips.json";

const clips = clipsFile.clips;

export function RemotionRoot() {
  return (
    <Composition
      id="demo"
      component={Demo}
      durationInFrames={totalFrames(clips)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ clips }}
    />
  );
}
