# Image OCR evaluation and SDK architecture

## Scope

This evaluation targets the image traffic developers normally send to Codex: web and desktop UI screenshots, terminal output, IDE/code views, error banners, charts, and photographed displays. It deliberately does not attempt general photographic privacy classification.

The working corpus was kept outside Git under `.eval/image-corpus/` and contained:

- 12 public GitHub issue attachments covering web forms and dashboards, mobile and desktop applications, source-code views, charts, error dialogs, and a photographed screen.
- 7 generated fixtures with known private strings, including small monospace text, duplicate values, multiline credentials, paths, email addresses, IP addresses, API tokens, dense IDE content, and private text injected over real GUI screenshots.

Public source provenance was retained in the local evaluation manifest. Representative repositories included `frappe/frappe`, `bytechefhq/bytechef`, `zenc-lang/zenc`, `luau-lang/luau`, `vllm-project/vllm-ascend`, and `Snapmaker/OrcaSlicer`.

## OCR candidates

All measurements were CPU-only on the development host. Accuracy is exact recovery of 24 known private substrings from the generated and injected fixtures.

| Candidate | Exact private spans | Mean recognition time | Installed footprint observed | Notes |
| --- | ---: | ---: | ---: | --- |
| Tesseract.js, raw AUTO | 15/24 | 2.65 s/image | ~16 MB with English data | Missed dense and tiny text. |
| Tesseract.js, preprocessed AUTO | 20/24 | 4.69 s/image | ~16 MB with English data | Strong baseline after resize and sharpening. |
| Tesseract.js, preprocessed AUTO + raw SPARSE union | 23/24 | 7.68 s/image | ~16 MB with English data | Complementary passes recovered dense IDE and GUI text. |
| PP-OCRv4 via `@gutenye/ocr-node` | 23/24 | 5.67 s/image | 160–600 MB depending on ONNX/CUDA packaging | Similar accuracy, materially larger runtime. |

`scribe.js-ocr` was excluded before benchmarking because its package is roughly 66 MB and AGPL-3.0 licensed. Browser/WebGL Paddle packages were not suitable for the Node gateway.

## Selected stack

- `tesseract.js`
- `@tesseract.js-data/eng`
- `sharp`

The selected OCR strategy unions two local passes:

1. normalized/upscaled image with Tesseract `AUTO` segmentation;
2. normalized original image with `SPARSE_TEXT` segmentation.

This matched PP-OCRv4's measured exact-span recall without requiring ONNX Runtime or GPU libraries. The reusable SDK engine initializes workers lazily, serializes OCR jobs, reuses workers across images, and terminates them when the image sanitizer closes. The Codex gateway owns one lazy SDK-backed adapter for its lifetime.

## Masking experiment

The renderer does not reconstruct the original background. It places an opaque dark rectangle over the exact OCR word boxes and renders the stable PrivacyAI placeholder in white. This is deterministic, cheap, and avoids recoverable blur or partially transparent pixels.

The production engine uses these rules:

1. map exact private substrings returned by the existing sanitizer back to OCR word ranges;
2. union boxes for fragmented or multiword values;
3. deduplicate overlapping detections from both OCR passes;
4. render an opaque exact-word mask and verify the result with OCR;
5. if verification still sees a protected original, rerender from the untouched normalized image with the containing OCR line expanded;
6. if the line attempt still leaks, rerender from the untouched normalized image with a broader opaque block;
7. flatten every rendered attempt to an opaque PNG and fail closed if the third verification still detects an original.

The privacy classifier runs once. Retry attempts change only pixel coverage and verification OCR, which avoids extra local-model latency and keeps placeholder mappings stable.

The final prototype produced no exact known-string leaks on representative terminal, tiny-text, real-web, and real-IDE fixtures. It preserved enough GUI and code structure for a coding model to reason about the screenshot.

## Package boundary

The reusable privacy engine lives in the optional `@privacy-ai/sdk/image` entry point. It owns image decoding, limits, normalization, OCR, private-region mapping, exact-to-line-to-block retries, rendering, and verification. The main `@privacy-ai/sdk` entry does not import image dependencies.

`@privacy-ai/agent-bridge` owns only Codex protocol concerns: locating supported `input_image` fields, validating `detail`, limiting image count, invoking the SDK engine before prompt sanitization, synchronizing session mappings, translating generic SDK errors into Codex gateway errors, and replacing the provider-bound data URL. The adapter loads `@privacy-ai/sdk/image` lazily on the first image request.

The browser playground imports `@privacy-ai/sdk/image` directly. It uses agent-bridge only for the shared local privacy-provider configuration and strict text-sanitizer construction.

## Codex request shape

A stock Codex CLI run with `gpt-5.4-mini` and `--image` emitted the image as a message content item:

```json
{
  "type": "input_image",
  "detail": "high",
  "image_url": "data:image/png;base64,..."
}
```

The gateway implementation should accept local raster data URLs only, reject remote URLs and unsupported formats, enforce decoded-byte and pixel limits, sanitize both message images and image tool outputs, and preserve the `detail` field.


## Production end-to-end validation

A final stock Codex CLI session was run through the completed PrivacyAI provider gateway with:

- remote coding model: `gpt-5.4-mini`;
- local privacy provider: Ollama only;
- local privacy model: `ministral-3:3b`;
- input: a generated deployment-form screenshot containing a known test email;
- Codex runtime: isolated auth-only home with unrelated MCP and provider-hosted features disabled.

Observed result:

- Ollama mapped the private email to `contact1@example.com`.
- The forwarded image was a changed, opaque PNG.
- Re-OCR of the forwarded image did not contain the original test email.
- The sanitized image visibly retained the form layout and safe replacement.
- Stock Codex exited successfully and described the form.
- Codex returned the owner value from the sanitized image, and the gateway restored the original test email only in the local user-visible response.

The first live attempt also exposed a persistence defect: image audit records were incorrectly inserted into the text verification cache without a corresponding verification row, causing a SQLite foreign-key failure. The final implementation does not cache image records; images are OCR-sanitized and independently re-verified on each request. A regression assertion covers this boundary.
