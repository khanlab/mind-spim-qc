/** Folders (OME-Zarr) whose files the main thread reads for the worker. */

/** A dropped or chosen folder: reads files by relative path. */
export interface Folder {
  name: string;
  read(path: string): Promise<File | null>;
}

export function folderFromEntry(dir: FileSystemDirectoryEntry): Folder {
  return {
    name: dir.name,
    read: (path) =>
      new Promise((resolve) =>
        dir.getFile(
          path,
          {},
          (entry) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
          () => resolve(null),
        ),
      ),
  };
}

export function folderFromHandle(dir: FileSystemDirectoryHandle): Folder {
  return {
    name: dir.name,
    async read(path) {
      try {
        const parts = path.split("/");
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
        return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      } catch {
        return null;
      }
    },
  };
}

/** From an <input webkitdirectory>, which lists every file up front. */
export function folderFromFileList(files: FileList): Folder {
  const byPath = new Map<string, File>();
  let name = "";
  for (const f of Array.from(files)) {
    const [root, ...rest] = f.webkitRelativePath.split("/");
    name = root;
    byPath.set(rest.join("/"), f);
  }
  return { name, read: async (path) => byPath.get(path) ?? null };
}

