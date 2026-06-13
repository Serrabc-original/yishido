import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const logsDir = join(process.cwd(), "logs");
const date = new Date().toISOString().slice(0, 10);
const dailyLogPath = join(logsDir, "agent-" + date + ".log");
const latestLogPath = join(logsDir, "dev-latest.log");
const isWindows = process.platform === "win32";

mkdirSync(logsDir, { recursive: true });

const dailyOut = createWriteStream(dailyLogPath, { flags: "a" });
const latestOut = createWriteStream(latestLogPath, { flags: "w" });
const command = isWindows ? "cmd.exe" : "npx";
const args = isWindows
  ? ["/d", "/s", "/c", "npx wrangler dev"]
  : ["wrangler", "dev"];

console.log("Capturing local Worker logs to:");
console.log("- " + dailyLogPath);
console.log("- " + latestLogPath);
console.log("If Wrangler asks to open a tunnel, press t manually in this terminal.");

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: false
});

child.stdout.on("data", function (chunk) {
  process.stdout.write(chunk);
  dailyOut.write(chunk);
  latestOut.write(chunk);
});

child.stderr.on("data", function (chunk) {
  process.stderr.write(chunk);
  dailyOut.write(chunk);
  latestOut.write(chunk);
});

child.on("error", function (error) {
  const message = "dev:log failed to start Wrangler: " + String(error.message || error) + "\n";
  process.stderr.write(message);
  dailyOut.write(message);
  latestOut.write(message);
  closeStreams(function () {
    process.exit(1);
  });
});

child.on("exit", function (code, signal) {
  closeStreams(function () {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
});

function closeStreams(callback) {
  let pending = 2;
  function done() {
    pending -= 1;
    if (pending === 0) callback();
  }
  dailyOut.end(done);
  latestOut.end(done);
}
