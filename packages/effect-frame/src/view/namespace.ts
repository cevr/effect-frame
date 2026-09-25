/**
 * The `View` namespace of `effect-frame/view`: every function and Effect a
 * view calls, in lowercase, and the `View` type it names. The types the
 * functions take and return are flat exports of `effect-frame/view`, so each
 * name has one path.
 */
export { attach, bind, event, submit, type View } from "./view.js";
export { form } from "./form.js";
export { list } from "./control.js";
export { attempt } from "./attempt.js";
export { LazyImportFailed, lazy } from "./lazy.js";
