import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const logsDir = join(process.cwd(), "logs");
const date = new Date().toISOString().slice(0, 10);
const logPath = join(logsDir, "agent-" + date + ".log");

mkdirSync(logsDir, { recursive: true });

const out = createWriteStream(logPath, { flags: "a" });
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "dev"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"]
});

console.log("Capturing local Worker logs to " + logPath);

child.stdout.on("data", function (chunk) {
  process.stdout.write(chunk);
  out.write(chunk);
});

child.stderr.on("data", function (chunk) {
  process.stderr.write(chunk);
  out.write(chunk);
});

child.on("exit", function (code, signal) {
  out.end();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
