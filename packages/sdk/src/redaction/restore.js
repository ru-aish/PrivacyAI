export function restore(text, sessionMap) {
  let restored = text;
  const replacements = Object.entries(sessionMap).sort(
    ([left], [right]) => right.length - left.length
  );

  for (const [dummy, value] of replacements) {
    restored = restored.split(dummy).join(value);
  }

  return restored;
}
