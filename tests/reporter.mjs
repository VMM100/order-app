// Prints each test result, and turns failures into GitHub annotations so they show on the run page.
const clean = (s) => String(s || "").replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, " ").slice(0, 400);
export default async function* reporter(source) {
  let pass = 0, fail = 0;
  for await (const ev of source) {
    const d = ev.data || {};
    if (d.details && d.details.type === "suite") continue;
    if (ev.type === "test:pass") { pass++; yield `ok   ${d.name}\n`; }
    if (ev.type === "test:fail") {
      fail++;
      const err = d.details && d.details.error, msg = clean((err && err.cause && err.cause.message) || (err && err.message));
      yield `FAIL ${d.name}: ${msg}\n`;
      yield `::error title=${clean(d.name).replace(/[,:]/g, " ")}::${msg}\n`;
    }
  }
  yield `::notice title=Security rules tests::${pass} passed, ${fail} failed\n`;
}
