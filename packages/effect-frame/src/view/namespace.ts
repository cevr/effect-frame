/**
 * The `View` namespace of `effect-frame/view`: every function and Effect a
 * view calls, in lowercase, the readiness services, and the `View` type it
 * names. The types the functions take and return are flat exports of
 * `effect-frame/view`, so each name has one path.
 *
 * The kind rule: a flat PascalCase value of `effect-frame/view` is a JSX tag
 * (`For`, `Show`, `Match`, `Portal`, `Await`) or a namespace (`View`, `Dom`,
 * `Html`, `Remote`). An Effect is never a tag, so `View.loading(...)` is
 * yielded and `<For>` is written in JSX.
 */
export { attach, bind, event, submit, type View } from "./view.js";
export { form } from "./form.js";
export { keyed, list, match, show } from "./control.js";
export { attempt } from "./attempt.js";
export { LazyImportFailed, lazy } from "./lazy.js";
export { flush, mount } from "./runtime.js";
export {
  ErroredScope,
  LoadingScope,
  errored,
  loading,
  orErrored,
  ready,
  readyWithStale,
} from "./readiness.js";
