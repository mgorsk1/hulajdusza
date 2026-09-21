// Motyw jasny/ciemny: domyślnie zgodny z systemem, wybór użytkownika zapamiętany w localStorage.
// Ładowany synchronnie w <head>, żeby uniknąć mignięcia złego motywu.
(() => {
  const root = document.documentElement;
  const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  if (saved === "light" || saved === "dark") {
    root.dataset.theme = saved;
    root.style.colorScheme = saved;
  }

  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  window.isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : systemDark.matches);

  function paint() {
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.innerHTML = window.isDark() ? SUN : MOON;
      b.setAttribute("aria-label", window.isDark() ? "Przełącz na tryb jasny" : "Przełącz na tryb ciemny");
    });
  }

  window.toggleTheme = () => {
    const next = window.isDark() ? "light" : "dark";
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try { localStorage.setItem("theme", next); } catch {}
    paint();
    window.dispatchEvent(new Event("themechange"));
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", window.toggleTheme));
    paint();
  });
  systemDark.addEventListener("change", () => {
    if (!root.dataset.theme) {
      paint();
      window.dispatchEvent(new Event("themechange"));
    }
  });
})();
