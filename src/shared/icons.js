const svgIcon = (path, viewBox = "24 24") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 ${viewBox}" fill="currentColor"><path d="${path}"/></svg>`;

export const ICONS = {
  "volume-1": svgIcon("M3 9h4l5-5v16l-5-5H3V9zm18 3a9.003 9.003 0 0 1-7 8.777V18.71a7.003 7.003 0 0 0 0-13.42V3.223c4.008.91 7 4.494 7 8.777zm-4 0a5.001 5.001 0 0 1-3 4.584V7.416c1.766.772 3 2.534 3 4.584z"),
  "volume-2": svgIcon("M5 9v6h4l5 5V4L9 9H5zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"),
  "volume-3": svgIcon("M3 9h4l5-5v16l-5-5H3V9zm9 2a4 4 0 0 1 0 6"),
  muted: svgIcon("M3.5 2A1 1 0 0 0 3 3.719l20 20a1 1 0 1 0 1.406-1.407L17 14.907V3.312c0-1.265-1.105-1.582-1.969-.718L9.812 7.719L4.407 2.312A1 1 0 0 0 3.594 2A1 1 0 0 0 3.5 2zM5 9.063c-.551 0-1 .448-1 1v6c0 .55.449 1 1 1h3.438L15 23.468c1 1 2 .488 2-.875V20.03L6.031 9.063H5z"),
  play: svgIcon("M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440Z"),
  pause: svgIcon("M208 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16Zm144 0h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16Z"),
  RArrows: svgIcon("m5.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L5.58 7.11C4.91 6.65 4 7.12 4 7.93v8.14c0 .81.91 1.28 1.58.82zM13 7.93v8.14c0 .81.91 1.28 1.58.82l5.77-4.07c.56-.4.56-1.24 0-1.63l-5.77-4.07c-.67-.47-1.58 0-1.58.81z"),
  LArrows: svgIcon("M11 16.07V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.56.4-.56 1.24 0 1.63l5.77 4.07c.67.47 1.58 0 1.58-.81zm1.66-3.25l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64z"),
  DArrow: svgIcon("M152 0q-21 0-21 21v297l-94-77q-7-6-16-5t-14 7q-6 7-5 16t7 14l143 111l141-111q15-15 2-30q-16-14-30-2l-92 77V21q0-21-21-21z", "304 480"),
  Resume: svgIcon("M6 18V6h2v12H6Zm4 0l10-6l-10-6v12Z"),
  fullscreen: svgIcon("M43 235v64h64v42H0V235h43zM0 149V43h107v42H43v64H0zm256 150v-64h43v106H192v-42h64zM192 43h107v106h-43V85h-64V43z", "300 280"),
  "exit-fullscreen": svgIcon("m192 64l-.001 85.333H192V192l-.001-.001l.001.001h-42.667v-.001L64 192v-42.667h85.333V64zm0 256v42.667l-.001-.001L192 448h-42.667v-85.334H64V320zM362.667 64l-.001 85.333H448V192l-85.334-.001V192H320V64zM448 320v42.667l-85.334-.001V448H320V320z", "512 512"),
  "fill-aspect": svgIcon("M17 15h-2q-.425 0-.713.288T14 16q0 .425.288.713T15 17h3q.425 0 .713-.288T19 16v-3q0-.425-.288-.713T18 12q-.425 0-.713.288T17 13v2ZM7 9h2q.425 0 .713-.288T10 8q0-.425-.288-.713T9 7H6q-.425 0-.713.288T5 8v3q0 .425.288.713T6 12q.425 0 .713-.288T7 11V9ZM4 20q-.825 0-1.413-.588T2 18V6q0-.825.588-1.413T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.588 1.413T20 20H4Zm0-2h16V6H4v12Zm0 0V6v12Z"),
  captions: svgIcon("M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 6.5a.5.5 0 0 1-.5.5H10a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h.5a.5.5 0 0 1 .5.5.5.5 0 0 1-.5.5H10a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h.5a.5.5 0 0 1 .5.5zm6 0a.5.5 0 0 1-.5.5H16a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h.5a.5.5 0 0 1 .5.5.5.5 0 0 1-.5.5H16a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h.5a.5.5 0 0 1 .5.5z"),
  reload: svgIcon("M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"),
  settings: svgIcon("M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.48.48 0 0 0 14.1 2h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.9 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"),
  trash: svgIcon("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"),
  upload: svgIcon("M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z")
};

const ALIASES = {
  vol: "volume-1",
  "vol-up": "volume-1",
  "vol-down": "volume-2",
  "vol-mute": "muted",
  mute: "muted",
  unmute: "volume-1",
  playing: "pause",
  paused: "play",
  fwd: "RArrows",
  forward: "RArrows",
  back: "LArrows",
  rewind: "LArrows",
  fs: "fullscreen",
  "fs-enter": "fullscreen",
  "fs-exit": "exit-fullscreen",
  "fs-exiting": "DArrow",
  "fill-aspect": "fill-aspect",
  resume: "Resume",
  captions: "captions",
  cc: "captions",
  reload: "reload",
  restart: "reload",
  settings: "settings",
  gear: "settings",
  delete: "trash",
  remove: "trash",
  load: "upload"
};

export function canonicalName(name) {
  return ALIASES[name] ?? (name in ICONS ? name : null);
}

export function iconMarkup(name) {
  const canonical = canonicalName(name);
  return canonical ? ICONS[canonical] : null;
}

const elementCache = new Map();

export function createIconElement(name, doc = document) {
  const canonical = canonicalName(name);
  if (!canonical) {
    return null;
  }
  if (elementCache.has(canonical)) {
    return elementCache.get(canonical).cloneNode(true);
  }
  const holder = doc.createElement("div");
  holder.innerHTML = ICONS[canonical];
  const el = holder.firstElementChild;
  if (el) {
    holder.removeChild(el);
  }
  elementCache.set(canonical, el);
  return el.cloneNode(true);
}
