import { TFile } from "obsidian";
import { NoteState } from "./common";

export const LOOM_DATA_VERSION = 1;

export interface LoomStorage {
  loadNoteState(file: TFile): Promise<NoteState | null>;
  saveNoteState(file: TFile, state: NoteState): Promise<void>;
  deleteNoteState(file: TFile): Promise<void>;
  loadAllStates(): Promise<Record<string, NoteState>>;
  saveAllStates(states: Record<string, NoteState>): Promise<void>;
  hasNoteState(file: TFile): Promise<boolean>;
  handleRename(oldPath: string, newPath: string): Promise<void>;
  getType(): "legacy" | "document";
}
