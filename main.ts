import {
  LoomView,
  LoomSiblingsView,
  LoomEditorPlugin,
  loomEditorPluginSpec,
  probeReadoutExtension,
  setProbeReadoutEffect,
  ProbeReadout,
  MakePromptFromPassagesModal,
} from "./views";
import {
  Provider,
  ModelPreset,
  LoomSettings,
  SearchResultState,
  Node,
  NoteState,
  ProbeConfig,
  SteeringType,
  getPreset,
} from "./common";
import { LoomStorage } from "./storage";
import { LegacyStorage } from "./legacyStorage";
import { DocumentStorage } from "./documentStorage";
import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
  setIcon,
  Modal,
} from "obsidian";
import { ViewPlugin } from "@codemirror/view";

import {
  Configuration as AzureConfiguration,
  OpenAIApi as AzureOpenAIApi,
} from "azure-openai";
import { Configuration, OpenAIApi } from "openai";
import * as cohere from "cohere-ai";
import Anthropic from "@anthropic-ai/sdk";

import cl100k from "gpt-tokenizer";
import p50k from "gpt-tokenizer/esm/model/text-davinci-003";
import r50k from "gpt-tokenizer/esm/model/davinci";

import * as fs from "fs";
import { toRoman } from "roman-numerals";
import { v4 as uuidv4 } from "uuid";
const untildify = require("untildify") as any;

type LoomSettingKey = keyof {
  [K in keyof LoomSettings]: LoomSettings[K];
};

const DEFAULT_SETTINGS: LoomSettings = {
  passageFolder: "",
  defaultPassageSeparator: "\\n\\n---\\n\\n",
  defaultPassageFrontmatter: "%r:\\n",
  logApiCalls: false,

  modelPresets: [],
  modelPreset: -1,

  visibility: {
    visibility: true,
    modelPreset: true,
    maxTokens: true,
    n: true,
    bestOf: false,
    temperature: true,
    topP: false,
    frequencyPenalty: false,
    presencePenalty: false,
    prepend: false,
    systemPrompt: false,
    userMessage: false,
    steering: true,
  },
  maxTokens: 60,
  temperature: 1,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  prepend: "<|endoftext|>",
  bestOf: 0,
  n: 5,
  systemPrompt:
    "The assistant is in CLI simulation mode, and responds to the user's CLI commands only with the output of the command.",
  userMessage: "<cmd>cat untitled.txt</cmd>",
  showSettings: false,
  showSearchBar: false,
  showNodeBorders: false,
  showExport: false,
  developerMode: false,
  
  // Storage settings
  useDocumentStorage: false,
  documentStorageLocation: 'alongside',
  autoMigrateOnSwitch: false,

  // Probe-server steering
  steeringType: "none",
  steeringProbe: "",
  steeringProbeIndex: 0,
  steeringStrength: 0,
  steeringRenorm: false,
  probeConfigs: {},
};

type CompletionResult =
  | { ok: true; completions: string[] }
  | { ok: false; status: number; message: string };

/** Simple confirmation modal with OK/Cancel buttons */
class ConfirmMigrationModal extends Modal {
  private onConfirm: () => void;

  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Migrate to Document Storage' });
    contentEl.createEl('p', {
      text: 'This will convert all your existing looms into per-document files. Make sure you have a backup before continuing.'
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    const continueBtn = buttons.createEl('button', { text: 'Continue' });

    cancelBtn.addEventListener('click', () => this.close());
    continueBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }
}

/** HTML Export path input modal */
class HTMLExportModal extends Modal {
  private onConfirm: (path: string) => void;
  private defaultPath: string;

  constructor(app: App, defaultPath: string, onConfirm: (path: string) => void) {
    super(app);
    this.defaultPath = defaultPath;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Export Loom as HTML' });
    contentEl.createEl('p', {
      text: 'This will create a self-contained HTML file that can be shared with anyone.'
    });
    
    const pathInfo = contentEl.createEl('div', { cls: 'setting-item-description' });
    pathInfo.innerHTML = `
      <p><strong>Path options:</strong></p>
      <ul>
        <li><code>${this.defaultPath}</code> - saves next to your markdown file</li>
        <li><code>~/Desktop/${this.defaultPath}</code> - saves to Desktop</li>
        <li><code>/full/path/to/${this.defaultPath}</code> - saves to specific location</li>
      </ul>
    `;

    const inputContainer = contentEl.createDiv({ cls: 'setting-item' });
    inputContainer.createDiv({ cls: 'setting-item-name', text: 'Export path:' });
    const inputControl = inputContainer.createDiv({ cls: 'setting-item-control' });
    
    const pathInput = inputControl.createEl('input', {
      type: 'text',
      value: this.defaultPath,
      placeholder: 'filename.html or /full/path/filename.html'
    });
    pathInput.style.width = '100%';

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    const exportBtn = buttons.createEl('button', { text: 'Export HTML', cls: 'mod-cta' });

    cancelBtn.addEventListener('click', () => this.close());
    exportBtn.addEventListener('click', () => {
      const path = pathInput.value.trim();
      if (path) {
        // Ensure .html extension
        const finalPath = path.endsWith('.html') ? path : path + '.html';
        this.close();
        this.onConfirm(finalPath);
      }
    });

    // Focus the input and select the filename part (without .html)
    pathInput.focus();
    if (this.defaultPath.endsWith('.html')) {
      pathInput.setSelectionRange(0, this.defaultPath.length - 5);
    }
    
    // Allow Enter key to export
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        exportBtn.click();
      }
    });
  }
}

export default class LoomPlugin extends Plugin {
  settings: LoomSettings;
  state: Record<string, NoteState>;
  storage: LoomStorage;

  editor: Editor;
  statusBarItem: HTMLElement;

  openai: OpenAIApi;
  azure: AzureOpenAIApi;
  anthropic: Anthropic;
  anthropicApiKey: string;

  probeReadouts: Record<string, ProbeReadout> = {};

  rendering = false;

