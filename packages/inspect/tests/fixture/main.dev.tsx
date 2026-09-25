/**
 * The development entry. Inspection is enabled only when the page config
 * names a gateway; otherwise this entry creates no connection either.
 */
import { Duration, Effect, Option, Schedule, Stream } from "effect";
import { attachGateway, defaultOpenTimeout } from "effect-frame/inspection";
import { start } from "./app.js";

/** The proofs wait on redials, so they start at 50 ms and stop doubling at 400 ms. */
const fastRetry = Schedule.exponential("50 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(400))),
  ),
);

start((config, status) =>
  Option.match(Option.fromNullishOr(config.gateway), {
    onNone: () => Effect.void,
    onSome: (gateway) =>
      attachGateway({
        url: gateway.url,
        token: gateway.token,
        retry: fastRetry,
        openTimeout: defaultOpenTimeout,
      }).pipe(
        Effect.flatMap((attachment) =>
          Effect.forkScoped(
            Stream.runForEach(attachment.status, (next) =>
              Effect.sync(() => {
                status.push(next);
              }),
            ),
          ),
        ),
        Effect.asVoid,
        Effect.catchTag("InvalidAttachOptions", (error) =>
          Effect.logWarning(`inspection attach refused: ${error.detail}`),
        ),
      ),
  }),
);
