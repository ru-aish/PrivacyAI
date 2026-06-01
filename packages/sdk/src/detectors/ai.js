export class AiDetector {
  constructor(provider, options = {}) {
    this.provider = provider;
    this.model = options.model;
  }

  async detect(text) {
    const prompt = [
      "Return only JSON with this shape:",
      '{"items":[{"type":"PERSON|LOCATION|ORGANIZATION|CUSTOM","value":"exact substring"}]}',
      "Find sensitive personal or organization data in the input.",
      "",
      text
    ].join("\n");

    const response = await this.provider.chat({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });

    const json = extractJson(response.text);
    if (!json || !Array.isArray(json.items)) {
      return [];
    }

    const detections = [];
    for (const item of json.items) {
      if (!item || typeof item.value !== "string" || typeof item.type !== "string") continue;
      const start = text.indexOf(item.value);
      if (start === -1) continue;
      detections.push({
        type: item.type.toUpperCase(),
        value: item.value,
        start,
        end: start + item.value.length,
        confidence: 0.62,
        source: "local-ai"
      });
    }
    return detections;
  }
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

