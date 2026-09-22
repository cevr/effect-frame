/* oxlint-disable effect/noGlobals -- the development entry reports attachment status to the page. */
/**
 * The development entry. Inspection is enabled only when the page config
 * names a gateway; otherwise this entry creates no connection either.
 */
import { Effect, Option } from "effect";
import { attach } from "../../src/attach.js";
import { start } from "./app.js";

start((config, status) =>
  Option.match(Option.fromNullishOr(config.gateway), {
    onNone: () => Effect.void,
    onSome: (gateway) =>
      attach({
        url: gateway.url,
        token: gateway.token,
        initialRetryMillis: 50,
        maxRetryMillis: 400,
        onStatus: (next) => {
          status.push(next);
        },
      }).pipe(
        Effect.catchTag("InvalidAttachOptions", (error) =>
          Effect.logWarning(`inspection attach refused: ${error.detail}`),
        ),
      ),
  }),
);
