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


(function () {


  class Capture {

    constructor() {
      this.window = window;
      this.document = document;
      this.location = location;

      // Keep the RAW (un-escaped) Org so the truncate path can cut on character
      // boundaries; escaping happens later in buildURI().
      this.selection_raw = getSelectionAsOrg();
      this.page_raw = getPageAsOrg();
      this.encoded_url = encodeURIComponent(location.href);
      this.escaped_title = escapeIt(document.title);

      this.mode = "default";   // "default" (truncate) | "clipboard"
      this.truncated = false;
    }

    rawBody() {
      return this.selection_raw !== "" ? this.selection_raw : this.page_raw;
    }

    templateFor() {
      return this.selection_raw !== "" ? this.selectedTemplate : this.unselectedTemplate;
    }

    // Assemble a capture URI from an already-escaped body string.
    buildURI(escapedBody) {
      var template = this.templateFor();
      if (this.useNewStyleLinks)
        return "org-protocol://capture?template=" + template +
               "&url=" + this.encoded_url + "&title=" + this.escaped_title +
               "&body=" + escapedBody;
      else
        return "org-protocol://capture:/" + template + "/" +
               this.encoded_url + "/" + this.escaped_title + "/" + escapedBody;
    }

    // Default path: fit the escaped body under maxUrlLength, truncating raw text
    // if needed so Chrome will actually hand the org-protocol:// URL off to the OS.
    createCaptureURI() {
      var raw = this.rawBody();
      var escaped = escapeIt(raw);
      var uri = this.buildURI(escaped);
      var max = this.maxUrlLength || 8000;
      if (uri.length <= max) return uri;

      this.truncated = true;
      var overhead = uri.length - escaped.length;            // fixed prefix length
      var markerLen = escapeIt("\n\n[... truncated " + raw.length + " chars ...]").length;

      // Escaped length of a raw prefix; Infinity if escaping throws (e.g. a
      // split surrogate), so the search treats that cut as over-budget.
      function encLen(n) {
        try { return escapeIt(raw.slice(0, n)).length; }
        catch (e) { return Infinity; }
      }

      // Binary-search the longest raw prefix whose escaped form fits the budget.
      var lo = 0, hi = raw.length, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (overhead + encLen(mid) + markerLen <= max) {
          best = mid; lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      // Don't split a UTF-16 surrogate pair (e.g. an emoji) at the cut point,
      // which would make encodeURIComponent throw.
      if (best > 0) {
        var c = raw.charCodeAt(best - 1);
        if (c >= 0xD800 && c <= 0xDBFF) best--;
      }
      var cut = raw.length - best;
      var truncatedRaw = raw.slice(0, best) + "\n\n[... truncated " + cut + " chars ...]";
      return this.buildURI(escapeIt(truncatedRaw));
    }

    // Clipboard path: stash the FULL (untruncated) body on the system clipboard and
    // send a short URL; an Emacs template (clipboardTemplate) yanks the body back.
    createClipboardURI() {
      copyToClipboard(this.rawBody());
      var template = this.clipboardTemplate || "Y";
      if (this.useNewStyleLinks)
        return "org-protocol://capture?template=" + template +
               "&url=" + this.encoded_url + "&title=" + this.escaped_title;
      else
        return "org-protocol://capture:/" + template + "/" +
               this.encoded_url + "/" + this.escaped_title + "/";
    }

    capture() {
      var uri = (this.mode === "clipboard")
        ? this.createClipboardURI()
        : this.createCaptureURI();

      if (this.debug) {
        logURI(uri);
      }

      location.href = uri;

      if (this.overlay) {
        toggleOverlay(this.mode === "clipboard"
          ? "Captured (clipboard)"
          : (this.truncated ? "Captured (truncated)" : "Captured"));
      }
    }

    captureIt(options) {
      try {
        if (chrome.runtime.lastError) {
          alert("Could not capture url. Error loading options: " + chrome.runtime.lastError.message);
          return;
        }

        for (var k in options) this[k] = options[k];
        this.mode = (window.__ocMode === "clipboard") ? "clipboard" : "default";
        this.capture();
      } catch (e) {
        console.error("org-capture failed:", e);
        alert("org-capture failed: " + (e && e.message ? e.message : e));
      }
    }
  }


  // Tracks compact nav/footer lines already emitted, so repeated menus (Squarespace
  // renders the nav 3×) collapse to the distinct ones only. Reset per page capture.
  var seenNavLines = {};

  function getPageAsOrg() {
    seenNavLines = {};
    var out = nodeToOrg(document.body, 0, false).trim().replace(/\n{3,}/g, '\n\n');
    return dedupeConsecutiveLines(out);
  }

  // Collapse an immediately-repeated phrase (carousels duplicate their slide text).
  // Best-effort; length-guarded to avoid pathological backtracking.
  function collapseRepeatPhrase(s) {
    if (!s || s.length > 400) return s;
    return s.replace(/(.{15,}?)(?:\s*\1)+/g, '$1');
  }

  // Drop consecutive identical non-empty lines (leftover repeated links/menus).
  function dedupeConsecutiveLines(s) {
    var out = [], prev = null;
    s.split('\n').forEach(function (l) {
      var key = l.trim();
      if (key !== '' && key === prev) return;
      out.push(l); prev = key;
    });
    return out.join('\n');
  }

  // Render a nav/footer block as one compact line of deduped links instead of a
  // long inline list (e.g. "Nav: [[u][Home]] | [[u][About]] | ...").
  function navToCompactLine(node, prefix) {
    var seen = {}, parts = [];
    var anchors = node.querySelectorAll ? node.querySelectorAll('a') : [];
    Array.prototype.forEach.call(anchors, function (a) {
      var href = a.href;
      if (typeof href !== 'string')
        href = (href && href.baseVal) || a.getAttribute('href') ||
               a.getAttribute('xlink:href') || '';
      if (!href || href.indexOf('javascript:') === 0 || href === '#') return;
      var label = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      var key = label.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      parts.push('[[' + href + '][' + label + ']]');
    });
    if (!parts.length) return '';
    var line = prefix + ': ' + parts.join(' | ');
    if (seenNavLines[line]) return '';
    seenNavLines[line] = 1;
    return '\n' + line + '\n';
  }

  function getSelectionAsOrg() {
    var selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return "";
    var container = document.createElement('div');
    container.appendChild(selection.getRangeAt(0).cloneContents());
    return nodeToOrg(container, 0, false).trim().replace(/\n{3,}/g, '\n\n');
  }

  var BLOCK_TAGS = new Set([
    'div', 'section', 'article', 'header', 'aside',
    'main', 'figure', 'figcaption', 'dl', 'dt', 'dd'
  ]);

  function nodeToOrg(node, depth, inPre) {
    if (node.nodeType === Node.TEXT_NODE)
      return inPre ? node.textContent : node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    var tag = node.tagName.toLowerCase();
    var nowInPre = inPre || tag === 'pre';

    // Skip true non-content / non-visible nodes.
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return '';
    try {
      var _cs = window.getComputedStyle && getComputedStyle(node);
      if (_cs && (_cs.display === 'none' || _cs.visibility === 'hidden')) return '';
    } catch (e) {}

    // Site chrome → one compact line of links instead of a long inline list.
    if (tag === 'nav')    return navToCompactLine(node, 'Nav');
    if (tag === 'footer') return navToCompactLine(node, 'Footer');

    if (!inPre && (tag === 'div' || tag === 'section')) {
      var tabResult = tryTabsToOrg(node, depth);
      if (tabResult !== null) return tabResult;
    }

    var children = Array.from(node.childNodes)
      .map(function(n) { return nodeToOrg(n, depth, nowInPre); }).join('');

    switch (tag) {
      case 'style': case 'script': case 'noscript': case 'template': return '';
      case 'a': {
        var href = node.href;
        // SVG <a> exposes href as an SVGAnimatedString, not a string.
        if (typeof href !== 'string')
          href = (href && href.baseVal) || node.getAttribute('href') ||
                 node.getAttribute('xlink:href') || '';
        // Description is the anchor's TEXT only — never the serialized children, so
        // block content (e.g. an <img> with its #+ATTR_ORG line) is not crammed
        // into [[..][..]]. Collapse repeated phrases (carousel slide text).
        var label = collapseRepeatPhrase((node.textContent || '').replace(/\s+/g, ' ').trim());
        if (!href || href.startsWith('javascript:') || href === '#') {
          var realUrl = node.getAttribute('data-href') ||
                        node.getAttribute('data-url')  ||
                        node.getAttribute('data-src')  ||
                        node.getAttribute('data-file-url');
          if (realUrl) {
            try { realUrl = new URL(realUrl, location.href).href; } catch(e) {}
            return label ? '[[' + realUrl + '][' + label + ']]' : '';
          }
          // No usable href: if it wraps block/image content, emit that; else the label.
          return label || children;
        }
        if (label) return '[[' + href + '][' + label + ']]';
        // Anchor with no text (wraps an image/icon): emit the inner content
        // (a clean image block) rather than an empty link.
        return children.trim() ? children : '';
      }
      case 'b': case 'strong': { var t = children.trim(); return t ? '*' + t + '*' : ''; }
      case 'em': case 'i':     { var t = children.trim(); return t ? '/' + t + '/' : ''; }
      case 'code':
        return inPre ? children : (children.trim() ? '~' + children.trim() + '~' : '');
      case 'pre':
        return '\n#+BEGIN_SRC\n' + children.trim() + '\n#+END_SRC\n';
      case 'blockquote':
        return '\n#+BEGIN_QUOTE\n' + children.trim() + '\n#+END_QUOTE\n';
      case 'h1': { var t = children.trim(); return t ? '\n\n* '      + t + '\n\n' : ''; }
      case 'h2': { var t = children.trim(); return t ? '\n\n** '     + t + '\n\n' : ''; }
      case 'h3': { var t = children.trim(); return t ? '\n\n*** '    + t + '\n\n' : ''; }
      case 'h4': { var t = children.trim(); return t ? '\n\n**** '   + t + '\n\n' : ''; }
      case 'h5': { var t = children.trim(); return t ? '\n\n***** '  + t + '\n\n' : ''; }
      case 'h6': { var t = children.trim(); return t ? '\n\n****** ' + t + '\n\n' : ''; }
      case 'img': {
        if (!node.src) return '';
        var w = node.clientWidth  || node.naturalWidth  || 0;
        var h = node.clientHeight || node.naturalHeight || 0;
        var MAX_W = 800, MAX_H = 600;
        var alt  = (node.alt || node.title || 'image').replace(/\s+/g, ' ').trim();
        var link = '[[' + node.src + '][' + alt + ']]';
        if (w > 0 || h > 0) {
          var dw = w > 0 ? Math.min(w, MAX_W) : null;
          var dh = h > 0 ? Math.min(h, MAX_H) : null;
          var attr = '#+ATTR_ORG:';
          if (dw) attr += ' :width '  + dw;
          if (dh) attr += ' :height ' + dh;
          return '\n\n' + attr + '\n' + link + '\n\n';
        }
        return '\n\n' + link + '\n\n';
      }
      case 'ul': case 'ol':
        return '\n' + listToOrg(node, tag, depth) + '\n';
      case 'li':
        return children;
      case 'br':
        return '\n';
      case 'iframe': {
        var src = node.src;
        if (!src) return '';
        var ytMatch = src.match(/youtube(?:-nocookie)?\.com\/embed\/([^?&/]+)/);
        if (ytMatch) return '[[https://www.youtube.com/watch?v=' + ytMatch[1] + '][YouTube video]]';
        var iframeTitle = node.getAttribute('title') || 'embedded content';
        return '[[' + src + '][' + iframeTitle + ']]';
      }
      case 'p':
        return '\n\n' + children.trim() + '\n\n';
      default: {
        var videoId = node.getAttribute('data-video-id');
        if (videoId) {
          var ytLabel = (node.getAttribute('data-title') || '').trim();
          if (!ytLabel || ytLabel === 'Play') ytLabel = 'YouTube video';
          return '[[https://www.youtube.com/watch?v=' + videoId + '][' + ytLabel + ']]';
        }
        var realUrl = node.getAttribute('data-href') ||
                      node.getAttribute('data-url')  ||
                      node.getAttribute('data-src')  ||
                      node.getAttribute('href')      ||
                      node.getAttribute('url')       ||
                      node.getAttribute('src');
        if (realUrl) {
          try { realUrl = new URL(realUrl, location.href).href; } catch(e) {}
          var label = children.replace(/\s+/g, ' ').trim();
          if (label) return '[[' + realUrl + '][' + label + ']]';
        }
        return BLOCK_TAGS.has(tag) ? '\n' + children + '\n' : children;
      }
    }
  }

  function listToOrg(listNode, type, depth) {
    var indent = '  '.repeat(depth);
    return Array.from(listNode.childNodes)
      .filter(function(n) { return n.nodeName.toLowerCase() === 'li'; })
      .map(function(li, i) {
        var prefix = type === 'ol' ? (i + 1) + '. ' : '- ';
        var content = Array.from(li.childNodes).map(function(n) {
          var tag = n.nodeName.toLowerCase();
          if (tag === 'ul' || tag === 'ol')
            return '\n' + listToOrg(n, tag, depth + 1);
          return nodeToOrg(n, depth + 1);
        }).join('').trim();
        return indent + prefix + content;
      })
      .join('\n');
  }

  function tryTabsToOrg(node, depth) {
    var tablist = node.querySelector(
      ':scope > [role="tablist"], :scope > * > [role="tablist"]'
    );
    if (!tablist) return null;

    var panels = Array.from(node.querySelectorAll('[role="tabpanel"]'));
    if (panels.length === 0) return null;

    var tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    var result = '';

    panels.forEach(function(panel, i) {
      var tabTitle = '';
      var labelId = panel.getAttribute('aria-labelledby');
      if (labelId) {
        var el = document.getElementById(labelId);
        if (el) tabTitle = el.textContent.replace(/\s+/g, ' ').trim();
      }
      if (!tabTitle && tabs[i])
        tabTitle = tabs[i].textContent.replace(/\s+/g, ' ').trim();

      var content = Array.from(panel.childNodes)
        .map(function(n) { return nodeToOrg(n, depth, false); })
        .join('').trim();

      // Shift panel headings one level deeper so they nest under the tab heading (**)
      content = content.replace(/^(\*+) /gm, function(_, stars) {
        return '*'.repeat(stars.length + 1) + ' ';
      });

      if (tabTitle) result += '\n\n** ' + tabTitle + '\n\n';
      if (content)  result += content + '\n';
    });

    return result.trim() ? result : null;
  }

  function replace_all(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
  }

  function escapeIt(text) {
    return replace_all(replace_all(replace_all(encodeURIComponent(text), "[(]", escape("(")),
                                   "[)]", escape(")")),
                       "[']" ,escape("'"));
  }

  function logURI(uri) {
    window.console.log("Capturing the following URI with new org-protocol: ", uri);
    return uri;
  }

  // Copy text to the system clipboard from the content-script context. Uses a
  // throwaway textarea + execCommand('copy') so it works without extra
  // permissions or transient-activation issues.
  function copyToClipboard(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      console.error("org-capture clipboard copy failed:", e);
    }
    document.body.removeChild(ta);
  }

  function toggleOverlay(label) {
    var outer_id = "org-capture-extension-overlay";
    var inner_id = "org-capture-extension-text";
    if (! document.getElementById(outer_id)) {
      var outer_div = document.createElement("div");
      outer_div.id = outer_id;

      var inner_div = document.createElement("div");
      inner_div.id = inner_id;
      inner_div.innerHTML = label || "Captured";

      outer_div.appendChild(inner_div);
      document.body.appendChild(outer_div);

      var css = document.createElement("style");
      css.type = "text/css";
      // noinspection JSAnnotator
      css.innerHTML = `#org-capture-extension-overlay {
        position: fixed; /* Sit on top of the page content */
        display: none; /* Hidden by default */
        width: 100%; /* Full width (cover the whole page) */
        height: 100%; /* Full height (cover the whole page) */
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0,0,0,0.2); /* Black background with opacity */
        z-index: 1; /* Specify a stack order in case you're using a different order for other elements */
        cursor: pointer; /* Add a pointer on hover */
    }

    #org-capture-extension-text{
    position: absolute;
    top: 50%;
    left: 50%;
    font-size: 50px;
    color: white;
    transform: translate(-50%,-50%);
    -ms-transform: translate(-50%,-50%);
}`;
        document.body.appendChild(css);
    }

    function on() {
      document.getElementById(outer_id).style.display = "block";
    }

    function off() {
      var el = document.getElementById(outer_id);
      if (el) el.remove();
    }

    on();
    setTimeout(off, 200);

  }


  try {
    var capture = new Capture();
    var f = function (options) { capture.captureIt(options); };
    chrome.storage.sync.get(null, f);
  } catch (e) {
    console.error("org-capture failed:", e);
    alert("org-capture failed: " + (e && e.message ? e.message : e));
  }
})();
