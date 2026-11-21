/**
 * Downloads the pinned GSM8K and ARC-Challenge files and draws a sample.
 * Shared by the public benchmark and the tuning run so both see the same items.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { arcPrompt, datasetSeed, gsm8kGold, gsm8kPrompt, selectDisjoint, selectSample } from "../src/publicGrade.js";
import { ARC, GSM8K, SAMPLE_SEED, TUNING_ARC_SIZE, TUNING_GSM8K_SIZE, TUNING_SEED } from "../src/publicSets.js";

export interface PublicItem {
  dataset: "gsm8k" | "arc";
  id: string;
  prompt: string;
  gold: string;
  labels?: string[];
}

export interface SamplePin {
  seed?: number;
  datasets?: { id?: string; sha256?: string; sampleSize?: number }[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function expectHash(buf: Buffer, expected: string, label: string): void {
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${label} sha256 is ${got}, expected ${expected}. The pinned file changed or the download was cut off.`);
}

async function download(url: string, headers?: Record<string, string>): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

async function allGsm8k(): Promise<PublicItem[]> {
  const { status, body } = await download(GSM8K.url);
  if (status !== 200) throw new Error(`GSM8K download returned ${status}.`);
  expectHash(body, GSM8K.sha256, "GSM8K test.jsonl");
  const items: PublicItem[] = [];
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { question: string; answer: string };
    items.push({
      dataset: "gsm8k",
      id: `gsm8k-${String(items.length).padStart(4, "0")}`,
      prompt: gsm8kPrompt(row.question),
      gold: gsm8kGold(row.answer),
    });
  }
  if (items.length !== GSM8K.population) throw new Error(`GSM8K has ${items.length} questions, expected ${GSM8K.population}.`);
  return items;
}

async function allArc(): Promise<PublicItem[]> {
  const end = ARC.rangeStart + ARC.rangeLength - 1;
  const { status, body } = await download(ARC.url, { Range: `bytes=${ARC.rangeStart}-${end}` });
  if (status !== 206) throw new Error(`ARC range request returned ${status}. The full archive is not downloaded.`);
  if (body.length !== ARC.rangeLength) throw new Error(`ARC range was ${body.length} bytes, expected ${ARC.rangeLength}.`);
  const raw = inflateRawSync(body);
  expectHash(raw, ARC.sha256, "ARC-Challenge-Test.jsonl");
  const items: PublicItem[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { id: string; answerKey: string; question: { stem: string; choices: { text: string; label: string }[] } };
    const labels = row.question.choices.map((choice) => choice.label);
    items.push({
      dataset: "arc",
      id: `arc:${row.id}`,
      prompt: arcPrompt(row.question.stem, row.question.choices),
      gold: row.answerKey,
      labels,
    });
  }
  if (items.length !== ARC.population) throw new Error(`ARC-Challenge test has ${items.length} questions, expected ${ARC.population}.`);
  return items;
}

export async function loadPopulations(): Promise<{ gsm8k: PublicItem[]; arc: PublicItem[] }> {
  const [gsm8k, arc] = await Promise.all([allGsm8k(), allArc()]);
  return { gsm8k, arc };
}

/** The reported 300. Same ids as scripts/public-benchmark.ts. */
export function reportedItems(populations: { gsm8k: PublicItem[]; arc: PublicItem[] }): PublicItem[] {
  return [
    ...selectSample(populations.gsm8k, GSM8K.sampleSize, datasetSeed(GSM8K.id), (item) => item.id),
    ...selectSample(populations.arc, ARC.sampleSize, datasetSeed(ARC.id), (item) => item.id),
  ];
}

/**
 * Tuning sample. A different seed, and every reported id is removed before
 * the draw, so the sets are disjoint even if the seeds had collided.
 */
export function tuningItems(populations: { gsm8k: PublicItem[]; arc: PublicItem[] }): PublicItem[] {
  const reported = new Set(reportedItems(populations).map((item) => item.id));
  const gsm = selectDisjoint(populations.gsm8k, TUNING_GSM8K_SIZE, datasetSeed(GSM8K.id, TUNING_SEED), reported, (item) => item.id);
  const arc = selectDisjoint(populations.arc, TUNING_ARC_SIZE, datasetSeed(ARC.id, TUNING_SEED), reported, (item) => item.id);
  const overlap = [...gsm, ...arc].filter((item) => reported.has(item.id));
  if (overlap.length) throw new Error(`Tuning sample overlaps the reported set: ${overlap.map((item) => item.id).join(", ")}`);
  return [...gsm, ...arc];
}

export function sampleMeta() {
  return {
    seed: SAMPLE_SEED,
    datasets: [
      {
        id: GSM8K.id,
        name: GSM8K.name,
        split: GSM8K.split,
        population: GSM8K.population,
        sampleSize: GSM8K.sampleSize,
        source: GSM8K.url,
        revision: GSM8K.revision,
        sha256: GSM8K.sha256,
      },
      {
        id: ARC.id,
        name: ARC.name,
        split: ARC.split,
        population: ARC.population,
        sampleSize: ARC.sampleSize,
        source: ARC.url,
        member: ARC.member,
        sha256: ARC.sha256,
        byteRange: [ARC.rangeStart, ARC.rangeStart + ARC.rangeLength - 1],
      },
    ],
  };
}

export function reportedPinMatches(sample: SamplePin | undefined): boolean {
  if (sample?.seed !== SAMPLE_SEED) return false;
  const sets = sample.datasets ?? [];
  const gsm = sets.find((d) => d.id === "gsm8k");
  const arc = sets.find((d) => d.id === "arc");
  return gsm?.sha256 === GSM8K.sha256 && gsm.sampleSize === GSM8K.sampleSize && arc?.sha256 === ARC.sha256 && arc.sampleSize === ARC.sampleSize;
}
