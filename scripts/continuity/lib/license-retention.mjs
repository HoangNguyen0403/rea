import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function retainLicenses(source, packages, destination) {
  const notices = [];
  await mkdir(join(destination, "source"), { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DISCLAIMER.md"]) {
    try {
      await lstat(join(source, name));
    } catch {
      continue;
    }
    const target = `licenses/source/${name}`;
    await mkdir(dirname(join(destination, "source", name)), {
      recursive: true,
    });
    await cp(join(source, name), join(destination, "source", name));
    notices.push(target);
  }
  try {
    await lstat(join(source, "licenses"));
    await cp(
      join(source, "licenses"),
      join(destination, "source", "licenses"),
      { recursive: true },
    );
    const files = (
      await readdir(join(destination, "source", "licenses"))
    ).sort();
    for (const file of files) notices.push(`licenses/source/licenses/${file}`);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  let dependencyNotices = 0;
  for (const packageEntry of packages) {
    const packageRoot = join(source, packageEntry.relativePath);
    const directory = join(
      destination,
      "dependencies",
      packageEntry.relativePath,
    );
    await mkdir(directory, { recursive: true });
    const entries = await readdir(packageRoot, { withFileTypes: true });
    const licenseFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|notice|copying|copyright)/iu.test(entry.name),
    );
    if (licenseFiles.length > 0) {
      for (const entry of licenseFiles) {
        await cp(join(packageRoot, entry.name), join(directory, entry.name));
        dependencyNotices += 1;
      }
    } else {
      const metadata = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      );
      const declaration =
        typeof metadata.license === "string"
          ? metadata.license
          : metadata.license?.type;
      if (typeof declaration !== "string" || declaration.length === 0)
        throw new Error(
          `Dependency ${packageEntry.name}@${packageEntry.version} has no license notice or declaration`,
        );
      await writeFile(
        join(directory, "DECLARED.json"),
        `${JSON.stringify(
          {
            name: packageEntry.name,
            version: packageEntry.version,
            license: declaration,
            repository:
              typeof metadata.repository === "string"
                ? metadata.repository
                : metadata.repository?.url,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      dependencyNotices += 1;
    }
  }
  if (dependencyNotices === 0)
    throw new Error("No dependency license notices were retained");
  return { notices, dependencyNotices };
}
