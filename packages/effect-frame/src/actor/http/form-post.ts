import type { Context, Duration } from "effect";
import { Effect, Match, Option, Schema } from "effect";
import type { Principal } from "../principal.js";
import { CurrentPrincipal } from "../principal.js";
import { freshCommandId } from "../command-id.js";
import type { Address, AnyContract } from "../contract.js";
import type { FormFields, FormIssue, FormIssues, FormMalformed } from "../form.js";
import {
  FormContext,
  decode,
  decodeKey,
  frameworkFields,
  fromBody,
  isReturnPath,
  issuesOf,
  last,
  submitted,
  without,
} from "../form.js";
import { membersOf } from "../generated.js";
import { ActorTransport } from "../transport.js";
import type { TransportCallError } from "../transport.js";
import { CommandId, Uncertain } from "../vocabulary.js";
import { readText } from "./body.js";

/**
 * `POST {prefix}/form`: the plain-form route of `HttpServer.make`. Its client
 * is the browser, its body is `application/x-www-form-urlencoded`, its
 * success is a 303, and its failure is the page the user asked for, drawn
 * again with the issues. It reaches `transport.call` exactly as `/call`
 * does, with the same command id, the same JSON payload, and the same
 * principal, so there is no second send path, no second idempotency rule,
 * and no second authorization path.
 *
 * The 303 follows the commit, not the admission: the commit is readable
 * before the 303, so a `$return` page rendered on request draws it. A commit that does not
 * come within `commitWithin` answers 504 with the same command id, because
 * the command may be in the mailbox.
 */
export interface FormRoute<E, R> {
  /** The contracts a form may post to, found by `$contract`. */
  readonly contracts: ReadonlyArray<AnyContract>;
  /**
   * Where an anonymous caller goes when a policy refuses the post: a
   * root-relative path, answered as 303 with the form's `$return` as the
   * `next` search parameter. Signing in could change that answer, so the
   * caller has somewhere to go. A signed-in caller who is refused gets 403
   * and the page: signing in again changes nothing. `Option.none()` answers
   * 403 to both, for an app with no sign-in route.
   */
  readonly login: Option.Option<string>;
  /**
   * Draw the page at `path` again. `FormContext` is in context: the view
   * reads the issues, the submitted values, and the id the form carries.
   */
  readonly render: (path: string) => Effect.Effect<string, E, R>;
  /**
   * How long a post waits for its command to commit before it answers 504
   * with the same command id. `HttpServer.defaultCommitWithin` is ten seconds.
   */
  readonly commitWithin: Duration.Input;
}

/** Where a refused anonymous post goes: the login path, with `next` set to `$return`. */
const loginLocation = (login: string, returnTo: string): string => {
  const base = "http://effect-frame.invalid";
  const url = new URL(login, base);
  url.searchParams.set("next", returnTo);
  return `${url.pathname}${url.search}`;
};

/** A plain-form reply: a redirect, a drawn page, or a plain refusal. */
type Reply =
  | { readonly _tag: "SeeOther"; readonly location: string }
  | {
      readonly _tag: "Page";
      readonly path: string;
      readonly status: number;
      readonly issues: FormIssues;
    }
  | { readonly _tag: "Refused"; readonly status: number; readonly reason: string };

/** Everything the framework fields named, decoded. */
interface Posted {
  readonly fields: FormFields;
  readonly contract: AnyContract;
  readonly commandId: CommandId;
  readonly key: string;
  readonly form: string;
  readonly returnTo: string;
  /** The form was redrawn after a lost reply: its id may be in a mailbox. */
  readonly uncertain: boolean;
}

const refused = (status: number, reason: string): Reply => ({ _tag: "Refused", status, reason });

const decodeCommandId = Schema.decodeUnknownOption(CommandId);

const required = (fields: FormFields, name: string): Effect.Effect<string, Reply> =>
  Option.match(last(fields, name), {
    onNone: () => Effect.fail(refused(400, `missing ${name}`)),
    onSome: Effect.succeed,
  });

const urlencoded = "application/x-www-form-urlencoded";

