import { Option } from "effect";

/**
 * The toolchain rule. The gate runs on the one Bun that `packageManager`
 * names (`bun@<version>`), because the bundles and the boundary's import
 * graph come from `Bun.build`. `bun run toolchain` checks it before any lane
 * runs, so a different Bun fails with its cause and not later, in a bundle
 * assertion.
 */

/** The message for a running Bun that is not the pinned one, if it is not. */
export const pinnedMismatch = (packageManager: string, running: string): Option.Option<string> => {
  const pinned = packageManager.replace(/^bun@/, "");
  return Option.liftPredicate(
    `package.json pins ${packageManager}, but this is Bun ${running}; install bun@${pinned}`,
    () => pinned !== running,
  );
};
