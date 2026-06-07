import { PrivateAI } from "@privacy-ai/sdk";

const client = PrivateAI.fromEnv();
const result = await client.ask("Call me at +1 555 123 4567.", {
  maxTokens: 64,
  temperature: 0
});

console.log(result.finalText);
