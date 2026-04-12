import { App, TFile, normalizePath } from "obsidian";
import { LoomSettings, NoteState } from "./common";
import { LoomStorage, LOOM_DATA_VERSION } from "./storage";

export class DocumentStorage implements LoomStorage {
  private app: App;
  private settings: LoomSettings;
  private fileWatcher: Map<string, () => void> = new Map();

  constructor(app: App, settings: LoomSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Debug helper gated by developerMode setting */
  private log(...args: any[]) {
    if (this.settings?.developerMode) {
      console.debug("[loom:doc-storage]", ...args);
    }
  }

  /**
   * Get the path for a loom file based on the markdown file
   */
  private getLoomPath(file: { path: string; basename: string; parent?: { path: string } | null }): string {
    if (this.settings.documentStorageLocation === "alongside") {
      const dir = file.parent?.path || "";
      const baseName = file.basename;
      return normalizePath(`${dir}/${baseName}.loom.json`);
    } else {
      const pluginDir = normalizePath(".obsidian/plugins/loom-d/data");
      return normalizePath(`${pluginDir}/${file.path}.loom.json`);
    }
  }

  /**
   * Ensure the directory exists for a file path
   */
  private async ensureDirectory(filePath: string): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  async loadNoteState(file: TFile): Promise<NoteState | null> {
    this.log("loadNoteState", file.path);
    const loomPath = this.getLoomPath(file);
    try {
      if (!(await this.app.vault.adapter.exists(loomPath))) {
        return null;
      }
      const data = await this.app.vault.adapter.read(loomPath);
      const loomDoc = JSON.parse(data);
      this.log("loaded", loomPath, "nodes=", Object.keys(loomDoc.state.nodes).length);

      // Migrate bookmarked -> tags
      Object.values(loomDoc.state.nodes).forEach((node: any) => {
        if (node.bookmarked) {
          if (!node.tags) node.tags = [];
          if (!node.tags.includes("fav")) node.tags.push("fav");
          delete node.bookmarked;
        }
        if (!node.tags) node.tags = [];
      });

      if (loomDoc.version !== LOOM_DATA_VERSION) {
        console.warn(
          `Loom file version mismatch: expected ${LOOM_DATA_VERSION}, got ${loomDoc.version}`
        );
      }
      return loomDoc.state;
    } catch (error) {
      console.error(`Error loading loom file ${loomPath}:`, error);
      return null;
    }
  }

  async saveNoteState(file: TFile, state: NoteState): Promise<void> {
    this.log("saveNoteState", file.path);
    const loomPath = this.getLoomPath(file);
    try {
      const nodeCount = Object.keys(state.nodes).length;

      // Don't persist trivial single-node looms
      if (nodeCount <= 1) {
        if (await this.app.vault.adapter.exists(loomPath)) {
          await this.app.vault.adapter.remove(loomPath);
          this.log("removed trivial loom file", loomPath);
        }
        return;
      }

      await this.ensureDirectory(loomPath);

      const loomDoc: any = {
        version: LOOM_DATA_VERSION,
        created: Date.now(),
        modified: Date.now(),
        documentPath: file.path,
        state,
        metadata: {
          totalNodes: nodeCount,
        },
      };

      // Preserve original created timestamp if file already exists
      if (await this.app.vault.adapter.exists(loomPath)) {
        try {
          const existingData = await this.app.vault.adapter.read(loomPath);
          const existing = JSON.parse(existingData);
          loomDoc.created = existing.created;
        } catch (e) {
          // Ignore parse errors on existing file
        }
      }

      const data = JSON.stringify(loomDoc, null, 2);
      await this.app.vault.adapter.write(loomPath, data);
      this.log("saved", loomPath, "nodes=", nodeCount);
    } catch (error) {
      console.error(`Error saving loom file ${loomPath}:`, error);
      throw error;
    }
  }

  async deleteNoteState(file: TFile): Promise<void> {
    this.log("deleteNoteState", file.path);
    const loomPath = this.getLoomPath(file);
    try {
      if (await this.app.vault.adapter.exists(loomPath)) {
        await this.app.vault.adapter.remove(loomPath);
      }
    } catch (error) {
      console.error(`Error deleting loom file ${loomPath}:`, error);
    }
  }

  async loadAllStates(): Promise<Record<string, NoteState>> {
    this.log("loadAllStates");
    const states: Record<string, NoteState> = {};
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const file of markdownFiles) {
      const state = await this.loadNoteState(file);
      if (state) {
        states[file.path] = state;
      }
    }

    this.log("loadedAllStates count=", Object.keys(states).length);
    return states;
  }

  async saveAllStates(states: Record<string, NoteState>): Promise<void> {
    this.log("saveAllStates", Object.keys(states).length);
    for (const [path, state] of Object.entries(states)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.saveNoteState(file, state);
      }
    }
  }

  async hasNoteState(file: TFile): Promise<boolean> {
    const loomPath = this.getLoomPath(file);
    return await this.app.vault.adapter.exists(loomPath);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    this.log("handleRename", oldPath, "->", newPath);
    const oldFile = {
      path: oldPath,
      basename: oldPath.split("/").pop()?.replace(".md", "") || "",
    };
    const newFile = this.app.vault.getAbstractFileByPath(newPath);
    if (!(newFile instanceof TFile)) return;

    const oldLoomPath = this.getLoomPath(oldFile);
    const newLoomPath = this.getLoomPath(newFile);

    try {
      if (await this.app.vault.adapter.exists(oldLoomPath)) {
        const data = await this.app.vault.adapter.read(oldLoomPath);
        const loomDoc = JSON.parse(data);
        loomDoc.documentPath = newPath;
        loomDoc.modified = Date.now();

        await this.ensureDirectory(newLoomPath);
        await this.app.vault.adapter.write(
          newLoomPath,
          JSON.stringify(loomDoc, null, 2)
        );
        await this.app.vault.adapter.remove(oldLoomPath);
      }
    } catch (error) {
      console.error(
        `Error handling rename from ${oldPath} to ${newPath}:`,
        error
      );
    }
  }

  getType(): "document" {
    return "document";
  }

  /**
   * Clean up any file watchers
   */
  destroy(): void {
    for (const unwatch of this.fileWatcher.values()) {
      unwatch();
    }
    this.fileWatcher.clear();
  }
}
