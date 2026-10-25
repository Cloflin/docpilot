/** The pure API behind `docpilot model`. `cli.ts` is the only module here that does console IO. */
export {readSafetensorsHeader, readGgufHeader, BoundedReader, GGML_TYPES, SAFETENSORS_MAX_HEADER} from './headers.js'
export {fingerprint, verify, listModelFiles, sha256File, checksumLines, manifestDigest, formatOf} from './fingerprint.js'
export {mcnemarExact, mcnemarMinFlips, mulberry32, pairedBootstrap} from './stats.js'
export {compareReports, renderCompare, incomparability, isOk, PINNED, METRICS} from './compare.js'
export {normalizeTokens, extractTrainTexts, createContaminationIndex, ngramContamination, renderContamination} from './contamination.js'
export {runModel, parseModelArgs, MODEL_FLAGS, HELP} from './cli.js'
