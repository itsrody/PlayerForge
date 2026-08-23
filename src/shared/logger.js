export const PREFIX = "[PlayerForge]";

const STYLES = {
  kernel: "color: #FF6B35; font-weight: bold",
  shell: "color: #4ECDC4; font-weight: bold",
  plugin: "color: #95E1D3",
  warn: "color: #F38181; font-weight: bold",
  error: "color: #AA0000; font-weight: bold"
};

function styleFor(channel) {
  return STYLES[channel] || "";
}

function log(channel, ...args) {
  console.log(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", styleFor(channel), ...args);
}

function warn(channel, ...args) {
  console.warn(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.warn, ...args);
}

function error(channel, ...args) {
  console.error(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.error, ...args);
}

function group(channel, label) {
  console.group(`%c${PREFIX}%c[${channel}] ${label}`, "color: #FF6B35", styleFor(channel));
}

function groupEnd() {
  console.groupEnd();
}

export const logger = { log, warn, error, group, groupEnd };
