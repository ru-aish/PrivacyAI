import { PrivateAI } from "../src/index.js";

const client = PrivateAI.fromEnv();

const result = await client.ask(
  "My name is John Smith and my email is john.smith@example.com. Write a polite follow-up."
);

console.log("Sanitized prompt:");
console.log(result.sanitizedText);
console.log("\nFinal response:");
console.log(result.finalText);

