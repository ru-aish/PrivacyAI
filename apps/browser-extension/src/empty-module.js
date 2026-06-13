const notAvailable = () => {
  throw new Error("Node built-ins are not available in the browser extension");
};

const browserPath = {
  join: (...parts) => parts.filter(Boolean).join("/"),
  dirname: (value) => value.replace(/[/\\][^/\\]*$/, "") || ".",
  isAbsolute: (value) => value.startsWith("/")
};

export default {
  readFileSync: notAvailable,
  existsSync: () => false,
  ...browserPath
};

export const readFileSync = notAvailable;
export const existsSync = () => false;
export const join = browserPath.join;
export const dirname = browserPath.dirname;
export const isAbsolute = browserPath.isAbsolute;