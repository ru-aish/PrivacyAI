import sharp from "sharp";

import { createImageError } from "./errors.js";
import { clampBox } from "./geometry.js";

export async function renderOpaqueRegions(image, regions) {
  const metadata = await sharp(image).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw createImageError("PRIVACYAI_IMAGE_RENDER_FAILED", "PrivacyAI could not render the sanitized image.");
  }

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    regions.map(region => regionSvg(region, width, height)).join("") +
    "</svg>"
  );
  return sharp(image)
    .composite([{ input: overlay, blend: "over" }])
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function regionSvg(region, imageWidth, imageHeight) {
  const [x0, y0, x1, y1] = clampBox(region.box, imageWidth, imageHeight);
  const x = Math.max(0, x0 - 4);
  const y = Math.max(0, y0 - 4);
  const right = Math.min(imageWidth, x1 + 4);
  const bottom = Math.min(imageHeight, y1 + 4);
  const height = Math.max(1, bottom - y);
  const fontSize = Math.max(8, Math.min(18, height - 5));
  const label = escapeXml(region.placeholder);
  const desiredWidth = Math.max(right - x, region.placeholder.length * fontSize * 0.62 + 12);
  const width = Math.max(1, Math.min(imageWidth - x, Math.ceil(desiredWidth)));
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#05070a"/>` +
    `<text x="${Math.min(imageWidth - 1, x + 6)}" y="${Math.max(fontSize, bottom - 4)}" ` +
    `fill="#ffffff" font-family="monospace" font-size="${fontSize}">${label}</text>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
