/**
 * `Streaming` as an app and a host read it: the record ids, the record
 * schemas, and `resume`. Writing a shell and waiting on the cache's
 * declarations stays in `streaming.ts`, which the hosts import by path.
 */
export {
  ActorSeed,
  ActorSeedJson,
  Closed,
  Patch,
  Placeholder,
  RecordJson,
  SeedJson,
  StreamRecord,
  actorSeedId,
  containerId,
  recordClass,
  recordId,
  resume,
  seedId,
  type DocumentRecords,
  type RecordId,
  type Resumed,
  type ShellOptions,
  type ShellRecords,
} from "./streaming.js";
