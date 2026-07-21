const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export function defineProviderAdapter(specification) {
  if (!isPlainObject(specification)) {
    throw new TypeError("PrivacyAI provider adapter specification must be a plain object.");
  }

  const id = validName(specification.id, "id");
  const aliases = uniqueNames(specification.aliases || [], `${id} aliases`);
  if (aliases.includes(id)) {
    throw new TypeError(`PrivacyAI provider adapter ${id} aliases must exclude its id.`);
  }
  const displayName = String(specification.displayName || "").trim();
  if (!displayName) throw new TypeError(`PrivacyAI provider adapter ${id} requires a display name.`);
  for (const method of ["parseArguments", "resolveExecutable", "invoke"]) {
    if (typeof specification[method] !== "function") {
      throw new TypeError(`PrivacyAI provider adapter ${id} requires ${method}().`);
    }
  }

  const modes = normalizedModes(specification.modes, id);
  const defaultMode = validName(specification.defaultMode, `${id} default mode`);
  if (!Object.hasOwn(modes, defaultMode)) {
    throw new TypeError(`PrivacyAI provider adapter ${id} default mode is not declared.`);
  }

  return Object.freeze({
    id,
    aliases,
    displayName,
    executable: validName(specification.executable, `${id} executable`),
    defaultMode,
    modes,
    parseArguments: specification.parseArguments,
    resolveExecutable: specification.resolveExecutable,
    invoke: specification.invoke
  });
}

function normalizedModes(value, id) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new TypeError(`PrivacyAI provider adapter ${id} requires at least one mode.`);
  }
  const modes = {};
  for (const [rawName, rawMode] of Object.entries(value)) {
    const name = validName(rawName, `${id} mode`);
    if (!isPlainObject(rawMode)) {
      throw new TypeError(`PrivacyAI provider adapter ${id} mode ${name} must be a plain object.`);
    }
    modes[name] = Object.freeze({
      transport: rawMode.transport == null ? null : String(rawMode.transport),
      streaming: rawMode.streaming === true,
      hookSemantics: rawMode.hookSemantics == null ? null : String(rawMode.hookSemantics),
      fallback: rawMode.fallback === true,
      unsupportedCapabilities: uniqueNames(
        rawMode.unsupportedCapabilities || [],
        `${id} mode ${name} capabilities`
      )
    });
  }
  return Object.freeze(modes);
}

function uniqueNames(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`PrivacyAI provider adapter ${label} must be an array.`);
  const names = value.map(name => validName(name, label));
  if (new Set(names).size !== names.length) {
    throw new TypeError(`PrivacyAI provider adapter ${label} must be unique.`);
  }
  return Object.freeze(names);
}

function validName(value, label) {
  const normalized = String(value || "");
  if (!NAME_PATTERN.test(normalized)) {
    throw new TypeError(`PrivacyAI provider adapter ${label} is invalid.`);
  }
  return normalized;
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
