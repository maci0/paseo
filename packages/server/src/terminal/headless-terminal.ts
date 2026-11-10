import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import xterm, {
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
  type Terminal,
} from "@xterm/headless";

export interface HeadlessTerminalOptions {
  rows: number;
  cols: number;
  scrollback?: number;
}

/**
 * A headless xterm that measures text the way Paseo clients render it.
 *
 * Grapheme-cluster widths give every emoji cluster (VS16, skin-tone, flags,
 * ZWJ sequences) one two-column cell, matching color-emoji fonts. Clients
 * replay this buffer's ANSI with the same table, so cells and the cursor line
 * up after reconnect. See docs/terminal-rendering.md.
 */
export function createHeadlessTerminal(options: HeadlessTerminalOptions): Terminal {
  // Named fields instead of a spread: scriptc cannot spread an interface-typed object.
  const terminalOptions: ITerminalOptions & ITerminalInitOnlyOptions = {
    rows: options.rows,
    cols: options.cols,
    allowProposedApi: true,
  };
  if (options.scrollback !== undefined) terminalOptions.scrollback = options.scrollback;
  const terminal = new xterm.Terminal(terminalOptions);
  terminal.loadAddon(new UnicodeGraphemesAddon());
  return terminal;
}
