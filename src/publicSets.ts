/**
 * Pins for the public benchmark. The sample is drawn from these exact files,
 * so a later upload of either dataset cannot silently change the questions.
 *
 * GSM8K is the MIT-licensed test split from openai/grade-school-math.
 * ARC-Challenge is the AI2 ARC-V1-Feb2018 challenge test file. The zip is
 * 680MB because of the corpus; the test file itself is the deflated member
 * at a fixed byte range, checked against the member's sha256.
 */

export const SAMPLE_SEED = 20_261_120;

/**
 * Seed for the threshold sample. Different from SAMPLE_SEED, and the draw
 * also drops every id in the reported sample, so the two sets cannot overlap.
 */
export const TUNING_SEED = 20_261_121;

/** GSM8K questions in the tuning sample. Small on purpose: it pays for a premium answer each time. */
export const TUNING_GSM8K_SIZE = 40;

/** ARC-Challenge questions in the tuning sample. */
export const TUNING_ARC_SIZE = 20;

export const GSM8K = {
  id: "gsm8k" as const,
  name: "GSM8K",
  split: "test",
  population: 1319,
  sampleSize: 200,
  revision: "b0bb162abedc65e1fdd8e93ed090fd7598ee68bc",
  url: "https://raw.githubusercontent.com/openai/grade-school-math/b0bb162abedc65e1fdd8e93ed090fd7598ee68bc/grade_school_math/data/test.jsonl",
  sha256: "3730d312f6e3440559ace48831e51066acaca737f6eabec99bccb9e4b3c39d14",
};

export const ARC = {
  id: "arc" as const,
  name: "ARC-Challenge",
  split: "test",
  population: 1172,
  sampleSize: 100,
  /** Official AI2 archive. Only the byte range below is downloaded. */
  url: "https://ai2-public-datasets.s3.amazonaws.com/arc/ARC-V1-Feb2018.zip",
  member: "ARC-V1-Feb2018-2/ARC-Challenge/ARC-Challenge-Test.jsonl",
  /** First byte of the deflated member (after its local zip header). */
  rangeStart: 194508,
  /** Deflated length. The inclusive HTTP Range end is rangeStart + rangeLength - 1. */
  rangeLength: 127743,
  sha256: "9fa8ffb3e3a1f88cb302d53dd95aae81e39209ad9bcf974376b319d8fd35717c",
};

export const PUBLIC_GRADING =
  "Each answer is marked by code against the published answer. GSM8K compares the final number. ARC-Challenge compares the choice label. The checker does not see the answer key, and it does not mark the final answers.";
