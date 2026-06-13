export default {
  readFileSync: () => { throw new Error("Not implemented in browser") },
  existsSync: () => false
};
export const join = () => "";
export const dirname = () => "";
export const isAbsolute = () => false;

export const readFileSync = () => { throw new Error("Not implemented in browser") };
export const existsSync = () => false;
