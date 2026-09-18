import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** One document for every browser test file in this process. */
export const registerDom = (): void => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
};
