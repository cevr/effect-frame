/**
 * The comments around a readiness boundary in server HTML (#22). Every
 * boundary the server drew writes a pair: an open mark that says which
 * branch it drew, and a close mark. The HTML host writes them and
 * `Dom.hydrate` reads them, so a hydrating client finds each boundary by its
 * own pair, never by position: a boundary that drew nothing, or a boundary
 * inside a fallback, still has one.
 */

/** Every open mark starts with this. */
export const boundaryPrefix = "frame-boundary:";

/** The open mark of a boundary the server drew with its fallback. */
export const boundaryFallback = `${boundaryPrefix}fallback`;

/** The open mark of a boundary the server drew with its content. */
export const boundaryContent = `${boundaryPrefix}content`;

/** The close mark of every boundary. */
export const boundaryClose = "/frame-boundary";

/** The open mark for the branch a boundary shows. */
export const boundaryOpen = (shown: boolean): string => {
  if (shown) {
    return boundaryContent;
  }
  return boundaryFallback;
};

/**
 * The attribute on a server-driven view's container (#18, #22 §5). The
 * container's children belong to the op wire, not to the page's hydration:
 * `Dom.hydrate` claims the container and leaves its children for the wire,
 * which adopts them when it opens. See `docs/design/driven-route.md`.
 */
export const drivenContainer = "data-frame-driven";
