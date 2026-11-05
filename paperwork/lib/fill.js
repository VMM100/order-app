// Fills a paperwork template from window.DATA (company facts merged with one customer's details).
// Everything goes in as text (textContent), never as HTML. Anything left empty becomes a write-on line,
// so the same template prints blank for handwriting or filled for a customer.
//
//   <span data-k="restaurant">            text, or a blank line
//   <span data-k="restaurant" data-w="60"> blank line 60mm wide
//   <span data-money="total">             TSh 130,000
//   <span data-date="issued">             5 November 2026
//   <div data-if="key"> / data-unless     shown only if the value is (not) filled in
//   <tbody data-list="lines"><template>…  one copy of the template per item; keys inside are the item's
(function () {
  const D = window.DATA || {};
  const get = (o, k) => k.split(".").reduce((v, p) => (v == null ? v : v[p]), o);
  const filled = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
  const money = (n) => "TSh " + Math.round(Number(n) || 0).toLocaleString("en-US");
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const date = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : String(s); };

  function fill(root, data) {
    root.querySelectorAll("[data-list]").forEach((host) => {
      const tpl = host.querySelector(":scope > template"), items = get(data, host.dataset.list) || [];
      items.forEach((it, i) => { const c = tpl.content.cloneNode(true); fill(c, { ...data, ...it, n: i + 1, qty: it.qty ?? 1, amount: it.amount ?? (Number(it.qty) || 1) * (Number(it.price) || 0) }); host.appendChild(c); });
      host.dataset.done = "1";
    });
    root.querySelectorAll("[data-if],[data-unless]").forEach((el) => {
      if (el.closest("[data-list]:not([data-done])") && el.closest("[data-list]") !== root) return;
      const k = el.dataset.if || el.dataset.unless, has = filled(get(data, k));
      if (el.dataset.if ? !has : has) el.remove();
    });
    root.querySelectorAll("[data-k],[data-money],[data-date]").forEach((el) => {
      const k = el.dataset.k || el.dataset.money || el.dataset.date, v = get(data, k);
      if (!filled(v)) { el.textContent = ""; el.classList.add("blank"); if (el.dataset.w) el.style.width = el.dataset.w + "mm"; return; }
      el.textContent = el.dataset.money != null ? money(v) : el.dataset.date != null ? date(v) : String(v);
    });
  }
  fill(document, D);
  // Totals for invoices: sum of lines (qty × price), unless given.
  document.querySelectorAll("[data-sum]").forEach((el) => {
    const lines = get(D, el.dataset.sum) || [];
    el.textContent = lines.length ? money(lines.reduce((s, l) => s + (Number(l.qty) || 1) * (Number(l.price) || 0), 0)) : "";
    if (!lines.length) el.classList.add("blank");
  });
  document.documentElement.dataset.filled = D._blank ? "blank" : "filled";
  if (!document.querySelector(".face")) window.FILL_DONE = true; // print pieces: print.js says when ready
})();
