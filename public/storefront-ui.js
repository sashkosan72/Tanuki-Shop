/* Tanuki Shop: responsive navigation and progressive catalog reveal. */
(() => {
  "use strict";
  const start = () => {
    if(location.hostname.includes('tanuki-shop-preview')) {
      const banner=document.createElement('div');
      banner.textContent='ТЕСТОВИЙ МАГАЗИН — замовлення не виконуються';
      banner.style.cssText='background:#fff0a8;color:#332200;text-align:center;padding:12px;font:700 14px system-ui';
      document.body.prepend(banner);
    }
    const toggle = document.getElementById("menuToggle");
    const nav = document.getElementById("siteNavigation");
    if (toggle && nav) {
      const close = (returnFocus = false) => {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Відкрити меню");
        if (returnFocus) toggle.focus();
      };
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        if (open) {
          nav.classList.add("is-open");
          toggle.setAttribute("aria-expanded", "true");
          toggle.setAttribute("aria-label", "Закрити меню");
          nav.querySelector("a")?.focus();
        } else close(true);
      });
      nav.addEventListener("click", event => {
        if (event.target.closest("a")) close();
      });
      document.addEventListener("click", event => {
        if (!nav.contains(event.target) && !toggle.contains(event.target)) close();
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && nav.classList.contains("is-open")) close(true);
      });
      const media = window.matchMedia("(min-width: 941px)");
      media.addEventListener?.("change", event => { if (event.matches) close(); });
    }

    const grid = document.getElementById("productsGrid");
    if (!grid) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || typeof IntersectionObserver === "undefined") return;
    const observed = new WeakSet();
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("catalog-reveal-pending");
        entry.target.classList.add("catalog-reveal-visible");
        io.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px 50px 0px", threshold: 0.05 });

    const watchCards = () => {
      const cards = grid.querySelectorAll(".product-card:not([hidden])");
      cards.forEach(card => {
        if (observed.has(card)) return;
        observed.add(card);
        // Cards in or near the viewport remain visible, including on initial load.
        if (card.getBoundingClientRect().top < window.innerHeight + 40) {
          card.classList.add("catalog-reveal-visible");
        } else {
          card.classList.add("catalog-reveal-pending");
          io.observe(card);
        }
      });
    };
    new MutationObserver(watchCards).observe(grid, { childList:true });
    watchCards();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, {once:true});
  } else start();
})();
