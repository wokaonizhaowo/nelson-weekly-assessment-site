const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const cardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "word",
          "displayWord",
          "meaningZh",
          "phonetic",
          "partOfSpeech",
          "collocations",
          "commonMistake",
          "example",
          "exampleZh",
          "spellingPrompt",
          "usagePrompt",
          "usageAnswer",
          "accepted",
          "explanation",
          "choiceQuestion",
        ],
        properties: {
          word: { type: "string" },
          displayWord: { type: "string" },
          meaningZh: { type: "string" },
          phonetic: { type: "string" },
          partOfSpeech: { type: "string" },
          collocations: { type: "string" },
          commonMistake: { type: "string" },
          example: { type: "string" },
          exampleZh: { type: "string" },
          spellingPrompt: { type: "string" },
          usagePrompt: { type: "string" },
          usageAnswer: { type: "string" },
          accepted: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          explanation: { type: "string" },
          choiceQuestion: {
            type: "object",
            additionalProperties: false,
            required: ["prompt", "options", "answer", "explanation"],
            properties: {
              prompt: { type: "string" },
              options: {
                type: "array",
                minItems: 4,
                maxItems: 4,
                items: { type: "string" },
              },
              answer: { type: "string" },
              explanation: { type: "string" },
            },
          },
        },
      },
    },
  },
};

function normalizeWord(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z'-]/g, "");
}

function outputText(response: Record<string, unknown>) {
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("OpenAI did not return structured text");
}

async function callOpenAI(system: string, payload: unknown) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "nelson_vocabulary_cards",
          strict: true,
          schema: cardSchema,
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return JSON.parse(outputText(await response.json()));
}

function validateCard(card: Record<string, unknown>) {
  const errors: string[] = [];
  const word = normalizeWord(card.word);
  if (!word) errors.push("invalid word");
  if (!card.meaningZh) errors.push("missing Chinese meaning");
  const example = String(card.example || "");
  if (!new RegExp(`\\b${word}\\w*\\b`, "i").test(example)) {
    errors.push("example must contain the target word or an inflected form");
  }
  if (!card.exampleZh) errors.push("missing example translation");
  const usagePrompt = String(card.usagePrompt || "");
  const blanks = usagePrompt.match(/[A-Za-z]_{3,}|_{3,}/g) || [];
  if (blanks.length !== 1) errors.push("usage prompt must contain exactly one blank");
  if (!card.usageAnswer) errors.push("missing usage answer");
  const accepted = Array.isArray(card.accepted) ? card.accepted : [];
  if (!accepted.includes(card.usageAnswer)) errors.push("accepted must contain usageAnswer");
  const choice = card.choiceQuestion as Record<string, unknown> | undefined;
  const options = Array.isArray(choice?.options) ? choice.options : [];
  if (options.length !== 4 || new Set(options).size !== 4) {
    errors.push("choice question must have four unique options");
  }
  if (options.filter((option) => option === choice?.answer).length !== 1) {
    errors.push("choice question must have exactly one explicit answer");
  }
  return errors;
}

async function authenticatedEmail(request: Request) {
  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!authorization || !supabaseUrl || !anonKey) return "";
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: anonKey },
  });
  if (!response.ok) return "";
  const user = await response.json();
  return String(user.email || "").toLowerCase();
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const email = await authenticatedEmail(request);
    if (email !== "parent@nelson-study.app") {
      return new Response(JSON.stringify({ error: "Parent access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const body = await request.json();
    const words = [...new Set(
      (Array.isArray(body.words) ? body.words : []).map(normalizeWord).filter(Boolean),
    )].slice(0, 30);
    if (!words.length) throw new Error("No valid English words were provided");

    const generationSystem = `
You are an expert English teacher designing rigorous vocabulary cards for Nelson, a Chinese teenage English learner at approximately B1-B2 level.
Create one card for every requested word, in the same order. Use the most useful school-age meaning unless alternateSense is true.
Every English sentence must be natural and grammatically flawless. Pay special attention to subject-verb agreement, articles, countability, tense, conditionals, future time clauses, collocations, and word forms.
The example must contain the exact target lemma. The usagePrompt must contain exactly one visible blank made from underscores, and usageAnswer must make the completed sentence grammatical.
accepted must include usageAnswer. The four choice options must be distinct and only one can answer the question.
Chinese translations must accurately match the English. Keep explanations concise and practical. Do not mention AI.`;
    const generated = await callOpenAI(generationSystem, {
      words,
      alternateSense: Boolean(body.alternateSense),
      existingWords: Array.isArray(body.existingWords) ? body.existingWords : [],
    });

    const reviewSystem = `
You are a second, independent senior English assessment editor. Audit every supplied vocabulary card and return the complete corrected cards.
Do not trust the draft. Correct all grammar, subject-verb agreement, tense, articles, countability, collocations, word forms, translations, ambiguity, and answer-key errors.
Ensure the example contains the exact target lemma, the usage question has exactly one underscore blank, the accepted answers contain the answer, and the multiple-choice question has four distinct options with exactly one defensible answer.
Preserve the requested word list and strict JSON structure.`;
    let reviewed = await callOpenAI(reviewSystem, { words, draft: generated.cards });
    let failures = reviewed.cards.flatMap((card: Record<string, unknown>, index: number) =>
      validateCard(card).map((error) => ({ index, word: card.word, error }))
    );
    if (failures.length) {
      reviewed = await callOpenAI(
        `${reviewSystem}\nA deterministic validator rejected the prior version. Repair every listed failure.`,
        { words, draft: reviewed.cards, failures },
      );
      failures = reviewed.cards.flatMap((card: Record<string, unknown>, index: number) =>
        validateCard(card).map((error) => ({ index, word: card.word, error }))
      );
    }
    if (reviewed.cards.length !== words.length || failures.length) {
      throw new Error(`Content validation failed: ${JSON.stringify(failures).slice(0, 500)}`);
    }
    return new Response(JSON.stringify({
      cards: reviewed.cards,
      model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini",
      review: "generated-independent-review-deterministic-validation",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
