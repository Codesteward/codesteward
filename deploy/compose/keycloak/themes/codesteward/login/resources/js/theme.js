/* Force Codesteward dark chrome (ignore OS light preference) + platform favicon */
(function () {
  try {
    document.documentElement.classList.add("pf-v5-theme-dark");
    document.documentElement.classList.remove("pf-v5-theme-light");
    if (document.body) {
      document.body.classList.add("pf-v5-theme-dark");
    }

    // Align with UI: /brand/codesteward-icon.png — theme template only loads favicon.ico
    var base = "";
    try {
      var iconLink = document.querySelector('link[rel="icon"]');
      if (iconLink && iconLink.href) {
        base = iconLink.href.replace(/\/img\/[^/]+$/, "/img/");
      }
    } catch (_) {
      /* ignore */
    }
    if (!base) {
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || "";
        var m = src.match(/^(.*\/resources\/[^/]+\/login\/)js\//);
        if (m) {
          base = m[1] + "img/";
          break;
        }
      }
    }
    if (base) {
      function setIcon(rel, href, type) {
        var el = document.querySelector('link[rel="' + rel + '"]');
        if (!el) {
          el = document.createElement("link");
          el.rel = rel;
          document.head.appendChild(el);
        }
        el.href = href;
        if (type) el.type = type;
      }
      setIcon("icon", base + "icon.png", "image/png");
      setIcon("apple-touch-icon", base + "apple-touch-icon.png", "image/png");
    }
  } catch (_) {
    /* ignore */
  }
})();
