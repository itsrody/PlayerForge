import { register } from "node:module";
register("./css-hook.mjs", import.meta.url);
// The platform-global shim set (Resize/IntersectionObserver, scheduler,
// navigation, MediaMetadata, matchMedia, vibrate) lives in shims.mjs so the
// bench cases get the identical harness world instead of hand-rolling
// partial stand-ins that bench a crashing page.
import "./shims.mjs";
