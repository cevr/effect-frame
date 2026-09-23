import { serverOnly } from "effect-frame/actor";

/** A browser entry that imports the full actor entry instead of /client. */
export const shipped = serverOnly;
