// Lays out print pieces (cards, flyers) two ways from one design:
//   print-shop  each face on its own page at trim size + 3 mm bleed all round (what print shops ask for)
//   office      as many as fit on A4, cut to trim size, with crop marks, for an ordinary printer
// A template declares <body data-trim="85x55"> and one <section class="face"> per side, each drawn at
// bleed size (keep text 4 mm inside the trim). Backs (data-back) are mirrored so they line up when
// printed double-sided, flipping on the long edge.
(function () {
  const D = window.DATA || {}, mode = D._mode || "print-shop", B = 3;
  const [tw, th] = document.body.dataset.trim.split("x").map(Number);
  const faces = [...document.querySelectorAll(".face")];
  const css = document.createElement("style"); document.head.appendChild(css);
  document.documentElement.style.setProperty("--bw", tw + 2 * B + "mm");
  document.documentElement.style.setProperty("--bh", th + 2 * B + "mm");

  if (mode === "print-shop") {
    css.textContent = `@page{size:${tw + 2 * B}mm ${th + 2 * B}mm;margin:0} .face{break-after:page} .face:last-child{break-after:auto}`;
  } else {
    // Pick the A4 orientation that fits the most copies, with 8 mm margins for the crop marks.
    // An A5 flyer only fits twice with no margin (A4 cut in half), so edge-to-edge is tried too.
    const fit = (W, H, m) => ({ W, H, m, cols: Math.floor((W - 2 * m + .01) / tw), rows: Math.floor((H - 2 * m + .01) / th) });
    let o = [fit(210, 297, 8), fit(297, 210, 8), fit(210, 297, 0), fit(297, 210, 0)].sort((a, b) => b.cols * b.rows - a.cols * a.rows || b.m - a.m)[0];
    if (!o.cols || !o.rows) o = { W: tw, H: th, cols: 1, rows: 1 };  // the piece is A4 itself: just trim it
    const gw = o.cols * tw, gh = o.rows * th, x0 = (o.W - gw) / 2, y0 = (o.H - gh) / 2;
    css.textContent = `@page{size:${o.W}mm ${o.H}mm;margin:0}
      .osheet{position:relative;width:${o.W}mm;height:${o.H}mm;overflow:hidden;break-after:page}
      .osheet:last-child{break-after:auto}
      .cell{position:absolute;width:${tw}mm;height:${th}mm;overflow:hidden}
      .cell>.face{position:absolute;left:-${B}mm;top:-${B}mm;margin:0}
      .crop{position:absolute;background:#000}`;
    const sheets = faces.map((f) => {
      const s = document.createElement("div"); s.className = "osheet";
      for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.cols; c++) {
        const cell = document.createElement("div"); cell.className = "cell";
        const col = f.hasAttribute("data-back") ? o.cols - 1 - c : c;
        cell.style.left = x0 + col * tw + "mm"; cell.style.top = y0 + r * th + "mm";
        cell.appendChild(f.cloneNode(true)); s.appendChild(cell);
      }
      if (o.W !== tw) { // crop marks in the margin, in line with every cut
        const mark = (x, y, w, h) => { const k = document.createElement("i"); k.className = "crop"; Object.assign(k.style, { left: x + "mm", top: y + "mm", width: w + "mm", height: h + "mm" }); s.appendChild(k); };
        // Outside the grid when there's room; otherwise short marks at the sheet's edge on the inner cuts.
        const vy = y0 >= 6 ? [y0 - 6, y0 + gh + 2] : [0, o.H - 4], hx = x0 >= 6 ? [x0 - 6, x0 + gw + 2] : [0, o.W - 4];
        for (let c = 0; c <= o.cols; c++) { const x = x0 + c * tw - 0.1; if (x > 0.5 && x < o.W - 0.5) vy.forEach((y) => mark(x, y, 0.2, 4)); }
        for (let r = 0; r <= o.rows; r++) { const y = y0 + r * th - 0.1; if (y > 0.5 && y < o.H - 0.5) hx.forEach((x) => mark(x, y, 4, 0.2)); }
      }
      return s;
    });
    faces.forEach((f) => f.remove()); sheets.forEach((s) => document.body.appendChild(s));
  }
  window.FILL_DONE = true;
})();
