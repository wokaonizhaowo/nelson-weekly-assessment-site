(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NelsonExamEngine = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function normalizeAnswer(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[“”"'.,!?;:，。！？；：]/g, "")
      .replace(/\s+/g, " ");
  }

  function deterministicSort(items, salt) {
    return [...items].sort((left, right) => hash(`${salt}:${left.id}`) - hash(`${salt}:${right.id}`));
  }

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function isQuestionUsed(question, used) {
    return used.has(question.id) || used.has(`knowledge:${question.knowledgeId}`);
  }

  function markQuestionUsed(question, used) {
    used.add(question.id);
    used.add(`knowledge:${question.knowledgeId}`);
  }

  function takeQuestions(bank, scope, count, salt, used) {
    const candidates = deterministicSort(
      bank.filter((question) => question.scope === scope && !isQuestionUsed(question, used)),
      salt,
    );
    const selected = [];
    for (const question of candidates) {
      if (selected.length >= count) break;
      selected.push({ ...question });
      markQuestionUsed(question, used);
    }
    if (selected.length < count) {
      const fallback = deterministicSort(
        bank.filter((question) => !isQuestionUsed(question, used)),
        `${salt}:fallback`,
      );
      for (const question of fallback) {
        if (selected.length >= count) break;
        selected.push({ ...question, scope });
        markQuestionUsed(question, used);
      }
    }
    return selected;
  }

  function takeBalancedQuestions(bank, scope, count, salt, used) {
    const scoped = deterministicSort(
      bank.filter((question) => question.scope === scope && !isQuestionUsed(question, used)),
      salt,
    );
    const selected = [];
    const days = [...new Set(scoped.map((question) => question.sourceDay).filter(Boolean))].sort(
      (left, right) => left - right,
    );
    if (days.length) {
      let round = 0;
      while (selected.length < count) {
        let added = 0;
        for (const day of days) {
          if (selected.length >= count) break;
          const dayQuestions = scoped.filter(
            (item) => item.sourceDay === day && !isQuestionUsed(item, used),
          );
          const question = dayQuestions[round];
          if (question) {
            selected.push({ ...question });
            markQuestionUsed(question, used);
            added += 1;
          }
        }
        if (!added) break;
        round += 1;
      }
    }
    if (selected.length < count) {
      selected.push(...takeQuestions(bank, scope, count - selected.length, `${salt}:fill`, used));
    }
    return selected;
  }

  function examTypeForDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getDay() !== 6) return null;
    const nextSaturday = new Date(date);
    nextSaturday.setDate(date.getDate() + 7);
    return nextSaturday.getMonth() !== date.getMonth() ? "monthly" : "weekly";
  }

  function buildExam(type, bank, profiles, salt = "2026-06") {
    const used = new Set();
    let questions;
    if (type === "monthly") {
      questions = [
        ...takeQuestions(bank, "mistake", 16, `${salt}:mistake`, used),
        ...takeQuestions(bank, "monthly-vocabulary", 14, `${salt}:vocabulary`, used),
        ...takeQuestions(bank, "monthly-grammar", 10, `${salt}:grammar`, used),
      ];
    } else {
      const sortedProfiles = Object.values(profiles || {})
        .sort((a, b) => calculatePriority(b) - calculatePriority(a))
      const carryoverIds = sortedProfiles
        .filter((profile) => (profile.remainingWeeklyReviews || 0) > 0)
        .map((profile) => profile.knowledgeId);
      const profileIds = sortedProfiles.map((profile) => profile.knowledgeId);
      const mistakePool = bank
        .filter((question) => question.scope === "mistake" || profileIds.includes(question.knowledgeId))
        .map((question) => ({
          ...question,
          scope: "mistake",
          carryoverRank: carryoverIds.indexOf(question.knowledgeId),
        }))
        .sort((left, right) => {
          const leftRank = left.carryoverRank < 0 ? 999 : left.carryoverRank;
          const rightRank = right.carryoverRank < 0 ? 999 : right.carryoverRank;
          return leftRank - rightRank;
        });
      const carryovers = mistakePool
        .filter((question) => question.carryoverRank >= 0)
        .slice(0, 5)
        .map((question) => ({ ...question }));
      carryovers.forEach((question) => markQuestionUsed(question, used));
      const remainingMistakes = takeQuestions(
        mistakePool,
        "mistake",
        5 - carryovers.length,
        `${salt}:mistake`,
        used,
      );
      questions = [
        ...takeBalancedQuestions(bank, "recent", 13, `${salt}:recent`, used),
        ...takeBalancedQuestions(bank, "previous", 7, `${salt}:previous`, used),
        ...carryovers,
        ...remainingMistakes,
      ];
    }
    const points = type === "monthly" ? 2.5 : 4;
    return {
      id: `${type}-${salt}`,
      type,
      version: 1,
      status: "published",
      points,
      totalPoints: 100,
      durationMinutes: type === "monthly" ? 30 : 15,
      questions: questions.map((question, index) => ({ ...question, order: index + 1, points })),
    };
  }

  function isCorrect(answer, question) {
    return (question.accepted || [question.answer]).some(
      (accepted) => normalizeAnswer(accepted) === normalizeAnswer(answer),
    );
  }

  function scoreExam(exam, answers, startedAt, submittedAt) {
    const results = exam.questions.map((question) => {
      const userAnswer = answers[question.id] || "";
      const correct = isCorrect(userAnswer, question);
      return { question, userAnswer, correct, earned: correct ? question.points : 0 };
    });
    const score = Number(results.reduce((sum, result) => sum + result.earned, 0).toFixed(1));
    const categoryMap = {};
    results.forEach((result) => {
      const key = result.question.category;
      if (!categoryMap[key]) categoryMap[key] = { earned: 0, possible: 0 };
      categoryMap[key].earned += result.earned;
      categoryMap[key].possible += result.question.points;
    });
    const breakdown = Object.fromEntries(
      Object.entries(categoryMap).map(([key, value]) => [
        key,
        Math.round((value.earned / Math.max(value.possible, 1)) * 100),
      ]),
    );
    return {
      id: `result-${exam.id}-${submittedAt}`,
      examId: exam.id,
      examType: exam.type,
      version: exam.version,
      score,
      durationSeconds: Math.max(1, Math.round((submittedAt - startedAt) / 1000)),
      submittedAt: new Date(submittedAt).toISOString(),
      breakdown,
      results,
      abnormal: false,
    };
  }

  function updateProfiles(profiles, result) {
    const next = JSON.parse(JSON.stringify(profiles || {}));
    result.results.forEach(({ question, userAnswer, correct }) => {
      const key = question.knowledgeId;
      const profile = next[key] || {
        knowledgeId: key,
        label: question.knowledge,
        category: question.category,
        attempts: 0,
        errors: 0,
        recentErrorStreak: 0,
        consecutiveCorrect: 0,
        monthlyErrors: 0,
        importance: question.importance || 3,
        manualAdjustment: 0,
        typicalWrongAnswer: "",
      };
      profile.attempts += 1;
      profile.lastTestedAt = result.submittedAt;
      if (correct) {
        profile.consecutiveCorrect += 1;
        profile.recentErrorStreak = 0;
      } else {
        profile.errors += 1;
        profile.recentErrorStreak += 1;
        profile.consecutiveCorrect = 0;
        profile.lastErrorAt = result.submittedAt;
        profile.typicalWrongAnswer = userAnswer || "未作答";
        if (result.examType === "monthly") {
          profile.monthlyErrors += 1;
          profile.remainingWeeklyReviews = 2;
        }
      }
      if (result.examType === "weekly" && (profile.remainingWeeklyReviews || 0) > 0) {
        profile.remainingWeeklyReviews -= 1;
      }
      next[key] = profile;
    });
    return next;
  }

  function calculatePriority(profile, now = Date.now()) {
    if (!profile || !profile.attempts) return 0;
    const errorRate = profile.errors / profile.attempts;
    const daysSinceError = profile.lastErrorAt
      ? Math.max(0, (now - new Date(profile.lastErrorAt).getTime()) / 86400000)
      : 60;
    const recency = Math.max(0, 1 - daysSinceError / 30);
    const sampleConfidence = Math.min(1, profile.attempts / 3);
    const masteryReduction = profile.consecutiveCorrect >= 2 ? 25 : profile.consecutiveCorrect * 8;
    return Math.max(
      0,
      Math.round(
        errorRate * 45 * sampleConfidence +
          Math.min(profile.errors, 5) * 5 +
          profile.recentErrorStreak * 8 +
          recency * 12 +
          Math.min(profile.monthlyErrors || 0, 2) * 8 +
          (profile.importance || 3) * 2 +
          (profile.manualAdjustment || 0) -
          masteryReduction,
      ),
    );
  }

  function recommendationFor(profile) {
    const rate = Math.round((profile.errors / Math.max(profile.attempts, 1)) * 100);
    const evidence = `考察 ${profile.attempts} 次，错误 ${profile.errors} 次，错误率 ${rate}%`;
    let action = "用新语境完成 2 次主动回忆";
    if (profile.category === "spelling") action = "进行“看中文拼写＋句中补全”各 2 次";
    if (profile.category === "collocation") action = "复习固定搭配，并完成 3 个换句填空";
    if (profile.category === "grammar") action = "先对比规则，再完成 3 组语法辨析";
    const priority = calculatePriority(profile);
    const level = profile.attempts === 1 ? "observe" : priority >= 58 ? "high" : priority >= 32 ? "medium" : "observe";
    const status =
      profile.consecutiveCorrect >= 2
        ? "stable"
        : profile.consecutiveCorrect === 1
          ? "improving"
          : profile.attempts <= 2
            ? "new"
            : "persistent";
    return {
      knowledgeId: profile.knowledgeId,
      label: profile.label,
      category: profile.category,
      priority,
      level,
      status,
      evidence,
      action,
      typicalWrongAnswer: profile.typicalWrongAnswer,
      lastErrorAt: profile.lastErrorAt,
    };
  }

  function buildRecommendations(profiles, limit = 8) {
    return Object.values(profiles || {})
      .filter((profile) => profile.errors > 0)
      .map(recommendationFor)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, limit);
  }

  return {
    normalizeAnswer,
    examTypeForDate,
    buildExam,
    scoreExam,
    updateProfiles,
    calculatePriority,
    buildRecommendations,
  };
});
