const assert = require("node:assert/strict");
const Vocabulary = require("./vocabulary-engine.js");

global.NELSON_MORNING_READING_DATA = undefined;
require("./morning-reading-data.js");
const morning = global.NELSON_MORNING_READING_DATA;
const items = Vocabulary.buildMorningItems(morning.questions);

assert.ok(items.length >= 100, "Morning reading questions should produce a reusable word library");
assert.equal(new Set(items.map((item) => item.id)).size, items.length);
assert.ok(items.every((item) => item.word && item.meaningZh && item.example));

const weekStart = Date.parse("2026-06-13T08:00:00+08:00");
const dayOneAvailable = items.filter((item) =>
  Vocabulary.isItemAvailable(item, morning, weekStart),
);
assert.ok(dayOneAvailable.some((item) => item.sourceWeek === "WEEK_04" && item.sourceDay === 1));
assert.ok(!dayOneAvailable.some((item) => item.sourceWeek === "WEEK_04" && item.sourceDay === 2));

const selected = Vocabulary.selectDailyItems(items, {}, morning, weekStart, 10);
assert.equal(selected.length, 10);
assert.ok(selected.every((item) => Vocabulary.isItemAvailable(item, morning, weekStart)));

const session = Vocabulary.buildSession(items, {}, morning, weekStart, 10);
assert.equal(session.itemIds.length, 10);
assert.equal(session.steps.length, 40);
assert.deepEqual(
  session.steps.slice(0, 4).map((step) => step.mode),
  ["learn", "recognition", "spelling", "usage"],
);

session.steps.forEach((step) => {
  if (step.mode !== "learn") session.answers[step.id] = step.answer;
});
let progress = Vocabulary.updateProgress({}, session, weekStart);
assert.ok(session.itemIds.every((id) => progress[id].stage !== "mastered"));

const secondSession = JSON.parse(JSON.stringify(session));
secondSession.id = "second-day";
progress = Vocabulary.updateProgress(progress, secondSession, weekStart + 86400000);
assert.ok(session.itemIds.every((id) => progress[id].stage === "mastered"));
assert.ok(session.itemIds.every((id) => progress[id].spellingSuccessDates.length === 2));
assert.ok(session.itemIds.every((id) => progress[id].usageSuccessDates.length === 2));

const wrongSession = Vocabulary.buildSession(items, {}, morning, weekStart, 1);
wrongSession.steps.forEach((step) => {
  if (step.mode !== "learn") wrongSession.answers[step.id] = step.answer;
});
const spelling = wrongSession.steps.find((step) => step.mode === "spelling");
wrongSession.errors.push({
  stepId: spelling.id,
  wordId: spelling.wordId,
  mode: "spelling",
  answer: "wrong",
});
const wrongProgress = Vocabulary.updateProgress({}, wrongSession, weekStart);
assert.equal(wrongProgress[spelling.wordId].spellingErrors, 1);
assert.equal(wrongProgress[spelling.wordId].typicalWrongAnswer, "wrong");

assert.deepEqual(
  Vocabulary.parseWordInput("adequate, evidence\nadequate；optimistic"),
  ["adequate", "evidence", "optimistic"],
);

const validCard = {
  word: "adequate",
  meaningZh: "足够的",
  example: "Adequate sleep helps students concentrate.",
  exampleZh: "充足的睡眠帮助学生集中注意力。",
  usagePrompt: "Students need a_______ sleep before an exam.",
  usageAnswer: "adequate",
  accepted: ["adequate"],
  explanation: "Adequate means enough for a particular purpose.",
  choiceQuestion: {
    options: ["足够的", "危险的", "突然的", "普通的"],
    answer: "足够的",
  },
};
assert.deepEqual(Vocabulary.validateVocabularyItem(validCard), []);
assert.ok(Vocabulary.validateVocabularyItem({
  ...validCard,
  usagePrompt: "No blank is present.",
}).length);
assert.ok(Vocabulary.validateVocabularyItem({
  ...validCard,
  choiceQuestion: { options: ["足够的", "足够的", "危险的", "普通的"], answer: "足够的" },
}).length);

console.log("All Nelson vocabulary engine tests passed.");
