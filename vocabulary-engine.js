(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NelsonVocabularyEngine = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const REVIEW_INTERVALS = [0, 1, 3, 7, 14, 30];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeWord(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z'-]/g, "");
  }

  function localDateKey(value = Date.now()) {
    const date = new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function addDays(value, days) {
    const date = new Date(value);
    date.setHours(8, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }

  function fillPrompt(prompt, answer) {
    const source = String(prompt || "");
    const match = source.match(/[A-Za-z]_{3,}|_{3,}/);
    if (!match) return source;
    const replacement = match.index === 0 && /^[A-Z]/.test(match[0])
      ? `${String(answer).charAt(0).toUpperCase()}${String(answer).slice(1)}`
      : answer;
    return source.replace(match[0], replacement);
  }

  function extractMeaning(question) {
    const match = String(question.instruction || "").match(/[「“](.+?)[」”]/);
    return match?.[1] || question.knowledge || question.answer;
  }

  function buildMorningItems(questions) {
    const items = new Map();
    (questions || []).forEach((question) => {
      if (!question.knowledgeId?.startsWith("word:")) return;
      const id = question.knowledgeId;
      const existing = items.get(id);
      const item = {
        id,
        word: normalizeWord(question.knowledge),
        displayWord: question.knowledge,
        meaningZh: extractMeaning(question),
        phonetic: "",
        partOfSpeech: "",
        collocations: question.explanation || "",
        commonMistake: question.errorType === "spelling" ? "注意完整拼写和词形变化。" : "",
        example: fillPrompt(question.prompt, question.answer),
        exampleZh: question.translation || "",
        spellingPrompt: `根据中文“${extractMeaning(question)}”拼写单词。`,
        usagePrompt: question.prompt,
        usageAnswer: question.answer,
        accepted: question.accepted || [question.answer],
        explanation: question.explanation || "",
        sourceType: "morning",
        sourceWeek: question.sourceWeek,
        sourceDay: question.sourceDay || 1,
        sourceQuestionId: question.id,
        status: "active",
        reviewStatus: "verified-source",
        createdAt: new Date().toISOString(),
      };
      if (!existing || question.scope === "recent") items.set(id, item);
    });
    return [...items.values()];
  }

  function parseWeekStart(dateRange) {
    const first = String(dateRange || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!first) return null;
    const date = new Date(`${first}T00:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function isItemAvailable(item, morningData, now = Date.now()) {
    if (item.status !== "active") return false;
    if (item.sourceType !== "morning") {
      return !item.availableAt || new Date(item.availableAt).getTime() <= now;
    }
    if (item.sourceWeek !== morningData?.latestWeek) return true;
    const start = parseWeekStart(morningData?.latestDateRange);
    if (!start) return true;
    const elapsedDay = Math.floor((now - start.getTime()) / 86400000) + 1;
    return (item.sourceDay || 1) <= Math.max(1, Math.min(7, elapsedDay));
  }

  function defaultProgress(item) {
    return {
      wordId: item.id,
      stage: "new",
      intervalIndex: 0,
      dueAt: null,
      attempts: 0,
      errors: 0,
      spellingAttempts: 0,
      spellingErrors: 0,
      usageAttempts: 0,
      usageErrors: 0,
      spellingSuccessDates: [],
      usageSuccessDates: [],
      consecutiveCorrect: 0,
      lastStudiedAt: null,
      lastErrorAt: null,
      typicalWrongAnswer: "",
      masteredAt: null,
    };
  }

  function itemPriority(item, progress, morningData, now) {
    if (!progress) {
      const latestBonus = item.sourceWeek === morningData?.latestWeek ? 30 : 0;
      return 60 + latestBonus + (8 - (item.sourceDay || 1));
    }
    const due = progress.dueAt && new Date(progress.dueAt).getTime() <= now ? 55 : 0;
    const errorRate = progress.errors / Math.max(progress.attempts, 1);
    const stage = progress.stage === "relearning" ? 35 : progress.stage === "learning" ? 20 : 0;
    return due + errorRate * 40 + stage + (progress.masteredAt ? -50 : 0);
  }

  function selectDailyItems(items, progressById, morningData, now = Date.now(), limit = 10) {
    return items
      .filter((item) => isItemAvailable(item, morningData, now))
      .map((item) => ({
        item,
        priority: itemPriority(item, progressById[item.id], morningData, now),
      }))
      .filter(({ item, priority }) => {
        const progress = progressById[item.id];
        return !progress || priority > 0 || progress.stage !== "mastered";
      })
      .sort((left, right) =>
        right.priority - left.priority ||
        left.item.word.localeCompare(right.item.word)
      )
      .slice(0, limit)
      .map(({ item }) => item);
  }

  function distractorsFor(item, allItems, field, count = 3) {
    const candidates = allItems.filter((candidate) =>
      candidate.id !== item.id && candidate[field] && candidate[field] !== item[field]
    );
    return candidates
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, count)
      .map((candidate) => candidate[field]);
  }

  function rotateOptions(values, seed) {
    const result = [...new Set(values)];
    if (!result.length) return result;
    const offset = [...String(seed)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % result.length;
    return result.slice(offset).concat(result.slice(0, offset));
  }

  function buildSteps(selectedItems, allItems) {
    const steps = [];
    selectedItems.forEach((item) => {
      steps.push({
        id: `${item.id}:learn`,
        wordId: item.id,
        mode: "learn",
        title: "认识单词",
      });
      steps.push({
        id: `${item.id}:recognition`,
        wordId: item.id,
        mode: "recognition",
        title: "快速辨认",
        prompt: `“${item.word}”最符合下面哪一个意思？`,
        answer: item.meaningZh,
        options: rotateOptions(
          [item.meaningZh, ...distractorsFor(item, allItems, "meaningZh")],
          item.id,
        ),
      });
      steps.push({
        id: `${item.id}:spelling`,
        wordId: item.id,
        mode: "spelling",
        title: "拼写挑战",
        prompt: item.spellingPrompt || `根据中文“${item.meaningZh}”拼写单词。`,
        answer: item.word,
        accepted: [item.word],
      });
      steps.push({
        id: `${item.id}:usage`,
        wordId: item.id,
        mode: "usage",
        title: "语境运用",
        prompt: item.usagePrompt,
        answer: item.usageAnswer || item.word,
        accepted: item.accepted || [item.usageAnswer || item.word],
      });
    });
    return steps;
  }

  function buildSession(items, progressById, morningData, now = Date.now(), limit = 10) {
    const selected = selectDailyItems(items, progressById, morningData, now, limit);
    return {
      id: `vocab-${localDateKey(now)}-${now}`,
      dateKey: localDateKey(now),
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      itemIds: selected.map((item) => item.id),
      steps: buildSteps(selected, items),
      activeIndex: 0,
      answers: {},
      attempts: {},
      errors: [],
      completed: false,
      elapsedSeconds: 0,
    };
  }

  function isAnswerCorrect(value, step) {
    if (step.mode === "recognition") {
      return String(value || "").trim() === String(step.answer || "").trim();
    }
    const normalized = normalizeWord(value);
    return (step.accepted || [step.answer]).some((answer) =>
      normalizeWord(answer) === normalized
    );
  }

  function uniqueDatePush(values, dateKey) {
    return [...new Set([...(values || []), dateKey])].sort();
  }

  function updateProgress(progressById, session, now = Date.now()) {
    const next = clone(progressById || {});
    const dateKey = localDateKey(now);
    session.steps
      .filter((step) => ["spelling", "usage"].includes(step.mode))
      .forEach((step) => {
        const value = session.answers[step.id] || "";
        const correct = isAnswerCorrect(value, step);
        const hadError = (session.errors || []).some((error) => error.stepId === step.id);
        const profile = next[step.wordId] || defaultProgress({ id: step.wordId });
        profile.attempts += 1;
        profile[`${step.mode}Attempts`] += 1;
        profile.lastStudiedAt = new Date(now).toISOString();
        if (hadError) {
          profile.errors += 1;
          profile[`${step.mode}Errors`] += 1;
          profile.lastErrorAt = new Date(now).toISOString();
          profile.typicalWrongAnswer =
            [...session.errors].reverse().find((error) => error.stepId === step.id)?.answer ||
            value ||
            "未作答";
        }
        if (correct) {
          profile.consecutiveCorrect += 1;
          profile[`${step.mode}SuccessDates`] = uniqueDatePush(
            profile[`${step.mode}SuccessDates`],
            dateKey,
          );
        } else {
          if (!hadError) {
            profile.errors += 1;
            profile[`${step.mode}Errors`] += 1;
          }
          profile.consecutiveCorrect = 0;
          profile.lastErrorAt = new Date(now).toISOString();
          profile.typicalWrongAnswer = value || "未作答";
          profile.stage = "relearning";
          profile.intervalIndex = 0;
        }
        next[step.wordId] = profile;
      });
    session.itemIds.forEach((wordId) => {
      const profile = next[wordId] || defaultProgress({ id: wordId });
      const spellingDays = profile.spellingSuccessDates?.length || 0;
      const usageDays = profile.usageSuccessDates?.length || 0;
      const mastered = spellingDays >= 2 && usageDays >= 2;
      if (mastered) {
        profile.stage = "mastered";
        profile.masteredAt ||= new Date(now).toISOString();
        profile.dueAt = null;
      } else if (profile.errors) {
        profile.stage = profile.consecutiveCorrect ? "reviewing" : "relearning";
        profile.intervalIndex = Math.min(
          REVIEW_INTERVALS.length - 1,
          profile.consecutiveCorrect ? profile.intervalIndex + 1 : 0,
        );
        profile.dueAt = addDays(now, REVIEW_INTERVALS[profile.intervalIndex]);
      } else {
        profile.stage = "learning";
        profile.intervalIndex = Math.min(REVIEW_INTERVALS.length - 1, profile.intervalIndex + 1);
        profile.dueAt = addDays(now, REVIEW_INTERVALS[profile.intervalIndex]);
      }
      next[wordId] = profile;
    });
    return next;
  }

  function validateVocabularyItem(item) {
    const errors = [];
    if (!normalizeWord(item.word)) errors.push("缺少有效英文单词");
    if (!item.meaningZh) errors.push("缺少中文释义");
    if (!item.example || !new RegExp(`\\b${normalizeWord(item.word)}\\w*\\b`, "i").test(item.example)) {
      errors.push("例句未包含目标词或其词形");
    }
    if (!item.exampleZh) errors.push("缺少例句翻译");
    const blanks = String(item.usagePrompt || "").match(/[A-Za-z]_{3,}|_{3,}/g) || [];
    if (blanks.length !== 1) errors.push("语境题必须且只能包含一个填空");
    if (!item.usageAnswer) errors.push("缺少语境题答案");
    if (!Array.isArray(item.accepted) || !item.accepted.length) errors.push("缺少可接受答案");
    if (!item.explanation) errors.push("缺少答案解析");
    if (item.usagePrompt && item.usageAnswer) {
      const completed = fillPrompt(item.usagePrompt, item.usageAnswer);
      if (completed === item.usagePrompt) errors.push("语境题答案无法代回题干");
    }
    if (item.choiceQuestion) {
      const options = item.choiceQuestion.options || [];
      if (options.length !== 4 || new Set(options).size !== 4) errors.push("选择题必须有四个不同选项");
      if (options.filter((option) => option === item.choiceQuestion.answer).length !== 1) {
        errors.push("选择题必须只有一个精确正确答案");
      }
    }
    return errors;
  }

  function parseWordInput(value) {
    return [...new Set(
      String(value || "")
        .split(/[\s,，;；]+/)
        .map(normalizeWord)
        .filter(Boolean),
    )];
  }

  return {
    REVIEW_INTERVALS,
    normalizeWord,
    localDateKey,
    fillPrompt,
    buildMorningItems,
    isItemAvailable,
    selectDailyItems,
    buildSession,
    isAnswerCorrect,
    updateProgress,
    validateVocabularyItem,
    parseWordInput,
  };
});
