/**
 * Test-only Web Animations API + FF-native DOM method shims for jsdom.
 *
 * Production code (src/) calls Element.animate()/getAnimations() and
 * video.animate() unconditionally (native Firefox 63+/75+, the FF 155
 * baseline), plus Element.checkVisibility() (FF 106+) and
 * Document.startViewTransition() (FF 144+). jsdom's elements/documents lack
 * them, and the loader can't reach jsdom's per-window prototypes (see
 * loader.mjs), so this helper — imported only by the specific test files that
 * step through those paths — installs controllable fakes on each window's
 * prototypes.
 *
 * The WAAPI fake returns real Animation-shaped stubs so tests can drive
 * completion explicitly (finishNow()/cancel()): the CSS-transition fallback
 * these paths replaced is gone, so settling is modelled by firing the WAAPI
 * completion event, not a transitionend.
 *
 * The most-recently-created stub is pushed to `mockAnimations` so tests can
 * settle or cancel the animation they just started.
 */
export function installWaapiShim(window, mockAnimations = []) {
  // FF-native Document.startViewTransition: run the DOM-swap update().
  if (typeof window.Document.prototype.startViewTransition !== "function") {
    window.Document.prototype.startViewTransition = ({ update }) => update();
  }
  // FF-native Element.checkVisibility: default to VISIBLE (the safe,
  // admission-negative-default posture for the sdk adoption gate).
  if (typeof window.Element.prototype.checkVisibility !== "function") {
    window.Element.prototype.checkVisibility = () => true;
  }
  // WAAPI on any HTMLElement (video included).
  window.HTMLElement.prototype.animate = function animate(keyframes) {
    const anim = {
      playState: "running",
      effect: { getKeyframes: () => keyframes },
      _listeners: { finish: [], cancel: [] },
      addEventListener(type, cb) {
        if (this._listeners[type]) {
          this._listeners[type].push(cb);
        }
      },
      cancel() {
        if (this.playState === "idle") {
          return;
        }
        this.playState = "idle";
        for (const cb of this._listeners.cancel) {
          cb();
        }
      },
      finishNow() {
        if (this.playState === "finished") {
          return;
        }
        this.playState = "finished";
        for (const cb of this._listeners.finish) {
          cb();
        }
      }
    };
    mockAnimations.push(anim);
    return anim;
  };
  window.Element.prototype.getAnimations = () => [];
  return window;
}
