// Pull to refresh, Wasabi style: at the top of any page, pull down and a dark disc with the Wasabi leaf
// slides in; its green ring fills as you pull. Pull far enough and let go: the ring spins and the page
// reloads. On a restaurant's own screens (menu, waiter, kitchen…) the disc shows that restaurant's logo
// on white, with the ring in its main colour. Replaces the browser's own pull-to-refresh (switched off with overscroll-behavior below).
// Not used inside the demo stage's phones, and not while a scanner, question box or menu is open.
(() => {
  if (window.top !== window.self || !("ontouchstart" in window)) return;
  const MARK = "M31.0 33.0L21.4 52.7A26 26 0 1 0 11.3 42.6ZM31.3 28.7L25.2 13.9L28.4 29.6ZM34.9 31.2L45.1 18.9L32.8 29.1ZM34.4 35.6L50.1 38.8L35.3 32.7Z",
    STEM = "M29.7 31.7L32.3 34.3L9.3 60.1a2.1 2.1 0 0 1-3-3Z", C = 2 * Math.PI * 24;
  const css = document.createElement("style");
  css.textContent = `html,body{overscroll-behavior-y:none}
.ptr{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 8px);width:52px;height:52px;margin-left:-26px;z-index:70;pointer-events:none;
  transform:translateY(-80px);opacity:0;filter:drop-shadow(0 4px 10px rgb(0 0 0/.28))}
.ptr.back{transition:transform .25s ease,opacity .25s ease}
.ptr .rot{transform-origin:28px 28px}
.ptr.spin .rot{animation:ptr-spin .8s linear infinite}
@keyframes ptr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ptr.spin .rot{animation-duration:2.4s}}`;
  document.head.appendChild(css);
  const el = document.createElement("div");
  el.className = "ptr"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
  el.innerHTML = `<svg viewBox="0 0 56 56" width="52" height="52" aria-hidden="true"><circle cx="28" cy="28" r="27" fill="#1a2117"/>
    <g class="rot"><circle class="arc" cx="28" cy="28" r="24" fill="none" stroke="#9cc43c" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 28 28)"/></g>
    <circle class="plate" cx="28" cy="28" r="22" fill="#ffffff" style="display:none"/>
    <g class="leaf" transform="translate(12 12) scale(0.5)"><path fill="#9cc43c" fill-rule="evenodd" d="${MARK}"/><path fill="#9cc43c" d="${STEM}"/></g></svg>
    <img class="ptr-logo" alt="" style="position:absolute;left:9px;top:9px;width:34px;height:34px;border-radius:50%;object-fit:contain;display:none">
    <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)" class="ptr-say"></span>`;
  const add = () => document.body.appendChild(el);
  document.body ? add() : addEventListener("DOMContentLoaded", add);
  const arc = el.querySelector(".arc"), say = el.querySelector(".ptr-say"), logo = el.querySelector(".ptr-logo"),
    leafG = el.querySelector(".leaf"), plate = el.querySelector(".plate"), disc = el.querySelector("circle");
  // Restaurant screens: the header shows the restaurant's logo (hidden on Wasabi's own pages).
  function setLook() {
    const h = document.getElementById("brandlogo");
    const own = document.documentElement.classList.contains("is-app") && h && !h.hidden && h.currentSrc;
    logo.style.display = own ? "block" : "none"; leafG.style.display = own ? "none" : ""; plate.style.display = own ? "" : "none";
    if (own) logo.src = h.currentSrc;
    disc.setAttribute("fill", own ? "#ffffff" : "#1a2117");
    const acc = own && getComputedStyle(document.body).getPropertyValue("--accent").trim();
    arc.setAttribute("stroke", acc || "#9cc43c");
  }
  const PULL = 80, MAX = 130;   // px of finger travel (after damping) needed to refresh, and the most it moves
  let y0 = null, pull = 0, busy = false;

  const blocked = () => busy || window.scrollY > 0 || document.body.classList.contains("scan-on") ||
    document.querySelector(".ask, .hello:not(.out)") || (document.getElementById("drawer") && !document.getElementById("drawer").hidden);
  function draw() {
    const p = Math.min(pull / PULL, 1);
    el.style.opacity = String(Math.min(1, pull / 30));
    el.style.transform = `translateY(${Math.min(pull, MAX) - 60}px)`;
    arc.setAttribute("stroke-dashoffset", String(C * (1 - p * 0.85)));
  }
  function reset() { el.classList.add("back"); pull = 0; draw(); setTimeout(() => el.classList.remove("back"), 260); }

  addEventListener("touchstart", (e) => { y0 = e.touches.length === 1 && !blocked() ? e.touches[0].clientY : null; if (y0 != null) setLook(); }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 == null || busy) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || window.scrollY > 0) { if (pull) reset(); return; }
    pull = dy * 0.55; draw();
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  addEventListener("touchend", () => {
    if (y0 == null) return; y0 = null;
    if (pull < PULL) return reset();
    busy = true; el.classList.add("back", "spin"); pull = PULL; draw();
    arc.setAttribute("stroke-dashoffset", String(C * 0.72)); say.textContent = "Refreshing";
    setTimeout(() => location.reload(), 450);
  });
  addEventListener("touchcancel", () => { y0 = null; if (!busy) reset(); });
})();
