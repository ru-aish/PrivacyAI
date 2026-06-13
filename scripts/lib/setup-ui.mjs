import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function log(message = "") {
  console.log(message);
}

export function isInteractive() {
  return Boolean(input.isTTY && output.isTTY);
}

export async function prompt(label, defaultValue = "") {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

export async function promptSecret(label) {
  const rl = readline.createInterface({ input, output });
  try {
    if (typeof rl.question === "function") {
      const answer = await rl.question(`${label}: `, { hideEchoBack: true });
      return answer.trim();
    }
    return (await rl.question(`${label}: `)).trim();
  } finally {
    rl.close();
  }
}

export async function promptChoice(label, defaultValue = "1") {
  return prompt(label, defaultValue);
}

export async function runQuiet(command, args, message, { cwd, shell = false } = {}) {
  const { spawn } = await import("node:child_process");
  const logFile = `${cwd}/.setup-install.log`;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let combined = "";
    child.stdout?.on("data", (chunk) => {
      combined += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      combined += chunk.toString();
    });

    const frames = ["|", "/", "-", "\\"];
    let index = 0;
    const timer = setInterval(() => {
      process.stdout.write(`\r\x1b[K${frames[index % frames.length]} ${message}`);
      index += 1;
    }, 120);

    child.on("close", (code) => {
      clearInterval(timer);
      if (code === 0) {
        process.stdout.write(`\r\x1b[K✓ ${message}\n`);
        resolve(true);
        return;
      }

      process.stdout.write(`\r\x1b[K✗ ${message}\n`);
      log("");
      log("Last lines from the install log:");
      log(combined.trim().split("\n").slice(-30).join("\n"));
      resolve(false);
    });
  });
}