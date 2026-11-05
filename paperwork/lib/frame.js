// Wraps each <section class="page" data-kind="…"> of an A4 template in the Wasabi sheet: green top
// strip, logo, document name, and a footer with the company's details and "page 1 of 2".
// Runs before fill.js, so the footer's details are filled from the same facts.
(function () {
  const pages = [...document.querySelectorAll("section.page")];
  pages.forEach((p, i) => {
    const s = document.createElement("div"); s.className = "sheet";
    s.innerHTML = `<div class="band"></div>
      <div class="head"><img class="lockup" src="../../img/brand/wasabi-lockup.svg" alt="Wasabi">
        <div class="doc-kind"></div></div>
      <div class="body"></div>
      <div class="foot-rule"></div>
      <div class="foot"><div class="who"><b data-k="legalName"></b> · <span data-if="registration">Business name reg. no. <span data-k="registration"></span> · </span><span data-unless="registration" data-k="registrationNote"></span> · <span data-k="address"></span><br>
        <span data-k="email"></span> · <span data-k="phone"></span> · <span data-k="web"></span></div>
        <div class="pg"></div></div>`;
    s.querySelector(".doc-kind").textContent = p.dataset.kind || (window.DATA && window.DATA.docType) || document.title.replace(/ · Wasabi$/, "");
    s.querySelector(".pg").textContent = pages.length > 1 ? `Page ${i + 1} of ${pages.length}` : "";
    p.replaceWith(s); s.querySelector(".body").appendChild(p);
  });
})();
