# Cheap First Local

**Your laptop answers first. The cloud only answers when it has to.**

Cheap First Local is a web app built on [Firebase AI Logic hybrid inference](https://firebase.google.com/docs/ai-logic/hybrid). Gemini Nano answers each question on your own device, which is free and private. Cheap First then checks that answer, and the question only goes to a stronger Gemini model in the cloud when the check fails.

Firebase's hybrid mode already falls back to the cloud when a device has **no** model. Cheap First adds the fallback that hybrid apps actually need: going to the cloud when the local answer **isn't good enough**.

It is the browser version of [Cheap First](https://cheap-first.vercel.app) (the rest of this repo), which does the same thing with cloud models. On our [published 300-question public run](../README.md) that version was about 95.5% cheaper than always using the premium model, and 2 points behind it (96.0% vs 98.0%).

## How it decides

1. **On device first.** A `PREFER_ON_DEVICE` model runs the question on Gemini Nano in Chrome. With no on-device model, Firebase answers with `gemini-3.5-flash-lite` in the cloud, and the page says so (`inferenceSource`).
2. **Check the answer**, on the device where possible:
   - **A number or a multiple-choice answer:** a second on-device answer (`ONLY_ON_DEVICE`), told to solve it from scratch, has to land on the same number or letter, and every written equation has to add up. This is the same check the hosted Cheap First uses ([`src/checkSignals.ts`](../src/checkSignals.ts), [`src/arithmetic.ts`](../src/arithmetic.ts)). A model can't rubber-stamp it.
   - **Anything else:** code looks for warning signs (blank, "I'm not sure", "I don't have access", cut off mid-sentence). Then a judge returns `{score, reason}` as structured JSON: Gemini Nano in Budget and Balanced, `gemini-3.5-flash-lite` in Strict.
3. **Escalate only when needed.** Below the pass mark (Budget 60, Balanced 75, Strict 85, the same as the hosted version), `gemini-3.8-flash` answers in the cloud (`ONLY_IN_CLOUD`). You see both answers, the score and the reason.

The logic is [`src/router.ts`](src/router.ts). It has no Firebase imports, so the tests use fake models.

## Firebase products

| Product | Used for |
| --- | --- |
| AI Logic (hybrid inference) | All model calls: `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `ONLY_IN_CLOUD` ([`src/firebase.ts`](src/firebase.ts)) |
| App Check (reCAPTCHA Enterprise) | Required by AI Logic. Debug provider for local development |
| Remote Config | Cloud model names and the default mode, changeable without a redeploy |
| Authentication (anonymous) | Lets a visitor add to the shared counts |
| Firestore | One document of shared counts. [Rules](firestore.rules) only allow adding 1 per question. No questions or answers are stored |

## Privacy

When the answer stays on the device, the question never leaves it. When the check fails, or the device has no model, the question goes to Google's Gemini API through Firebase. Strict mode also sends open questions to a cloud judge.

## Limits

- On-device inference needs Chrome on desktop (139 or later) with the Prompt API flag on, and room for the model download. Other browsers get cloud answers, labelled as such.
- A small model judging open questions misses mistakes. That is why number and choice questions are checked by code and a second answer instead. Use Strict for open questions where a mistake matters.
- On-device answers are slower than a cloud model on some laptops.

## Run it

```bash
cd hybrid
npm install
cp .env.example .env.local   # only needed for your own Firebase project or a debug token
npm run dev                  # http://localhost:5173
npm test                     # router tests, no keys needed
npm run typecheck
npm run build                # static site in dist/
```

Firebase setup: create a project, open **AI Services → AI Logic → Get started** with the Gemini Developer API, register a web app, turn on Anonymous sign-in and Firestore, and register the app in App Check with reCAPTCHA Enterprise. For local development, set `VITE_APPCHECK_DEBUG_TOKEN` and register that token under **App Check → Manage debug tokens**. Deploy the rules and Remote Config template with `firebase deploy --only firestore:rules,remoteconfig`.

In Chrome, turn on `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` and restart.

## Test questions

The page can run 20 public questions (the first 14 GSM8K and first 6 ARC-Challenge rows of our published run), or the 12 questions the cheap cloud model got wrong on that run. Final answers are marked by code against the published key. The checker never sees the key. GSM8K is MIT licensed (OpenAI). ARC-Challenge is CC BY-SA 4.0 (AI2).

## Licence

MIT, like the rest of the repo.
