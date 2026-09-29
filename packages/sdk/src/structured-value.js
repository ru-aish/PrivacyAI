export function transformValue(value, transformText, options = {}, path = []) {
  if (typeof transformText !== "function") {
    throw new TypeError("transformValue requires a text transformation function.");
  }
  if (typeof value === "string") return transformText(value);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      transformValue(item, transformText, options, [...path, index])
    );
  }
  if (!value || typeof value !== "object") return value;

  const transformed = {};
  for (const [key, item] of Object.entries(value)) {
    const keyPath = [...path, key];
    const transformedKey = shouldProcessKey(options.transformKeys, keyPath, key)
      ? transformText(key)
      : key;
    defineStructuredProperty(
      transformed,
      transformedKey,
      transformValue(item, transformText, options, keyPath)
    );
  }
  return transformed;
}

export function visitText(value, visitor, options = {}, path = []) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      visitText(value[index], visitor, options, [...path, index]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const keyPath = [...path, key];
    if (shouldProcessKey(options.includeKeys, keyPath, key)) visitor(key);
    visitText(item, visitor, options, keyPath);
  }
}

export function describeStructuredValue(value, slots, options = {}) {
  return describe(value, []);

  function describe(entry, path) {
    if (typeof entry === "string") {
      const index = slots.length;
      slots.push({ value: entry });
      return { type: "slot", index };
    }
    if (Array.isArray(entry)) {
      return {
        type: "array",
        items: entry.map((item, index) => describe(item, [...path, index]))
      };
    }
    if (!entry || typeof entry !== "object") return { type: "literal", value: entry };

    const entries = [];
    for (const [key, item] of Object.entries(entry)) {
      const keyPath = [...path, key];
      entries.push({
        key: shouldProcessKey(options.sanitizeObjectKeys, keyPath, key)
          ? describe(key, keyPath)
          : { type: "literal", value: key },
        value: describe(item, keyPath)
      });
    }
    return { type: "object", entries };
  }
}

export function rebuildStructuredValue(template, resolved) {
  switch (template.type) {
    case "slot":
      return resolved[template.index];
    case "literal":
      return template.value;
    case "array":
      return template.items.map(entry => rebuildStructuredValue(entry, resolved));
    case "object": {
      const output = {};
      for (const entry of template.entries) {
        defineStructuredProperty(
          output,
          rebuildStructuredValue(entry.key, resolved),
          rebuildStructuredValue(entry.value, resolved)
        );
      }
      return output;
    }
    default:
      throw new TypeError("PrivacyAI encountered an invalid structured-value template.");
  }
}

export function structuredValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shouldProcessKey(policy, path, key) {
  if (typeof policy === "function") return policy({ path: [...path], key }) !== false;
  return policy !== false;
}

function defineStructuredProperty(target, key, value) {
  if (Object.hasOwn(target, key)) {
    const error = new Error(
      "PrivacyAI blocked a structured value because key transformation caused a collision."
    );
    error.code = "PRIVACYAI_TRANSFORM_KEY_COLLISION";
    throw error;
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}
