import { App, Plugin, TFile } from "obsidian";
import { NoteState, LoomSettings } from "./common";
import { LoomStorage } from "./storage";

export class LegacyStorage implements LoomStorage {
  private app: App;
  private plugin: Plugin & { settings: LoomSettings };
  private state: Record<string, NoteState>;

  constructor(
    app: App,
    plugin: Plugin & { settings: LoomSettings },
    state: Record<string, NoteState>
  ) {
    this.app = app;
    this.plugin = plugin;
    this.state = state;
  }

  async loadNoteState(file: TFile): Promise<NoteState | null> {
    return this.state[file.path] || null;
  }

  async saveNoteState(file: TFile, state: NoteState): Promise<void> {
    this.state[file.path] = state;
    await this.plugin.saveData({
      settings: this.plugin.settings,
      state: this.state,
    });
  }

  async deleteNoteState(file: TFile): Promise<void> {
    delete this.state[file.path];
    await this.plugin.saveData({
      settings: this.plugin.settings,
      state: this.state,
    });
  }

  async loadAllStates(): Promise<Record<string, NoteState>> {
    return this.state;
  }

  async saveAllStates(states: Record<string, NoteState>): Promise<void> {
    this.state = states;
    await this.plugin.saveData({
      settings: this.plugin.settings,
      state: this.state,
    });
  }

  async hasNoteState(file: TFile): Promise<boolean> {
    return file.path in this.state;
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    if (oldPath in this.state) {
      this.state[newPath] = this.state[oldPath];
      delete this.state[oldPath];
      await this.plugin.saveData({
        settings: this.plugin.settings,
        state: this.state,
      });
    }
  }

  getType(): "legacy" {
    return "legacy";
  }
}
