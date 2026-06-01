import { ask } from "@privacy-ai/sdk";

const result = await ask("My email is jane@example.com. Make this safe.");
console.log(result.finalText);

