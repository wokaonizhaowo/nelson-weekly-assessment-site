const assert = require("node:assert/strict");
const Engine = require("./exam-engine.js");

global.NELSON_WEEK_DATA = undefined;
require("./week-data.js");
const bank = global.NELSON_WEEK_DATA.questions;
assert.ok(bank.every((question) => question.translation), "Every question must include a Chinese translation");

assert.equal(Engine.examTypeForDate("2026-06-20T08:00:00+08:00"), "weekly");
assert.equal(Engine.examTypeForDate("2026-06-27T08:00:00+08:00"), "monthly");
assert.equal(Engine.examTypeForDate("2026-06-26T08:00:00+08:00"), null);

const weekly = Engine.buildExam("weekly", bank, {}, "test-week");
assert.equal(weekly.questions.length, 25);
assert.equal(weekly.points, 4);
assert.equal(weekly.questions.reduce((sum, question) => sum + question.points, 0), 100);
assert.deepEqual(
  weekly.questions.reduce((result, question) => ({ ...result, [question.scope]: (result[question.scope] || 0) + 1 }), {}),
  { recent: 13, previous: 7, mistake: 5 },
);

global.NELSON_MORNING_READING_DATA = undefined;
require("./morning-reading-data.js");
const morningBank = [
  ...global.NELSON_MORNING_READING_DATA.questions,
  ...bank.filter((question) =>
    ["mistake", "monthly-vocabulary", "monthly-grammar"].includes(question.scope),
  ),
];
const weekThree = Engine.buildExam("weekly", morningBank, {}, "WEEK_03-test");
const morningQuestions = weekThree.questions.filter((question) =>
  ["recent", "previous"].includes(question.scope),
);
assert.equal(morningQuestions.length, 20);
assert.deepEqual(
  [...new Set(morningQuestions.map((question) => question.sourceDay))].sort(),
  [1, 2, 3, 4, 5, 6, 7],
);
assert.equal(new Set(morningQuestions.map((question) => question.knowledgeId)).size, 20);
assert.ok(morningQuestions.every((question) => question.sourceWeek === "WEEK_03"));
assert.ok(morningQuestions.every((question) => question.translation));

const monthly = Engine.buildExam("monthly", bank, {}, "test-month");
assert.equal(monthly.questions.length, 40);
assert.equal(monthly.points, 2.5);
assert.equal(monthly.questions.reduce((sum, question) => sum + question.points, 0), 100);
assert.deepEqual(
  monthly.questions.reduce((result, question) => ({ ...result, [question.scope]: (result[question.scope] || 0) + 1 }), {}),
  { mistake: 16, "monthly-vocabulary": 14, "monthly-grammar": 10 },
);

const answers = Object.fromEntries(weekly.questions.map((question) => [question.id, question.answer]));
const perfect = Engine.scoreExam(weekly, answers, 0, 600000);
assert.equal(perfect.score, 100);

const question = weekly.questions[0];
const wrongResult = Engine.scoreExam(weekly, { ...answers, [question.id]: "wrong" }, 0, 600000);
const updated = Engine.updateProfiles({}, wrongResult);
assert.equal(updated[question.knowledgeId].errors, 1);
assert.equal(updated[question.knowledgeId].attempts, 1);
assert.equal(Engine.buildRecommendations(updated)[0].level, "observe");

const profile = {
  ...updated[question.knowledgeId],
  attempts: 4,
  errors: 3,
  recentErrorStreak: 2,
  lastErrorAt: new Date().toISOString(),
};
assert.equal(Engine.buildRecommendations({ one: profile })[0].level, "high");

profile.consecutiveCorrect = 2;
profile.recentErrorStreak = 0;
assert.ok(Engine.calculatePriority(profile) < Engine.calculatePriority({ ...profile, consecutiveCorrect: 0 }));

const monthlyWrong = Engine.scoreExam(monthly, {}, 0, 1200000);
const afterMonthly = Engine.updateProfiles({}, monthlyWrong);
const monthlyKnowledge = monthly.questions[0].knowledgeId;
assert.equal(afterMonthly[monthlyKnowledge].remainingWeeklyReviews, 2);
const carryoverWeekly = Engine.buildExam("weekly", bank, afterMonthly, "carryover-week");
assert.ok(carryoverWeekly.questions.some((item) => item.knowledgeId === monthlyKnowledge && item.scope === "mistake"));
const afterWeekly = Engine.updateProfiles(afterMonthly, Engine.scoreExam(carryoverWeekly, {}, 0, 600000));
assert.equal(afterWeekly[monthlyKnowledge].remainingWeeklyReviews, 1);

console.log("All Nelson assessment engine tests passed.");
