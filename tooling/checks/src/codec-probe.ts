import { Schema } from "effect";

export const Probe = Schema.Struct({
  text: Schema.NonEmptyString,
});

export interface Probe extends Schema.Schema.Type<typeof Probe> {}

export const decodeProbe = Schema.decodeUnknownEffect(Probe);
export const encodeProbe = Schema.encodeEffect(Probe);
