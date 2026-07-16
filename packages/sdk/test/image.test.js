import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import {
  createImageSanitizer,
  createTesseractOcrEngine,
  decodeImageDataUrl,
  locatePrivateRegions
} from "../src/image/index.js";

const PRIVATE = "alice.private@example.test";
const PLACEHOLDER = "[EMAIL_1]";

function sanitizer(text) {
  const found = text.includes(PRIVATE);
  return Promise.resolve({
    sanitizedPrompt: found ? text.replaceAll(PRIVATE, PLACEHOLDER) : text,
    sessionMap: found ? { [PLACEHOLDER]: PRIVATE } : {}
  });
}

async function imageDataUrl(width = 240, height = 100) {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: "#f8fafc" }
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function privateLine() {
  const text = `owner ${PRIVATE} backup ${PRIVATE}`;
  const first = text.indexOf(PRIVATE);
  const second = text.indexOf(PRIVATE, first + 1);
  return {
    text,
    confidence: 0.96,
    box: [10, 10, 590, 42],
    words: [
      { text: PRIVATE, start: first, end: first + PRIVATE.length, box: [62, 10, 260, 42] },
      { text: PRIVATE, start: second, end: second + PRIVATE.length, box: [330, 10, 528, 42] }
    ]
  };
}

test("root SDK entry stays image-free while the optional image entry exports the engine", async () => {
  const rootSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(rootSource, /(?:sharp|tesseract|\.\/image)/i);

  const root = await import("../src/index.js");
  const image = await import("../src/image/index.js");
  assert.equal("createImageSanitizer" in root, false);
  assert.equal(typeof image.createImageSanitizer, "function");
});

test("image data URLs reject remote, malformed, mismatched, and oversized media", async () => {
  const valid = await imageDataUrl();
  assert.equal((await decodeImageDataUrl(valid)).width, 240);
  await assert.rejects(
    decodeImageDataUrl("https://example.test/private.png"),
    error => error?.code === "PRIVACYAI_IMAGE_UNSUPPORTED_URL"
  );
  await assert.rejects(
    decodeImageDataUrl("data:image/png;base64,AB=="),
    error => error?.code === "PRIVACYAI_IMAGE_INVALID_BASE64"
  );
  await assert.rejects(
    decodeImageDataUrl(valid.replace("image/png", "image/jpeg")),
    error => error?.code === "PRIVACYAI_IMAGE_MIME_MISMATCH"
  );
  await assert.rejects(
    decodeImageDataUrl(valid, { maxImageBytes: 10 }),
    error => error?.code === "PRIVACYAI_IMAGE_TOO_LARGE"
  );
  await assert.rejects(
    decodeImageDataUrl(valid, { maxImagePixels: 100 }),
    error => error?.code === "PRIVACYAI_IMAGE_TOO_LARGE"
  );
});

test("private region mapping covers duplicate and fragmented OCR spans", () => {
  assert.deepEqual(
    locatePrivateRegions([privateLine()], { [PLACEHOLDER]: PRIVATE }).map(region => region.box),
    [[62, 10, 260, 42], [330, 10, 528, 42]]
  );

  const text = `token=${PRIVATE}`;
  const fragmented = {
    text,
    confidence: 0.8,
    box: [0, 0, 400, 30],
    words: [
      { text: text.slice(0, 20), start: 0, end: 20, box: [0, 0, 190, 30] },
      { text: text.slice(20), start: 20, end: text.length, box: [190, 0, 350, 30] }
    ]
  };
  assert.deepEqual(
    locatePrivateRegions([fragmented], { [PLACEHOLDER]: PRIVATE })[0].box,
    [0, 0, 350, 30]
  );
});

test("image sanitizer masks duplicate regions and verifies opaque PNG output", async () => {
  const source = await imageDataUrl(650, 100);
  let calls = 0;
  const imageSanitizer = createImageSanitizer({
    ocr: {
      async recognize() {
        calls += 1;
        return calls === 1
          ? [privateLine()]
          : [{ text: `owner ${PLACEHOLDER}`, words: [], box: [10, 10, 200, 42] }];
      }
    }
  });

  const result = await imageSanitizer.sanitize(source, { sanitizer, sessionMap: {} });
  assert.equal(result.changed, true);
  assert.equal(result.regionCount, 2);
  assert.equal(result.maskStrategy, "exact");
  assert.equal(result.verificationAttempts, 1);
  assert.deepEqual(result.sessionMapAdditions, { [PLACEHOLDER]: PRIVATE });
  const output = Buffer.from(result.dataUrl.split(",", 2)[1], "base64");
  assert.equal((await sharp(output).stats()).isOpaque, true);
});

