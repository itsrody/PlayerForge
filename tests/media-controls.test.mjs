import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMediaControls } from "../src/shell/media.js";
import { BUS_EVENTS } from "../src/shared/events.js";

function makeEnv(readyState = 0) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  const video = dom.window.document.createElement("video");
  if (readyState != null) {
    Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
  }
  const emissions = [];
  const bus = {
    emit(type, detail) {
      emissions.push({ type, detail });
    }
  };
  const controls = createMediaControls({ video, bus, shellId: "s1" });
  const commands = () => emissions.filter((entry) => entry.type === BUS_EVENTS.mediaCommand);
  return { dom, video, controls, commands, emissions };
}

test("every control is inert before metadata loads (readyState 0)", async () => {
  const { video, controls, commands } = makeEnv(0);
  const snap = () => ({
    time: video.currentTime,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate
  });

  const before = snap();
  controls.seekTo(50);
  controls.scrubTo(30);
  controls.skip(10);
  controls.stop();
  controls.toggleMute();
  controls.setVolume(0.3);
  controls.nudgeVolume("up");
  controls.beginBoost(2);
  controls.endBoost(1);
  controls.pause();
  await controls.togglePlay();
  await controls.play();

  assert.deepEqual(snap(), before);
  assert.equal(commands().length, 0, "no media command emitted before load");
});

test("play is inert before metadata loads", async () => {
  const { video, controls, commands } = makeEnv(0);
  let played = false;
  video.play = () => {
    played = true;
    return Promise.resolve();
  };
  await controls.play();
  assert.equal(played, false);
  assert.equal(commands().length, 0);
});

test("controls engage once metadata is loaded (readyState 4)", async () => {
  const { dom, video, controls, commands } = makeEnv(4);
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  video.play = () => Promise.resolve();

  controls.setVolume(0.5);
  assert.equal(video.volume, 0.5);

  controls.toggleMute();
  assert.equal(video.muted, true);

  controls.seekTo(60);
  assert.equal(video.currentTime, 60);

  controls.skip(10);
  assert.equal(video.currentTime, 70);

  controls.scrubTo(90);
  assert.equal(video.currentTime, 90);

  controls.beginBoost(2);
  assert.equal(video.playbackRate, 2);
  controls.endBoost(1);
  assert.equal(video.playbackRate, 1);

  await controls.play();
  controls.pause();

  const types = commands().map((entry) => entry.detail.type);
  assert.deepEqual(types, [
    "volume", "mute", "seek", "seek", "skip", "boost-start", "boost-end", "play", "pause"
  ]);
});

test("gating reads live readyState, not a snapshot at creation", async () => {
  const { video, controls, commands } = makeEnv(0);
  controls.pause();
  assert.equal(commands().length, 0);

  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  video.play = () => Promise.resolve();
  await controls.togglePlay();
  assert.ok(commands().some((entry) => entry.detail.type === "play"));
});
