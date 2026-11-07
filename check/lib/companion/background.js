/*
 * Companion background page. One receiver: the pfTrigger round trip - the
 * popup channel's exact shape (browser.tabs.sendMessage into the active
 * tab's top document), owned here because a content script has no tabs
 * access. The reply is structured-cloneable plain data by construction.
 *
 * The TAB_COMMAND literal "pf:command" mirrors src/kernel/contract.js's
 * TAB_COMMAND (a static file cannot import src); suite rows exercise the
 * channel so a contract drift fails loudly, not silently.
 */
browser.runtime.onMessage.addListener((message) => {
  if (message?.pfTrigger === undefined) {
    return undefined;
  }
  return (async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) {
        return { ok: false, error: "no active tab" };
      }
      const reply = await browser.tabs.sendMessage(tab.id, {
        type: "pf:command",
        command: String(message.pfTrigger)
      });
      return { ok: true, reply: reply === undefined ? null : reply };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  })();
});
