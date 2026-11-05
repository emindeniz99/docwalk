// Values worker/vitest.config.ts hands to the tests running in workerd.
declare module "vitest" {
  export interface ProvidedContext {
    /** public/_headers, or null when the file is missing. */
    publicHeaders: string | null;
  }
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- an augmentation must live in a module
export {};
