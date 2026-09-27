/**
 * Zotero DSH — bootstrap entry.
 * Lifecycle hooks follow Zotero 7 bootstrapped-extension conventions
 * (same shape as the official Make It Red example).
 */

var chromeHandle;
var APP_SHUTDOWN = 2;

function install(data, reason) {}

function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-dsh", rootURI + "content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/zotero-dsh.js",
    ctx,
  );
  return Zotero.ZoteroDSH.hooks.onStartup();
}

function onMainWindowLoad({ window }, reason) {
  Zotero.ZoteroDSH?.hooks.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }, reason) {
  Zotero.ZoteroDSH?.hooks.onMainWindowUnload(window);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.ZoteroDSH?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = undefined;
  }
}

function uninstall(data, reason) {}