  withFile<T>(callback: (file: TFile) => T): T | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return callback(file);
  }

  thenSaveAndRender(callback: () => void | Promise<void>) {
    const result = callback();
    if (result instanceof Promise) {
      result.then(() => this.saveAndRender());
    } else {
      this.saveAndRender();
    }
  }

  wftsar(callback: (file: TFile) => void | Promise<void>) {
    this.thenSaveAndRender(async () => {
      const result = this.withFile(callback);
      if (result instanceof Promise) {
        await result;
      }
    });
  }

  initializeProviders() {
    const preset = getPreset(this.settings);
    if (preset === undefined) return;

    if (["openai", "openai-chat"].includes(preset.provider)) {
      this.openai = new OpenAIApi(
        new Configuration({
          apiKey: preset.apiKey,
          // @ts-expect-error TODO
          organization: preset.organization,
        })
      );
    } else if (preset.provider == "cohere") cohere.init(preset.apiKey);
    else if (preset.provider == "azure") {
      // @ts-expect-error TODO
      const url = preset.url;

      if (!preset.apiKey || !url) return;
      this.azure = new AzureOpenAIApi(
        new AzureConfiguration({
          apiKey: preset.apiKey,
          azure: {
            apiKey: preset.apiKey,
            endpoint: url,
          },
        })
      );
    } else if (preset.provider == "anthropic") {
      //(property) ClientOptions.fetch?: Fetch | undefined
      //Specify a custom fetch function implementation.
      //If not provided, we use node-fetch on Node.js and otherwise expect that fetch is defined globally.
      // expects Promise<Response> as return value
      this.anthropicApiKey = preset.apiKey;

      this.anthropic = new Anthropic({
        apiKey: preset.apiKey,
        // fetch:
        defaultHeaders: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "messages-2023-12-15",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }
  }

  apiKeySet() {
    if (this.settings.modelPreset == -1) return false;
    return this.settings.modelPresets[this.settings.modelPreset].apiKey != "";
  }

  newNode(
    text: string,
    parentId: string | null,
    unread: boolean = false,
    nodeType: 'ai-generated' | 'user-edited' | 'user-created' = 'user-created'
  ): [string, Node] {
    const id = uuidv4();
    const now = Date.now();
    const node: Node = {
      text,
      parentId,
      collapsed: false,
      unread,
      tags: [],
      searchResultState: null,
      
      // New metadata fields
      nodeType,
      createdTimestamp: now,
      reReadTimestamps: [],
    };
    return [id, node];
  }

  initializeNoteState(file: TFile) {
    const [current, node] = this.newNode(this.editor.getValue(), null);
    this.state[file.path] = {
      current,
      hoisted: [] as string[],
      searchTerm: "",
      filter: "",
      nodes: { [current]: node },
      generating: null,
    };
    this.saveAndRender();

    // Migrate any old bookmarked nodes to fav tag
    Object.values(this.state[file.path].nodes).forEach(node => {
      if ((node as any).bookmarked) {
        if (!node.tags) node.tags = [];
        if (!node.tags.includes('fav')) node.tags.push('fav');
        delete (node as any).bookmarked;
      }
    });
  }

  ancestors(file: TFile, id: string): string[] {
    const state = this.state[file.path];
    let ancestors = [];
    let node: string | null = id;
    while (node) {
      node = state.nodes[node].parentId;
      if (node) ancestors.push(node);
    }
    return ancestors.reverse();
  }

  family(file: TFile, id: string): string[] {
    return [...this.ancestors(file, id), id];
  }

  fullText(file: TFile, id: string | null) {
    const state = this.state[file.path];

    let text = "";
    let current = id;
    while (current) {
      text = state.nodes[current].text + text;
      current = state.nodes[current].parentId;
    }
    return text;
  }

  breakAtPoint(file: TFile): (string | null)[] {
    // split the current node into:
    //   - parent node with text before cursor
    //   - child node with text after cursor

    const state = this.state[file.path];
    const current = state.current;

    // first, get the cursor's position in the full text
    const cursor = this.editor.getCursor();
    let cursorPos = 0;
    for (let i = 0; i < cursor.line; i++)
      cursorPos += this.editor.getLine(i).length + 1;
    cursorPos += cursor.ch;

    const family = this.family(file, current);
    const familyTexts = family.map((id) => state.nodes[id].text);

    // find the node that the cursor is in
    let i = cursorPos;
    let n = 0;
    while (true) {
      if (i < familyTexts[n].length) break;
      // if the cursor is at the end of the last node, don't split, just return the current node
      if (n === family.length - 1) return [current, null];
      i -= familyTexts[n].length;
      n++;
    }

    const parentNode = family[n];
    const parentNodeText = familyTexts[n];

    // then, get the text before and after the cursor
    const before = parentNodeText.substring(0, i);
    const after = parentNodeText.substring(i);

    // then, set the in-range node's text to the text before the cursor
    this.state[file.path].nodes[parentNode].text = before;

    // get the in-range node's children, which will be moved later
    const children = Object.values(state.nodes).filter(
      (node) => node.parentId === parentNode
    );

    // then, create a new node with the text after the cursor
    const [childId, childNode] = this.newNode(after, parentNode);
    this.state[file.path].nodes[childId] = childNode;

    // move the children to under the after node
    children.forEach((child) => (child.parentId = childId));

    return [parentNode, childId];
  }

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.app.workspace.trigger("parse-style-settings");
    this.addSettingTab(new LoomSettingTab(this.app, this));

    this.initializeProviders();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Generating...");
    this.statusBarItem.style.display = "none";

    const completeCallback = (
      checking: boolean,
      callback: (file: TFile) => Promise<void>
    ) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;

      if (!this.apiKeySet()) return false;
      if (!checking) callback(file);
      return true;
    };

    this.addCommand({
      id: "complete",
      name: "Complete from current point",
      checkCallback: (checking: boolean) =>
        completeCallback(checking, this.complete.bind(this)),
      hotkeys: [{ modifiers: ["Ctrl"], key: " " }],
    });

    this.addCommand({
      id: "generate-siblings",
      name: "Generate siblings of the current node",
      checkCallback: (checking: boolean) =>
        completeCallback(checking, this.generateSiblings.bind(this)),
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: " " }],
    });

    this.addCommand({
      id: "bookmark",
      name: "Toggle favorite tag on current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:toggle-tag", { id: state.current, tag: 'fav' });
        }),
      hotkeys: [{ modifiers: ["Ctrl"], key: "b" }],
    });

    const withState = (
      checking: boolean,
      callback: (state: NoteState) => void
    ) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;

      const state = this.state[file.path];
      if (!state) this.initializeNoteState(file);

      if (!checking) callback(state);
      return true;
    };

    const withStateChecked = (
      checking: boolean,
      checkCallback: (state: NoteState) => boolean,
      callback: (state: NoteState) => void
    ) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;

      const state = this.state[file.path];
      if (!state) this.initializeNoteState(file);

      if (!checkCallback(state)) return false;

      if (!checking) callback(state);
      return true;
    };

    const openPane = (type: string, focus: boolean) => {
      const panes = this.app.workspace.getLeavesOfType(type);
      try {
        if (panes.length === 0)
          this.app.workspace.getRightLeaf(false)?.setViewState({ type });
        else if (focus) this.app.workspace.revealLeaf(panes[0]);
      } catch (e) {} // expect "TypeError: Cannot read properties of null (reading 'children')"
    };
    const openLoomPane = (focus: boolean) => openPane("loom", focus);
    const openLoomSiblingsPane = (focus: boolean) =>
      openPane("loom-siblings", focus);

    this.addCommand({
      id: "create-child",
      name: "Create child of current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:create-child", state.current);
        }),
    });

    this.addCommand({
      id: "create-sibling",
      name: "Create sibling of current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:create-sibling", state.current);
        }),
    });

    this.addCommand({
      id: "clone-current-node",
      name: "Clone current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clone", state.current);
        }),
    });

    this.addCommand({
      id: "break-at-point",
      name: "Split at current point",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:break-at-point", state.current);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "s" }],
    });

    this.addCommand({
      id: "break-at-point-create-child",
      name: "Split at current point and create child",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger(
            "loom:break-at-point-create-child",
            state.current
          );
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "c" }],
    });

    const canMerge = (state: NoteState, id: string, checking: boolean) => {
      const parentId = state.nodes[id].parentId;
      if (!parentId) {
        if (!checking) new Notice("Can't merge a root node with its parent");
        return false;
      }
      const nSiblings = Object.values(state.nodes).filter(
        (n) => n.parentId === parentId
      ).length;
      if (nSiblings > 1) {
        if (!checking)
          new Notice("Can't merge this node with its parent; it has siblings");
        return false;
      }
      return true;
    };

    this.addCommand({
      id: "merge-with-parent",
      name: "Merge current node with parent",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => canMerge(state, state.current, checking),
          (state) => {
            this.app.workspace.trigger("loom:merge-with-parent", state.current);
          }
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "m" }],
    });

    const switchToSibling = (state: NoteState, delta: number) => {
      const parentId = state.nodes[state.current].parentId;
      const siblings = Object.entries(state.nodes)
        .filter(([, node]) => node.parentId === parentId)
        .map(([id]) => id);

      if (siblings.length === 1) return;

      const index =
        (siblings.indexOf(state.current) + delta + siblings.length) %
        siblings.length;
      this.app.workspace.trigger("loom:switch-to", siblings[index]);
    };

    this.addCommand({
      id: "switch-to-next-sibling",
      name: "Switch to next sibling",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => switchToSibling(state, 1)),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowDown" }],
    });

    this.addCommand({
      id: "switch-to-previous-sibling",
      name: "Switch to previous sibling",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => switchToSibling(state, -1)),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowUp" }],
    });

    const switchToParent = (state: NoteState) =>
      this.app.workspace.trigger(
        "loom:switch-to",
        state.nodes[state.current].parentId
      );

    this.addCommand({
      id: "switch-to-parent",
      name: "Switch to parent",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => state.nodes[state.current].parentId !== null,
          switchToParent
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }],
    });

    const switchToChild = (state: NoteState) => {
      const children = Object.entries(state.nodes)
        .filter(([, node]) => node.parentId === state.current)
        .sort(
          ([, node1], [, node2]) =>
            (node2.lastVisited || 0) - (node1.lastVisited || 0)
        );

      if (children.length > 0)
        this.app.workspace.trigger("loom:switch-to", children[0][0]);
    };

    this.addCommand({
      id: "switch-to-child",
      name: "Switch to child",
      checkCallback: (checking: boolean) => withState(checking, switchToChild),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }],
    });

    const canDelete = (state: NoteState, id: string, checking: boolean) => {
      const rootNodes = Object.entries(state.nodes)
        .filter(([, node]) => node.parentId === null)
        .map(([id]) => id);
      if (rootNodes.length === 1 && rootNodes[0] === id) {
        if (!checking) new Notice("Can't delete the last root node");
        return false;
      }
      return true;
    };

    this.addCommand({
      id: "delete-current-node",
      name: "Delete current node",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => canDelete(state, state.current, checking),
          (state) => {
            this.app.workspace.trigger("loom:delete", [state.current]);
          }
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "Backspace" }],
    });

    this.addCommand({
      id: "clear-children",
      name: "Delete current node's children",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clear-children", state.current);
        }),
    });

    this.addCommand({
      id: "clear-siblings",
      name: "Delete current node's siblings",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clear-siblings", state.current);
        }),
    });

    this.addCommand({
      id: "toggle-collapse-current-node",
      name: "Toggle whether current node is collapsed",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:toggle-collapse", state.current);
        }),
    });

    const getState = () => this.withFile((file) => this.state[file.path]);
    const getSettings = () => this.settings;

    this.addCommand({
      id: "make-prompt-from-passages",
      name: "Make prompt from passages",
      callback: () => {
        if (this.settings.passageFolder.trim() === "") {
          new Notice("Please set the passage folder in settings");
          return;
        }
        new MakePromptFromPassagesModal(this.app, getSettings).open();
      },
    });

    this.addCommand({
      id: "open-pane",
      name: "Open Loom pane",
      callback: () => openLoomPane(true),
    });

    this.addCommand({
      id: "open-siblings-pane",
      name: "Open Loom siblings pane",
      callback: () => openLoomSiblingsPane(true),
    });

    this.addCommand({
      id: "debug-reset-state",
      name: "Debug: Reset state",
      callback: () => this.thenSaveAndRender(() => { this.state = {}; }),
    });

    this.addCommand({
      id: "debug-reset-hoist-stack",
      name: "Debug: Reset hoist stack",
      callback: () =>
        this.wftsar((file) => { this.state[file.path].hoisted = []; }),
    });

    this.addCommand({
      id: "export-html", 
      name: "Export as HTML",
      callback: () => {
        console.log("HTML export command triggered!");
        
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file to export");
          return;
        }
        
        if (!this.state[file.path] || !this.state[file.path].nodes) {
          new Notice("No loom data found for this file. Try generating some completions first.");
          return;
        }
        
        console.log("Exporting loom for:", file.path);
        const defaultPath = file.basename + ".html";
        
        // Create a proper modal instead of using prompt()
        new HTMLExportModal(this.app, defaultPath, (inputPath) => {
          console.log("Export path selected:", inputPath);
          try {
            this.app.workspace.trigger("loom:export-html", inputPath);
          } catch (error) {
            console.error("Export error:", error);
            new Notice(`Export failed: ${error.message}`);
          }
        }).open();
      },
    });

    this.registerView(
      "loom",
      (leaf) => new LoomView(leaf, getState, getSettings)
    );
    this.registerView(
      "loom-siblings",
      (leaf) => new LoomSiblingsView(leaf, getState)
    );

    openLoomPane(true);
    openLoomSiblingsPane(false);

    const loomEditorPlugin = ViewPlugin.fromClass(
      LoomEditorPlugin,
      loomEditorPluginSpec
    );
    this.registerEditorExtension([loomEditorPlugin, probeReadoutExtension]);

    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      
      // Find the nearest anchor element
      const link = target.closest('a');
      if (!link) {
        return;
      }

      // Determine the target text that might contain our loom hash
      let targetText: string | null = link.getAttribute('href');
      if (!targetText || targetText === '#' || targetText === '') {
        // Some editors store the real link in a data-href attribute
        targetText = link.getAttribute('data-href');
      }
      if (!targetText || targetText === '#' || targetText === '') {
        // Live Preview often sets href="#" and keeps the display text as the actual link
        targetText = link.textContent || '';
      }

      if (!targetText) return;

      // Strip leading [[ and trailing ]] if present
      targetText = targetText.replace(/^\[\[/, '').replace(/\]\]$/, '');

      if (targetText.includes('#loom=')) {
        console.log(`Loom: Found loom link: ${targetText}`);
        evt.preventDefault(); // Stop Obsidian from handling the click
        evt.stopPropagation(); // Stop the event from bubbling further

        const [path, hash] = targetText.split('#');
        if (hash && hash.startsWith('loom=')) {
          const nodeId = hash.substring(5); // 'loom='.length is 5
          
          this.app.workspace.openLinkText(path, '', false).then(() => {
            setTimeout(() => {
              console.log(`Loom: Triggering loom:switch-to with ID: ${nodeId}`);
              this.app.workspace.trigger("loom:switch-to", nodeId);
            }, 100); 
          });
        }
      }
    }, { capture: true }); // Use capture phase to intercept the click early.

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, view: MarkdownView) => {
          // @ts-expect-error
          const editorView = editor.cm;
          const plugin = editorView.plugin(loomEditorPlugin);

          // get cursor position, so it can be restored later
          const cursor = editor.getCursor();

          // if this note has no state, initialize it and return
          // @ts-ignore `Object is possibly 'null'` only in github actions
          if (!this.state[view.file.path]) {
            const [current, node] = this.newNode(editor.getValue(), null);
            // @ts-ignore
            this.state[view.file.path] = {
              current,
              hoisted: [] as string[],
              searchTerm: "",
              filter: "",
              nodes: { [current]: node },
              generating: null,
            };
            return;
          }

          // @ts-ignore
          const current = this.state[view.file.path].current;

          // `ancestors`: starts with the root node, ends with the parent of the current node
          let ancestors: string[] = [];
          let node: string | null = current;
          while (node) {
            // @ts-ignore
            node = this.state[view.file.path].nodes[node].parentId;
            if (node) ancestors.push(node);
          }
          ancestors = ancestors.reverse();

          // `ancestorTexts`: the text of each node in `ancestors`
          const text = editor.getValue();
          const ancestorTexts = ancestors.map(
            // @ts-ignore
            (id) => this.state[view.file.path].nodes[id].text
          );

          // `familyTexts`: `ancestorTexts` + the current node's text
          const familyTexts = ancestorTexts.concat(
            // @ts-ignore
            this.state[view.file.path].nodes[current].text
          );

          // for each ancestor, check if the editor's text starts with the ancestor's full text
          // if not, edit the ancestor's text to match the in-range section of the editor's text
          const editNode = (i: number) => {
            const prefix = familyTexts.slice(0, i).join("");
            const suffix = familyTexts.slice(i + 1).join("");

            let newText = text.substring(prefix.length);
            newText = newText.substring(0, newText.length - suffix.length);

            // @ts-ignore
            this.state[view.file.path].nodes[ancestors[i]].text = newText;
          };

          const updateDecorations = () => {
            const ancestorLengths = ancestors.map((id) => [
              id,
              // @ts-ignore
              this.state[view.file.path].nodes[id].text.length,
            ]);
            plugin.state = { ...plugin.state, ancestorLengths };
            plugin.update();
          };

          for (let i = 0; i < ancestors.length; i++) {
            const textBefore = ancestorTexts.slice(0, i + 1).join("");
            if (!text.startsWith(textBefore)) {
              editNode(i);
              updateDecorations();
              return;
            }
          }
          // @ts-ignore
          this.state[view.file.path].nodes[current].text = text.slice(
            ancestorTexts.join("").length
          );

          updateDecorations();

          setTimeout(() => {
            this.saveAndRender();
          }, 0);

          // restore cursor position
          editor.setCursor(cursor);
        }
      )
    );

    this.registerEvent(
      // ignore ts2769; the obsidian-api declarations don't account for custom events
      // @ts-expect-error
      this.app.workspace.on("loom:switch-to", (id: string) =>
        this.wftsar((file) => {
          this.state[file.path].current = id;

          this.state[file.path].nodes[id].unread = false;
          this.state[file.path].nodes[id].lastVisited = Date.now();

          // uncollapse the node's ancestors
          const ancestors = this.family(file, id).slice(0, -1);
          ancestors.forEach(
            (id) => (this.state[file.path].nodes[id].collapsed = false)
          );

          // update the editor's text
          // const cursor = this.editor.getCursor();
          // const linesBefore = this.editor.getValue().split("\n");
          this.editor.setValue(this.fullText(file, id));

          // always move cursor to the end of the editor
          const line = this.editor.lineCount() - 1;
          const ch = this.editor.getLine(line).length;
          this.editor.setCursor({ line, ch });
          // return;

          // // if the cursor is at the beginning of the editor, move it to the end
          // if(cursor.line === 0 && cursor.ch === 0) {
          //   const line = this.editor.lineCount() - 1;
          //   const ch = this.editor.getLine(line).length;
          //   this.editor.setCursor({ line, ch });
          //   return;
          // }

          // // if the text preceding the cursor has changed, move the cursor to the end of the text
          // // otherwise, restore the cursor position
          //     const linesAfter = this.editor
          //       .getValue()
          //       .split("\n")
          //       .slice(0, cursor.line + 1);
          //     for (let i = 0; i < cursor.line; i++)
          //       if (linesBefore[i] !== linesAfter[i]) {
          //         const line = this.editor.lineCount() - 1;
          //         const ch = this.editor.getLine(line).length;
          //         this.editor.setCursor({ line, ch });
          //               return;
          //       }
          // this.editor.setCursor(cursor);
          this.saveAndRender(); // Add explicit view refresh
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:toggle-collapse", (id: string) =>
        this.wftsar(
          (file) => {
            this.state[file.path].nodes[id].collapsed =
              !this.state[file.path].nodes[id].collapsed;
          }
        )
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:hoist", (id: string) =>
        this.wftsar((file) => { this.state[file.path].hoisted.push(id); })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:unhoist", () =>
        this.wftsar((file) => { this.state[file.path].hoisted.pop(); })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:toggle-tag", ({ id, tag }: { id: string; tag: string }) =>
        this.wftsar(
          (file) => {
            const node = this.state[file.path].nodes[id];
            if (!node.tags) node.tags = [];
            const idx = node.tags.indexOf(tag);
            if (idx >= 0) {
              node.tags.splice(idx, 1);
            } else {
              node.tags.push(tag);
            }
          }
        )
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:create-child", (id: string) =>
        this.withFile((file) => {
          const [newId, newNode] = this.newNode("", id);
          this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:create-sibling", (id: string) =>
        this.withFile((file) => {
          const [newId, newNode] = this.newNode(
            "",
            this.state[file.path].nodes[id].parentId
          );
          this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clone", (id: string) =>
        this.withFile((file) => {
          const node = this.state[file.path].nodes[id];
          const [newId, newNode] = this.newNode(node.text, node.parentId);
          this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:break-at-point", () =>
        this.withFile((file) => {
          const [, childId] = this.breakAtPoint(file);
          if (childId) this.app.workspace.trigger("loom:switch-to", childId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:break-at-point-create-child", () =>
        this.withFile((file) => {
          const [parentId] = this.breakAtPoint(file);
          if (parentId !== undefined) {
            const [newId, newNode] = this.newNode("", parentId);
            this.state[file.path].nodes[newId] = newNode;
            this.app.workspace.trigger("loom:switch-to", newId);
          }
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:merge-with-parent", (id: string) =>
        this.wftsar((file) => {
          const state = this.state[file.path];

          if (!canMerge(state, id, false)) return;

          const parentId = state.nodes[id].parentId!;

          // update the merged node's text
          state.nodes[parentId].text += state.nodes[id].text;

          // move the children to the merged node
          const children = Object.entries(state.nodes).filter(
            ([, node]) => node.parentId === id
          );
          for (const [childId] of children)
            this.state[file.path].nodes[childId].parentId = parentId;

          // switch to the merged node and delete the child node
          this.app.workspace.trigger("loom:switch-to", parentId);
          this.app.workspace.trigger("loom:delete", [id]);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:delete", (ids: string[]) =>
        this.wftsar((file) => {
          const state = this.state[file.path];

          ids = ids.filter((id) => canDelete(state, id, false));
          if (ids.length === 0) return;

          // remove the nodes from the hoist stack
          this.state[file.path].hoisted = state.hoisted.filter(
            (id) => !ids.includes(id)
          );

          // add the nodes and their descendants to a list of nodes to delete

          let deleted = [...ids];

          const addChildren = (id: string) => {
            const children = Object.entries(state.nodes)
              .filter(([, node]) => node.parentId === id)
              .map(([id]) => id);
            deleted = deleted.concat(children);
            children.forEach(addChildren);
          };
          ids.forEach(addChildren);

          // if the current node will be deleted, switch to its next sibling or its closest ancestor
          if (deleted.includes(state.current)) {
            const parentId = state.nodes[state.current].parentId;
            const siblings = Object.entries(state.nodes)
              .filter(([, node]) => node.parentId === parentId)
              .map(([id]) => id);

            (() => {
              // try to switch to the next sibling
              if (siblings.some((id) => !deleted.includes(id))) {
                const index = siblings.indexOf(state.current);
                const nextSibling = siblings[(index + 1) % siblings.length];
                this.app.workspace.trigger("loom:switch-to", nextSibling);
                return;
              }

              // try to switch to the closest ancestor
              let ancestorId = parentId;
              while (ancestorId !== null) {
                if (!deleted.includes(ancestorId)) {
                  this.app.workspace.trigger("loom:switch-to", ancestorId);
                  return;
                }
                ancestorId = state.nodes[ancestorId].parentId;
              }

              // if all else fails, switch to a root node
              const rootNodes = Object.entries(state.nodes)
                .filter(([, node]) => node.parentId === null)
                .map(([id]) => id);
              for (const id of rootNodes)
                if (!deleted.includes(id)) {
                  this.app.workspace.trigger("loom:switch-to", id);
                  return;
                }
            })();
          }

          // delete the nodes in the list
          for (const id of deleted) delete this.state[file.path].nodes[id];
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-children", (id: string) =>
        this.wftsar((file) => {
          const children = Object.entries(this.state[file.path].nodes)
            .filter(([, node]) => node.parentId === id)
            .map(([id]) => id);
          this.app.workspace.trigger("loom:delete", children);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-siblings", (id: string) =>
        this.wftsar((file) => {
          const parentId = this.state[file.path].nodes[id].parentId;
          const siblings = Object.entries(this.state[file.path].nodes)
            .filter(([id_, node]) => node.parentId === parentId && id_ !== id)
            .map(([id]) => id);
          this.app.workspace.trigger("loom:delete", siblings);
        })
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:set-setting",
        (setting: string, value: any) => {
          this.settings = { ...this.settings, [setting]: value };
          this.saveAndRender();

          // if changing showNodeBorders, update the editor
          if (setting === "showNodeBorders") {
            // @ts-expect-error
            const editor = this.editor.cm;
            const plugin = editor.plugin(loomEditorPlugin);

            plugin.state.showNodeBorders = this.settings.showNodeBorders;
            plugin.update();

            editor.focus();
          }
        }
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:set-visibility-setting",
        (setting: string, value: boolean) => {
          this.settings.visibility[setting] = value;
          this.saveAndRender();
        }
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:probe-doc",
        () => this.withFile((file) => this.probeDocument(file))
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:probe-clear",
        () => this.withFile((file) => this.clearProbeReadout(file))
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:search", (term: string) =>
        this.withFile((file) => {
          const state = this.state[file.path];

          this.state[file.path].searchTerm = term;
          if (!term) {
            Object.keys(state.nodes).forEach((id) => {
              this.state[file.path].nodes[id].searchResultState = null;
            });
            this.save(); // don't re-render
            return;
          }

          const matches = Object.entries(state.nodes)
            .filter(([, node]) =>
              node.text.toLowerCase().includes(term.toLowerCase())
            )
            .map(([id]) => id);

          let ancestors: string[] = [];
          for (const id of matches) {
            let parentId = state.nodes[id].parentId;
            while (parentId !== null) {
              ancestors.push(parentId);
              parentId = state.nodes[parentId].parentId;
            }
          }

          Object.keys(state.nodes).forEach((id) => {
            let searchResultState: SearchResultState;
            if (matches.includes(id)) searchResultState = "result";
            else if (ancestors.includes(id)) searchResultState = "ancestor";
            else searchResultState = "none";
            this.state[file.path].nodes[id].searchResultState =
              searchResultState;
          });

          this.save();
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:import", (path: string) =>
        this.wftsar((file) => {
          const fullPath = untildify(path);
          const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          this.state[file.path] = data;
          this.app.workspace.trigger("loom:switch-to", data.current);

          new Notice("Imported from " + fullPath);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:export", (path: string) =>
        this.wftsar(async (file) => {
          const fullPath = untildify(path);
          
          try {
            // Determine export format based on file extension
            if (fullPath.endsWith('.html')) {
              await this.exportToHTML(file, fullPath);
            } else {
              // Default to JSON export
              const json = JSON.stringify(this.state[file.path], null, 2);
              fs.writeFileSync(fullPath, json);
            }

            new Notice("Exported to " + fullPath);
          } catch (error) {
            console.error('Export failed:', error);
            new Notice(`Export failed: ${error.message}`);
          }
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:export-html", (path: string) =>
        this.wftsar(async (file) => {
          const fullPath = untildify(path);
          try {
            await this.exportToHTML(file, fullPath);
            new Notice("HTML exported to " + fullPath);
          } catch (error) {
            console.error('HTML export failed:', error);
            new Notice(`Export failed: ${error.message}`);
          }
        })
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:make-prompt-from-passages",
        (passages: string[], rawSeparator: string, rawFrontmatter: string) =>
          this.wftsar((file) => {
            const separator = rawSeparator.replace(/\\n/g, "\n");
            const frontmatter = (index: number) =>
              rawFrontmatter
                .replace(/%n/g, (index + 1).toString())
                .replace(/%r/g, toRoman(index + 1))
                .replace(/\\n/g, "\n");

            const passageTexts = passages.map((passage, index) => {
              return Object.entries(this.state[passage].nodes)
                .filter(([, node]) => node.parentId === null)
                .map(([, node]) => frontmatter(index) + node.text);
            });
            const text = `${passageTexts.join(
              separator
            )}${separator}${frontmatter(passages.length)}`;

            const state = this.state[file.path];
            const currentNode = state.nodes[state.current];

            let id;
            if (currentNode.text === "" && currentNode.parentId === null) {
              this.state[file.path].nodes[state.current].text = text;
              id = state.current;
            } else {
              const [newId, newNode] = this.newNode(text, null);
              this.state[file.path].nodes[newId] = newNode;
              id = newId;
            }

            this.app.workspace.trigger("loom:switch-to", id);
          })
      )
    );

    const onFileOpen = (file: TFile) => {
      if (file.extension !== "md") return;

      // Load state from storage if not already in memory
      if (!this.state[file.path]) {
        // For document storage, try loading from .loom.json first
        if (this.settings.useDocumentStorage) {
          this.storage.loadNoteState(file).then((loadedState) => {
            if (loadedState) {
              this.state[file.path] = loadedState;
              // Re-trigger file open to update editor decorations
              onFileOpen(file);
            } else {
              // No saved state, initialize new
              this.initializeNoteState(file);
            }
          });
          return; // Wait for async load
        } else {
          // Legacy storage - initialize if missing
          this.initializeNoteState(file);
        }
      }

      const state = this.state[file.path];

      // find this file's `MarkdownView`, then set `this.editor` to its editor
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          leaf.view instanceof MarkdownView &&
          // @ts-ignore
          leaf.view.file.path === file.path
        )
          this.editor = leaf.view.editor;
      });

      // get the length of each ancestor's text,
      // which will be passed to `LoomEditorPlugin` to mark ancestor nodes in the editor
      const ancestors = this.ancestors(file, state.current);
      const ancestorLengths = ancestors.map((id) => [
        id,
        state.nodes[id].text.length,
      ]);

      // set `LoomEditorPlugin`'s state, then refresh it
      // @ts-expect-error
      const plugin = this.editor.cm.plugin(loomEditorPlugin);
      plugin.state = {
        ancestorLengths,
        showNodeBorders: this.settings.showNodeBorders,
      };
      plugin.update();

      // Reapply any cached probe readout for this file
      this.applyProbeReadout(this.probeReadouts[file.path] || null);

      this.refreshViews();
    };

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => file && onFileOpen(file))
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView) this.editor = view.editor;
      })
    );

    this.registerEvent(
      this.app.workspace.on("resize", () => {
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Update in-memory state
        this.state[file.path] = this.state[oldPath];
        delete this.state[oldPath];
        
        // Handle storage-specific rename
        this.storage.handleRename(oldPath, file.path);
        
        // Only save if using legacy storage (document storage handles its own saves)
        if (!this.settings.useDocumentStorage) {
          this.save();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        // Delete from storage
        if (file instanceof TFile) {
          this.storage.deleteNoteState(file);
        }
        
        // Update in-memory state
        delete this.state[file.path];
        
        // Only save if using legacy storage
        if (!this.settings.useDocumentStorage) {
          this.save();
        }
      })
    );

    this.withFile((file) =>
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          leaf.view instanceof MarkdownView &&
          // @ts-ignore
          leaf.view.file.path === file.path
        ) {
          this.editor = leaf.view.editor;
          onFileOpen(file);
        }
      })
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:set-filter", (filter: string) =>
        this.withFile((file) => {
          this.state[file.path].filter = filter;
          // Only refresh the tree views, not the entire UI (to preserve focus)
          this.app.workspace.getLeavesOfType("loom").forEach((leaf) => {
            if (leaf.view instanceof LoomView) {
              const view = leaf.view as LoomView;
              if (view.tree) {
                view.renderTree(view.tree, this.state[file.path]);
              }
            }
          });
          // Save state without re-rendering
          if (this.settings.useDocumentStorage) {
            this.storage.saveNoteState(file, this.state[file.path]);
          } else {
            this.save();
          }
        })
      )
    );
  }

  async complete(file: TFile) {
    const state = this.state[file.path];
    const [parentNode] = this.breakAtPoint(file);
    // switch to the parent node
    this.app.workspace.trigger("loom:switch-to", parentNode);
    this.saveAndRender();

    await this.generate(file, state.current);
  }

  async generateSiblings(file: TFile) {
    const state = this.state[file.path];
    await this.generate(file, state.nodes[state.current].parentId);
  }

  async generate(file: TFile, rootNode: string | null) {
    // show the "Generating..." indicator in the status bar
    this.statusBarItem.style.display = "inline-flex";

    const state = this.state[file.path];

    this.state[file.path].generating = rootNode;

    // show the "Generating..." indicator in the loom view
    this.refreshViews();

    let prompt = `${this.settings.prepend}${this.fullText(file, rootNode)}`;

    // remove a trailing space if there is one
    // store whether there was, so it can be added back post-completion
    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    // replace "\<" with "<", because obsidian tries to render html tags
    // and "\[" with "["
    prompt = prompt.replace(/\\</g, "<").replace(/\\\[/g, "[");

    // the tokenization and completion depend on the provider,
    // so call a different method depending on the provider

    // console.log("prompt", prompt);

    const completionMethods: Record<
      Provider,
      (prompt: string) => Promise<CompletionResult>
    > = {
      cohere: this.completeCohere,
      textsynth: this.completeTextSynth,
      "openai-compat": this.completeOpenAICompat,
      openai: this.completeOpenAI,
      "openai-chat": this.completeOpenAIChat,
      azure: this.completeAzure,
      "azure-chat": this.completeAzureChat,
      anthropic: this.completeAnthropic,
      openrouter: this.completeOpenRouter,
      bedrock: this.completeBedrock,
      probe: this.completeProbe,
    };
    let result;
    try {
      result = await completionMethods[getPreset(this.settings).provider].bind(
        this
      )(prompt);
    } catch (e) {
      new Notice(`Error: ${e}`);
      this.state[file.path].generating = null;
      this.saveAndRender();
      this.statusBarItem.style.display = "none";

      return;
    }
    if (!result.ok) {
      new Notice(`Error ${result.status}: ${result.message}`);
      this.state[file.path].generating = null;
      this.saveAndRender();
      this.statusBarItem.style.display = "none";

      return;
    }
    const rawCompletions = result.completions;

    // console.log("rawCompletions", rawCompletions);

    // escape and clean up the completions
    const completions = rawCompletions.map((completion: string) => {
      if (!completion) completion = ""; // empty completions are null, apparently
      completion = completion.replace(/</g, "\\<"); // escape < for obsidian
      completion = completion.replace(/\[/g, "\\["); // escape [ for obsidian

      // if using a chat provider, always separate the prompt and completion with a space
      // otherwise, deduplicate adjacent spaces between the prompt and completion
      if (
        ["azure-chat", "openai-chat"].includes(
          getPreset(this.settings).provider
        )
      ) {
        if (!trailingSpace) completion = " " + completion;
      } else if (trailingSpace && completion[0] === " ")
        completion = completion.slice(1);

      return completion;
    });

    // create a child of the current node for each completion
    let ids = [];
    for (let completion of completions) {
      const [id, node] = this.newNode(completion, rootNode, true);
      state.nodes[id] = node;
      ids.push(id);
    }

    // switch to the first completion if currently at rootNode
    // or if rootNode is in the ancestry of the current node
    if (
      rootNode &&
      (rootNode === state.current ||
        this.ancestors(file, state.current).includes(rootNode))
    ) {
      this.app.workspace.trigger("loom:switch-to", ids[0]);
    }

    this.state[file.path].generating = null;
    this.saveAndRender();
    this.statusBarItem.style.display = "none";
  }

  addNode(file: TFile, text: string, parentId: string | null) {
    const state = this.state[file.path];
    const [id, node] = this.newNode(text, parentId, true);
    state.nodes[id] = node;
  }

  async exportToHTML(file: TFile, outputPath: string) {
    const state = this.state[file.path];
    
    // Apply current filter if any
    let filteredNodes: Set<string> | null = null;
    if (state.filter) {
      const { include, exclude } = this.parseFilter(state.filter);
      if (include.length > 0 || exclude.length > 0) {
        filteredNodes = this.buildFilteredNodeSet(state, include, exclude);
      }
    }
    
    const html = this.generateHTML(state, file, filteredNodes);
    
    // Resolve the output path properly
    let resolvedPath = outputPath;
    
    // Check if path is absolute (Unix/Mac starts with /, Windows with C:\ etc)
    const isAbsolute = outputPath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(outputPath);
    
    if (!isAbsolute) {
      // Relative path - place it next to the source markdown file
      const sourceDir = file.parent ? file.parent.path : '';
      resolvedPath = sourceDir ? `${sourceDir}/${outputPath}` : outputPath;
    }
    
    // Use untildify to expand ~ in paths
    const finalPath = untildify(resolvedPath);
    
    console.log(`Resolved export path: "${outputPath}" -> "${finalPath}"`);
    
    try {
      if (!isAbsolute) {
        // For relative paths, save in the vault using Obsidian's adapter
        let vaultRelativePath: string;
        
        // Save next to the source file or in vault root
        vaultRelativePath = file.parent ? `${file.parent.path}/${outputPath}` : outputPath;
        
        await this.app.vault.adapter.write(vaultRelativePath, html);
        console.log(`Successfully exported using vault adapter: ${vaultRelativePath}`);
      } else {
        // For absolute paths, use direct filesystem access
        fs.writeFileSync(finalPath, html);
        console.log(`Successfully exported using fs: ${finalPath}`);
      }
    } catch (error) {
      console.error('Export error:', error);
      // Try fallback: save in vault root with just the filename
      try {
        await this.app.vault.adapter.write(outputPath, html);
        console.log(`Successfully exported to vault root: ${outputPath}`);
      } catch (fallbackError) {
        console.error('Vault fallback also failed:', fallbackError);
        throw new Error(`Cannot write export file. Try entering a full path like "~/Desktop/${outputPath}" or just "${outputPath}" to save in your vault.`);
      }
    }
  }

  detectNodeType(node: Node): string {
    // If explicitly set, use that
    if (node.nodeType) return node.nodeType;
    
    // Heuristic detection based on node characteristics
    if (node.generationModel || node.generationParameters) {
      return 'ai-generated';
    }
    
    // Default heuristic: nodes with parents are likely AI-generated responses
    // Root nodes are typically user-created prompts
    if (node.parentId) {
      return 'ai-generated';
    }
    
    // Root nodes are typically user-created
    return 'user-created';
  }

  parseFilter(filterStr: string): { include: string[], exclude: string[] } {
    const include: string[] = [];
    const exclude: string[] = [];
    
    if (!filterStr.trim()) return { include, exclude };
    
    const parts = filterStr.trim().split(/\s+/);
    for (const part of parts) {
      if (part.startsWith('+')) {
        include.push(part.slice(1));
      } else if (part.startsWith('-')) {
        exclude.push(part.slice(1));
      } else if (part.trim()) {
        include.push(part);
      }
    }
    
    return { include, exclude };
  }

  buildFilteredNodeSet(state: NoteState, include: string[], exclude: string[]): Set<string> {
    if (include.length === 0 && exclude.length === 0) {
      return new Set(Object.keys(state.nodes));
    }
    
    const directMatches = new Set<string>();
    const toHide = new Set<string>();
    
    // Find nodes that directly match the filter
    for (const [id, node] of Object.entries(state.nodes)) {
      if (this.nodeMatchesFilter(node, include, exclude)) {
        directMatches.add(id);
      }
    }
    
    // Hide excluded nodes and descendants
    for (const [id, node] of Object.entries(state.nodes)) {
      const nodeTags = node.tags || [];
      if (exclude.some(tag => nodeTags.includes(tag))) {
        const hideDescendants = (nodeId: string) => {
          toHide.add(nodeId);
          for (const [childId, childNode] of Object.entries(state.nodes)) {
            if (childNode.parentId === nodeId) {
              hideDescendants(childId);
            }
          }
        };
        hideDescendants(id);
      }
    }
    
    // Include ancestors of direct matches for tree connectivity
    const toShow = new Set<string>();
    for (const matchId of directMatches) {
      if (!toHide.has(matchId)) {
        let currentId: string | null = matchId;
        while (currentId) {
          if (!toHide.has(currentId)) {
            toShow.add(currentId);
          }
          currentId = state.nodes[currentId]?.parentId || null;
        }
      }
    }
    
    return toShow;
  }

  nodeMatchesFilter(node: Node, include: string[], exclude: string[]): boolean {
    const nodeTags = node.tags || [];
    
    // Must have all included tags
    for (const tag of include) {
      if (!nodeTags.includes(tag)) return false;
    }
    
    // Must not have any excluded tags
    for (const tag of exclude) {
      if (nodeTags.includes(tag)) return false;
    }
    
    return true;
  }

  generateHTML(state: NoteState, file: TFile, filteredNodes: Set<string> | null): string {
    const rootNodes = Object.entries(state.nodes)
      .filter(([id, node]) => node.parentId === null && (!filteredNodes || filteredNodes.has(id)))
      .map(([id]) => id);

    const escapeHtml = (text: string) => {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    const formatTimestamp = (timestamp?: number) => {
      if (!timestamp) return '';
      return new Date(timestamp).toLocaleString();
    };

        const renderNodeHTML = (nodeId: string, depth: number = 0): string => {
      const node = state.nodes[nodeId];
      if (!node || (filteredNodes && !filteredNodes.has(nodeId))) return '';

      const children = Object.entries(state.nodes)
        .filter(([id, childNode]) => childNode.parentId === nodeId && (!filteredNodes || filteredNodes.has(id)))
        .map(([id]) => id);

      // Detect node type for visual indicators
      const nodeType = node.nodeType || this.detectNodeType(node);
      const nodeTypeClass = `node-type-${nodeType}`;
      const nodeTypeIcon = nodeType === 'ai-generated' ? '🤖' : nodeType === 'user-edited' ? '✏️' : '👤';

      const tagsHtml = (node.tags || []).length > 0 
        ? `<div class="node-tags">${(node.tags || []).map(tag => 
            `<span class="tag tag-${tag}">${tag}</span>`
          ).join('')}</div>`
        : '';

      const metadataHtml = `<div class="node-metadata">
          <span class="node-type-indicator" title="${nodeType}">${nodeTypeIcon}</span>
          ${node.created ? `<span class="created">Created: ${formatTimestamp(node.created)}</span>` : ''}
          ${node.lastVisited ? `<span class="last-visited">Last visited: ${formatTimestamp(node.lastVisited)}</span>` : ''}
          ${node.generationModel ? `<span class="model">Model: ${node.generationModel}</span>` : ''}
        </div>`;

      const childrenHtml = children.length > 0 
        ? `<div class="node-children">${children.map(childId => renderNodeHTML(childId, depth + 1)).join('')}</div>`
        : '';

      return `
        <div class="node ${nodeTypeClass}" data-node-id="${nodeId}" data-depth="${depth}">
         <div class="node-header">
           ${children.length > 0 ? '<button class="collapse-button" onclick="toggleCollapse(this)">▼</button>' : ''}
           <div class="node-content">
             <div class="node-text">${escapeHtml(node.text || 'No text')}</div>
             ${tagsHtml}
             ${metadataHtml}
           </div>
         </div>
         ${childrenHtml}
       </div>
     `;
    };

    const treeHtml = rootNodes.map(rootId => renderNodeHTML(rootId)).join('');

    const currentNodeText = state.current ? this.fullText(file, state.current) : '';

    // Generate full text for all nodes for JavaScript access
    const nodeFullTexts: Record<string, string> = {};
    for (const nodeId of Object.keys(state.nodes)) {
      nodeFullTexts[nodeId] = this.fullText(file, nodeId);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Loom Export: ${escapeHtml(file.basename)}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            background: #1e1e1e;
            color: #d4d4d4;
            display: flex;
            height: 100vh;
        }
        
        .sidebar {
            width: 350px;
            background: #252526;
            border-right: 1px solid #3e3e42;
            overflow-y: auto;
            padding: 20px;
            box-sizing: border-box;
        }
        
        .main-content {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            background: #1e1e1e;
        }
        
        .header {
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid #3e3e42;
        }
        
        .header h1 {
            margin: 0;
            color: #569cd6;
            font-size: 1.5em;
        }
        
        .node {
            margin: 8px 0;
            border-left: 2px solid transparent;
            transition: all 0.2s ease;
        }
        
        .node:hover {
            border-left-color: #569cd6;
        }
        
        .node.active {
            border-left-color: #569cd6;
            background: rgba(86, 156, 214, 0.1);
        }
        
        .node-header {
            display: flex;
            align-items: flex-start;
            cursor: pointer;
            padding: 8px;
            border-radius: 4px;
        }
        
        .node-header:hover {
            background: rgba(255, 255, 255, 0.05);
        }
        
        .collapse-button {
            background: none;
            border: none;
            color: #d4d4d4;
            cursor: pointer;
            margin-right: 8px;
            padding: 0;
            width: 16px;
            text-align: center;
            transition: transform 0.2s ease;
        }
        
        .collapse-button.collapsed {
            transform: rotate(-90deg);
        }
        
        .node-content {
            flex: 1;
            min-width: 0;
        }
        
        .node-text {
            white-space: pre-wrap;
            word-wrap: break-word;
            margin-bottom: 4px;
            line-height: 1.4;
        }
        
        .node-tags {
            margin: 4px 0;
        }
        
        .tag {
            display: inline-block;
            background: #3e3e42;
            color: #d4d4d4;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.8em;
            margin-right: 4px;
        }
        
        .tag-fav { background: #f9e71e; color: #000; }
        .tag-to_continue { background: #569cd6; }
        .tag-private { background: #f44747; }
        
        .node-metadata {
            font-size: 0.7em;
            color: #969696;
            margin-top: 4px;
        }
        
        .node-metadata span {
            margin-right: 8px;
        }
        
        .node-type-indicator {
            font-size: 1em;
            margin-right: 8px;
        }
        
        .node-type-ai-generated { border-left-color: #569cd6; }
        .node-type-user-edited { border-left-color: #ff9800; }
        .node-type-user-created { border-left-color: #4caf50; }
        
        .node-children {
            margin-left: 20px;
            border-left: 1px solid #3e3e42;
            padding-left: 8px;
        }
        
        .node-children.collapsed {
            display: none;
        }
        
        .current-text {
            background: #252526;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            padding: 20px;
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.6;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        }
        
        .export-info {
            margin-bottom: 20px;
            padding: 10px;
            background: rgba(86, 156, 214, 0.1);
            border-radius: 4px;
            font-size: 0.9em;
        }
        
        @media (max-width: 768px) {
            body { flex-direction: column; }
            .sidebar { width: 100%; height: 40vh; }
            .main-content { height: 60vh; }
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="header">
            <h1>${escapeHtml(file.basename)}</h1>
        </div>
        <div class="tree">
            ${treeHtml}
        </div>
    </div>
    
    <div class="main-content">
        <div class="export-info">
            <strong>Loom Export</strong><br>
            Generated: ${new Date().toLocaleString()}<br>
            ${filteredNodes ? `Filtered nodes: ${filteredNodes.size} of ${Object.keys(state.nodes).length}` : `Total nodes: ${Object.keys(state.nodes).length}`}
        </div>
        
        <div class="current-text" id="current-text">
            ${escapeHtml(currentNodeText)}
        </div>
    </div>
    
    <script>
        // Full text data for each node
        const nodeFullTexts = ${JSON.stringify(nodeFullTexts)};
        
        function toggleCollapse(button) {
            button.classList.toggle('collapsed');
            const nodeChildren = button.closest('.node').querySelector('.node-children');
            if (nodeChildren) {
                nodeChildren.classList.toggle('collapsed');
            }
        }
        
        function selectNode(nodeId) {
            // Remove active class from all nodes
            document.querySelectorAll('.node').forEach(n => n.classList.remove('active'));
            
            // Add active class to selected node
            const selectedNode = document.querySelector(\`[data-node-id="\${nodeId}"]\`);
            if (selectedNode) {
                selectedNode.classList.add('active');
                
                // Update main content with node's full path text
                const fullText = nodeFullTexts[nodeId] || 'No text available';
                document.getElementById('current-text').textContent = fullText;
                
                // Scroll the main content to top
                document.querySelector('.main-content').scrollTop = 0;
            }
        }
        
        // Add click handlers to nodes
        document.querySelectorAll('.node-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.classList.contains('collapse-button')) return;
                
                const nodeId = header.closest('.node').dataset.nodeId;
                selectNode(nodeId);
            });
        });
        
        // Select the current node on load
        if ('${state.current}') {
            selectNode('${state.current}');
        } else {
            // If no current node, select the first root node
            const firstRoot = document.querySelector('.node');
            if (firstRoot) {
                selectNode(firstRoot.dataset.nodeId);
            }
        }
    </script>
</body>
</html>`;
  }

  async completeCohere(prompt: string) {
    if (this.settings.logApiCalls) {
      console.log("Cohere request:", {
        model: getPreset(this.settings).model,
        prompt,
        max_tokens: this.settings.maxTokens,
        num_generations: this.settings.n,
        temperature: this.settings.temperature,
        p: this.settings.topP,
        frequency_penalty: this.settings.frequencyPenalty,
        presence_penalty: this.settings.presencePenalty,
      });
    }

    const tokens = (await cohere.tokenize({ text: prompt })).body.token_strings;
    prompt = tokens.slice(-getPreset(this.settings).contextLength).join("");

    const response = await cohere.generate({
      model: getPreset(this.settings).model,
      prompt,
      max_tokens: this.settings.maxTokens,
      num_generations: this.settings.n,
      temperature: this.settings.temperature,
      p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    });

    if (this.settings.logApiCalls) {
      console.log("Cohere response:", response);
    }

    const result: CompletionResult =
      response.statusCode === 200
        ? {
            ok: true,
            completions: response.body.generations.map(
              (generation) => generation.text
            ),
          }
        : {
            ok: false,
            status: response.statusCode!,
            message: "",
          };
    return result;
  }

  async completeTextSynth(prompt: string) {
    const body = {
      prompt,
      max_tokens: this.settings.maxTokens,
      best_of: this.settings.bestOf,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    };

    if (this.settings.logApiCalls) {
      console.log("TextSynth request:", body);
    }

    const response = await requestUrl({
      url: `https://api.textsynth.com/v1/engines/${
        getPreset(this.settings).model
      }/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getPreset(this.settings).apiKey}`,
      },
      throw: false,
      body: JSON.stringify(body),
    });

    if (this.settings.logApiCalls) {
      console.log("TextSynth response:", response);
    }

    let result: CompletionResult;
    if (response.status === 200) {
      const completions =
        this.settings.n === 1 ? [response.json.text] : response.json.text;
      result = { ok: true, completions };
    } else {
      result = {
        ok: false,
        status: response.status,
        message: response.json.error || "Unknown error",
      };
    }
    return result;
  }

  trimOpenAIPrompt(prompt: string) {
    const cl100kModels = [
      "gpt-4-32k",
      "gpt-4-0314",
      "gpt-4-32k-0314",
      "gpt-3.5-turbo",
      "gpt-3.5-turbo-0301",
      "gpt-4-base",
      // TODO: llama 3.1 has "28k additional multilingual tokens", so cl100k is not exactly right
      "meta-llama/llama-3.1-8b",
      "meta-llama/llama-3.1-70b",
      "meta-llama/llama-3.1-405b",
      "meta-llama/llama-3.1-8b-instruct",
      "meta-llama/llama-3.1-70b-instruct",
      "meta-llama/llama-3.1-405b-instruct",
      "meta-llama/Meta-Llama-3.1-405B",
      "meta-llama/Meta-Llama-3.1-405B-FP8",
    ];
    const p50kModels = [
      "text-davinci-003",
      "text-davinci-002",
      "code-davinci-002",
      "code-davinci-001",
      "code-cushman-002",
      "code-cushman-001",
      "davinci-codex",
      "cushman-codex",
    ];
    // const r50kModels = ["text-davinci-001", "text-curie-001", "text-babbage-001", "text-ada-001", "davinci", "curie", "babbage", "ada"];

    let tokenizer;
    if (cl100kModels.includes(getPreset(this.settings).model))
      tokenizer = cl100k;
    else if (p50kModels.includes(getPreset(this.settings).model))
      tokenizer = p50k;
    else tokenizer = r50k; // i expect that an unknown model will most likely be r50k

    return tokenizer.decode(
      tokenizer
        .encode(prompt, { disallowedSpecial: new Set() })
        .slice(
          -(getPreset(this.settings).contextLength - this.settings.maxTokens)
        )
    );
  }

  async completeOpenAICompat(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);

    // @ts-expect-error TODO
    let url = getPreset(this.settings).url;

    if (!(url.startsWith("http://") || url.startsWith("https://")))
      url = "https://" + url;
    if (!url.endsWith("/")) url += "/";
    url = url.replace(/v1\//, "");
    url += "v1/completions";
    
    let body: any = {
      prompt,
      model: getPreset(this.settings).model,
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
    };
    if (this.settings.bestOf > this.settings.n) {
      body.best_of = this.settings.bestOf;
    }
    if (this.settings.frequencyPenalty !== 0)
      body.frequency_penalty = this.settings.frequencyPenalty;
    if (this.settings.presencePenalty !== 0)
      body.presence_penalty = this.settings.presencePenalty;

    if (this.settings.logApiCalls) {
      console.log("OpenAI-compatible API request:", {
        url,
        body
      });
    }

    const response = await requestUrl({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${getPreset(this.settings).apiKey}`,
        "Content-Type": "application/json",
      },
      throw: false,
      body: JSON.stringify(body),
    });

    if (this.settings.logApiCalls) {
      console.log("OpenAI-compatible API response:", response);
    }

    const result: CompletionResult =
      response.status === 200
        ? {
            ok: true,
            completions: response.json.choices.map(
              (choice: any) => choice.text
            ),
          }
        : { 
            ok: false, 
            status: response.status, 
            message: response.json?.error?.message || "Unknown error" 
          };

    if (!result.ok && this.settings.logApiCalls) {
      console.error("OpenAI-compatible error:", response);
    }

    return result;
  }

  async completeOpenRouter(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);

    let body: any = {
      prompt,
      model: getPreset(this.settings).model,
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      best_of: this.settings.bestOf,
      provider: {
        // @ts-expect-error
        quantizations: [getPreset(this.settings).quantization]
      }
    };
    if (this.settings.frequencyPenalty !== 0)
      body.frequency_penalty = this.settings.frequencyPenalty;
    if (this.settings.presencePenalty !== 0)
      body.presence_penalty = this.settings.presencePenalty;

    if (this.settings.logApiCalls) {
      console.log("OpenRouter request:", body);
    }

    const requests = Array(this.settings.n).fill(null).map(() =>
      requestUrl({
        url: "https://openrouter.ai/api/v1/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${getPreset(this.settings).apiKey}`,
          "HTTP-Referer": "https://github.com/cosmicoptima/loom",
          "X-Title": "Loomsidian",
          "Content-Type": "application/json",
        },
        throw: false,
        body: JSON.stringify(body),
      })
    );

    const responses = await Promise.all(requests);

    if (this.settings.logApiCalls) {
      console.log("OpenRouter responses:", responses);
    }

    const result: CompletionResult = responses.every(response => !response.json.hasOwnProperty('error'))
      ? {
          ok: true,
          completions: responses.map(response => response.json.choices[0].text),
        }
      : {
          ok: false,
          status: responses[0].json.error.code,
          message: responses[0].json.error.message,
        };
    return result;
  }

  probeServerUrl(): string | null {
    // @ts-expect-error — url exists only on probe preset
    let url: string = getPreset(this.settings)?.url || "";
    if (!url) return null;
    if (!(url.startsWith("http://") || url.startsWith("https://")))
      url = "http://" + url;
    return url.replace(/\/+$/, "");
  }

  buildIntervention() {
    const s = this.settings;
    if (s.steeringType === "none" || !s.steeringProbe) return null;
    return {
      type: s.steeringType,
      probe: s.steeringProbe,
      probe_index: s.steeringProbeIndex,
      strength: s.steeringStrength,
      renorm: s.steeringRenorm,
    };
  }

  async fetchProbeConfig(url: string, apiKey: string): Promise<ProbeConfig | null> {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const response = await requestUrl({
        url: `${url}/v1/config`,
        method: "GET",
        headers,
        throw: false,
      });
      if (response.status !== 200) return null;
      return response.json as ProbeConfig;
    } catch (e) {
      console.error("Failed to fetch probe config:", e);
      return null;
    }
  }

  async refreshProbeConfig() {
    const url = this.probeServerUrl();
    if (!url) {
      new Notice("No probe server URL set.");
      return;
    }
    const preset = getPreset(this.settings);
    const config = await this.fetchProbeConfig(url, preset.apiKey || "");
    if (!config) {
      new Notice(`Failed to fetch probe config from ${url}`);
      return;
    }
    this.settings.probeConfigs[url] = config;
    if (!this.settings.steeringProbe && config.probes.length > 0) {
      this.settings.steeringProbe = config.probes[0].name;
    }
    await this.saveAndRender();
    new Notice(`Loaded ${config.probes.length} probe set(s) from ${config.model}`);
  }

  async singleProbeCompletion(
    url: string,
    apiKey: string,
    prompt: string,
    intervention: any,
  ): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
    const body: any = {
      prompt,
      stream: true,
      max_tokens: this.settings.maxTokens,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      probes: [],
    };
    if (intervention) body.intervention = intervention;

    if (this.settings.logApiCalls) {
      console.log("Probe server request:", { url, body });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${url}/v1/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, status: 0, message: String(e) };
    }

    if (!response.ok || !response.body) {
      const message = await response.text().catch(() => "");
      return { ok: false, status: response.status, message: message || "Request failed" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0];
          if (delta?.text) text += delta.text;
          else if (delta?.delta?.content) text += delta.delta.content;
        } catch {
          // keepalive or partial — ignore
        }
      }
    }

    return { ok: true, text };
  }

  async completeProbe(prompt: string): Promise<CompletionResult> {
    const url = this.probeServerUrl();
    if (!url) {
      return { ok: false, status: 0, message: "Probe server URL is not set." };
    }
    const apiKey = getPreset(this.settings).apiKey || "";
    const intervention = this.buildIntervention();

    const requests = Array(this.settings.n)
      .fill(null)
      .map(() => this.singleProbeCompletion(url, apiKey, prompt, intervention));
    const results = await Promise.all(requests);

    const failed = results.find((r) => !r.ok) as
      | { ok: false; status: number; message: string }
      | undefined;
    if (failed) {
      return { ok: false, status: failed.status, message: failed.message };
    }
    return {
      ok: true,
      completions: results.map((r) => (r as { ok: true; text: string }).text),
    };
  }

  async probeDocument(file: TFile) {
    const url = this.probeServerUrl();
    if (!url) {
      new Notice("No probe server URL set — select a probe-server preset.");
      return;
    }
    const probeName = this.settings.steeringProbe;
    if (!probeName) {
      new Notice("No probe selected. Click \"Refresh probes\" in Settings → Loom.");
      return;
    }
    const config = this.settings.probeConfigs[url];
    if (!config) {
      new Notice("No probe config cached. Click \"Refresh probes\" first.");
      return;
    }
    const probeInfo = config.probes.find((p) => p.name === probeName);
    if (!probeInfo) {
      new Notice(`Probe "${probeName}" not found on server.`);
      return;
    }

    const text = this.editor.getValue();
    if (!text.trim()) {
      new Notice("Document is empty.");
      return;
    }

    const preset = getPreset(this.settings);
    const apiKey = preset.apiKey || "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const body = {
      texts: [text],
      layers: [probeInfo.layer],
      project: [probeName],
      aggregate: "tokens",
      skip_tokens: 1,
      max_length: Math.max(2048, Math.min(32768, text.length)),
      return_tokens: true,
    };

    this.statusBarItem.style.display = "inline-flex";
    new Notice("Probing document...");

    let response;
    try {
      response = await requestUrl({
        url: `${url}/v1/encode`,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        throw: false,
      });
    } catch (e) {
      this.statusBarItem.style.display = "none";
      new Notice(`Probe request failed: ${e}`);
      return;
    }
    this.statusBarItem.style.display = "none";

    if (response.status !== 200) {
      new Notice(`Probe failed (${response.status}): ${response.text?.slice(0, 200) || ""}`);
      return;
    }

    console.log("[loom probe] encode response keys:", Object.keys(response.json));
    const result = response.json.results?.[0];
    if (!result) {
      new Notice("Probe response missing results.");
      return;
    }
    console.log("[loom probe] result keys:", Object.keys(result));
    const layerKey = `layer_${probeInfo.layer}`;
    const probeMatrix: number[][] = result[layerKey]?.[probeName];
    const tokens: string[] =
      result.tokens ||
      response.json.token_strings?.[0] ||
      response.json.tokens?.[0] ||
      result.token_strings ||
      [];
    console.log(
      `[loom probe] matrix=${probeMatrix?.length}×${probeMatrix?.[0]?.length}, tokens=${tokens.length}`
    );
    console.log(
      "[loom probe] first 15 tokens (JSON):",
      JSON.stringify(tokens.slice(0, 15))
    );
    console.log(
      "[loom probe] doc head (JSON):",
      JSON.stringify(this.editor.getValue().slice(0, 80))
    );
    if (!probeMatrix || !tokens.length) {
      new Notice("Probe response missing per-token data (check server return_tokens support).");
      console.error("Encode result:", response.json);
      return;
    }

    // Server returns `tokens` already aligned 1:1 with projection rows.
    const n = Math.min(tokens.length, probeMatrix.length);

    const readout: ProbeReadout = {
      tokens: tokens.slice(0, n),
      projections: probeMatrix.slice(0, n),
      labels: probeInfo.labels,
      probeName,
      selectedIndex: this.settings.steeringProbeIndex,
    };
    this.probeReadouts[file.path] = readout;
    this.applyProbeReadout(readout);
    new Notice(`Probed ${n} tokens with ${probeName}`);
  }

  applyProbeReadout(readout: ProbeReadout | null) {
    if (!this.editor) return;
    // @ts-expect-error — cm is CodeMirror view
    const cmView = this.editor.cm;
    if (!cmView) return;
    cmView.dispatch({
      effects: setProbeReadoutEffect.of(readout),
    });
  }

  clearProbeReadout(file: TFile) {
    delete this.probeReadouts[file.path];
    this.applyProbeReadout(null);
  }

  async completeOpenAI(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    const body = {
      model: getPreset(this.settings).model,
      prompt,
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    };

    if (this.settings.logApiCalls) {
      console.log("OpenAI request:", body);
    }

    let result: CompletionResult;
    try {
      const response = await this.openai.createCompletion(body);
      if (this.settings.logApiCalls) {
        console.log("OpenAI response:", response);
      }
      result = {
        ok: true,
        completions: response.data.choices.map((choice) => choice.text || ""),
      };
    } catch (e) {
      if (this.settings.logApiCalls) {
        console.error("OpenAI error:", e);
      }
      result = {
        ok: false,
        status: e.response.status,
        message: e.response.data.error.message || "Unknown error",
      };
    }
    return result;
  }

  async completeOpenAIChat(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    const body = {
      model: getPreset(this.settings).model,
      messages: [{ role: "assistant" as const, content: prompt }],
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    };

    if (this.settings.logApiCalls) {
      console.log("OpenAI Chat request:", body);
    }

    let result: CompletionResult;
    try {
      const response = await this.openai.createChatCompletion(body);
      if (this.settings.logApiCalls) {
        console.log("OpenAI Chat response:", response);
      }
      result = {
        ok: true,
        completions: response.data.choices.map(
          (choice) => choice.message?.content || ""
        ),
      };
    } catch (e) {
      if (this.settings.logApiCalls) {
        console.error("OpenAI Chat error:", e);
      }
      result = {
        ok: false,
        status: e.response.status,
        message: e.response.data.error.message || "Unknown error",
      };
    }
    return result;
  }

  async completeAzure(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    const body = {
      model: getPreset(this.settings).model,
      prompt,
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    };

    if (this.settings.logApiCalls) {
      console.log("Azure request:", body);
    }

    let result: CompletionResult;
    try {
      const response = await this.azure.createCompletion(body);
      if (this.settings.logApiCalls) {
        console.log("Azure response:", response);
      }
      result = {
        ok: true,
        completions: response.data.choices.map((choice) => choice.text || ""),
      };
    } catch (e) {
      if (this.settings.logApiCalls) {
        console.error("Azure error:", e);
      }
      result = {
        ok: false,
        status: e.response.status,
        message: e.response.data.error.message || "Unknown error",
      };
    }
    return result;
  }

  async completeAzureChat(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    const body = {
      model: getPreset(this.settings).model,
      messages: [{ role: "assistant" as const, content: prompt }],
      max_tokens: this.settings.maxTokens,
      n: this.settings.n,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
    };

    if (this.settings.logApiCalls) {
      console.log("Azure Chat request:", body);
    }

    let result: CompletionResult;
    try {
      const response = await this.azure.createChatCompletion(body);
      if (this.settings.logApiCalls) {
        console.log("Azure Chat response:", response);
      }
      result = {
        ok: true,
        completions: response.data.choices.map(
          (choice) => choice.message?.content || ""
        ),
      };
    } catch (e) {
      if (this.settings.logApiCalls) {
        console.error("Azure Chat error:", e);
      }
      result = {
        ok: false,
        status: e.response.status,
        message: e.response.data.error.message || "Unknown error",
      };
    }
    return result;
  }

  async completeAnthropic(prompt: string) {
    const completions = await Promise.all(
      [...Array(this.settings.n).keys()].map(async () => {
        return await this.getAnthropicResponse(prompt);
      })
    );

    const result: CompletionResult = { ok: true, completions };
    return result;
  }

  async getAnthropicResponse(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    // let result: CompletionResult;
    const body = JSON.stringify(
      {
        model: getPreset(this.settings).model,
        max_tokens: this.settings.maxTokens,
        temperature: this.settings.temperature,
        system: this.settings.systemPrompt,
        messages: [
          { role: "user", content: `${this.settings.userMessage}` },
          { role: "assistant", content: `${prompt}` },
        ],
      },
      null,
      2
    );
    

    
    if (this.settings.logApiCalls) {
      console.log(`request body: ${body}`);
    }
    try {
      const response = await requestUrl({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": this.anthropicApiKey,
        },
        body,
      });

      if (response.status !== 200) {
        console.error("response", response);
        return null;
      }

      const result = response.json.content[0]?.text || "<no text>";

      // ? { ok: true, completions: [response.json.content[0]?.text || "<no text>"] }
      // : { ok: false, status: response.status, message: "" };

      if (this.settings.logApiCalls) {
        console.log(result);
      }

      return result;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async completeBedrock(prompt: string) {
    const completions = await Promise.all(
      [...Array(this.settings.n).keys()].map(async () => {
        return await this.getBedrockResponse(prompt);
      })
    );

    const result: CompletionResult = { ok: true, completions };
    return result;
  }

  async getBedrockResponse(prompt: string) {
    prompt = this.trimOpenAIPrompt(prompt);
    const preset = getPreset(this.settings);
    // @ts-expect-error - Bedrock preset has region property
    const region = preset.region || 'us-east-1';

    if (!preset.apiKey.includes(':')) {
      throw new Error('Bedrock API key must be in format: accessKeyId:secretAccessKey');
    }
    
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.settings.maxTokens,
      temperature: this.settings.temperature,
      system: this.settings.systemPrompt,
      messages: [
        { role: "user", content: `${this.settings.userMessage}` },
        { role: "assistant", content: `${prompt}` },
      ],
    });

    if (this.settings.logApiCalls) {
      console.log(`Bedrock request body: ${body}`);
    }

    // Try direct HTTP implementation first, with Node.js fallback
    // AWS SDK doesn't work reliably in Obsidian's Electron renderer process
    try {
      return await this.getBedrockResponseDirect(prompt);
    } catch (obsidianError) {
      // Fallback to Node.js https if Obsidian requestUrl fails
      return await this.getBedrockResponseNodeJS(prompt);
    }
  }

  async getBedrockResponseDirect(prompt: string) {
    // Fallback implementation using direct HTTP requests with AWS signature v4
    prompt = this.trimOpenAIPrompt(prompt);
    const preset = getPreset(this.settings);
    
    if (!preset.apiKey.includes(':')) {
      throw new Error('Bedrock API key must be in format: accessKeyId:secretAccessKey');
    }
    
    const [accessKeyId, secretAccessKey] = preset.apiKey.split(':');
    // @ts-expect-error - Bedrock preset has region property
    const region = preset.region || 'us-east-1';
    
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.settings.maxTokens,
      temperature: this.settings.temperature,
      system: this.settings.systemPrompt,
      messages: [
        { role: "user", content: `${this.settings.userMessage}` },
        { role: "assistant", content: `${prompt}` },
      ],
    });

    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const url = `https://${host}/model/${preset.model}/invoke`;
    
    // Create AWS signature v4
    const awsSignature = this.createAwsSignature({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body,
      accessKeyId,
      secretAccessKey,
      region,
      service: 'bedrock'  // AWS requires 'bedrock' for credential scope
    });

    try {
      const response = await requestUrl({
        url,
        method: 'POST',
        headers: awsSignature.headers,
        body,
      });

      if (response.status !== 200) {
        let errorMessage = 'Unknown error';
        if (response.json && response.json.message) {
          errorMessage = response.json.message;
        } else if (response.text) {
          errorMessage = response.text;
        }
        throw new Error(`Bedrock API error: ${response.status} - ${errorMessage}`);
      }

      return response.json?.content?.[0]?.text || "<no text>";
      
    } catch (e) {
      throw e;
    }
  }

  async getBedrockResponseNodeJS(prompt: string) {
    // Alternative implementation using Node.js built-ins (https module)
    prompt = this.trimOpenAIPrompt(prompt);
    const preset = getPreset(this.settings);
    // @ts-expect-error - Bedrock preset has region property
    const region = preset.region || 'us-east-1';

    if (!preset.apiKey.includes(':')) {
      throw new Error('Bedrock API key must be in format: accessKeyId:secretAccessKey');
    }
    
    const [accessKeyId, secretAccessKey] = preset.apiKey.split(':');
    
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.settings.maxTokens,
      temperature: this.settings.temperature,
      system: this.settings.systemPrompt,
      messages: [
        { role: "user", content: `${this.settings.userMessage}` },
        { role: "assistant", content: `${prompt}` },
      ],
    });

    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const url = `https://${host}/model/${preset.model}/invoke`;
    
    // Create AWS signature v4
    const awsSignature = this.createAwsSignature({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body,
      accessKeyId,
      secretAccessKey,
      region,
      service: 'bedrock'
    });

    return new Promise<string>((resolve, reject) => {
      const https = require('https');
      const urlObj = new URL(url);
      
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: awsSignature.headers,
      };

      const req = https.request(options, (res: any) => {
        let responseBody = '';
        
        res.on('data', (chunk: any) => {
          responseBody += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(responseBody);
              const result = parsed.content[0]?.text || "<no text>";
              resolve(result);
            } catch (parseError) {
              reject(new Error(`Failed to parse response: ${parseError}`));
            }
          } else {
            reject(new Error(`Bedrock error ${res.statusCode}: ${responseBody}`));
          }
        });
      });
      
      req.on('error', (error: any) => {
        reject(error);
      });
      
      req.write(body);
      req.end();
    });
  }

  createAwsSignature(params: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service: string;
  }) {
    const crypto = require('crypto');
    
    const { method, url, headers, body, accessKeyId, secretAccessKey, region, service } = params;
    const urlParts = new URL(url);
    const host = urlParts.hostname;
    // URL encode the path properly for AWS signature
    const path = encodeURI(urlParts.pathname).replace(/:/g, '%3A');
    const queryString = urlParts.search.substring(1); // Remove leading ?
    
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    
    // Build canonical headers (must be sorted)
    const requiredHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-date': amzDate
    };
    
    const canonicalHeaderNames = Object.keys(requiredHeaders).sort();
    const canonicalHeaders = canonicalHeaderNames
      .map(name => `${name}:${requiredHeaders[name]}`)
      .join('\n') + '\n';
    
    const signedHeaders = canonicalHeaderNames.join(';');
    
    // Build canonical request
    const canonicalRequest = [
      method.toUpperCase(),
      path,
      queryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');
    
    // Build string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');
    
    // Generate signing key
    const getSignatureKey = (key: string, dateStamp: string, regionName: string, serviceName: string) => {
      const kDate = crypto.createHmac('sha256', 'AWS4' + key).update(dateStamp).digest();
      const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
      const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
      const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
      return kSigning;
    };
    
    const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    
    const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    return {
      headers: {
        'Content-Type': 'application/json',
        'X-Amz-Date': amzDate,
        'Authorization': authorizationHeader
      }
    };
  }

  async loadSettings() {
    const settings = (await this.loadData())?.settings || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async loadState() {
    // Initialize storage based on settings
    if (this.settings.useDocumentStorage) {
      this.storage = new DocumentStorage(this.app, this.settings);
    } else {
      // Load legacy state first
      const legacyState = (await this.loadData())?.state || {};
      this.state = legacyState;
      this.storage = new LegacyStorage(this.app, this, this.state);
    }
    
    // Load all states through storage interface
    this.state = await this.storage.loadAllStates();
  }

  async save() {
    // Save settings separately (always using the plugin's data.json)
    await this.saveData({ settings: this.settings, state: this.state });
    
    // If using document storage, we only save settings to data.json
    if (this.settings.useDocumentStorage) {
      await this.saveData({ settings: this.settings, state: {} });
    }
    
    this.initializeProviders();
  }

  // Add this new method to properly refresh all views
  private refreshViews() {
    // Refresh Loom views
    this.app.workspace.getLeavesOfType("loom").forEach((leaf) => {
      if (leaf.view instanceof LoomView) {
        leaf.view.render();
      }
    });

    // Refresh Loom siblings views  
    this.app.workspace.getLeavesOfType("loom-siblings").forEach((leaf) => {
      if (leaf.view instanceof LoomSiblingsView) {
        leaf.view.render();
      }
    });
  }

  // Update saveAndRender to use the new refresh method
  async saveAndRender() {
    // When using document storage, we need to save the current file's state
    if (this.settings.useDocumentStorage) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && this.state[activeFile.path]) {
        await this.storage.saveNoteState(activeFile, this.state[activeFile.path]);
      }
    } else {
      // Legacy behavior - save everything
      await this.save();
    }

    if (this.rendering) return;
    this.rendering = true;

    this.refreshViews();

    this.rendering = false;
  }

  async onunload() {
    // Clean up document storage if it exists
    if (this.storage && this.storage.getType() === 'document') {
      (this.storage as DocumentStorage).destroy();
    }
  }

  /**
   * Convert legacy monolithic state to per-document `.loom.json` files.
   */
  async migrateToDocumentStorage() {
    // Migration can run irrespective of current storage mode. If files already exist it will overwrite/update them.

    const docStorage = new DocumentStorage(this.app, this.settings);
    const legacyStates = { ...this.state };
    const errors: string[] = [];

    for (const [path, noteState] of Object.entries(legacyStates)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          await docStorage.saveNoteState(file, noteState);
        } catch (err) {
          console.error('Migration error for', path, err);
          errors.push(path);
        }
      } else {
        console.warn('Markdown file missing for saved loom:', path);
        errors.push(path + ' (missing)');
      }
    }

    if (errors.length) {
      new Notice(`Migration finished with ${errors.length} errors. Check console for details.`, 8000);
      return;
    }

    // Success – switch to document storage
    this.state = {};
    this.settings.useDocumentStorage = true;
    await this.save();
    new Notice('Migration complete! Document storage enabled. Please restart Obsidian.', 8000);
  }
}

// this relies on `LoomPlugin`, so it's here, not in `views.ts`

class LoomSettingTab extends PluginSettingTab {
  plugin: LoomPlugin;

  constructor(app: App, plugin: LoomPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    const disclaimerHeader = containerEl.createEl("p");

    disclaimerHeader.createEl("strong", { text: "To those new to Obsidian:" });
    disclaimerHeader.createEl("span", {
      text: " the Loom UI is not open by default. You can open it via one of the following methods:",
    });

    const methods = containerEl.createEl("ul");
    methods.createEl("li", {
      text: "Open the right sidebar and click the Loom icon.",
    });
    const method2 = methods.createEl("li");
    method2.createEl("span", {
      text: "Open the command palette, then search for and run the ",
    });
    method2.createEl("kbd", { text: "Loom: Open Loom pane" });
    method2.createEl("span", { text: " command." });

    const presetHeader = containerEl.createDiv({
      cls: "setting-item setting-item-heading",
    });
    presetHeader.createDiv({ cls: "setting-item-name", text: "Presets" });

    const presetEditor = containerEl.createDiv({
      cls: "loom__preset-editor setting-item",
    });

    const presetList = presetEditor.createDiv({ cls: "loom__preset-list" });

    const selectPreset = (index: number) => {
      this.plugin.settings.modelPreset = index;
      this.plugin.save();
      updatePresetFields();
      updatePresetList();
    };

    const deletePreset = (index: number) => {
      this.plugin.settings.modelPresets.splice(index, 1);
      this.plugin.save();

      if (index === this.plugin.settings.modelPreset) {
        if (this.plugin.settings.modelPresets.length === 0) selectPreset(-1);
        else if (index === this.plugin.settings.modelPresets.length)
          selectPreset(index - 1);
        else selectPreset(index);
      }
    };

    const createPreset = (preset: ModelPreset<Provider>) => {
      this.plugin.settings.modelPresets.push(preset);
      this.plugin.save();
      selectPreset(this.plugin.settings.modelPresets.length - 1);
    };

    const newPresetButtons = presetEditor.createDiv({
      cls: "loom__new-preset-buttons",
    });

    const newPresetButton = newPresetButtons.createEl("button", {
      text: "New preset",
    });
    newPresetButton.addEventListener("click", () => {
      const newPreset: ModelPreset<"openai"> = {
        name: "New preset",
        provider: "openai",
        model: "davinci-002",
        contextLength: 16384,
        apiKey: "",
        organization: "",
      };
      createPreset(newPreset);
    });

    const fillInModelDropdown = newPresetButtons.createEl("select", {
      cls: "loom__new-preset-button dropdown",
    });
    fillInModelDropdown.createEl("option", {
      text: "Fill in model details...",
      attr: { value: "none", selected: "", disabled: "" },
    });

    fillInModelDropdown.createEl("option", {
      text: "Llama 3.1 405B (Hyperbolic)",
      attr: { value: "llama-3.1-405b-hyperbolic" },
    });
    fillInModelDropdown.createEl("option", {
      text: "Llama 3.1 405B (OpenRouter)",
      attr: { value: "llama-3.1-405b-openrouter" },
    });
    fillInModelDropdown.createEl("option", {
      text: "Claude 3 Opus",
      attr: { value: "claude-3-opus" },
    });
    fillInModelDropdown.createEl("option", {
      text: "Claude 3.5 Sonnet",
      attr: { value: "claude-3.5-sonnet" },
    });
    fillInModelDropdown.createEl("option", {
      text: "GPT-4 base",
      attr: { value: "gpt-4-base" },
    });
    fillInModelDropdown.createEl("option", {
      text: "davinci-002",
      attr: { value: "davinci-002" },
    });

    fillInModelDropdown.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      switch (value) {
        case "llama-3.1-405b-hyperbolic": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "openai-compat";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          // @ts-expect-error
          ].url = "https://api.hyperbolic.xyz";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "meta-llama/Meta-Llama-3.1-405B";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 32768;
          break;
        }
        case "llama-3.1-405b-openrouter": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "openrouter";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          // @ts-expect-error
          ].quantization = "bf16";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "meta-llama/llama-3.1-405b";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 32768;
          break;
        }
        case "claude-3-opus": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "anthropic";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "claude-3-opus-20240229";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 50000;
          break;
        }
        case "claude-3.5-sonnet": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "anthropic";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "claude-3-5-sonnet-20240620";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 50000;
          break;
        }
        case "gpt-4-base": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "openai";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "gpt-4-base";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 8192;
          break;
        }
        case "davinci-002": {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = "openai";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].model = "davinci-002";
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].contextLength = 16384;
          break;
        }
      }
      this.plugin.save();
      updatePresetFields();

      fillInModelDropdown.value = "none";
    });

    const restoreApiKeyDropdown = newPresetButtons.createEl("select", {
      cls: "loom__new-preset-button dropdown",
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "Restore API key from pre-1.19...",
      attr: { value: "none", selected: "", disabled: "" },
    });

    restoreApiKeyDropdown.createEl("option", {
      text: "OpenAI-compatible API",
      attr: { value: "openai-compat" },
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "Anthropic",
      attr: { value: "anthropic" },
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "OpenAI",
      attr: { value: "openai" },
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "Azure",
      attr: { value: "azure" },
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "Cohere",
      attr: { value: "cohere" },
    });
    restoreApiKeyDropdown.createEl("option", {
      text: "TextSynth",
      attr: { value: "textsynth" },
    });

    restoreApiKeyDropdown.addEventListener("change", (event) => {
      const provider = (event.target as HTMLSelectElement).value as Provider;
      let preset = {
        name: "New preset",
        provider,
        model: "",
        contextLength: "",
      };
      switch (provider) {
        case "openai": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.openaiApiKey || "",
            // @ts-expect-error
            organization: this.plugin.settings.openaiOrganization || "",
          };
          break;
        }
        case "openai-compat": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.ocpApiKey || "",
            // @ts-expect-error
            url: this.plugin.settings.ocpUrl || "",
          };
          break;
        }
        case "cohere": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.cohereApiKey || "",
          };
          break;
        }
        case "textsynth": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.textsynthApiKey || "",
          };
          break;
        }
        case "azure": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.azureApiKey || "",
            // @ts-expect-error
            endpoint: this.plugin.settings.azureEndpoint || "",
          };
          break;
        }
        case "anthropic": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: this.plugin.settings.anthropicApiKey || "",
            // // @ts-expect-error
            // systemPrompt: this.plugin.settings.anthropicSystemPrompt || "",
            // // @ts-expect-error
            // userMessage: this.plugin.settings.anthropicUserMessage || "",
          };
          break;
        }
        case "bedrock": {
          preset = {
            ...preset,
            // @ts-expect-error
            apiKey: "", // User will need to provide accessKeyId:secretAccessKey format
            region: "us-east-1",
          };
          break;
        }
        default: {
          throw new Error(`Unknown provider: ${provider}`);
        }
      }
      // @ts-expect-error TODO
      createPreset(preset);

      restoreApiKeyDropdown.value = "none";
    });

    // edit preset fields

    const presetFields = containerEl.createDiv();

    const updatePresetFields = () => {
      presetFields.empty();

      if (this.plugin.settings.modelPreset === -1) {
        presetFields.createEl("p", {
          cls: "loom__no-preset-selected",
          text: "No preset selected.",
        });
        return;
      }

      new Setting(presetFields).setName("Name").addText((text) =>
        text
          .setValue(
            this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
              .name
          )
          .onChange((value) => {
            this.plugin.settings.modelPresets[
              this.plugin.settings.modelPreset
            ].name = value;
            this.plugin.saveAndRender();
            updatePresetList();
          })
      );

      new Setting(presetFields).setName("Provider").addDropdown((dropdown) => {
        const options: Record<string, string> = {
          "openai-compat": "OpenAI-compatible API",
          "openrouter": "OpenRouter",
          anthropic: "Anthropic",
          openai: "OpenAI",
          "openai-chat": "OpenAI (Chat)",
          azure: "Azure",
          "azure-chat": "Azure (Chat)",
          cohere: "Cohere",
          textsynth: "TextSynth",
          bedrock: "Amazon Bedrock",
          probe: "Probe server (assistant-axis)",
        };
        dropdown.addOptions(options);
        dropdown.setValue(
          this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
            .provider
        );
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelPresets[
            this.plugin.settings.modelPreset
          ].provider = value;
          await this.plugin.save();
          updatePresetFields();
        });
      });

      new Setting(presetFields).setName("Model").addText((text) =>
        text
          .setValue(
            this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
              .model
          )
          .onChange(async (value) => {
            this.plugin.settings.modelPresets[
              this.plugin.settings.modelPreset
            ].model = value;
            await this.plugin.save();
          })
      );

      new Setting(presetFields).setName("Context length").addText((text) =>
        text
          .setValue(
            this.plugin.settings.modelPresets[
              this.plugin.settings.modelPreset
            ].contextLength.toString()
          )
          .onChange(async (value) => {
            this.plugin.settings.modelPresets[
              this.plugin.settings.modelPreset
            ].contextLength = parseInt(value);
            await this.plugin.save();
          })
      );

      new Setting(presetFields).setName("API key").addText((text) =>
        text
          .setValue(
            this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
              .apiKey
          )
          .onChange(async (value) => {
            this.plugin.settings.modelPresets[
              this.plugin.settings.modelPreset
            ].apiKey = value;
            await this.plugin.save();
          })
      );

      if (
        ["openai", "openai-chat"].includes(
          this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
            .provider
        )
      ) {
        new Setting(presetFields).setName("Organization").addText((text) =>
          text
            .setValue(
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].organization
            )
            .onChange(async (value) => {
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].organization = value;
              await this.plugin.save();
            })
        );
      }

      if (
        ["openai-compat", "azure", "azure-chat", "probe"].includes(
          this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
            .provider
        )
      ) {
        new Setting(presetFields).setName("URL").addText((text) =>
          text
            .setValue(
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].url || ""
            )
            .onChange(async (value) => {
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].url = value;
              await this.plugin.save();
            })
        );
      }

      if (
        this.plugin.settings.modelPresets[this.plugin.settings.modelPreset]
          .provider === "probe"
      ) {
        new Setting(presetFields)
          .setName("Probe config")
          .setDesc(
            "Fetch available probe sets and labels from the probe server."
          )
          .addButton((button) =>
            button
              .setButtonText("Refresh probes")
              .onClick(async () => {
                await this.plugin.refreshProbeConfig();
                updatePresetFields();
              })
          );
      }

      if (this.plugin.settings.modelPresets[this.plugin.settings.modelPreset].provider === "bedrock") {
        new Setting(presetFields).setName("Region").addText((text) =>
          text
            .setValue(
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].region || "us-east-1"
            )
            .setPlaceholder("us-east-1")
            .onChange(async (value) => {
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].region = value;
              await this.plugin.save();
            })
        );
      }

      if (this.plugin.settings.modelPresets[this.plugin.settings.modelPreset].provider === "openrouter") {
        new Setting(presetFields).setName("Quantization").addDropdown((dropdown) =>
          dropdown
            .addOptions({
              bf16: "bf16",
              fp16: "fp16",
              fp8: "fp8",
              int8: "int8",
              int4: "int4"
            })
            .setValue(
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].quantization
            )
            .onChange(async (value) => {
              this.plugin.settings.modelPresets[
                this.plugin.settings.modelPreset
              // @ts-expect-error TODO
              ].quantization = value;
              await this.plugin.save();
            })
        );
      }
    };

    const updatePresetList = () => {
      presetList.empty();
      for (const i in this.plugin.settings.modelPresets) {
        const preset = this.plugin.settings.modelPresets[i];
        const isActive = this.plugin.settings.modelPreset === parseInt(i);

        const presetContainer = presetList.createDiv({
          cls: `loom__preset is-clickable outgoing-link-item tree-item-self${
            isActive ? " is-active" : ""
          }`,
        });
        presetContainer.addEventListener("click", () =>
          selectPreset(parseInt(i))
        );

        presetContainer.createSpan({
          cls: "loom__preset-name tree-item-inner",
          text: preset.name,
        });

        const deletePresetOuter = presetContainer.createDiv({
          cls: "loom__preset-buttons",
        });
        const deletePresetInner = deletePresetOuter.createDiv({
          cls: "loom__preset-button",
          attr: { "aria-label": "Delete" },
        });
        setIcon(deletePresetInner, "trash-2");
        deletePresetInner.addEventListener("click", (event) => {
          event.stopPropagation();
          deletePreset(parseInt(i));
        });
      }
    };

    updatePresetFields();
    updatePresetList();

    // TODO simplify below?

    const passagesHeader = containerEl.createDiv({
      cls: "setting-item setting-item-heading",
    });
    passagesHeader.createDiv({ cls: "setting-item-name", text: "Passages" });

    const setting = (
      name: string,
      key: LoomSettingKey,
      toText: (value: any) => string,
      fromText: (text: string) => any
    ) => {
      new Setting(containerEl).setName(name).addText((text) =>
        text
          .setValue(toText(this.plugin.settings[key]))
          .onChange(async (value) => {
            // @ts-expect-error
            this.plugin.settings[key] = fromText(value);
            await this.plugin.save();
          })
      );
    };

    const idSetting = (name: string, key: LoomSettingKey) =>
      setting(
        name,
        key,
        (value) => value,
        (text) => text
      );

    new Setting(containerEl)
      .setName("Passage folder location")
      .setDesc("Passages can be quickly combined into a multipart prompt")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.passageFolder)
          .onChange(async (value) => {
            this.plugin.settings.passageFolder = value;
            await this.plugin.save();
          })
      );

    idSetting("Default passage separator", "defaultPassageSeparator");
    idSetting("Default passage frontmatter", "defaultPassageFrontmatter");

    const debugHeader = containerEl.createDiv({
      cls: "setting-item setting-item-heading",
    });
    debugHeader.createDiv({ cls: "setting-item-name", text: "Debug" });

    new Setting(containerEl)
      .setName("Log API calls")
      .setDesc("Log API calls to the console")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.logApiCalls)
          .onChange(async (value) => {
            this.plugin.settings.logApiCalls = value;
            await this.plugin.save();
          })
      );

    new Setting(containerEl)
      .setName("Developer mode")
      .setDesc("Enable debug logging for filters and storage")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.developerMode)
          .onChange(async (value) => {
            this.plugin.settings.developerMode = value;
            await this.plugin.save();
          })
      );

    // Storage Settings
    const storageHeader = containerEl.createDiv({
      cls: "setting-item setting-item-heading",
    });
    storageHeader.createDiv({ cls: "setting-item-name", text: "Storage (Experimental)" });

    // Toggle for enabling document storage
    new Setting(containerEl)
      .setName("Use document-based storage")
      .setDesc("Store each loom in a separate file instead of one large data.json (BETA - backup your data first!)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useDocumentStorage)
          .onChange(async (value) => {
            this.plugin.settings.useDocumentStorage = value;
            await this.plugin.save();
            this.display();
            new Notice(
              "Please restart Obsidian for storage changes to take effect",
              5000
            );
          })
      );

    // Storage location dropdown (always visible, disabled until enabled)
    new Setting(containerEl)
      .setName("Storage location")
      .setDesc("Where to store .loom.json files")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            alongside: "Alongside markdown files",
            "plugin-folder": "In plugin folder",
          })
          .setValue(this.plugin.settings.documentStorageLocation)
          .onChange(async (value: 'alongside' | 'plugin-folder') => {
            this.plugin.settings.documentStorageLocation = value;
            await this.plugin.save();
          })
      )
      .setDisabled(!this.plugin.settings.useDocumentStorage);

    // Migration command (always visible)
    containerEl.createEl("p", {
      text: "Convert existing looms to per-document storage:",
      cls: "setting-item-description",
    });
    const migrationDiv = containerEl.createDiv({ cls: "setting-item" });
    const migrationButton = migrationDiv.createEl("button", {
      text: "Migrate to Document Storage",
    });
    migrationButton.addEventListener("click", () => {
      new ConfirmMigrationModal(this.app, async () => {
        await this.plugin.migrateToDocumentStorage();
        this.display(); // refresh UI to reflect new state
      }).open();
    });
  }
}
