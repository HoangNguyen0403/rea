export interface BundleInventorySummary {
  readonly path: string;
  readonly sha256: string;
  readonly files: number;
  readonly bytes: number;
}

export function writeBundleInventory(
  root: string,
  options?: { readonly exclude?: readonly string[] },
): Promise<BundleInventorySummary>;
