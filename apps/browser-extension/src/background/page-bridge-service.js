import { isSupportedChatUrl } from "../supported-sites.js";

export async function injectPageBridge(tabId) {
  if (!tabId) return false;

  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedChatUrl(tab.url)) return false;

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    files: ["page-bridge-main.js"]
  });

  return true;
}
