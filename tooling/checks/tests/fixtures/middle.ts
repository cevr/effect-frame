import { secret } from "./secret.server.js";

/** An ordinary module that leaks a server import to whatever imports it. */
export const wrapped = secret;
