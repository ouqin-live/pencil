// Pencil 网页涂鸦 - background service worker
// 职责：点击扩展图标 / 快捷键时，按需把 content.js 注入当前页面，并切换涂鸦模式。

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/i.test(tab.url || "")) {
    // chrome://、扩展商店等页面无法注入，静默忽略
    return;
  }
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__pencilInjected,
    });

    if (!injected?.result) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    }

    await chrome.tabs.sendMessage(tab.id, { type: "pencil-toggle" });
  } catch (err) {
    console.warn("[Pencil] 注入失败：", err);
  }
});