/**
 * A media type parameter the body reader honours. The body is read as
 * UTF-8, so a `charset` that names anything else is refused rather than
 * decoded wrongly. Other parameters are ignored. Input is lower case.
 */
const isUtf8Parameter = (parameter: string): boolean => {
  const [name = "", value = ""] = parameter.split("=").map((part) => part.trim());
  if (name !== "charset") {
    return true;
  }
  const charset = value.replace(/^"(.*)"$/, "$1");
  return charset === "utf-8" || charset === "utf8";
};

/**
 * Read the body. Only urlencoded: multipart is not specified, so
 * it is refused rather than parsed by a rule nobody wrote down.
 */
const readBody = (request: Request, maxBodyBytes: number): Effect.Effect<FormFields, Reply> => {
  const header = Option.getOrElse(
    Option.fromNullishOr(request.headers.get("content-type")),
    () => "",
  );
  const [media = "", ...parameters] = header.split(";").map((part) => part.trim().toLowerCase());
  if (media === "multipart/form-data") {
    return Effect.fail(
      refused(415, "multipart/form-data is not accepted: file uploads are not specified"),
    );
  }
  if (media !== urlencoded) {
    return Effect.fail(refused(415, `expected ${urlencoded}`));
  }
  if (!parameters.every(isUtf8Parameter)) {
    return Effect.fail(refused(415, `expected ${urlencoded} in UTF-8`));
  }
  return readText(request, maxBodyBytes).pipe(
    Effect.catchTags({
      BodyTooLarge: (error) => Effect.fail(refused(413, error.message)),
      BodyUnreadable: (error) => Effect.fail(refused(400, error.reason)),
    }),
    Effect.map(fromBody),
  );
};

/**
 * The framework fields, last write wins. `$return` is checked before
 * anything else can act on the request: a reply the server cannot give
 * safely is a request it does not perform.
 */
const readFramework = (
  fields: FormFields,
  contracts: ReadonlyMap<string, AnyContract>,
): Effect.Effect<Posted, Reply> =>
  Effect.gen(function* () {
    const returnTo = yield* required(fields, frameworkFields.returnTo);
    if (!isReturnPath(returnTo)) {
      return yield* Effect.fail(refused(400, "$return must be a root-relative path"));
    }
    const rawCommand = yield* required(fields, frameworkFields.command);
    const commandId = yield* Option.match(decodeCommandId(rawCommand), {
      onNone: () => Effect.fail(refused(400, "$command is not a command id")),
      onSome: Effect.succeed,
    });
    const name = yield* required(fields, frameworkFields.contract);
    const contract = yield* Option.match(Option.fromNullishOr(contracts.get(name)), {
      onNone: () => Effect.fail(refused(404, `unknown contract ${name}`)),
      onSome: Effect.succeed,
    });
    const version = yield* required(fields, frameworkFields.version);
    if (version !== String(contract.version)) {
      return yield* Effect.fail(
        refused(409, `${name} is version ${String(contract.version)}; the form posted ${version}`),
      );
    }
    const key = yield* required(fields, frameworkFields.key);
    const form = yield* required(fields, frameworkFields.form);
    const uncertain = Option.isSome(last(fields, frameworkFields.uncertain));
    return { fields, contract, commandId, key, form, returnTo, uncertain };
  });

/** The generated fields of every member: dropped from the values a fresh id redraws. */
const generatedNames = (contract: AnyContract): ReadonlyArray<string> =>
  membersOf(contract.raw.message.ast).flatMap((member) => member.generated.map(([name]) => name));

/**
 * The page again, with issues. A fresh id when the command certainly did
 * not reach the mailbox, and then the generated values go with the old id.
 * The same id when it may have, and the generated values stay with it, so
 * a resubmit is byte-identical and hits the stored receipt.
 */
