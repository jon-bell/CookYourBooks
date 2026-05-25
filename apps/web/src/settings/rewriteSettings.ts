// Default model + prompt for the LLM-powered instruction-rewriting
// flow. The user's chosen defaults live in `user_rewrite_prefs`
// server-side — there is no localStorage shape. Cook Mode shows the
// rewritten steps once the worker writes them back onto the
// instruction rows.

export type RewriteProvider = 'gemini' | 'openai-compatible';

export const DEFAULT_REWRITE_PROMPT = `You are a cooking assistant. You will receive a JSON object describing a recipe's instructions. For each instruction, break compound sentences into atomic single-action steps suitable for hands-free Cook Mode display.

Return ONLY valid JSON (no markdown, no commentary) with this exact shape:

{
  "rewritten": [
    {
      "instructionId": "<echo the input id verbatim>",
      "simplifiedSteps": [
        {
          "text": "<one action>",
          "durationSec": <integer or null>,
          "temperature": { "value": <number>, "unit": "FAHRENHEIT" | "CELSIUS" } | null,
          "notes": "<short hint>" | null
        }
      ]
    }
  ]
}

Rules:
- One step per atomic action: one verb + one object, plus optional duration.
- If the source mentions a duration ("for 2 minutes", "about 30 seconds"), extract it as integer seconds in durationSec ("2 minutes" -> 120, "30 seconds" -> 30). If no duration is mentioned, omit the field or use null.
- If the source mentions a temperature ("over medium-high heat", "350F"), keep it on the relevant step.
- Echo each input instructionId verbatim so we can match results back to the source steps.
- Do not invent new instructions; only rephrase what is present.
- Do not include the original sentence as a step — only the atomic rewrites.
- No markdown, no code fences, JSON only.

Example input:
{
  "instructions": [
    {
      "id": "abc",
      "stepNumber": 1,
      "text": "Heat a large frying pan over medium-high heat, add the cumin and coriander seeds and toast for about 2 minutes, shaking the pan."
    }
  ]
}

Example output:
{
  "rewritten": [
    {
      "instructionId": "abc",
      "simplifiedSteps": [
        { "text": "Heat a large frying pan over medium-high heat" },
        { "text": "Add the cumin and coriander seeds to the pan" },
        { "text": "Toast the seeds, shaking the pan", "durationSec": 120 }
      ]
    }
  ]
}`;

// Default model defaults are cheap text-only models. Rewrite is a
// single LLM call per recipe so the price difference between Flash and
// Pro hardly matters, but Flash is plenty for atomic-step rewrites.
export const DEFAULT_REWRITE_MODEL_BY_PROVIDER: Record<RewriteProvider, string> = {
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'gpt-4o-mini',
};
