import type { RenderContext, Renderable } from "@opentui/core";
import {
  BaseRenderable,
  BoxRenderable,
  InputRenderable,
  TextNodeRenderable,
  TextRenderable,
} from "@opentui/core";
import type { Effect, Scope } from "effect";
import { Option } from "effect";
import type { Cleanup, EventHandler, Host, PropertyValue, StaticProps } from "../host.js";
import type { PortalHost, PortalTarget } from "../portal-target.js";
import { makeTarget } from "../portal-target.js";
import type { Attached } from "../view.js";
import { attach as attachNode } from "../view.js";

/**
 * The terminal host. Tags are `box`, `text`, and `input`.
 *
 * A terminal has no text node in the DOM sense: text lives inside a
 * `TextRenderable` as `TextNodeRenderable` runs. Making `createText` build one
 * of those keeps one rule for every slot, so `For` and `Show` move a line of
 * text the same way they move a box.
 */

export type TuiNode = BaseRenderable;

/** A behaviour for a terminal renderable, run once it is in the tree. */
export const attach = (
  run: (node: TuiNode) => Effect.Effect<unknown, never, Scope.Scope>,
): Attached<TuiNode> => attachNode<TuiNode>(run);

/**
 * The target a `<Portal>` draws its children under: a renderable outside
 * the view's own subtree, such as the renderer's root. Only a terminal host
 * draws into it.
 */
export const target = (renderable: TuiNode): PortalTarget => makeTarget("OpenTUI", renderable);

const portal: PortalHost<TuiNode> = {
  name: "OpenTUI",
  resolve: (made) => {
    if (made.host === "OpenTUI" && made.node instanceof BaseRenderable) {
      return Option.some(made.node);
    }
    return Option.none();
  },
};

const create = (context: RenderContext, tag: string, options: StaticProps): Renderable => {
  if (tag === "box") {
    return new BoxRenderable(context, options);
  }
  if (tag === "input") {
    return new InputRenderable(context, options);
  }
  return new TextRenderable(context, options);
};

/** A node that holds text: either a text run or the renderable around it. */
const asTextRun = (node: TuiNode): Option.Option<TextNodeRenderable> => {
  if (node instanceof TextNodeRenderable) {
    return Option.some(node);
  }
  return Option.none();
};

const asTextBox = (node: TuiNode): Option.Option<TextRenderable> => {
  if (node instanceof TextRenderable) {
    return Option.some(node);
  }
  return Option.none();
};

const setText = (node: TuiNode, text: string): void => {
  Option.match(asTextRun(node), {
    onSome: (run) => {
      run.children = [text];
      run.requestRender();
    },
    onNone: () =>
      Option.match(asTextBox(node), {
        onNone: () => {},
        onSome: (box) => {
          box.content = text;
        },
      }),
  });
};

/**
 * Every renderable is an event emitter. OpenTUI hands a plain string to
 * `input` and `change`, and nothing to the rest, so one listener shape serves
 * every tag.
 */
interface Emitter {
  readonly on: (name: string, listener: (payload: string) => void) => unknown;
  readonly off: (name: string, listener: (payload: string) => void) => unknown;
}

/** A parent that accepts children, whatever kind of node it is. */
interface Parent {
  readonly add: (child: TuiNode) => unknown;
  readonly insertBefore: (child: TuiNode, anchor: TuiNode) => unknown;
  readonly remove: (child: TuiNode) => unknown;
}

const asParent = (node: TuiNode): Parent => node;

const asEmitter = (node: TuiNode): Emitter => node;

export const make = (context: RenderContext): Host<TuiNode> => ({
  createElement: (tag, staticProps) => create(context, tag, staticProps),
  createText: (text) => TextNodeRenderable.fromString(text),
  createDetachedElement: (tag, staticProps) => create(context, tag, staticProps),
  createDetachedText: (text) => TextNodeRenderable.fromString(text),
  setProperty: (node, name, value: PropertyValue) => {
    if (name === "content") {
      setText(node, String(value));
      return;
    }
    Reflect.set(node, name, value);
  },
  insert: (parent, node, anchor) => {
    const container = asParent(parent);
    Option.match(anchor, {
      onNone: () => container.add(node),
      onSome: (before) => container.insertBefore(node, before),
    });
  },
  remove: (parent, node) => {
    if (node.parent === parent) {
      asParent(parent).remove(node);
    }
  },
  setText,
  addEventListener: (node, name, handler: EventHandler): Cleanup => {
    const emitter = asEmitter(node);
    const listener = (payload: string): void =>
      handler({ value: String(payload), preventDefault: () => {}, form: Option.none() });
    emitter.on(name, listener);
    return () => void emitter.off(name, listener);
  },
  attach: (node, run) => run(node),
  portal,
});