const page = (
  posted: Posted,
  status: number,
  issues: ReadonlyArray<FormIssue>,
  retry: "fresh" | "same",
): Effect.Effect<Reply> =>
  Effect.gen(function* () {
    const values = submitted(posted.fields);
    const base = {
      contract: posted.contract.name,
      key: posted.key,
      form: posted.form,
      issues,
    };
    if (retry === "same") {
      return {
        _tag: "Page",
        path: posted.returnTo,
        status,
        issues: { ...base, commandId: posted.commandId, outcome: "Uncertain", submitted: values },
      } satisfies Reply;
    }
    const commandId = yield* freshCommandId;
    return {
      _tag: "Page",
      path: posted.returnTo,
      status,
      issues: {
        ...base,
        commandId,
        outcome: "Refused",
        submitted: without(values, generatedNames(posted.contract)),
      },
    } satisfies Reply;
  });

/**
 * The id a message that does not decode redraws with. A post from a form
 * redrawn after a lost reply keeps its id: that id may be in a mailbox, and
 * a fresh one would let the corrected post apply the message a second time.
 * A redacted field is never written back, so a required one is the common
 * way to reach this. Any other refused decode mints a fresh id.
 */
const decodeRetry = (posted: Posted): "fresh" | "same" => {
  if (posted.uncertain) {
    return "same";
  }
  return "fresh";
};

/**
 * The route and the hydrated binding send the same command id, so they
 * must send the same bytes, or the store answers `CommandConflict`. That
 * holds only when the message codec is repeatable: the same fields decode
 * and encode to the same payload every time. A value that needs entropy or
 * a clock is minted at render as a generated field, never at decode.
 * The route decodes a second time and compares, and refuses the post
 * before any send when the two payloads differ. The cost is one decode and
 * one encode of a small body per plain post.
 */
const encodeOnce = (
  posted: Posted,
  fields: FormFields,
  payload: string,
): Effect.Effect<void, Reply> =>
  Effect.gen(function* () {
    const again = yield* Effect.orDie(
      Effect.flatMap(
        decode(posted.contract.raw.message)(fields),
        Schema.encodeUnknownEffect(posted.contract.message),
      ),
    );
    if (again === payload) {
      return;
    }
    yield* Effect.logError(
      `HttpServer.make: ${posted.contract.name} does not decode repeatably; the same fields gave two payloads. Mint the value at render with Generated, not at decode.`,
    );
    return yield* Effect.fail(
      refused(500, `${posted.contract.name}: the form message does not decode repeatably`),
    );
  });

/** The behavior's own words for a refusal; the tag for every other failure. */
const failureIssue = (error: TransportCallError): FormIssue => {
  if (error._tag === "Refused") {
    return { field: "", message: error.reason };
  }
  return { field: "", message: error._tag };
};

/**
 * A refusal redirects only when authenticating would change the answer:
 * the caller is anonymous and the app named a login route.
 */
const unauthorized = (
  posted: Posted,
  issues: ReadonlyArray<FormIssue>,
  principal: Principal,
  login: Option.Option<string>,
): Effect.Effect<Reply> =>
  Option.match(
    Option.filter(login, () => principal._tag === "Anonymous"),
    {
      onNone: () => page(posted, 403, issues, "fresh"),
      onSome: (path) =>
        Effect.succeed<Reply>({
          _tag: "SeeOther",
          location: loginLocation(path, posted.returnTo),
        }),
    },
  );

/** A send failure as the page it draws. Only a lost reply or a late commit keeps the id. */
const sendFailure = (
  posted: Posted,
  error: TransportCallError,
  principal: Principal,
  login: Option.Option<string>,
): Effect.Effect<Reply> => {
  const issues = [failureIssue(error)];
  return Match.valueTags(error, {
    Unreachable: () => page(posted, 504, issues, "same"),
    Uncertain: () => page(posted, 504, issues, "same"),
    CommandConflict: () => page(posted, 409, issues, "fresh"),
    ContractMismatch: () => page(posted, 409, issues, "fresh"),
    Unauthorized: () => unauthorized(posted, issues, principal, login),
    UnknownContract: () => page(posted, 404, issues, "fresh"),
    ActorStopped: () => page(posted, 503, issues, "fresh"),
    // The same bytes are refused every time: the page draws the reason, and
    // a corrected post is a new form with a new id.
    Refused: () => page(posted, 422, issues, "fresh"),
  });
};

