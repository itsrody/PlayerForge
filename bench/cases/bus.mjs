import { measure } from "../lib.mjs";

const { EventBus } = await import("../../src/kernel/bus.js");

export default [
  measure("bus emit no-listener (fresh detail per tick, legacy)", () => {
    const bus = new EventBus();
    return () => {
      for (let i = 0; i < 200; i++) {
        bus.emit("pf:shell-timeupdate", { shellId: "s", event: { type: "timeupdate" }, video: null });
      }
    };
  }),

  measure("bus emit no-listener (reused detail register)", () => {
    const bus = new EventBus();
    const detail = { shellId: "s", event: null, video: null };
    const tick = { type: "timeupdate" };
    return () => {
      for (let i = 0; i < 200; i++) {
        detail.event = tick;
        bus.emit("pf:shell-timeupdate", detail);
      }
    };
  }),

  measure("bus emit one listener (reused detail)", () => {
    const bus = new EventBus();
    bus.addEventListener("pf:bench", () => {});
    const detail = { shellId: "s", event: null };
    return () => {
      for (let i = 0; i < 200; i++) {
        detail.event = null;
        bus.emit("pf:bench", detail);
      }
    };
  })
];
