import type { Context } from "effect";
import { Duration, Effect, Match, Option, Schema } from "effect";
import type { Principal } from "../principal.js";
import { CurrentPrincipal } from "../principal.js";
import { freshCommandId } from "../command-id.js";
import type { Address, AnyContract } from "../contract.js";
import type { FormFields, FormIssue, FormIssues, FormMalformed, FormTree } from "../form.js";
import {
  FormContext,
  decodeKey,
  frameworkFields,
  fromBody,
  isReturnPath,
  issuesOf,
  last,
  strip,
  submitted,
  tree,
  without,
} from "../form.js";
import { membersOf } from "../generated.js";
import { ActorTransport } from "../transport.js";
import type { TransportCallError } from "../transport.js";
import { CommandId, Uncertain } from "../vocabulary.js";
import type { DerivePrincipal, WebHandler } from "./server.js";

/**
 * `POST {base}/form`: the plain-form route (#21 §2). Its client is the
 * browser, its body is `application/x-www-form-urlencoded`, its success is
 * a 303, and its failure is the page the user asked for, drawn again with
 * the issues. It reaches `transport.call` exactly as `/call` does, with the
 * same command id and the same JSON payload, so there is no second send
 * path and no second idempotency rule.
 *
 * The 303 follows the commit, not the admission: the commit is readable
 * before the 303, so a `$return` page rendered on request draws it (#21 §5). A commit that does not
 * come within `commitWithin` answers 504 with the same command id, because
 * the command may be in the mailbox (#21 §2).
 */
export interface FormPostOptions<E, R, P = never> {
  /** The contracts a form may post to, found by `$contract`. */
  readonly contracts: ReadonlyArray<AnyContract>;
  /**
   * Derives who is posting, exactly as the JSON handler does (#20 §5): the
   * same cookie, the same derivation, the same policy check at
   * `transport.call`. There is no second authorization path.
   */
  readonly principal: DerivePrincipal<P>;
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
   * with the same command id. Ten seconds when omitted.
   */
  readonly commitWithin?: Duration.Input;
}

