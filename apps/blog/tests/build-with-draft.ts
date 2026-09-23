import { command } from "../src/prerender.server.js";
import { routes } from "../src/routes.js";
import { DraftRoute } from "./fixture-routes.js";

/**
 * The prerender command, run as a process, over a tree that also mounts
 * `DraftRoute`. `build.test.ts` runs it and reads its exit code: a route
 * that reads `Draft` must fail the build. Arguments: the posts directory,
 * then the output directory.
 */
// oxlint-disable-next-line effect/noGlobals -- a process reads its arguments here.
const [posts = "", out = ""] = process.argv.slice(2);
command({ routes: [...routes, DraftRoute], posts, out });
