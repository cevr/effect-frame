import type { BoxOptions, InputRenderableOptions, TextOptions } from "@opentui/core";
import type { Attr, Children, On, VoidElementHoldsNoChildren } from "../intrinsics.js";
import type { Node } from "../jsx-runtime.js";
import type { Attached } from "../view.js";
import type { TuiNode } from "./opentui.js";

/**
 * The terminal's JSX runtime. The functions are the one runtime every host
 * shares; only the tags differ. A file that draws a terminal names this
 * runtime in a block comment at its top, `@jsxImportSource
 * effect-frame/view/opentui`, so the host a file draws for is written where
 * the file is, and an HTML tag in it does not compile.
 *
 * The tags are `box`, `text`, and `input`, the renderables the OpenTUI host
 * builds. A prop is one of the renderable's own options, written once or
 * bound with `View.bind`; an option OpenTUI takes as a callback is not a
 * prop, because the host listens for events by name (`onInput` is `input`).
 */

export { Fragment, jsx, jsxDEV, jsxs } from "../jsx-runtime.js";

/** A renderable's options that are values, each written once or bound. */
export type Settable<Options> = {
  readonly [
    K in keyof Options as NonNullable<Options[K]> extends (...args: never) => unknown ? never : K
  ]?: Attr<NonNullable<Options[K]>>;
};

/** What every terminal tag takes beside its options. */
export interface TuiProps {
  /** Behaviours run with the renderable once it is in the tree (`attach` from `effect-frame/view/opentui`). */
  readonly attach?: Attached<TuiNode> | ReadonlyArray<Attached<TuiNode>>;
}

export interface BoxProps extends Settable<BoxOptions>, TuiProps {
  readonly children?: Children;
}

export interface TextProps extends Settable<TextOptions>, TuiProps {
  readonly children?: Children;
}

/** A one-line input. It emits `input` as the text changes, `change`, and `enter`. */
export interface InputProps extends Settable<InputRenderableOptions>, TuiProps {
  readonly onInput?: On;
  readonly onChange?: On;
  readonly onEnter?: On;
  readonly children?: VoidElementHoldsNoChildren;
}

/** Every terminal tag a view may write. */
export interface TuiElements {
  readonly box: BoxProps;
  readonly text: TextProps;
  readonly input: InputProps;
}

export declare namespace JSX {
  /** What every JSX expression evaluates to. */
  type Element = Node;
  /** A terminal tag this map lists, or any function from its own props to a node. */
  type ElementType = keyof IntrinsicElements | ((props: never) => Node);
  interface ElementChildrenAttribute {
    readonly children: Children;
  }
  /** The terminal tags and their props. */
  interface IntrinsicElements extends TuiElements {}
}
