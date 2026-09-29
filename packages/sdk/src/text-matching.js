export function foldCase(value) {
  return String(value).toLocaleLowerCase("en-US");
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
