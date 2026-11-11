/* How to use Silent Partner: moving through the pages.
 *
 * Deliberately small and dull. The audience is someone who is not sure what will happen when
 * they click, so: one page at a time, the arrow keys work, the address bar keeps up so a page
 * can be bookmarked or sent to somebody, and it remembers where you stopped.
 */
(function () {
  "use strict";

  const slides = Array.from(document.querySelectorAll(".slide"));
  const total = slides.length;
  const KEY = "silentPartner.guidePage";

  const $ = s => document.querySelector(s);
  const prevBtn = $("#prevBtn"), nextBtn = $("#nextBtn");
  const bar = $("#bar"), where = $("#where");
  const contents = $("#contents");

  let at = 0;

  function clamp(n) { return Math.max(0, Math.min(total - 1, n)); }

  function show(n, remember) {
    at = clamp(n);
    slides.forEach((s, i) => s.classList.toggle("on", i === at));

    prevBtn.disabled = at === 0;
    // At the end, the forward button stops being "more guide" and becomes the way into the site.
    if (at === total - 1) {
      nextBtn.textContent = "Open Silent Partner →";
      nextBtn.dataset.done = "1";
    } else {
      nextBtn.textContent = "Next →";
      delete nextBtn.dataset.done;
    }

    bar.style.width = ((at + 1) / total * 100) + "%";
    where.textContent = `Page ${at + 1} of ${total}`;

    document.querySelectorAll(".contents-item").forEach(b =>
      b.classList.toggle("here", Number(b.dataset.go) === at));

    window.scrollTo(0, 0);
    if (remember !== false) {
      try { localStorage.setItem(KEY, String(at)); } catch { /* private browsing; not important */ }
      const hash = "#p" + (at + 1);
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }
  }

  const go = n => show(n);

  prevBtn.addEventListener("click", () => go(at - 1));
  nextBtn.addEventListener("click", () => {
    if (nextBtn.dataset.done) { location.href = "index.html"; return; }
    go(at + 1);
  });

  // contents
  $("#contentsBtn").addEventListener("click", () => contents.classList.remove("hidden"));
  $("#contentsClose").addEventListener("click", () => contents.classList.add("hidden"));
  contents.addEventListener("click", e => {
    if (e.target === contents) return contents.classList.add("hidden");
    const b = e.target.closest(".contents-item");
    if (!b) return;
    contents.classList.add("hidden");
    go(Number(b.dataset.go));
  });

  // Printing wants every page visible at once, so put them all back afterwards.
  $("#printBtn").addEventListener("click", () => window.print());

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!contents.classList.contains("hidden")) {
      if (e.key === "Escape") contents.classList.add("hidden");
      return;
    }
    switch (e.key) {
      case "ArrowRight": case "PageDown": go(at + 1); break;
      case "ArrowLeft": case "PageUp": go(at - 1); break;
      case "Home": go(0); break;
      case "End": go(total - 1); break;
      case " ": if (e.target === document.body) { e.preventDefault(); go(at + 1); } break;
      default: return;
    }
  });

  // Start where they left off, unless the address bar says otherwise.
  let start = 0;
  const fromHash = /^#p(\d+)$/.exec(location.hash);
  if (fromHash) start = Number(fromHash[1]) - 1;
  else { try { start = Number(localStorage.getItem(KEY)) || 0; } catch { start = 0; } }
  show(start, true);

  window.addEventListener("hashchange", () => {
    const m = /^#p(\d+)$/.exec(location.hash);
    if (m && Number(m[1]) - 1 !== at) show(Number(m[1]) - 1);
  });
})();
