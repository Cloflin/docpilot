/**
 * Text from somewhere else, made safe to print to a terminal.
 *
 * A remote page title, an llms.txt line or a GGUF `general.name` can carry ESC
 * and other C0/C1 control bytes. Printed raw, they move the cursor, clear the
 * screen, hide the rest of a report (SGR 8) or, on terminals that honour OSC 52,
 * write to the clipboard. Every control byte except tab is shown as a visible
 * `\xNN` escape instead, so the text stays readable and nothing is executed.
 * A newline is escaped too: a raw one in a title can forge a report line.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g

/** `s` with every control byte except tab escaped as `\xNN` (or `\uNNNN`). */
export function printable(s) {
  return String(s ?? '').replace(CONTROL, (c) => {
    const code = c.charCodeAt(0)
    return code > 0xff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\x${code.toString(16).padStart(2, '0')}`
  })
}

/**
 * The same, but keeping line breaks: for multi-line text this tool composed
 * itself around remote fragments, where each fragment was already escaped or
 * the breaks are the tool's own. Only `\n` survives; `\r` is escaped, since a
 * bare carriage return can overwrite the start of the line it ends.
 */
export function printableLines(s) {
  return String(s ?? '')
    .split('\n')
    .map(printable)
    .join('\n')
}
