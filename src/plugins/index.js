import { HotkeysPlugin } from "./hotkeys.js";
import { ResumePlugin } from "./resume.js";
import { SubtitlesPlugin } from "./subtitles.js";
import { SettingsPlugin } from "./settings.js";

/** Register the built-in plugin set on a freshly created shell. */
export function registerBuiltins(shell) {
  shell.plugins.register(new HotkeysPlugin());
  shell.plugins.register(new ResumePlugin());
  shell.plugins.register(new SubtitlesPlugin());
  shell.plugins.register(new SettingsPlugin());
}