test("verification retries exact, line, then block masks without reclassifying", async () => {
  const source = await imageDataUrl(650, 100);
  const rendered = [];
  let ocrCalls = 0;
  let sanitizerCalls = 0;
  const imageSanitizer = createImageSanitizer({
    ocr: {
      async recognize() {
        ocrCalls += 1;
        return ocrCalls < 4
          ? [privateLine()]
          : [{ text: `owner ${PLACEHOLDER}`, words: [], box: [10, 10, 200, 42] }];
      }
    },
    async renderer(image, regions, options) {
      rendered.push({ strategy: options.maskStrategy, box: regions[0].box });
      return image;
    }
  });

  const result = await imageSanitizer.sanitize(source, {
    sanitizer: async text => {
      sanitizerCalls += 1;
      return sanitizer(text);
    },
    sessionMap: {}
  });

  assert.equal(result.maskStrategy, "block");
  assert.equal(result.verificationAttempts, 3);
  assert.equal(ocrCalls, 4);
  assert.equal(sanitizerCalls, 1);
  assert.deepEqual(rendered.map(item => item.strategy), ["exact", "line", "block"]);
  assert.ok(rendered[1].box[0] < rendered[0].box[0]);
  assert.ok(rendered[2].box[0] < rendered[1].box[0]);
});

test("unchanged images preserve bytes and persistent verification leaks fail closed", async () => {
  const source = await imageDataUrl(650, 100);
  const clean = createImageSanitizer({
    ocr: {
      async recognize() {
        return [{ text: "public error", words: [], box: [0, 0, 100, 20] }];
      }
    }
  });
  const cleanResult = await clean.sanitize(source, { sanitizer, sessionMap: {} });
  assert.equal(cleanResult.dataUrl, source);
  assert.equal(cleanResult.changed, false);
  assert.equal(cleanResult.verificationAttempts, 0);

  let leakingCalls = 0;
  const leaking = createImageSanitizer({
    ocr: {
      async recognize() {
        leakingCalls += 1;
        return [privateLine()];
      }
    }
  });
  await assert.rejects(
    leaking.sanitize(source, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_IMAGE_VERIFICATION_FAILED"
  );
  assert.equal(leakingCalls, 4);
});

test("malformed OCR and render results fail at the SDK boundary", async () => {
  const source = await imageDataUrl();
  const malformedOcr = createImageSanitizer({ ocr: { async recognize() { return {}; } } });
  await assert.rejects(
    malformedOcr.sanitize(source, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_IMAGE_OCR_FAILED"
  );

  const malformedWords = createImageSanitizer({
    ocr: {
      async recognize() {
        return [{ text: PRIVATE, box: [0, 0, 100, 20], words: [{ text: PRIVATE, start: 0, end: 999, box: [0, 0, 100, 20] }] }];
      }
    }
  });
  await assert.rejects(
    malformedWords.sanitize(source, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_IMAGE_OCR_FAILED"
  );

  let calls = 0;
  const malformedRender = createImageSanitizer({
    ocr: {
      async recognize() {
        calls += 1;
        return calls === 1 ? [privateLine()] : [];
      }
    },
    async renderer() {
      return null;
    }
  });
  await assert.rejects(
    malformedRender.sanitize(source, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_IMAGE_RENDER_FAILED"
  );
});

test("line fallback is used only when OCR words cannot locate an exact span", () => {
  const line = {
    text: `owner=${PRIVATE}`,
    confidence: 0.4,
    box: [5, 6, 390, 38],
    words: []
  };
  const [region] = locatePrivateRegions([line], { [PLACEHOLDER]: PRIVATE });
  assert.equal(region.fallback, true);
  assert.deepEqual(region.box, line.box);
});

test("Tesseract engine owns and terminates both lazy workers", async () => {
  let terminated = 0;
  const worker = () => ({
    async setParameters() {},
    async recognize() { return { data: { blocks: [] } }; },
    async terminate() { terminated += 1; }
  });
  const engine = createTesseractOcrEngine({ createWorker: async () => worker() });
  const input = Buffer.from((await imageDataUrl()).split(",", 2)[1], "base64");
  await engine.recognize(input);
  await engine.close();
  await engine.close();
  assert.equal(terminated, 2);
});

test("real CPU OCR removes private text from a generated developer screenshot", { timeout: 60_000 }, async () => {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="220">` +
    `<rect width="1000" height="220" fill="#111827"/>` +
    `<text x="35" y="75" fill="#f8fafc" font-family="DejaVu Sans Mono" font-size="31">` +
    `Build failed for ${PRIVATE}</text>` +
    `<text x="35" y="135" fill="#fbbf24" font-family="DejaVu Sans Mono" font-size="24">` +
    `Retry after configuration update</text></svg>`
  );
  const input = await sharp(svg).png().toBuffer();
  const source = `data:image/png;base64,${input.toString("base64")}`;
  const imageSanitizer = createImageSanitizer();
  try {
    const result = await imageSanitizer.sanitize(source, { sanitizer, sessionMap: {} });
    assert.equal(result.changed, true);
    assert.deepEqual(result.sessionMapAdditions, { [PLACEHOLDER]: PRIVATE });
  } finally {
    await imageSanitizer.close();
  }
});
