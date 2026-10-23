// Scan table QR: the camera reads the table card and opens that table's menu.
// Used on the landing page and inside the app (My account). Any element with data-scan opens it,
// including ones the app draws later. Uses the browser's own QR reader where there is one (Chrome on
// Android), otherwise a small bundled reader (vendor/jsQR.min.js, loaded only when needed).
// Only Wasabi table links are opened.
(() => {
  const css = `body.wscan-on{overflow:hidden}
.wscan{position:fixed;inset:0;z-index:1000;background:#000;color:#fff;font-family:"Work Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wscan[hidden]{display:none}
.wscan video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.wscan-frame{position:absolute;left:50%;top:46%;width:min(68vw,300px);aspect-ratio:1;transform:translate(-50%,-50%);border-radius:24px;box-shadow:0 0 0 100vmax rgb(0 0 0/.55);
  --c:#9cc43c;background:linear-gradient(var(--c),var(--c)) top left/36px 4px,linear-gradient(var(--c),var(--c)) top left/4px 36px,
  linear-gradient(var(--c),var(--c)) top right/36px 4px,linear-gradient(var(--c),var(--c)) top right/4px 36px,
  linear-gradient(var(--c),var(--c)) bottom left/36px 4px,linear-gradient(var(--c),var(--c)) bottom left/4px 36px,
  linear-gradient(var(--c),var(--c)) bottom right/36px 4px,linear-gradient(var(--c),var(--c)) bottom right/4px 36px;background-repeat:no-repeat}
.wscan-top{position:absolute;inset:0 0 auto;display:flex;justify-content:space-between;align-items:center;padding:calc(14px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-left,0px)) 14px;font-size:17px}
.wscan-x{width:44px;height:44px;border-radius:50%;border:0;background:rgb(255 255 255/.16);color:#fff;font-size:18px;cursor:pointer}
.wscan button:focus-visible{outline:3px solid #9cc43c;outline-offset:2px}
.wscan-bottom{position:absolute;inset:auto 0 0;padding:20px max(16px,env(safe-area-inset-left,0px)) calc(28px + env(safe-area-inset-bottom,0px));text-align:center}
.wscan-bottom p{max-width:28em;margin:0 auto;font-size:16px;line-height:1.45}
.wscan-acts{display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap}
.wscan-acts button{min-height:46px;padding:0 22px;border-radius:999px;font:600 15px/1 inherit;cursor:pointer;border:1.5px solid rgb(255 255 255/.5);background:none;color:#fff}
.wscan-acts .go{background:#9cc43c;border-color:#9cc43c;color:#1a2117}
.wscan.err{background:#1a2117}
.wscan.err video,.wscan.err .wscan-frame{display:none}
.wscan.err .wscan-bottom{inset:auto 0 50%;transform:translateY(50%)}`;
  const sc = { el: null, v: null, msg: null, stream: null, det: null, cv: null, run: false, last: "", from: null };
  function build() {
    if (sc.el) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "wscan"; el.hidden = true; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "wscan-t");
    el.innerHTML = `<video playsinline muted></video><div class="wscan-frame" aria-hidden="true"></div>
      <div class="wscan-top"><b id="wscan-t">Scan the table QR</b><button type="button" class="wscan-x" data-close aria-label="Close">✕</button></div>
      <div class="wscan-bottom"><p role="status">Starting the camera…</p>
        <div class="wscan-acts"><button type="button" class="go" data-retry hidden>Try again</button><button type="button" data-close hidden>Close</button></div></div>`;
    document.body.appendChild(el);
    sc.el = el; sc.v = el.querySelector("video"); sc.msg = el.querySelector("p");
    el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); else if (e.target.closest("[data-retry]")) open(); });
  }
  const say = (t) => { sc.msg.textContent = t; };
  const acts = (on) => sc.el.querySelectorAll(".wscan-acts button").forEach((b) => (b.hidden = !on));
  const ours = (u) => ["wasabi.co.tz", "www.wasabi.co.tz", location.host].includes(u.host) || (u.host === "vmm100.github.io" && u.pathname.startsWith("/order-app"));
  function stopCam() { sc.run = false; if (sc.stream) sc.stream.getTracks().forEach((t) => t.stop()); sc.stream = null; if (sc.v) sc.v.srcObject = null; }
  function close() { stopCam(); sc.el.hidden = true; sc.el.classList.remove("err"); document.body.classList.remove("wscan-on"); if (sc.from && document.contains(sc.from)) sc.from.focus(); }
  function fail(t) { stopCam(); sc.el.classList.add("err"); say(t); acts(true); }
  const base = new URL(".", document.currentScript ? document.currentScript.src : location.href).href;
  const loadReader = () => window.jsQR ? Promise.resolve() : new Promise((ok, no) => { const x = document.createElement("script"); x.src = base + "vendor/jsQR.min.js"; x.onload = ok; x.onerror = no; document.head.appendChild(x); });
  async function open(from) {
    build();
    if (from) sc.from = from;
    sc.el.hidden = false; sc.el.classList.remove("err"); acts(false); sc.last = "";
    document.body.classList.add("wscan-on"); sc.el.querySelector(".wscan-x").focus(); say("Starting the camera…");
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
      if (u && ours(u) && u.searchParams.get("r")) { say("Opening the menu…"); stopCam(); if (navigator.vibrate) navigator.vibrate(40); location.href = u.href; return; }
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
