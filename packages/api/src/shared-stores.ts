import { createFindingsStore } from "@codesteward/findings";
import { createLearningStore } from "@codesteward/learning";

export const findingsStore = createFindingsStore({
  filePath:
    process.env.FINDINGS_STORE_PATH ??
    `${process.env.STEW_DATA_DIR ?? ".steward-data"}/findings.json`,
});

export const learningStore = createLearningStore({
  filePath:
    process.env.LEARNING_STORE_PATH ??
    `${process.env.STEW_DATA_DIR ?? ".steward-data"}/learning.json`,
});
