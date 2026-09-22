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
  const originalLabel = button.getAttribute("aria-label");
  const status = button.closest(".install-panel")?.querySelector("[data-copy-status]");
  const copied = state === "copied";

  button.dataset.state = state;
  button.textContent = copied ? "Copied" : "Select text";
  button.setAttribute(
    "aria-label",
    copied ? "Install command copied" : "Select install command text to copy",
  );
  if (status) {
    status.textContent = copied
      ? "Install command copied."
      : "Install command selected. Copy the selected text manually.";
  }

  window.setTimeout(() => {
    delete button.dataset.state;
    button.textContent = original || "Copy";
    if (originalLabel) button.setAttribute("aria-label", originalLabel);
    if (status) status.textContent = "";
  }, 1600);
}

function initMobileNavigation() {
  const header = document.querySelector(".site-header");
  const toggle = document.querySelector(".menu-toggle");
  const nav = document.querySelector("#site-nav");
  if (!header || !toggle || !nav) return;

  const setOpen = (open, restoreFocus = false) => {
    header.classList.toggle("is-menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.textContent = open ? "Close" : "Menu";
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", () => {
    setOpen(!header.classList.contains("is-menu-open"));
  });

  nav.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      setOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    if (
      header.classList.contains("is-menu-open") &&
      event.target instanceof Node &&
      !header.contains(event.target)
    ) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("is-menu-open")) {
      setOpen(false, true);
    }
  });
}

function init() {
  initReveal();
  initCopyButtons();
  initMobileNavigation();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}