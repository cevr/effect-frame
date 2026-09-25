import { registerDom } from "./dom-setup.js";

registerDom();

import { Dom } from "effect-frame/view";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

describe("Dom.root", () => {
  it.effect("finds the element the document wrote for its rootId", () =>
    Effect.gen(function* () {
      const written = yield* Effect.sync(() => {
        const element = document.createElement("div");
        element.id = "dom-root-found";
        document.body.append(element);
        return element;
      });
      expect(yield* Dom.root("dom-root-found")).toBe(written);
    }),
  );

  it.effect("fails with RootNotFound, naming the id, when the page has none", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Dom.root("dom-root-missing"));
      expect(error._tag).toBe("RootNotFound");
      expect(error.id).toBe("dom-root-missing");
    }),
  );
});
