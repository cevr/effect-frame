import type { Route } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect } from "effect";
import type { post } from "./routing.js";

/** The post page, imported on first use by `View.lazy` in `routing.tsx`. */
const PostView = (props: Route.PropsOf<typeof post>) =>
  Effect.succeed(<article>{View.bind(props.params, (params) => params.postId)}</article>);

export default PostView;
