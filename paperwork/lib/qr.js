// Draws QR codes as sharp vector shapes for print. <div data-qr="whatsapp"> takes its link from that
// fact (window.DATA.whatsapp). Uses the same pinned library as the app (vendor/qrcode.min.js) only to
// work out the grid. Runs before print.js copies the faces.
(function () {
  const D = window.DATA || {};
  document.querySelectorAll("[data-qr]").forEach((el) => {
    const text = D[el.dataset.qr]; if (!text) return;
    const tmp = document.createElement("div");
    const m = new QRCode(tmp, { text, width: 64, height: 64, correctLevel: QRCode.CorrectLevel.M })._oQRCode;
    const n = m.getModuleCount(); let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="${el.dataset.ink || "#1a2117"}"/></svg>`;
  });
})();
