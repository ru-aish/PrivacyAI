import assert from "node:assert/strict";
import test from "node:test";

import {
  EXACT_TEXT_EDIT_PROMPT,
  TextEditGenerator,
  applyTextEdits,
  parseAndApplyTextEdits
} from "../src/index.js";

test("applies compact exact patches to code and prose", () => {
  const code = "function total() {\n  return value;\n}";
  assert.equal(
    applyTextEdits(code, [{
      search: "return value;",
      replace: "return value * 1.1;",
      occurrence: 1,
      all: false
    }]).text,
    "function total() {\n  return value * 1.1;\n}"
  );

  const prose = "The service starts at nine. It closes at five.";
  assert.equal(
    applyTextEdits(prose, [{ search: "nine", replace: "ten", occurrence: 1 }]).text,
    "The service starts at ten. It closes at five."
  );
});

test("supports occurrence selection and replace-all against the original source", () => {
  assert.equal(
    applyTextEdits("enabled\nkeep\nenabled", [{
      search: "enabled",
      replace: "disabled",
      occurrence: 2,
      all: false
    }]).text,
    "enabled\nkeep\ndisabled"
  );

  assert.equal(
    applyTextEdits("const count = 5;\nconsole.log(count);", [
      { search: "count", replace: "total", occurrence: 1, all: true },
      { search: "5", replace: "10", occurrence: 1, all: false }
    ]).text,
    "const total = 10;\nconsole.log(total);"
  );
});

test("rejects ambiguous, missing, overlapping, and whole-document edits", () => {
  assert.throws(
    () => applyTextEdits("same same", [{ search: "same", replace: "other" }]),
    error => error?.code === "PRIVACYAI_AMBIGUOUS_TEXT_EDIT"
  );
  assert.throws(
    () => applyTextEdits("one", [{ search: "missing", replace: "two", occurrence: 1 }]),
    error => error?.code === "PRIVACYAI_TEXT_EDIT_NOT_FOUND"
  );
  assert.throws(
    () => applyTextEdits("abcdef", [
      { search: "abc", replace: "x", occurrence: 1 },
      { search: "bcd", replace: "y", occurrence: 1 }
    ]),
    error => error?.code === "PRIVACYAI_OVERLAPPING_TEXT_EDITS"
  );

  const document = "a".repeat(300);
  assert.throws(
    () => applyTextEdits(document, [{
      search: document,
      replace: "replacement",
      occurrence: 1
    }]),
    error => error?.code === "PRIVACYAI_WHOLE_DOCUMENT_EDIT"
  );
});

test("parses fenced model JSON and reconstructs the result locally", () => {
  const source = "alpha beta beta";
  const modelText = "```json\n" + JSON.stringify({
    edits: [{ search: "beta", replace: "gamma", occurrence: 2, all: false }]
  }) + "\n```";
  const result = parseAndApplyTextEdits(modelText, source);
  assert.equal(result.text, "alpha beta gamma");
  assert.equal(result.edits.length, 1);
  assert.equal(modelText.includes(source), false);
});

test("TextEditGenerator asks for compact patches and never needs a full rewritten document", async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(request);
      return {
        text: JSON.stringify({
          edits: [{
            search: "return total;",
            replace: "return total * 1.1;",
            occurrence: 1,
            all: false
          }]
        }),
        raw: {},
        provider: { model: "mock" }
      };
    }
  };
  const source = "function total() {\n  return total;\n}";
  const generator = new TextEditGenerator({ provider, model: "mock" });
  const result = await generator.edit(source, "Add ten percent tax without rounding.");

  assert.equal(result.text, "function total() {\n  return total * 1.1;\n}");
  assert.equal(result.modelText.includes(source), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content, EXACT_TEXT_EDIT_PROMPT);
  assert.deepEqual(
    JSON.parse(requests[0].messages[1].content),
    { instruction: "Add ten percent tax without rounding.", source }
  );
});

test("TextEditGenerator rejects invalid model patches instead of guessing", async () => {
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({
          edits: [{ search: "same", replace: "other" }]
        }),
        raw: {},
        provider: {}
      };
    }
  };
  const generator = new TextEditGenerator({ provider, model: "mock" });
  await assert.rejects(
    generator.edit("same same", "Change only the second value."),
    error => error?.code === "PRIVACYAI_INVALID_TEXT_EDITS"
  );
});
