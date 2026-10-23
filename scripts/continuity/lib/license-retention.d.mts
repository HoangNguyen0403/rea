export interface RetainedDependencyPackage {
  readonly name: string;
  readonly version: string;
  readonly relativePath: string;
}

export interface RetainedLicenses {
  readonly notices: readonly string[];
  readonly dependencyNotices: number;
}

export function retainLicenses(
  source: string,
  packages: readonly RetainedDependencyPackage[],
  destination: string,
): Promise<RetainedLicenses>;
