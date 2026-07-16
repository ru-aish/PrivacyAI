import engData from "@tesseract.js-data/eng";
import sharp from "sharp";
import { createWorker, OEM, PSM } from "tesseract.js";

import { createImageError, throwIfImageAborted } from "./errors.js";
import { overlapOverMinimum, scaleBox } from "./geometry.js";

export function createTesseractOcrEngine(options = {}) {
  let workersPromise;
  let queue = Promise.resolve();
  let closed = false;

  const runSerial = operation => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => {});
    return run;
  };

  return {
    recognize(image, context = {}) {
      return runSerial(async () => {
        if (closed) {
          throw createImageError("PRIVACYAI_IMAGE_SANITIZER_CLOSED", "PrivacyAI OCR is closed.");
        }
        throwIfImageAborted(context.signal);
        const workers = await (workersPromise ||= createWorkers(options));
        const prepared = await prepareOcrInput(image);
        const [auto, sparse] = await Promise.all([
          workers.auto.recognize(prepared.upscaled, {}, { text: true, blocks: true }),
          workers.sparse.recognize(prepared.normalized, {}, { text: true, blocks: true })
        ]);
        throwIfImageAborted(context.signal);
        return dedupeLines([
          ...linesFromBlocks(auto.data, 1 / prepared.scale, "auto"),
          ...linesFromBlocks(sparse.data, 1, "sparse")
        ]);
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      await queue.catch(() => {});
      if (!workersPromise) return;
      const workers = await workersPromise;
      await Promise.all([workers.auto.terminate(), workers.sparse.terminate()]);
    }
  };
}

async function createWorkers(options) {
  const workerFactory = options.createWorker || createWorker;
  const workerOptions = {
    langPath: options.langPath || engData.langPath,
    gzip: options.gzip ?? engData.gzip,
    cacheMethod: "none",
    logger: typeof options.ocrLogger === "function" ? options.ocrLogger : () => {}
  };
  const [auto, sparse] = await Promise.all([
    workerFactory("eng", OEM.LSTM_ONLY, workerOptions),
    workerFactory("eng", OEM.LSTM_ONLY, workerOptions)
  ]);
  await Promise.all([
    auto.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" }),
    sparse.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: "1" })
  ]);
  return { auto, sparse };
}

async function prepareOcrInput(normalized) {
  const metadata = await sharp(normalized).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const scale = Math.max(1, Math.min(2, 2400 / width, 1800 / height));
  const upscaled = await sharp(normalized)
    .resize({ width: Math.round(width * scale), height: Math.round(height * scale), kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 0.8 })
    .png()
    .toBuffer();
  return { normalized, upscaled, scale };
}

function linesFromBlocks(data, scale, pass) {
  const output = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = String(line.text || "").trimEnd();
        if (!text.trim()) continue;
        output.push({
          text,
          confidence: Number(line.confidence || 0) / 100,
          pass,
          box: scaleBox(line.bbox, scale),
          words: locateWords(text, line.words, scale)
        });
      }
    }
  }
  return output;
}

function locateWords(text, words, scale) {
  const output = [];
  let cursor = 0;
  for (const word of words || []) {
    const value = String(word.text || "").trim();
    if (!value) continue;
    let start = text.indexOf(value, cursor);
    if (start === -1) start = text.indexOf(value);
    if (start === -1) continue;
    output.push({ text: value, start, end: start + value.length, box: scaleBox(word.bbox, scale) });
    cursor = start + value.length;
  }
  return output;
}

function dedupeLines(lines) {
  const kept = [];
  for (const line of lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const duplicate = kept.find(current =>
      current.text === line.text && overlapOverMinimum(current.box, line.box) >= 0.7
    );
    if (!duplicate) kept.push(line);
    else if (line.confidence > duplicate.confidence) Object.assign(duplicate, line);
  }
  return kept;
}
