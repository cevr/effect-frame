---
"effect-frame": minor
---

Place scroll and focus at shell commit (#31).

New exports on `effect-frame/router`:

- `NavigationBehavior`: a namespace with the `NavigationBehavior.NavigationBehavior` type and its two values, `Restore` (the default) and `Preserve`.
- `browserNavigation`: the browser `Location` on the Navigation API, with the History API as the fallback.
- `mount({ behavior })`, `Route.leaf(segment, view, { behavior })`, and `behavior` on a flat `Route.client` definition. A layout takes none.
- The `Route.LeafOptions` type.

Changed behavior:

- Under `Restore`, a push or replace scrolls to the top or to the URL's fragment when the new branch is in the document, and Back or Forward restores the browser's saved position. Focus moves to the entering leaf's root, or to the first `autofocus` element inside it. A stayed leaf keeps focus.
- A leaf's root element renders with `tabindex="-1"`, unless the view wrote a tab index (`tabindex` or `tabIndex`) or the element is focusable by the platform already (for example a `<button>` or an `<a href>`).
- `browserLocation` now scrolls and focuses the same way through the History API.
- `followLinks` no longer follows a link that only changes the current page's fragment.
- A cancelable Back or Forward on an engine without a precommit handler (WebKit) is no longer canceled. It is followed and reported with `reason=noncancelable`, because a canceled traversal there leaves the back-forward list out of step with the page.
