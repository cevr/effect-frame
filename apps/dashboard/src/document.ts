/**
 * The id of the element the Dashboard page mounts into. The server's document
 * names it (`Html.Document.rootId`) and the browser entry finds it
 * (`Dom.root`), both from here.
 */
export const rootId = "app";

/**
 * The path the actor transport answers under: the server mounts its handler
 * here, and the browser entry and the forms send here.
 */
export const actorPrefix = "/actors";
