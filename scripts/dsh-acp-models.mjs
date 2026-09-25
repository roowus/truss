/* probe: list the patched dsh acp profile's model options */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const env = { ...process.env };
for (const line of readFileSync("/opt/dsh/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2];
}
env.DSH_HOME = "/opt/dsh";
const proc = spawn("dsh", ["--profile", "acp", "--patch", new URL("../config/truss-dsh-acp.yml", import.meta.url).pathname], { stdio: ["pipe", "pipe", "ignore"], env });
let buf = ""; const pending = new Map(); let idc = 0;
const send = (method, params) => {
  const id = `r${++idc}`;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => { pending.set(id, res); setTimeout(() => rej(new Error("timeout " + method)), 180000); });
};
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.id && pending.has(rec.id)) { pending.get(rec.id)(rec); pending.delete(rec.id); }
  }
});
await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
const sn = await send("session/new", { cwd: "/tmp", mcpServers: [] });
const opts = sn.result?.configOptions ?? [];
for (const o of opts) {
  if (o.id !== "model") continue;
  const flat = [];
  const walk = (x) => { if (x.options) x.options.forEach(walk); else flat.push(x.name ?? x.value); };
  (o.options ?? []).forEach(walk);
  console.log(`model options (${flat.length}):`, flat.slice(0, 40).join(", "));
}
if (!opts.length) console.log("no configOptions:", JSON.stringify(sn.error ?? sn.result).slice(0, 300));
proc.stdin.end();
setTimeout(() => process.exit(0), 600);
