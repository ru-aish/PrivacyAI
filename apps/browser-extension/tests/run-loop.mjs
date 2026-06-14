import { spawn } from "node:child_process";

const maxAttempts = 10;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`\n=== Playwright attempt ${attempt}/${maxAttempts} ===`);
  try {
    await run("npm", ["run", "test:e2e"]);
    console.log("\nExtension e2e tests passed.");
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    if (attempt === maxAttempts) {
      process.exit(1);
    }
  }
}