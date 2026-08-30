import { Shell } from "./shell.js";

/**
 * The shell plugin's "main": the one place the shell reaches the framework and
 * hands it a host provider. The kernel (framework) never imports the shell - it
 * only calls the provider registered here. Keeping the `Shell` import in the
 * plugin (and out of the kernel) is what makes the shell a plug-in rather than
 * something the framework constructs directly.
 */
export function registerShell(kernel) {
  kernel.registerShellProvider({
    create({ video, container, sdk, onDestroy }) {
      return new Shell({ video, container, sdk, onDestroy });
    }
  });
}
