/**
 * Pi Rephrase Input — site/main.js
 *
 * Progressive enhancement only. No frameworks. No tracking.
 *  - IntersectionObserver fade-in for sections (no-op when unavailable)
 *  - Copy-to-clipboard for the install command, with a graceful fallback
 *    that selects the inline code for manual copy on older browsers.
 *  - Honors prefers-reduced-motion: animations collapse to instant.
 */

const REVEAL_SELECTOR = "[data-reveal]";

function initReveal() {
  const items = document.querySelectorAll(REVEAL_SELECTOR);
  if (!items.length) return;

  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          obs.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );

  items.forEach((item) => observer.observe(item));
}

function initCopyButtons() {
  const buttons = document.querySelectorAll("[data-copy]");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const value = button.getAttribute("data-copy");
      if (!value) return;

      let state = "copied";

      try {
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function"
        ) {
          await navigator.clipboard.writeText(value);
        } else {
          state = selectFallback(button);
        }
      } catch {
        state = selectFallback(button);
      }

      flashButton(button, state);
    });
  });
}

function selectFallback(button) {
  const row = button.closest(".command-row");
  const code = row && row.querySelector(".command");
  if (!code) return "fallback";
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  if (!selection) return "fallback";
  selection.removeAllRanges();
  selection.addRange(range);
  return "fallback";
}

function flashButton(button, state) {
  const original = button.textContent;
  button.dataset.state = state;
  button.textContent = state === "copied" ? "Copied" : "Select text";

  window.setTimeout(() => {
    delete button.dataset.state;
    button.textContent = original || "Copy";
  }, 1600);
}

function init() {
  initReveal();
  initCopyButtons();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}