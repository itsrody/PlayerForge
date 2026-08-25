import { logger } from "../shared/logger.js";
import { gmRegisterMenu, gmUnregisterMenu, getConfigValue, setConfigValue } from "../shared/storage.js";
import { DEBUG_LOGS_KEY } from "../shell/chrome/config.js";

/**
 * GM menu wiring, owned here instead of the kernel so the two commands
 * exist from script eval - not just after a video is discovered. Before
 * that fix, pages without a supported player had NO menu at all because
 * registration lived inside kernel.init(), which only runs on boot.
 *
 * getKernel() returns the live Kernel or null (pre-boot). The debug toggle
 * works fully without a kernel: it persists the setting and flips module-
 * level logger state; whichever kernel boots later applies the stored
 * value to its bus. Only the panel action needs a live kernel.
 */
export function installMenuCommands({ getKernel }) {
  let panelId = null;
  let debugId = null;

  const registerPanel = () => {
    panelId = gmRegisterMenu("⚙️ PlayerForge Panel", () => {
      const kernel = getKernel();
      if (!kernel) {
        logger.warn("menus", "No player discovered yet - nothing to open a panel for");
        return;
      }
      kernel.togglePanel();
    }, { autoClose: true });
  };

  const refreshDebug = () => {
    if (debugId != null) {
      gmUnregisterMenu(debugId);
    }
    const enabled = getConfigValue(DEBUG_LOGS_KEY, false);
    debugId = gmRegisterMenu(
      `\u{1F41B} PlayerForge Debug Logs: ${enabled ? "On" : "Off"}`,
      () => {
        const next = !getConfigValue(DEBUG_LOGS_KEY, false);
        setConfigValue(DEBUG_LOGS_KEY, next);
        if (next) {
          logger.enable();
        } else {
          logger.disable();
        }
        const kernel = getKernel();
        if (kernel) {
          kernel.bus.debug = next;
        }
        // Re-caption so the label always reads current state.
        refreshDebug();
      },
      { autoClose: true }
    );
  };

  registerPanel();
  refreshDebug();

  return () => {
    if (panelId != null) {
      gmUnregisterMenu(panelId);
      panelId = null;
    }
    if (debugId != null) {
      gmUnregisterMenu(debugId);
      debugId = null;
    }
  };
}
