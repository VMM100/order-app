// Talking to a printer on the restaurant's network: plain TCP to port 9100, which basic Ethernet
// thermal printers accept. One connection per ticket; the restaurant's till can print in between.
import net from "node:net";

// Send bytes; resolves when the printer has taken them, rejects if it can't be reached in time.
export function send(ip, port, bytes, timeoutMs = 5000) {
  return new Promise((ok, no) => {
    const s = net.createConnection({ host: ip, port });
    const fail = (e) => { s.destroy(); no(e instanceof Error ? e : new Error(String(e))); };
    s.setTimeout(timeoutMs, () => fail(new Error("not responding")));
    s.once("error", fail);
    s.once("connect", () => s.end(bytes, () => { s.destroy(); ok(); }));
  });
}

// Is the printer there? Opens and closes a connection, nothing is printed.
export function probe(ip, port, timeoutMs = 3000) {
  return new Promise((ok) => {
    const s = net.createConnection({ host: ip, port });
    const done = (v) => { s.destroy(); ok(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("error", () => done(false));
    s.once("connect", () => done(true));
  });
}

// A couple of quick retries: the till may be printing at the same moment.
export async function sendWithRetry(ip, port, bytes, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { await send(ip, port, bytes); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}
