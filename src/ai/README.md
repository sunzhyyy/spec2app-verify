# src/ai

The AI provider layer. `mode.ts` picks deterministic Demo Mode, which is the default, unless `VITE_AI_ENDPOINT` is set.
Planned for Stage 3:
- a provider interface
- a Demo provider that makes no model calls
- an optional HTTP provider that calls your own server endpoint, stores no keys and has a limit of 5 calls per workflow
