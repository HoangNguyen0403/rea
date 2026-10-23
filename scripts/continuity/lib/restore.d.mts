export interface ContinuityFileSystem {
  rename(source: string, destination: string): Promise<void>;
  rm(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void>;
  writeFile(
    path: string,
    data: string,
    options?: { readonly encoding?: BufferEncoding; readonly mode?: number },
  ): Promise<void>;
}

export interface RestoreRetainedBundleOptions {
  readonly bundle: string;
  readonly installDirectory: string;
  readonly expectedManifestSha256: string;
  readonly replace?: boolean;
  readonly now?: () => Date;
  readonly filesystem?: ContinuityFileSystem;
}

export function restoreRetainedBundle(
  options: RestoreRetainedBundleOptions,
): Promise<{
  readonly state: "restored";
  readonly installDirectory: string;
  readonly previousInstall: string | null;
  readonly package: unknown;
  readonly source: unknown;
  readonly runtime: unknown;
}>;

export function rollbackRetainedInstall(options: {
  readonly installDirectory: string;
  readonly now?: () => Date;
  readonly filesystem?: ContinuityFileSystem;
}): Promise<{
  readonly state: "rolled-back";
  readonly installDirectory: string;
  readonly previousInstall: string;
}>;
