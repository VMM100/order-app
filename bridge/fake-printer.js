// A pretend thermal printer for testing without hardware: listens on a port like a real one (9100)
// and shows each ticket as plain text. Usage: node fake-printer.js [port] [folder to save tickets in]
import net from "node:net";
import fs from "node:fs";
import { readable } from "./lib.js";

const port = Number(process.argv[2] || 9100), dir = process.argv[3];
let n = 0;
net.createServer((sock) => {
  const chunks = [];
  sock.on("data", (c) => chunks.push(c));
  sock.on("end", () => {
    const buf = Buffer.concat(chunks); if (!buf.length) return;   // a status check, not a ticket
    n++;
    const txt = readable(buf);
    console.log(`----- ticket ${n} (${buf.length} bytes, cut: ${buf.includes(Buffer.from([0x1d, 0x56])) ? "yes" : "no"}) -----\n${txt}`);
    if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/ticket-${String(n).padStart(3, "0")}.txt`, txt); }
  });
  sock.on("error", () => {});
}).listen(port, () => console.log(`fake printer listening on port ${port}`));
