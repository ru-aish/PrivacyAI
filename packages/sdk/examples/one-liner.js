import { ask } from "../src/index.js";

const result = await ask("Call Maria Rodriguez at +1 555 123 4567 and summarize the next step.");

console.log(result.finalText);

