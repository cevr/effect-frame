import type { Option } from "effect";
import { Schema } from "effect";

const TargetTypeId: unique symbol = Symbol.for("effect-frame/view/PortalTarget");

/**
 * Where a `<Portal>` draws its children. Only a host module makes one
 * (`Dom.target(element)`, the OpenTUI entry's `target(renderable)`), and
 * only the host that made a target draws into it: the view never names a
 * node type its host cannot produce, and a host that cannot draw a Portal
 * refuses it instead of drawing nothing.
 *
 * The brand is a symbol no module outside the package can name, so a
 * target cannot be written as a literal.
 */
export interface PortalTarget {
  readonly [TargetTypeId]: typeof TargetTypeId;
  /** The host that made the target, as its `PortalHost` names itself. */
  readonly host: string;
  /** The host's node. Only that host reads it, after it checks `host`. */
  readonly node: unknown;
}

/**
 * What a host that can draw a Portal adds to itself. `resolve` answers the
 * node a target names when this host made it, and `None` when it did not.
 * A host that draws no Portal names itself and resolves nothing, so the
 * refusal says which host it was.
 */
export interface PortalHost<HostNode> {
  readonly name: string;
  readonly resolve: (target: PortalTarget) => Option.Option<HostNode>;
}

/** A target the drawing host did not make, or a host that draws no Portal. */
export class PortalTargetRefused extends Schema.TaggedError<PortalTargetRefused>()(
  "PortalTargetRefused",
  {
    /** The host drawing the view. */
    host: Schema.String,
    /** The host that made the target. */
    made: Schema.String,
  },
) {
  override get message(): string {
    return `the ${this.host} host cannot draw a Portal into a target the ${this.made} host made`;
  }
}

/**
 * Make a target. Internal: a host module wraps it in a constructor typed by
 * its own node, and the package exports only that constructor.
 */
export const makeTarget = <HostNode>(host: string, node: HostNode): PortalTarget => ({
  [TargetTypeId]: TargetTypeId,
  host,
  node,
});
