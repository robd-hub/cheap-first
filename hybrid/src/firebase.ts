/**
 * Everything that touches Firebase: App Check, AI Logic (hybrid inference),
 * Remote Config, anonymous Auth and Firestore totals.
 *
 * The Firebase web config is public by design (it ships in every page).
 * Values come from VITE_FIREBASE_* at build time. See .env.example.
 */
import { initializeApp, type FirebaseOptions } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, type GenerativeModel } from "firebase/ai";
import { fetchAndActivate, getRemoteConfig, getString } from "firebase/remote-config";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getFirestore, increment, onSnapshot, setDoc } from "firebase/firestore";
import { JUDGE_SCHEMA, type Gen, type Models, type Mode, type Outcome, type Source } from "./router";

const env = import.meta.env;

/** The cheap-first-local project. Public by design; VITE_FIREBASE_* overrides it for your own project. */
const DEFAULT_CONFIG: FirebaseOptions = {
  apiKey: "AIzaSyAMLQ7oH3ai0C-3oI14Hda3sL-o809N_3c",
  authDomain: "cheap-first-local.firebaseapp.com",
  projectId: "cheap-first-local",
  storageBucket: "cheap-first-local.firebasestorage.app",
  messagingSenderId: "359588364014",
  appId: "1:359588364014:web:fb021eb8db8e8624297dff",
};

const firebaseConfig: FirebaseOptions = env.VITE_FIREBASE_PROJECT_ID
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : DEFAULT_CONFIG;

/** reCAPTCHA Enterprise site key for App Check (public, like the config above). */
const RECAPTCHA_SITE_KEY = env.VITE_RECAPTCHA_SITE_KEY || "6LfjaDEuAAAAAKx4K-9KzdrgLlaq_TAqENyl3sP9";

export const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

/** Remote Config defaults. Change them in the console without a redeploy. */
const DEFAULTS = {
  cloud_model: "gemini-3.8-flash",
  fallback_model: "gemini-3.5-flash-lite",
  judge_model: "gemini-3.5-flash-lite",
  default_mode: "balanced",
};

const ANSWER_SYSTEM =
  "Answer the question directly and briefly. Put the answer first. " +
  "If you are not sure or cannot know, say so plainly instead of guessing.";

const app = configured ? initializeApp(firebaseConfig) : null;

if (app) {
  // Local development uses the App Check debug provider. The token is
  // registered in the console and never committed (VITE_APPCHECK_DEBUG_TOKEN).
  if (env.DEV || env.VITE_APPCHECK_DEBUG === "1") {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      env.VITE_APPCHECK_DEBUG_TOKEN || true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY || "missing-site-key"),
    isTokenAutoRefreshEnabled: true,
  });
}

const settings = { ...DEFAULTS };

export async function loadRemoteConfig(): Promise<typeof DEFAULTS> {
  if (!app) return settings;
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
    rc.defaultConfig = DEFAULTS;
    await fetchAndActivate(rc);
    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      const value = getString(rc, key);
      if (value) settings[key] = value;
    }
  } catch (error) {
    console.warn("Remote Config unavailable, using defaults.", error);
  }
  return settings;
}

export function defaultMode(): Mode {
  return settings.default_mode === "strict" || settings.default_mode === "budget" ? settings.default_mode : "balanced";
}

function wrap(model: GenerativeModel): Gen {
  return async (prompt) => {
    const result = await model.generateContent(prompt);
    const source: Source = result.response.inferenceSource === InferenceSource.ON_DEVICE ? "ON_DEVICE" : "IN_CLOUD";
    return { text: result.response.text(), source };
  };
}

let models: Models | null = null;
let firstModel: GenerativeModel | null = null;

/** Built after Remote Config so a changed model name takes effect. */
export function getModels(): Models {
  if (!app) throw new Error("Firebase is not configured. Copy .env.example to .env.local and fill it in.");
  if (models) return models;
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const system = { role: "system" as const, content: [{ type: "text" as const, value: ANSWER_SYSTEM }] };

  firstModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: { createOptions: { initialPrompts: [system] } },
    inCloudParams: { model: settings.fallback_model, systemInstruction: ANSWER_SYSTEM },
  });
  const localSample = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE });
  const localJudge = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: { promptOptions: { responseConstraint: JUDGE_SCHEMA } },
  });
  const cloudJudge = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: settings.judge_model,
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: JUDGE_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  const cloud = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model: settings.cloud_model, systemInstruction: ANSWER_SYSTEM },
  });

  models = { first: wrap(firstModel), localSample: wrap(localSample), localJudge: wrap(localJudge), cloudJudge: wrap(cloudJudge), cloud: wrap(cloud) };
  return models;
}

/** Must run on a click. Starts the Gemini Nano download if Chrome hasn't got it yet. */
export async function initializeDeviceModel(onProgress: (fraction: number) => void): Promise<void> {
  getModels();
  await firstModel!.initializeDeviceModel(onProgress);
}

export type DeviceStatus = "no-api" | "unavailable" | "downloadable" | "downloading" | "available";

/** Chrome's Prompt API, read directly so the page can say what is going on. */
export async function deviceStatus(): Promise<DeviceStatus> {
  const api = (self as unknown as { LanguageModel?: { availability: () => Promise<string> } }).LanguageModel;
  if (!api) return "no-api";
  try {
    const value = await api.availability();
    if (value === "available" || value === "downloadable" || value === "downloading" || value === "unavailable") return value;
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

// ---- Shared totals (Firestore). Counts only: no questions or answers are stored. ----

export interface Totals {
  questions: number;
  onDevice: number;
  escalated: number;
  noDevice: number;
}

const EMPTY: Totals = { questions: 0, onDevice: 0, escalated: 0, noDevice: 0 };
let signedIn: Promise<unknown> | null = null;

function totalsDoc() {
  return doc(getFirestore(app!), "stats", "global");
}

export async function recordOutcome(outcome: Outcome): Promise<void> {
  if (!app) return;
  try {
    signedIn ??= signInAnonymously(getAuth(app));
    await signedIn;
    await setDoc(
      totalsDoc(),
      {
        questions: increment(1),
        onDevice: increment(outcome.answeredBy === "device" ? 1 : 0),
        escalated: increment(outcome.answeredBy === "cloud-escalated" ? 1 : 0),
        noDevice: increment(outcome.answeredBy === "cloud-no-device" ? 1 : 0),
      },
      { merge: true },
    );
  } catch (error) {
    console.warn("Could not record totals.", error);
  }
}

export function watchTotals(onChange: (totals: Totals) => void): void {
  if (!app) return;
  try {
    onSnapshot(
      totalsDoc(),
      (snap) => onChange({ ...EMPTY, ...(snap.data() as Partial<Totals> | undefined) }),
      (error) => console.warn("Totals unavailable.", error),
    );
  } catch (error) {
    console.warn("Totals unavailable.", error);
  }
}