/** How long a post waits for its commit when the app names no limit. */
const defaultCommitWithin = Duration.seconds(10);

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
 * Read the body. Only urlencoded: multipart is not specified (#21 §6), so
 * it is refused rather than parsed by a rule nobody wrote down.
 */
const readBody = (request: Request): Effect.Effect<FormFields, Reply> => {
  const header = Option.getOrElse(
    Option.fromNullishOr(request.headers.get("content-type")),
    () => "",
  );
  const [media = "", ...parameters] = header.split(";").map((part) => part.trim().toLowerCase());
  if (media === "multipart/form-data") {
    return Effect.fail(
      refused(415, "multipart/form-data is not accepted: file uploads are not specified (#21 §6)"),
    );
  }
  if (media !== urlencoded) {
    return Effect.fail(refused(415, `expected ${urlencoded}`));
  }
  if (!parameters.every(isUtf8Parameter)) {
    return Effect.fail(refused(415, `expected ${urlencoded} in UTF-8`));
  }
  return Effect.map(
    Effect.tryPromise({ try: () => request.text(), catch: (cause) => refused(400, String(cause)) }),
    fromBody,
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
 * way to reach this. Any other refused decode mints a fresh id (#21 §4).
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
 * a clock is minted at render as a generated field (#32), never at decode.
 * The route decodes a second time and compares, and refuses the post
 * before any send when the two payloads differ. The cost is one decode and
 * one encode of a small body per plain post.
 */
const encodeOnce = (
  posted: Posted,
  nested: { readonly [key: string]: FormTree },
  payload: string,
): Effect.Effect<void, Reply> =>
  Effect.gen(function* () {
    const again = yield* Effect.orDie(
      Effect.flatMap(
        Schema.decodeUnknownEffect(posted.contract.raw.message)(nested),
        Schema.encodeUnknownEffect(posted.contract.message),
      ),
    );
    if (again === payload) {
      return;
    }
    yield* Effect.logError(
      `HttpServer.form: ${posted.contract.name} does not decode repeatably; the same fields gave two payloads. Mint the value at render with Generated, not at decode.`,
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
 * the caller is anonymous and the app named a login route (#20 §5).
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
  switch (error._tag) {
    case "Unreachable":
    case "Uncertain":
      return page(posted, 504, issues, "same");
    case "CommandConflict":
    case "ContractMismatch":
      return page(posted, 409, issues, "fresh");
    case "Unauthorized":
      return unauthorized(posted, issues, principal, login);
    case "UnknownContract":
      return page(posted, 404, issues, "fresh");
    case "ActorStopped":
      return page(posted, 503, issues, "fresh");
    // The same bytes are refused every time: the page draws the reason, and
    // a corrected post is a new form with a new id.
    case "Refused":
      return page(posted, 422, issues, "fresh");
  }
};

const malformed = (error: FormMalformed): Reply => refused(400, error.reason);

/** Decode, send, answer. Every branch ends in a reply; nothing fails. */
const post = (
  request: Request,
  contracts: ReadonlyMap<string, AnyContract>,
  login: Option.Option<string>,
  commitWithin: Duration.Input,
): Effect.Effect<Reply, never, ActorTransport> =>
  Effect.gen(function* () {
    const fields = yield* readBody(request);
    const posted = yield* readFramework(fields, contracts);
    const wireKey = yield* Effect.mapError(decodeKey(posted.contract, posted.key), malformed);
    const nested = yield* Effect.mapError(tree(strip(fields)), malformed);
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(posted.contract.raw.message)(nested),
    );
    if (decoded._tag === "Failure") {
      return yield* page(posted, 200, issuesOf(decoded.failure), decodeRetry(posted));
    }
    const payload = yield* Effect.orDie(
      Schema.encodeUnknownEffect(posted.contract.message)(decoded.success),
    );
    yield* encodeOnce(posted, nested, payload);
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
 * The form route's handler. Mount it at `{base}/form`, beside the JSON
 * handler at `{base}`. `render` runs with the context this Effect was
 * built in, plus `FormContext` and the posting principal.
 */
export const form = <E, R, P = never>(
  options: FormPostOptions<E, R, P>,
): Effect.Effect<WebHandler, never, ActorTransport | P | Exclude<R, FormContext>> =>
  Effect.gen(function* () {
    const context: Context.Context<ActorTransport | Exclude<R, FormContext>> =
      yield* Effect.context<ActorTransport | Exclude<R, FormContext>>();
    const derivation: Context.Context<P> = yield* Effect.context<P>();
    const contracts = new Map(options.contracts.map((contract) => [contract.name, contract]));
    const commitWithin = Option.getOrElse(
      Option.fromNullishOr(options.commitWithin),
      () => defaultCommitWithin,
    );
    const draw = (path: string, status: number, issues: FormIssues): Effect.Effect<Response> =>
      options.render(path).pipe(
        Effect.provideService(FormContext, issues),
        Effect.map((body) => html(status, body)),
        Effect.catch((error) =>
          Effect.as(
            Effect.logError("HttpServer.form: the page could not be drawn", error),
            html(500, "the page could not be drawn"),
          ),
        ),
        Effect.provideContext(context),
      );
    const handler: WebHandler = (request) => {
      if (request.method !== "POST") {
        return Effect.succeed(new Response("method not allowed", { status: 405 }));
      }
      // The route is the boundary: the derivation runs with the context `form` was built in.
      const derived = Effect.provideContext(options.principal(request), derivation);
      const answer = post(request, contracts, options.login, commitWithin).pipe(
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
      // A post is one request: it runs under the one principal it read.
      return Effect.flatMap(
        Effect.flatMap(derived, (who) => who.get),
        (principal) => Effect.provideService(answer, CurrentPrincipal, principal),
      );
    };
    return handler;
  });
