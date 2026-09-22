/** The production entry: no inspection module is imported. */
import { Effect } from "effect";
import { start } from "./app.js";

start(() => Effect.void);
