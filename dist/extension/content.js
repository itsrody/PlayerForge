/*
 * The package pointer, not the player. MV2 content scripts are classic
 * scripts (the manifest's js[] vocabulary carries no module grammar), so
 * this member stays chrome: its one job is evaluating the real entry - the
 * kernel bundle, as a module, from this package's own origin - in every
 * frame the manifest reaches.
 *
 * The shell is deliberately NOT named here. kernel.js imports the package's
 * shell.js lazily, on the first confirmed adoption (the provider's own
 * await), so a non-player frame never evals the shell; the module cache
 * makes the second shell cost one promise.
 */
import(browser.runtime.getURL("kernel.js"));
