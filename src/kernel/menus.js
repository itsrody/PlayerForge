import { logger } from "../shared/logger.js";
import { gmRegisterMenu, gmUnregisterMenu, getConfigValue, setConfigValue } from "../shared/storage.js";
import { DEBUG_LOGS_KEY } from "./contract.js";

/**
 * GM menu wiring, owned here instead of the kernel so the debug command
 * exists from script eval - not just after a video is discovered. The
 * debug toggle works fully without a kernel: it persists the setting and
 * flips module-level logger state.
 */
export function installMenuCommands() {
  let debugId = null;

  const refreshDebug = () => {
    if (debugId != null) {
      gmUnregisterMenu(debugId);
    }
    const enabled = getConfigValue(DEBUG_LOGS_KEY, false);
    debugId = gmRegisterMenu(
      `\u{1F41B} Debug Logs:${enabled ? "On" : "Off"}`,
      () => {
        const next = !getConfigValue(DEBUG_LOGS_KEY, false);
        setConfigValue(DEBUG_LOGS_KEY, next);
        if (next) {
          logger.enable();
        } else {
          logger.disable();
        }
        refreshDebug();
      },
      { autoClose: true }
    );
  };

  refreshDebug();

  return () => {
    if (debugId != null) {
      gmUnregisterMenu(debugId);
      debugId = null;
    }
  };
}
