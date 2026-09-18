import { Option } from "effect";
import type { Cleanup, EventHandler, Host, PropertyValue, StaticProps } from "../host.js";

/**
 * The browser host. Property names reach `setProperty` exactly as JSX wrote
 * them: a name the element owns becomes a property, anything else becomes an
 * attribute, so `value` and `disabled` behave and `aria-label` still lands.
 */

/** A DOM node the runtime may parent, text, or listen to. */
export type DomNode = Node;

const asElement = (node: Node): Option.Option<Element> => {
  if (node instanceof Element) {
    return Option.some(node);
  }
  return Option.none();
};

const applyProperty = (node: Node, name: string, value: PropertyValue): void => {
  const element = asElement(node);
  if (Option.isNone(element)) {
    return;
  }
  const target = element.value;
  if (name in target) {
    Reflect.set(target, name, value);
    return;
  }
  if (value === false) {
    target.removeAttribute(name);
    return;
  }
  target.setAttribute(name, String(value));
};

/** An event target that carries the text a person typed. */
interface Valued {
  readonly value: string;
}

const valueOf = (event: Event): string => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const valued: Valued = target;
    return valued.value;
  }
  return "";
};

export const host: Host<DomNode> = {
  createElement: (tag: string, staticProps: StaticProps) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(staticProps)) {
      applyProperty(element, name, value);
    }
    return element;
  },
  createText: (text: string) => document.createTextNode(text),
  setProperty: applyProperty,
  insert: (parent, node, anchor) => {
    Option.match(anchor, {
      onNone: () => parent.appendChild(node),
      onSome: (before) => parent.insertBefore(node, before),
    });
  },
  remove: (parent, node) => {
    if (node.parentNode === parent) {
      parent.removeChild(node);
    }
  },
  setText: (node, text) => {
    node.textContent = text;
  },
  addEventListener: (node, name, handler: EventHandler): Cleanup => {
    const listener = (event: Event): void =>
      handler({ value: valueOf(event), preventDefault: () => event.preventDefault() });
    node.addEventListener(name, listener);
    return () => node.removeEventListener(name, listener);
  },
};
