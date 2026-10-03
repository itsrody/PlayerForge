import js from "@eslint/js";
import { pfRules } from "./platform/eslint-rules.mjs";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: "module",
      globals: {
        // Manager (GM) API
        GM_getValue: "readonly",
        GM_setValue: "readonly",
        GM_addValueChangeListener: "readonly",
        GM_removeValueChangeListener: "readonly",
        GM_registerMenuCommand: "readonly",
        GM_unregisterMenuCommand: "readonly",
        GM_xmlhttpRequest: "readonly",
        GM_info: "readonly",
        // Browser globals not in default env
        scheduler: "readonly",
        screen: "readonly",
        requestAnimationFrame: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        performance: "readonly",
        location: "readonly",
        document: "readonly",
        window: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        Uint8Array: "readonly",
        Int32Array: "readonly",
        Map: "readonly",
        Set: "readonly",
        WeakMap: "readonly",
        WeakSet: "readonly",
        Promise: "readonly",
        Proxy: "readonly",
        Reflect: "readonly",
        JSON: "readonly",
        Math: "readonly",
        Date: "readonly",
        RegExp: "readonly",
        Error: "readonly",
        TypeError: "readonly",
        RangeError: "readonly",
        SyntaxError: "readonly",
        Infinity: "readonly",
        NaN: "readonly",
        parseInt: "readonly",
        parseFloat: "readonly",
        isNaN: "readonly",
        isFinite: "readonly",
        encodeURIComponent: "readonly",
        decodeURIComponent: "readonly",
        encodeURI: "readonly",
        decodeURI: "readonly",
        atob: "readonly",
        btoa: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        Blob: "readonly",
        File: "readonly",
        FormData: "readonly",
        URLSearchParams: "readonly",
        Element: "readonly",
        HTMLElement: "readonly",
        HTMLVideoElement: "readonly",
        HTMLIFrameElement: "readonly",
        Node: "readonly",
        NodeList: "readonly",
        DocumentFragment: "readonly",
        ShadowRoot: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        MediaStream: "readonly",
        TextTrack: "readonly",
        TextTrackCue: "readonly",
        VTTCue: "readonly",
        XMLHttpRequest: "readonly",
        DOMParser: "readonly",
        Image: "readonly",
        Symbol: "readonly",
        BigInt: "readonly",
        FinalizationRegistry: "readonly",
        WeakRef: "readonly",
        AggregateError: "readonly",
        URIError: "readonly",
        EvalError: "readonly",
        CompileError: "readonly",
        LinkError: "readonly",
        RuntimeError: "readonly",
        SharedArrayBuffer: "readonly",
        Atomics: "readonly",
        WebAssembly: "readonly",
        matchMedia: "readonly",
        CloseWatcher: "readonly",
        getComputedStyle: "readonly",
        cancelAnimationFrame: "readonly",
        requestAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        CSSStyleSheet: "readonly",
        MediaMetadata: "readonly",
        AudioContext: "readonly",
        OffscreenCanvas: "readonly",
        Clipboard: "readonly",
        ClipboardItem: "readonly",
        Notification: "readonly",
        NotificationEvent: "readonly",
        ServiceWorkerRegistration: "readonly",
        NavigationHistoryEntry: "readonly",
        navigator: "readonly",
        PerformanceObserver: "readonly",
        MessageChannel: "readonly",
        MessagePort: "readonly",
        Worker: "readonly",
        self: "readonly",
        __VTT_WORKER_SOURCE__: "readonly",
        GM_getResourceText: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-extra-semi": "error",
      "no-redeclare": "error",
      "no-sparse-arrays": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-caller": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-wrappers": "error",
      "no-throw-literal": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn",
      "prefer-const": "error",
      "no-var": "error",
      "no-loss-of-precision": "error",
      "no-promise-executor-return": "error",
      "no-self-assign": "error",
      "no-unmodified-loop-condition": "error",
      "no-useless-concat": "error",
      "no-useless-escape": "error",
      "no-void": "error",
      "no-with": "error",
      "no-shadow-restricted-names": "error",
      "no-useless-assignment": "error"
    }
  },
  {
    // §5's "No forced synchronous layout" is stated as a lint rule in the
    // invariant table, so it is one. src/ only: the platform side has no DOM
    // writes to read back from, and the rule's whole premise is the pair.
    files: ["src/**/*.js"],
    plugins: { pf: { rules: pfRules } },
    rules: { "pf/no-forced-layout": "error" }
  },
  {
    // Node-side harness and test tooling.
    //
    // Linted at all only recently, and the first pass found two things worth
    // having: genuine dead code in the Firefox driver, and no-void / unused
    // bindings that lint alone cannot judge. The exceptions below are
    // deliberate, not a backlog.
    files: ["platform/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        performance: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        // Constructed inside driver.eval(), i.e. in the page, not here. They
        // exist at runtime; eslint cannot see across the WebDriver boundary.
        KeyboardEvent: "readonly",
        PointerEvent: "readonly",
        DataTransfer: "readonly",
        DOMException: "readonly"
      }
    },
    rules: {
      // `new Promise(resolve => setTimeout(resolve, ms))` returns the timer id.
      // That is the house idiom for a delay in this tree and reads better than
      // a braced block that discards it; src/ has no occurrences, so this only
      // ever fires on the Node side.
      "no-promise-executor-return": "off",
      // `void somePromise()` is how this tree marks a deliberately un-awaited
      // call at a call site, which is more legible than an empty .catch() and
      // is not the same statement as ignoring a rejected promise by accident.
      "no-void": "off",
      // Unused `catch (e)` is the shape of a deliberately ignored rejection.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  },
  {
    // The add-on under platform/harness/native-extension/ is classic WebExtension
    // script, not ESM: the pages load it as a plain <script> and it uses `var`
    // and bare `catch (e)` throughout. Holding it to the module rules would be
    // holding it to the wrong language.
    files: ["platform/harness/native-extension/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        browser: "readonly",
        chrome: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        // Supplied at runtime, not by this file: __PF_CONTROL_PORT__ is
        // substituted into the archive by buildExtension() in native.mjs, and
        // the PF_* bridge is defined by content/api.js in the same realm.
        __PF_CONTROL_PORT__: "readonly",
        PF_storage: "readonly",
        PF_setValue: "readonly",
        PF_deleteValue: "readonly",
        PF_report: "readonly"
      }
    },
    rules: {
      "no-var": "off",
      "no-promise-executor-return": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "bench/**"
    ]
  }
];
