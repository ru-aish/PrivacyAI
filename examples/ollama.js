import { PrivateAI } from "@privacy-ai/sdk";

const client = PrivateAI.fromEnv();
const result = await client.ask("local.e2e@example.com");
console.log(result.finalText);

