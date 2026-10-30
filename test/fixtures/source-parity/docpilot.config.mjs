// The parity fixture's project: a docs tree, an import directory and (from the
// second task on) a built site beside it. `embed: false` and no calibration
// file, so the index it builds carries no vectors and no gate threshold, and a
// recalibration can not move its bytes.
export const docPilot = {
  product: 'Parity',
  embed: false,
  chat: false,
  importDir: 'kb',
  sources: { allow: ['https://example.com'] },
}
export default {}
