import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const logsDir = join(process.cwd(), "logs");
const limit = Number(process.argv[2] || 120);

if (!existsSync(logsDir)) {
  console.log(JSON.stringify({
    status: "no_logs_dir",
    message: "No logs directory found. Create logs/ or run the Worker locally with log capture enabled."
  }, null, 2));
  process.exit(0);
}

const files = readdirSync(logsDir)
  .filter(function (file) {
    return file.endsWith(".log");
  })
  .sort()
  .reverse();

if (!files.length) {
  console.log(JSON.stringify({
    status: "no_log_files",
    logsDir: logsDir
  }, null, 2));
  process.exit(0);
}

const requested = process.argv[3] || "";
const latest = requested && files.includes(requested)
  ? requested
  : files.includes("dev-latest.log") ? "dev-latest.log" : files[0];
const lines = readFileSync(join(logsDir, latest), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(-limit);

console.log(JSON.stringify({
  status: "ok",
  file: latest,
  lineCount: lines.length,
  lines: lines
}, null, 2));
