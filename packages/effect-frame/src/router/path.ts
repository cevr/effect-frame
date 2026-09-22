import { Option } from "effect";
import type { Part, PathRecord } from "./route.js";

/**
 * Path matching shared by the router and nested branches. Internal: the
 * router index does not export this module, so nothing here is part of the
 * public `Route` namespace.
 */

/** The non-empty pathname segments, still percent-encoded. */
export const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment !== "");

const decodeSegment = Option.liftThrowable(decodeURIComponent);

/** A prefix match: the record the parts decoded and the next unread segment. */
export interface PrefixMatch {
  readonly record: PathRecord;
  readonly next: number;
}

/**
 * Match parts against the segments that start at `start`. Every segment is
 * percent-decoded first. A tail takes every remaining segment. The match
 * need not reach the end: a nested segment leaves the rest to its children.
 */
export const matchPrefix = (
  parts: ReadonlyArray<Part>,
  segments: ReadonlyArray<string>,
  start: number,
): Option.Option<PrefixMatch> => {
  const record: Record<string, string | ReadonlyArray<string>> = {};
  let index = start;
  for (const part of parts) {
    if (part._tag === "Tail") {
      const rest = Option.all(segments.slice(index).map(decodeSegment));
      if (Option.isNone(rest)) {
        return Option.none();
      }
      record[part.name] = rest.value;
      index = segments.length;
      continue;
    }
    const segment = Option.flatMap(Option.fromNullishOr(segments[index]), decodeSegment);
    if (Option.isNone(segment)) {
      return Option.none();
    }
    index += 1;
    if (part._tag === "Literal") {
      if (segment.value !== part.text) {
        return Option.none();
      }
      continue;
    }
    record[part.name] = segment.value;
  }
  return Option.some({ record, next: index });
};
