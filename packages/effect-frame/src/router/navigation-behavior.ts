/**
 * What a navigation does to the viewport and to keyboard focus once the
 * destination's shell is in the document (#31). A value, not a flag: the
 * router has one default (`mount({ landing })`, `Restore` when absent) and
 * a leaf may override it (`Route.leaf(segment, view, { landing })`). A
 * layout cannot: a navigation has one destination, and only its leaf knows
 * whether it is a page or a panel. See `docs/design/navigation-behavior.md`.
 */

/**
 * The default. A push or replace scrolls to the fragment the URL names, or
 * to the top. A Back or Forward restores the position the browser saved for
 * that entry. When the destination's leaf entered, focus moves to it: to
 * the first element with `autofocus` inside it, or else to its root. A
 * stayed leaf keeps focus.
 */
export interface Restore {
  readonly _tag: "Restore";
}

/**
 * Leave both alone: the viewport and the focused element stay where they
 * are. For a tab strip or a filter that navigates only to keep the URL
 * shareable.
 */
export interface Preserve {
  readonly _tag: "Preserve";
}

export type NavigationBehavior = Restore | Preserve;

export const Restore: Restore = { _tag: "Restore" };

export const Preserve: Preserve = { _tag: "Preserve" };
