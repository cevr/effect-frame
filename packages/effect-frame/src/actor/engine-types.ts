/**
 * The value committed by an actor's private runtime.
 *
 * Public `Applied` values are an adapter concern. Keeping this numeric value
 * private leaves the runtime independent of future displayed/provisional
 * public values.
 */
export interface Committed<State> {
  readonly revision: number;
  readonly state: State;
}
