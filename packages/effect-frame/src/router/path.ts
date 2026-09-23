import { Option, Schema } from "effect";
import type { Part, PathRecord } from "./codec.js";

/**
 * Path matching shared by the router and nested branches. Internal: the
 * router index does not export this module, so nothing here is part of the
 * public `Route` namespace.
 */

/**
 * A value a route printer cannot write so that it parses back. The route
 * domain is what a URL can carry both ways (see `docs/design/route-data.md`):
 *
 * - a path segment, a param's or each item of a tail's, is well-formed text
 *   that is not empty and not `.` or `..`. The URL parser drops an empty
 *   segment and removes a dot segment, so either would print a URL that
 *   matches another route or none;
 * - a search key or value is well-formed text. A URL writer replaces a lone
 *   surrogate with U+FFFD, so it would read back as another value.
 *
 * Parse never yields a value outside the domain. Print refuses one with this
 * defect instead of writing a wrong URL. `name` is the param or search key;
 * the value itself is not in the message.
 */
export class UrlValueRejected extends Schema.TaggedError<UrlValueRejected>()("UrlValueRejected", {
  name: Schema.String,
  reason: Schema.Literals(["empty segment", "dot segment", "lone surrogate"]),
}) {}

type OutOfDomain = UrlValueRejected["reason"];

const loneSurrogate = /\p{Cs}/u;

/** Why a decoded text is not URL text. None: it is well-formed. */
export const textFault = (value: string): Option.Option<OutOfDomain> => {
  if (loneSurrogate.test(value)) {
    return Option.some("lone surrogate");
  }
  return Option.none();
};

/** Why a decoded path segment cannot round-trip. None: it can. */
export const segmentFault = (value: string): Option.Option<OutOfDomain> => {
  if (value === "") {
    return Option.some("empty segment");
  }
  if (value === "." || value === "..") {
    return Option.some("dot segment");
  }
  return textFault(value);
};

/** Refuse a value outside the domain, as a defect. */
export const refuseOutOfDomain = (name: string, fault: Option.Option<OutOfDomain>): void => {
  if (Option.isSome(fault)) {
    Option.getOrThrowWith(Option.none(), () =>
      UrlValueRejected.make({ name, reason: fault.value }),
    );
  }
};

/** The non-empty pathname segments, still percent-encoded. */
export const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment !== "");

/**
 * One segment, percent-decoded. None when it does not decode, or when it
 * decodes to a value outside the route domain (`UrlValueRejected`): parse
 * refuses what print refuses, so both agree.
 */
const decodeSegment = (segment: string): Option.Option<string> =>
  Option.filter(decodeText(segment), (decoded) => Option.isNone(segmentFault(decoded)));

const decodeText = Option.liftThrowable(decodeURIComponent);

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
