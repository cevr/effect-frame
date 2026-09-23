import { Route } from "effect-frame/router";
import { ListView } from "./page.js";
import { home, index, list, lists, print, scratch, shell } from "./segments.js";
import { Effect } from "effect";
import { BareShell, IndexView, ListsView, ScratchView, Shell } from "./views.js";

/**
 * The Notes route tree (#18, #22, #25 §1). One set of segments and views,
 * mounted by four constructors. A constructor is the rendering mode, so
 * `/lists/:list` and `/lists/:list/print` share their segments, their data
 * and `ListView`, and differ only in the constructor that mounts them.
 */

/** The list page's branch: the shell, the lists layout, and one list. */
export const listBranch = Route.layout(
  shell,
  [Route.layout(lists, [Route.leaf(list, ListView)], ListsView)],
  Shell,
);

/** `/lists`: the server resolves the list names before it draws. */
export const Lists = Route.ssr(
  "lists",
  Route.layout(shell, [Route.layout(lists, [Route.leaf(index, IndexView)], ListsView)], Shell),
);

/** `/lists/:list`: the shell first, then the counts as they settle. */
export const List = Route.streamed("list", listBranch);

/** `/lists/:list/print`: one document once every read settled. */
export const Print = Route.awaitAll(
  "print",
  Route.layout(shell, [Route.layout(lists, [Route.leaf(print, ListView)], ListsView)], Shell),
);

/**
 * `/scratch`: the server writes an empty mount element; the client draws.
 * It reads nothing, so its shell has no `Loading` to wait on.
 */
export const Scratch = Route.client(
  "scratch",
  Route.layout(shell, [Route.leaf(scratch, ScratchView)], BareShell),
);

/** `/`: a redirect, answered before anything draws. */
export const Home = Route.ssr(
  "home",
  Route.leaf(home, () => Effect.succeed(<p id="moved">moved to the lists</p>)),
);

export const routes = [Home, Lists, List, Print, Scratch];
