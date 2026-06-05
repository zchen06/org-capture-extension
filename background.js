///////////////////////////////////////////////////////////////////////////////////
// Copyright (c) 2015-2017 Konstantin Kliakhandler				 //
// 										 //
// Permission is hereby granted, free of charge, to any person obtaining a copy	 //
// of this software and associated documentation files (the "Software"), to deal //
// in the Software without restriction, including without limitation the rights	 //
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell	 //
// copies of the Software, and to permit persons to whom the Software is	 //
// furnished to do so, subject to the following conditions:			 //
// 										 //
// The above copyright notice and this permission notice shall be included in	 //
// all copies or substantial portions of the Software.				 //
// 										 //
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR	 //
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,	 //
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE	 //
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER	 //
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, //
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN	 //
// THE SOFTWARE.								 //
///////////////////////////////////////////////////////////////////////////////////


chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason == "install")
    chrome.storage.sync.set(
      {
        selectedTemplate: 'p',
        unselectedTemplate: 'L',
        useNewStyleLinks: true,
        debug: false,
        overlay: true
      });
  else if ((details.reason == "update" && details.previousVersion.startsWith("0.1")))
    chrome.storage.sync.set(
      {
        selectedTemplate: 'p',
        unselectedTemplate: 'L',
        useNewStyleLinks: false,
        debug: false,
        overlay: true
      });
});

// Inject capture.js into a tab. In "clipboard" mode, first set a flag on the
// shared content-script `window` (same isolated world) so capture.js routes the
// full page through the clipboard instead of truncating into the URL.
function injectCapture(tabId, mode) {
  if (tabId == null) return;
  if (mode === "clipboard") {
    chrome.scripting.executeScript(
      { target: { tabId: tabId }, func: function () { window.__ocMode = "clipboard"; } },
      function () {
        if (chrome.runtime.lastError) {
          console.error("org-capture inject(flag) failed:", chrome.runtime.lastError.message);
          return;
        }
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["capture.js"] });
      });
  } else {
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["capture.js"] });
  }
}

// Default path: clicking the toolbar icon (or Cmd/Ctrl+Shift+L) → truncate-to-fit.
chrome.action.onClicked.addListener(function (tab) {
  injectCapture(tab.id, "default");
});

// Clipboard path trigger #1: explicit keyboard command.
chrome.commands.onCommand.addListener(function (command, tab) {
  if (command !== "capture-page-clipboard") return;
  if (tab && tab.id != null) {
    injectCapture(tab.id, "clipboard");
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]) injectCapture(tabs[0].id, "clipboard");
    });
  }
});

// Clipboard path trigger #2: right-click context-menu item.
chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "org-capture-clipboard",
      title: "Org-capture full page (clipboard)",
      contexts: ["page", "selection", "link", "image"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "org-capture-clipboard" && tab && tab.id != null) {
    injectCapture(tab.id, "clipboard");
  }
});

// Backfill new option defaults without clobbering the user's existing settings.
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.get(["maxUrlLength", "clipboardTemplate"], function (cur) {
    var patch = {};
    if (cur.maxUrlLength === undefined) patch.maxUrlLength = 8000;
    if (cur.clipboardTemplate === undefined) patch.clipboardTemplate = "C";
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });
});
