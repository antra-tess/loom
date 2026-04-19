# loom(sidian)

**READ THE README IF YOU PLAN TO USE THIS PLUGIN. IT IS USEFUL**

This is a reimplementation of [Loom](https://github.com/socketteer/loom) as an Obsidian plugin, designed to be easier to use and more modular and extensible.

Loom is a recursively branching interface to GPT-3 and other language models; it is designed to be conducive to exploratory and experimental use of base models. The workflow primarily consists of this: you hit `Ctrl+Space` from a point in the text, and Loom generates `n` child nodes of the current node, where each child contains a different completion of the text leading up to the cursor. This is paired with a tree interface and settings panel in the right sidebar, as well as a pane containing the full text of the current node and its siblings.

Loom can request completions from the following providers: [Cohere](https://docs.cohere.ai/docs), [TextSynth](https://textsynth.com/documentation.html), [OpenAI](https://platform.openai.com/docs/introduction), and [Azure OpenAI Service](https://learn.microsoft.com/en-us/azure/ai-services/openai). It can also request completions from implementations of [openai-cd2-proxy](https://github.com/cosmicoptima/openai-cd2-proxy), in which case you must provide the base URL in the Loom tab in Settings.

## Probe server (activation steering + per-token readouts)

This fork adds a `Probe server` provider that talks to the [assistant-axis](https://github.com/antra-tess/assistant-axis) probe server — a vLLM-based inference server with emotion probes and activation steering. It enables two things on top of normal completions:

1. **Inline activation steering** — push generation toward (or cap at) a probe direction (e.g. any of 171 emotions).
2. **Per-token probe readouts** — encode the current document and hover any token to see its top positive and top negative probe projections.

### Setup

1. In Settings → Loom, create a new preset and set its provider to **Probe server (assistant-axis)**.
2. Fill in the **URL** field (e.g. `http://your-node:8000`). No IP is hardcoded — use whatever URL your server is reachable at.
3. Optional: set an **API key** if your server requires a bearer token.
4. Click **Refresh probes** — this fetches `/v1/config` and caches the probe sets + labels so they can populate the sidebar.

### Steering

The Loom sidebar has a **Steering** section (toggle via the visibility checkboxes). It lets you pick:

- **Intervention**: `none` / `steer` (add magnitude in probe direction) / `floor` / `ceil` (threshold-clamp on the projection).
- **Probe set** — e.g. `emotions`.
- **Label** — the specific probe within the set (e.g. `afraid`).
- **Strength** — meaning depends on type; `steer afraid@30` pushes toward fear, `ceil afraid@3` prevents exceeding fear=3, etc.
- **Renorm** — if on, preserves the activation's original norm after steering (softer steering).

When any intervention other than `none` is active, every generation sends it to the server as part of the request body.

### Per-token probe readouts

Under the steering controls, **Probe document** encodes the current editor text via `/v1/encode` with the selected probe set and tags every token with a CodeMirror decoration (dotted underline). Hover a token to see a tooltip with:

- the selected probe (always shown first, highlighted),
- the top 5 positive probes for that token (high → low),
- the top 5 negative probes for that token (least-negative → most-negative).

**Clear readout** removes the decorations. Readouts are not persisted — pressing **Probe document** again after edits re-aligns them. Readouts are cached in memory and reapplied when you switch files.

If you are interested in funding this plugin's development, you can **[support me on Patreon](https://patreon.com/parafactual)**; I would then be able to devote more time to this and other independent projects.

**If you are new to Obsidian:** if you want to see the tree interface, make sure to open the right sidebar using the button on the top right, or using `Ctrl+P` then `Toggle right sidebar`. Once you've done that, go to the Loom tab, which is signified by a network icon.

**Default hotkeys:**

- generate - `Ctrl+Space`
- generate siblings - `Ctrl+Shift+Space`
- split at point - `Alt+s`
- split at point and create child - `Alt+c`
- delete (current node) - `Alt+Backspace`
- merge (current node) with parent - `Alt+m`

Navigation:
- switch to next sibling - `Alt+Down`
- switch to previous sibling - `Alt+Up`
- switch to parent - `Alt+Left`
- switch to (most recently visited) child - `Alt+Right`

In the editor:
- `Shift+click` on the text corresponding to a node to switch to it

**Upstream Loom can be installed in the Obsidian store.** This fork (probe server / steering / readouts) is not yet in the store, so install it manually.

### Manual install (temporary, until this fork ships a release)

Obsidian plugins consist of up to four files in a single folder:

- `main.js` (NOT `main.ts`!)
- `manifest.json`
- `styles.css` (optional)
- `data.json` (optional — created by the plugin at runtime; you usually won't have one to copy)

These files should be available for download on the **Releases** page of the plugin's GitHub repository.

Download them, move them into a new directory (name doesn't matter, e.g. `loom`), and place that directory under the plugins directory (`.obsidian/plugins/`) of your vault.

To find the plugins directory: Settings → Community plugins → Installed plugins → click the 📂 (folder) icon on the right side of the section heading.

Once the plugin files are in place, click the 🔄 (refresh) icon next to the folder icon, then toggle the plugin on in the Installed plugins list.

### Build from source

1. Clone this repository (`git clone https://github.com/antra-tess/loom`) in `[path to vault]/.obsidian/plugins`, creating the `plugins` directory if necessary
2. Run: `cd loom; npm i; npm run build`
3. Go to the "Community plugins" tab in Obsidian settings, then enable "Loom"
4. To update, `git pull; npm i; npm run build`, then disable and re-enable Loom

**If you are using MacOS:** a few hotkeys -- `Alt+s`, `Alt+c`, and `Alt+m` -- are bound to special characters. You can either:

1. Disable MacOS's special character shortcuts, as explained here: https://superuser.com/questions/941286/disable-default-option-key-binding
2. Rebind the Loom hotkeys you want to use in the Hotkeys tab in Settings
