import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const extraArgs = rawArgs.includes("--") ? rawArgs.slice(rawArgs.indexOf("--") + 1) : rawArgs;
const playwrightArgs = ["playwright", "test", ...extraArgs];

function hasCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

const forceForeground = process.env.PRIVACYAI_E2E_FOREGROUND === "1";
const useXvfb = process.platform === "linux" && !forceForeground && hasCommand("xvfb-run");

const command = useXvfb ? "xvfb-run" : "npx";
const args = useXvfb
  ? ["-a", "--server-args=-screen 0 1280x720x24", "npx", ...playwrightArgs]
  : playwrightArgs;

const childEnv = { ...process.env };
if (useXvfb) {
  delete childEnv.WAYLAND_DISPLAY;
  childEnv.XDG_SESSION_TYPE = "x11";
  childEnv.GDK_BACKEND = "x11";
  childEnv.QT_QPA_PLATFORM = "xcb";
}

console.log(`Running browser extension tests via ${useXvfb ? "Xvfb background X11 display" : "current display"}.`);
const result = spawnSync(command, args, { stdio: "inherit", env: childEnv });
process.exit(result.status ?? 1);
