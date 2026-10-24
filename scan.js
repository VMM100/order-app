// Scan table QR: the camera reads the table card and opens that table's menu.
// Used on the landing page and inside the app (My account). Any element with data-scan opens it,
// including ones the app draws later. Uses the browser's own QR reader where there is one (Chrome on
// Android), otherwise a small bundled reader (vendor/jsQR.min.js, loaded only when needed).
// Only Wasabi table links are opened.
//
// The look: the camera fills the screen; everything outside the scanning window is blurred and dimmed,
// the window stays clear, and Wasabi-green brackets hug its rounded corners. The blur's cut-out and the
// brackets are drawn from the same measurements (layout()), so they always line up exactly.
(() => {
  const GREEN = "#9cc43c";
  const css = `body.wscan-on{overflow:hidden}
.wscan{position:fixed;inset:0;z-index:1000;background:#0d110b;color:#fff;font-family:"Work Sans",system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.wscan[hidden]{display:none}
.wscan video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.wscan-dim{position:absolute;inset:0;background:rgb(13 17 11/.55);-webkit-backdrop-filter:blur(14px) saturate(.8);backdrop-filter:blur(14px) saturate(.8);
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-size:100% 100%;mask-size:100% 100%}
.wscan-frame{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.wscan-frame .edge{fill:none;stroke:rgb(255 255 255/.22);stroke-width:1.5}
.wscan-frame .corner{fill:none;stroke:${GREEN};stroke-width:6;stroke-linecap:round;stroke-linejoin:round;transition:stroke-width .2s}
.wscan-frame .sweep{fill:url(#wscan-sweep);animation:wscan-sweep 2.4s ease-in-out infinite alternate}
@keyframes wscan-sweep{from{transform:translateY(0)}to{transform:translateY(var(--travel,200px))}}
.wscan.hit .corner{stroke-width:9}
.wscan.hit .sweep{display:none}
.wscan-top{position:absolute;inset:0 0 auto;display:flex;justify-content:space-between;align-items:center;padding:calc(14px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 14px max(16px,env(safe-area-inset-left,0px));font-size:17px}
.wscan-x{width:44px;height:44px;border-radius:50%;border:0;background:rgb(255 255 255/.16);color:#fff;font-size:18px;cursor:pointer}
.wscan button:focus-visible{outline:3px solid ${GREEN};outline-offset:2px}
.wscan-msg{position:absolute;left:0;right:0;padding:0 max(20px,env(safe-area-inset-left,0px));text-align:center}
.wscan-msg p{max-width:26em;margin:0 auto;font-size:16px;line-height:1.45;text-shadow:0 1px 8px rgb(0 0 0/.5)}
.wscan-acts{display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap}
.wscan-acts button{min-height:46px;padding:0 22px;border-radius:999px;font:600 15px/1 inherit;cursor:pointer;border:1.5px solid rgb(255 255 255/.5);background:none;color:#fff}
.wscan-acts .go{background:${GREEN};border-color:${GREEN};color:#1a2117}
.wscan-badge{position:absolute;left:50%;bottom:calc(22px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);height:34px;width:auto;pointer-events:none;filter:drop-shadow(0 2px 8px rgb(0 0 0/.35))}
.wscan.err video,.wscan.err .wscan-frame{display:none}
.wscan.err .wscan-dim{-webkit-mask-image:none!important;mask-image:none!important;background:#1a2117}
.wscan.err .wscan-msg{top:50%!important;transform:translateY(-50%)}
@media (prefers-reduced-motion:reduce){.wscan-frame .sweep{animation:none;display:none}}`;
  const sc = { el: null, v: null, msg: null, box: null, stream: null, det: null, cv: null, run: false, last: "", from: null };
  const base = new URL(".", document.currentScript ? document.currentScript.src : location.href).href;
  function build() {
    if (sc.el) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "wscan"; el.hidden = true; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "wscan-t");
    el.innerHTML = `<video playsinline muted></video><div class="wscan-dim" aria-hidden="true"></div>
      <svg class="wscan-frame" aria-hidden="true"><defs><linearGradient id="wscan-sweep" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${GREEN}" stop-opacity="0"/><stop offset=".85" stop-color="${GREEN}" stop-opacity=".28"/><stop offset="1" stop-color="${GREEN}" stop-opacity=".9"/></linearGradient>
        <clipPath id="wscan-clip"><path class="clip"/></clipPath></defs>
        <g clip-path="url(#wscan-clip)"><rect class="sweep"/></g><path class="edge"/><path class="corner"/></svg>
      <div class="wscan-top"><b id="wscan-t">Scan the table QR</b><button type="button" class="wscan-x" data-close aria-label="Close">✕</button></div>
      <div class="wscan-msg"><p role="status">Starting the camera…</p>
        <div class="wscan-acts"><button type="button" class="go" data-retry hidden>Try again</button><button type="button" data-close hidden>Close</button></div></div>
      <img class="wscan-badge" src="${base}img/brand/powered-by-wasabi.png" alt="Spiced by Wasabi">`;
    document.body.appendChild(el);
    sc.el = el; sc.v = el.querySelector("video"); sc.msg = el.querySelector(".wscan-msg p");
    el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); else if (e.target.closest("[data-retry]")) open(); });
    addEventListener("resize", layout); addEventListener("orientationchange", () => setTimeout(layout, 250));
  }
  // One set of numbers for the window: the blur's hole, the faint edge, the green corner brackets
  // and the sweep all come from here.
  function layout() {
    if (!sc.el || sc.el.hidden) return;
    const W = sc.el.clientWidth, H = sc.el.clientHeight;
    const s = Math.round(Math.min(W * 0.72, H * 0.46, 340));
    const x = Math.round((W - s) / 2), y = Math.max(84, Math.round(H * 0.44 - s / 2)), r = Math.round(s * 0.09);
    const L = Math.round(s * 0.16);                                  // bracket arm beyond the curve
    const rect = `M${x + r} ${y}H${x + s - r}A${r} ${r} 0 0 1 ${x + s} ${y + r}V${y + s - r}A${r} ${r} 0 0 1 ${x + s - r} ${y + s}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + s - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
    const corners = [
      `M${x} ${y + r + L}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + r + L}`,
      `M${x + s - r - L} ${y}H${x + s - r}A${r} ${r} 0 0 1 ${x + s} ${y + r}V${y + r + L}`,
      `M${x + s} ${y + s - r - L}V${y + s - r}A${r} ${r} 0 0 1 ${x + s - r} ${y + s}H${x + s - r - L}`,
      `M${x + r + L} ${y + s}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + s - r}V${y + s - r - L}`,
    ].join("");
    const svg = sc.el.querySelector(".wscan-frame");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.querySelector(".edge").setAttribute("d", rect);
    svg.querySelector(".corner").setAttribute("d", corners);
    svg.querySelector(".clip").setAttribute("d", rect);
    const sw = svg.querySelector(".sweep"), band = Math.round(s * 0.28);
    sw.setAttribute("x", x); sw.setAttribute("y", y - band); sw.setAttribute("width", s); sw.setAttribute("height", band);
    sw.style.setProperty("--travel", s + "px");
    // The blur everywhere except the window: a mask with the same rounded square cut out.
    const mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path fill-rule="evenodd" d="M0 0H${W}V${H}H0Z${rect}"/></svg>`)}")`;
    const dim = sc.el.querySelector(".wscan-dim"); dim.style.webkitMaskImage = mask; dim.style.maskImage = mask;
    sc.el.querySelector(".wscan-msg").style.top = (y + s + 26) + "px";
  }
  const say = (t) => { sc.msg.textContent = t; };
  const acts = (on) => sc.el.querySelectorAll(".wscan-acts button").forEach((b) => (b.hidden = !on));
  const ours = (u) => ["wasabi.co.tz", "www.wasabi.co.tz", location.host].includes(u.host) || (u.host === "vmm100.github.io" && u.pathname.startsWith("/order-app"));
  function stopCam() { sc.run = false; if (sc.stream) sc.stream.getTracks().forEach((t) => t.stop()); sc.stream = null; if (sc.v) sc.v.srcObject = null; }
  function close() { stopCam(); sc.el.hidden = true; sc.el.classList.remove("err"); document.body.classList.remove("wscan-on"); if (sc.from && document.contains(sc.from)) sc.from.focus(); }
  function fail(t) { stopCam(); sc.el.classList.add("err"); say(t); acts(true); }
  const loadReader = () => window.jsQR ? Promise.resolve() : new Promise((ok, no) => { const x = document.createElement("script"); x.src = base + "vendor/jsQR.min.js"; x.onload = ok; x.onerror = no; document.head.appendChild(x); });
  async function open(from) {
    build();
    if (from) sc.from = from;
    sc.el.hidden = false; sc.el.classList.remove("err"); acts(false); sc.last = "";
    document.body.classList.add("wscan-on"); sc.el.classList.remove("hit"); layout(); sc.el.querySelector(".wscan-x").focus(); say("Starting the camera…");
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return fail("This browser can't open the camera here. Use your phone's camera app instead: point it at the table card and tap the link that appears.");
    try { sc.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); }
    catch (err) {
      const n = err && err.name;
      return fail(n === "NotAllowedError" || n === "SecurityError" ? "Camera access is off. Allow the camera for this site in your browser settings and try again, or use your phone's camera app."
        : n === "NotFoundError" || n === "OverconstrainedError" ? "No camera was found on this device." : "Couldn't start the camera. Try again, or use your phone's camera app.");
    }
    if (sc.el.hidden) return stopCam();
    sc.v.srcObject = sc.stream; try { await sc.v.play(); } catch {}
    say("Point your camera at the QR code on your table.");
    sc.det = null;
    if ("BarcodeDetector" in window) { try { if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) sc.det = new BarcodeDetector({ formats: ["qr_code"] }); } catch {} }
    if (!sc.det) { try { await loadReader(); } catch { return fail("Couldn't load the code reader. Check your connection, or use your phone's camera app."); } }
    sc.run = true; tick();
  }
  async function read() {
    const v = sc.v; if (v.readyState < 2 || !v.videoWidth) return null;
    if (sc.det) { const c = await sc.det.detect(v); return c.length ? c[0].rawValue : null; }
    const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
    sc.cv = sc.cv || document.createElement("canvas"); sc.cv.width = w; sc.cv.height = h;
    const g = sc.cv.getContext("2d", { willReadFrequently: true }); g.drawImage(v, 0, 0, w, h);
    const r = window.jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" }); return r ? r.data : null;
  }
  async function tick() {
    if (!sc.run) return;
    let t = null; try { t = await read(); } catch {}
    if (t && t !== sc.last) {
      sc.last = t; let u = null; try { u = new URL(t); } catch {}
      if (u && ours(u) && u.searchParams.get("r")) { say("Opening the menu…"); sc.el.classList.add("hit"); stopCam(); if (navigator.vibrate) navigator.vibrate(40); location.href = u.href; return; }
      say("That isn't a Wasabi table code. Look for the card on your table with the Wasabi leaf.");
      setTimeout(() => { if (sc.run) { sc.last = ""; say("Point your camera at the QR code on your table."); } }, 3000);
    }
    setTimeout(() => requestAnimationFrame(tick), 120);
  }
  window.wasabiScan = open;
  // Delegated, so buttons the app draws later work too.
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-scan]"); if (b) { e.preventDefault(); open(b); } });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && sc.el && !sc.el.hidden) close(); });
  addEventListener("pagehide", stopCam);
})();
