import type { Html } from "effect-frame/view";

/**
 * The document around every Blog page. The build and the server write the
 * same one, so a page the build wrote and the page the server renders when
 * the file is missing are the same bytes but for what was read when
 * (#23 §5.1). The build writes `Prerender.clientScript` as the bootstrap;
 * the server writes the same tag.
 */
export const blogDocument: Omit<Html.Document, "bootstrap"> = {
  head: '<!doctype html><html><head><meta charset="utf-8"><title>Blog</title></head><body><main id="app">',
  tail: "</main>",
  end: "</body></html>",
};
