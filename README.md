# PlayerForge

A userscript that upgrades HTML5 video players on the web — gestures, hotkeys,
resume, subtitles, color filters — for **Firefox**, desktop and Android.

PlayerForge attaches to the recognized self-hostable players — JW Player,
Video.js, Plyr, ArtPlayer, DPlayer, and more — and to plain videos in generic
pages. It does **not** break into proprietary streaming platforms: YouTube,
Netflix, Vimeo and friends are deliberately excluded.

## Requirements

- **Firefox 159 or newer** (desktop: macOS / Windows / Linux; also Android)
- **Violentmonkey 2.50 or newer** as the userscript manager

## Installing

Two options:

1. **Build and install locally:** `npm ci && npm run build`, then serve the
   `dist/` folder over HTTP (e.g. `npx serve dist`) and install
   `http://localhost:<port>/playerforge.user.js` from inside Violentmonkey.
   The CSS companion (`playerforge.css`) is fetched by the script itself from
   the same URL, which is why serving the folder — rather than opening the
   file — is the reliable route.

2. **Install from a hosted dist:** point Violentmonkey at a hosted
   `playerforge.user.js` (GitHub Pages works well) and the updater keeps it
   fresh — the header pins the dist URL for this.

PlayerForge runs on every frame of a page, so it also works **inside embedded
players** (iframes), not just top-level pages. One instance per page video;
embedded players on a big page get their own separate instance, each scoped to
its video.

## What you get

**Gestures** (pointer/touch over the video; the press-and-hold works
anywhere, the drag gestures are fullscreen-only — inline screens leave
every tap and drag to the host page natively):

**Gestures** (pointer/touch over the video; the press-and-hold works
anywhere, the drag gestures are fullscreen-only — inline screens leave
every tap and drag to the host page natively):

| Gesture            | Works      | Action                                               |
| ------------------ | ---------- | ---------------------------------------------------- |
| Press and hold     | Everywhere | Speed up playback while held (2×)                    |
| Horizontal drag    | Fullscreen | Scrub seeking with a live time readout               |
| Vertical drag down | Fullscreen | Picture follows the drag; a long drag exits fullscreen |
| Vertical drag up   | Fullscreen | Opens the PlayerForge panel                          |
| Double-tap         | Fullscreen | Screen edges skip ±1 step; center play/pause         |
| Two-finger pinch   | Fullscreen | Pinch out to fill edge-to-edge; pinch in to release  |

**Hotkeys** (all on a single toggle):

| Key        | Action                                |
| ---------- | ------------------------------------- |
| Space      | Tap = play/pause · Hold = speed up 2× |
| ← / →      | Skip back / forward (Skip Step)       |
| ↑ / ↓      | Volume up / down                      |
| M          | Mute                                  |
| P          | Picture-in-picture                    |
| S          | Open the settings panel               |

Arrow keys skip faster the faster you tap them. All of this only engages when
a video is actually playable, so page shortcuts keep working when playback has
ended.

**In-player settings panel** (`S`, or from the shell surface): skip step size
(5/10/15 s), hotkeys on/off, per-gesture toggles, edge-to-edge fullscreen,
compact panel mode. Settings live in your browser via the userscript
manager's storage and sync live across tabs.

**Progress resume + watch history.** PlayerForge remembers where you left
each video (per site/page, stored locally) and resumes on return — videos
with under 5 seconds of progress record nothing, positions near the end
count as watched, and there's a "Start over" action when you'd rather not.
The watch-history panel lists what you've watched.

**Subtitles.** Load your own `.srt`/`.vtt` files — drag them onto the panel
or paste a URL. Per-cue positioning (vertical/horizontal steppers), a global
sync offset with live preview, and files/URLs are remembered and restored per
video. Cues anchor to the actual displayed picture (letterboxing is handled),
and subtitle files never leak into the host player's own track list.

**Color filters.** Brightness/contrast/saturation/hue-type corrections with
presets, applied from first play even without opening the panel.

**Fullscreen.** Native fullscreen is provisioned across embedded-iframe
chains automatically, and pinch-to-fill zooms the video edge-to-edge inside
the player (release by pinching back in or exiting fullscreen). The
"Edge-to-edge Fullscreen" setting draws Android fullscreen behind display
cutouts (`viewport-fit=cover`); disabling it keeps the system letterbox.

## What it works on

PlayerForge auto-detects the player SDK it's attached to and uses its real
controls: **JW Player, Video.js, Plyr, ArtPlayer, DPlayer, MediaElement.js,
XGPlayer, Aliplayer, Fluid Player, Flowplayer, Clappr, Vidstack, Mux Player,
Radiant Media Player, and Laravel Video Embeds**. A bare `<video>` with no
recognizable player is left alone on purpose — no half-boots on unknown
markup.

## Menu commands

Violentmonkey's menu (PlayerForge entry) carries:

- **Toggle PF debug logging** — flip console chatter for one session
- **Print one state line per realm** — field-triage dump: which frames
  (documents) are running PlayerForge, what videos they see, which shell is
  live. The fastest way to answer "is it even running here?"
- **Restore the default color filter**
- **Restore the default subtitle sync offset**

For one-page debugging you can also open a page with `#pf-debug` appended to
its URL. An explicit menu "Off" wins.

## Privacy

Everything is local: settings, resume points, history and subtitles live in
your userscript manager's sync-tolerant storage. There is no analytics and no
telemetry. The only network request PlayerForge ever makes is fetching the
subtitle file at a URL you supply, via the manager (`GM_xmlhttpRequest`, so
CORS-hostile hosts work); the HUD stylesheet is fetched by the manager from
the bundle it ships with.

## Troubleshooting

- **"Nothing happens on this page"** — run the menu command **Print one
  state line per realm**. If you see no state line at all, the script isn't
  running (check it's enabled and the site isn't excluded); if the line lists
  no videos, the player isn't recognized and PlayerForge leaves it alone by
  design.
- **Platform sites (YouTube/Netflix/…) are intentionally out of scope** — the
  script's header excludes them; that's support policy, not breakage.
- **Embedded players** — the script runs in iframes; use the realm-state dump
  to see which document (frame) has the video if the top page looks inert.
  On an embedded player's own fullscreen, provisioning is pushed to all
  ancestor frames automatically.

## Going deeper

For the reader who wants the how/why: the internal design/development
document is [AGENTS.md](AGENTS.md) — module map, the full refactoring path,
the HUD design rules and the test battery, written for a developer landing
in this repo cold.

## Building from source

```sh
npm ci          # install deps
npm run build   # write dist/playerforge.user.js + dist/playerforge.css
npm test        # syntax + flaws + census + bundle + a real-Firefox browser gate (~2 min)
npm run lint    # eslint src/
```

The version is derived from `package.json` by the build — never hand-edited.
See AGENTS.md §7 for how the check tool proves behavior on a real Firefox
159 floor.
