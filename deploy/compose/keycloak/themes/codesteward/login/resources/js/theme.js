/* Force Codesteward dark chrome (ignore OS light preference) */
(function () {
  try {
    document.documentElement.classList.add("pf-v5-theme-dark");
    document.documentElement.classList.remove("pf-v5-theme-light");
    if (document.body) {
      document.body.classList.add("pf-v5-theme-dark");
    }
  } catch (_) {
    /* ignore */
  }
})();