const malformed = (error: FormMalformed): Reply => refused(400, error.reason);

/** Decode, send, answer. Every branch ends in a reply; nothing fails. */
const post = (
  request: Request,
  contracts: ReadonlyMap<string, AnyContract>,
  login: Option.Option<string>,
  commitWithin: Duration.Input,
  maxBodyBytes: number,
): Effect.Effect<Reply, never, ActorTransport> =>
  Effect.gen(function* () {
    const fields = yield* readBody(request, maxBodyBytes);
    const posted = yield* readFramework(fields, contracts);
    const wireKey = yield* Effect.mapError(decodeKey(posted.contract, posted.key), malformed);
    const decoded = yield* Effect.result(decode(posted.contract.raw.message)(fields));
    if (decoded._tag === "Failure") {
      const failure = decoded.failure;
      // A body that does not nest is refused before any page; one that
      // nests but does not decode redraws with its issues.
      if (failure._tag === "FormMalformed") {
        return yield* Effect.fail(malformed(failure));
      }
      return yield* page(posted, 200, issuesOf(failure), decodeRetry(posted));
    }
    const payload = yield* Effect.orDie(
      Schema.encodeUnknownEffect(posted.contract.message)(decoded.success),
    );
    yield* encodeOnce(posted, fields, payload);
    const address: Address = {
      contract: posted.contract.name,
      version: posted.contract.version,
      key: wireKey,
    };
    const transport = yield* ActorTransport;
    const principal = yield* CurrentPrincipal;
    // The browser reads `$return` next: answer once that read sees the commit.
    return yield* transport.call(address, posted.commandId, payload, commitWithin, []).pipe(
      // A remote transport starts its host's deadline only once the host is
      // reached, so the route bounds the whole call: no post waits unanswered.
      Effect.timeoutOrElse({
        duration: commitWithin,
        orElse: () => Effect.fail(Uncertain.make({ commandId: posted.commandId })),
      }),
      Effect.as<Reply>({ _tag: "SeeOther", location: posted.returnTo }),
      Effect.catch((error) => sendFailure(posted, error, principal, login)),
    );
  }).pipe(Effect.catch((reply) => Effect.succeed(reply)));

const html = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * The form route's handler, built once by `HttpServer.make`. It answers a
 * POST that already passed the server's method check, under the
 * `CurrentPrincipal` the server derived. `render` runs with the context
 * this Effect was built in, plus `FormContext` and the posting principal.
 */
export const formPost = <E, R>(
  options: FormRoute<E, R>,
  maxBodyBytes: number,
): Effect.Effect<
  (request: Request) => Effect.Effect<Response>,
  never,
  ActorTransport | Exclude<R, FormContext>
> =>
  Effect.gen(function* () {
    const context: Context.Context<ActorTransport | Exclude<R, FormContext>> =
      yield* Effect.context<ActorTransport | Exclude<R, FormContext>>();
    const contracts = new Map(options.contracts.map((contract) => [contract.name, contract]));
    const draw = (path: string, status: number, issues: FormIssues): Effect.Effect<Response> =>
      options.render(path).pipe(
        Effect.provideService(FormContext, issues),
        Effect.map((body) => html(status, body)),
        Effect.catch((error) =>
          Effect.as(
            Effect.logError("HttpServer.make: the form's page could not be drawn", error),
            html(500, "the page could not be drawn"),
          ),
        ),
        Effect.provideContext(context),
      );
    return (request: Request): Effect.Effect<Response> =>
      post(request, contracts, options.login, options.commitWithin, maxBodyBytes).pipe(
        Effect.provideContext(context),
        Effect.flatMap(
          Match.type<Reply>().pipe(
            Match.tagsExhaustive({
              SeeOther: (reply) =>
                Effect.succeed(
                  new Response("", { status: 303, headers: { location: reply.location } }),
                ),
              Refused: (reply) =>
                Effect.succeed(new Response(reply.reason, { status: reply.status })),
              Page: (reply) => draw(reply.path, reply.status, reply.issues),
            }),
          ),
        ),
      );
  });
