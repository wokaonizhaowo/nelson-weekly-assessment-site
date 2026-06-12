const STORAGE_KEY = "nelson-weekly-assessment-v1";
const Engine = window.NelsonExamEngine;
const legacyData = window.NELSON_WEEK_DATA;
const morningReadingData = window.NELSON_MORNING_READING_DATA;
const morningQuestions = morningReadingData?.questions || [];
const legacySupportQuestions = legacyData.questions.filter((question) =>
  ["mistake", "monthly-vocabulary", "monthly-grammar"].includes(question.scope),
);
const bank = morningQuestions.length
  ? [...morningQuestions, ...legacySupportQuestions]
  : legacyData.questions;

function currentWeekSalt(type = "weekly") {
  const latestWeek = morningReadingData?.latestWeek || "2026-W24";
  return type === "monthly" ? `${latestWeek}-month` : latestWeek;
}

const seededProfiles = {
  "word:adequate": {
    knowledgeId: "word:adequate", label: "adequate", category: "spelling", attempts: 4, errors: 3,
    recentErrorStreak: 2, consecutiveCorrect: 0, monthlyErrors: 0, importance: 5, manualAdjustment: 0,
    typicalWrongAnswer: "adquate", lastErrorAt: "2026-06-07T03:20:00.000Z", lastTestedAt: "2026-06-07T03:20:00.000Z",
  },
  "grammar:pay-attention-to": {
    knowledgeId: "grammar:pay-attention-to", label: "pay attention to", category: "collocation", attempts: 3, errors: 2,
    recentErrorStreak: 2, consecutiveCorrect: 0, monthlyErrors: 0, importance: 5, manualAdjustment: 0,
    typicalWrongAnswer: "pay attention at", lastErrorAt: "2026-06-07T03:22:00.000Z", lastTestedAt: "2026-06-07T03:22:00.000Z",
  },
  "grammar:evidence-uncountable": {
    knowledgeId: "grammar:evidence-uncountable", label: "evidence 不可数", category: "grammar", attempts: 3, errors: 2,
    recentErrorStreak: 1, consecutiveCorrect: 0, monthlyErrors: 1, importance: 5, manualAdjustment: 0,
    typicalWrongAnswer: "There are enough evidences", lastErrorAt: "2026-05-30T03:26:00.000Z", lastTestedAt: "2026-06-07T03:26:00.000Z",
  },
  "grammar:only-if-inversion": {
    knowledgeId: "grammar:only-if-inversion", label: "Only if... 倒装", category: "grammar", attempts: 2, errors: 1,
    recentErrorStreak: 1, consecutiveCorrect: 0, monthlyErrors: 1, importance: 5, manualAdjustment: 0,
    typicalWrongAnswer: "Only if... vocabulary can", lastErrorAt: "2026-05-30T03:29:00.000Z", lastTestedAt: "2026-05-30T03:29:00.000Z",
  },
  "word:consistent": {
    knowledgeId: "word:consistent", label: "consistent", category: "spelling", attempts: 3, errors: 1,
    recentErrorStreak: 0, consecutiveCorrect: 2, monthlyErrors: 0, importance: 5, manualAdjustment: 0,
    typicalWrongAnswer: "consistant", lastErrorAt: "2026-05-23T03:10:00.000Z", lastTestedAt: "2026-06-07T03:10:00.000Z",
  },
};

const defaultState = {
  profiles: seededProfiles,
  results: [
    { id: "w1", examType: "weekly", score: 68, durationSeconds: 902, submittedAt: "2026-05-16T03:30:00.000Z", breakdown: { spelling: 62, collocation: 70, grammar: 71 } },
    { id: "w2", examType: "weekly", score: 72, durationSeconds: 865, submittedAt: "2026-05-23T03:30:00.000Z", breakdown: { spelling: 68, collocation: 75, grammar: 73 } },
    { id: "m1", examType: "monthly", score: 70, durationSeconds: 1760, submittedAt: "2026-05-30T04:00:00.000Z", breakdown: { spelling: 72, collocation: 69, grammar: 67 } },
    { id: "w3", examType: "weekly", score: 76, durationSeconds: 821, submittedAt: "2026-06-07T03:30:00.000Z", breakdown: { spelling: 73, collocation: 80, grammar: 75 } },
  ],
  drafts: [],
  currentAttempt: null,
  submittedExamIds: [],
};

let state = loadState();
let activeExam = null;
let activeIndex = 0;
let answers = {};
let elapsedSeconds = 0;
let activeSince = 0;
let timerId = null;
let historyType = "weekly";
let dashboardType = "weekly";
let latestResult = null;

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const screens = [...document.querySelectorAll(".screen")];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...clone(defaultState), ...saved } : clone(defaultState);
  } catch {
    return clone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function findOfficialResult(examId) {
  return state.results.find((result) => result.examId === examId && !result.practice);
}

function incompleteCorrectionResults() {
  return state.results
    .filter((result) => !result.practice && Array.isArray(result.results))
    .map((result) => ({
      result,
      pending: result.results.filter((item) => !item.correct && !item.corrected).length,
    }))
    .filter((item) => item.pending > 0)
    .sort((left, right) => new Date(right.result.submittedAt) - new Date(left.result.submittedAt));
}

function questionTranslation(question) {
  if (question.translation) return question.translation;
  const source = bank.find(
    (item) => item.id === question.id || item.knowledgeId === question.knowledgeId,
  );
  return source?.translation || "本题中文句意暂未录入。";
}

function openStoredResult(result) {
  activeExam = Engine.buildExam(
    result.examType,
    bank,
    state.profiles,
    currentWeekSalt(result.examType),
  );
  activeExam.practiceMode = false;
  latestResult = result;
  renderResult(result);
  showScreen("reviewScreen");
}

function showScreen(id) {
  screens.forEach((screen) => screen.classList.toggle("active", screen.id === id));
  const rootScreen = ["studentHome", "historyScreen", "parentScreen"].includes(id);
  elements.studentNav.classList.toggle("hidden", !rootScreen);
  elements.backButton.classList.toggle("hidden", rootScreen);
  elements.roleButton.classList.toggle("hidden", id === "examScreen" || id === "reviewScreen");
  const titles = {
    studentHome: ["NELSON · WEEKLY CHECK", "周六英语测验"],
    examScreen: [activeExam?.type === "monthly" ? "MONTHLY EXAM" : "WEEKLY TEST", "专注完成整套试卷"],
    reviewScreen: ["SCORE SAVED", "成绩与订正"],
    historyScreen: ["NELSON · SCOREBOOK", "成绩记录"],
    parentScreen: ["NELSON · PARENT", "家长看板"],
  };
  [elements.eyebrow.textContent, elements.pageTitle.textContent] = titles[id] || titles.studentHome;
  document.querySelectorAll("[data-screen]").forEach((button) => button.classList.toggle("active", button.dataset.screen === id));
  if (id === "studentHome") renderHome();
  if (id === "historyScreen") renderHistory();
  if (id === "parentScreen") renderParent();
  document.querySelector(".screen.active")?.scrollTo(0, 0);
}

function resultSeries(type) {
  return state.results
    .filter((result) => result.examType === type && !result.abnormal)
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
}

function renderChart(container, results) {
  if (!results.length) {
    container.innerHTML = `<p class="empty-copy">完成第一次考试后，这里会出现成绩曲线。</p>`;
    return;
  }
  const width = 320;
  const height = 112;
  const padding = 18;
  const minScore = Math.max(0, Math.min(...results.map((item) => item.score)) - 10);
  const range = Math.max(20, 100 - minScore);
  const points = results.map((item, index) => {
    const x = results.length === 1 ? width / 2 : padding + (index * (width - padding * 2)) / (results.length - 1);
    const y = height - padding - ((item.score - minScore) / range) * (height - padding * 2);
    return { x, y, item };
  });
  const path = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="成绩趋势图">
      <path class="chart-guide" d="M ${padding} ${height - padding} H ${width - padding}" />
      <path class="chart-line" d="${path}" />
      ${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4"></circle><text x="${point.x}" y="${point.y - 10}">${point.item.score}</text>`).join("")}
    </svg>
    <div class="chart-labels">${results.map((item) => `<span>${formatDate(item.submittedAt)}</span>`).join("")}</div>
  `;
}

function renderHome() {
  elements.todayLabel.textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", weekday: "long",
  }).format(new Date());
  elements.currentWeekLabel.textContent = morningReadingData?.latestLabel || legacyData.label;
  const weekly = resultSeries("weekly");
  elements.latestWeeklyScore.textContent = weekly.at(-1)?.score ?? "--";
  renderChart(elements.studentTrend, weekly.slice(-5));
  const recommendations = Engine.buildRecommendations(state.profiles, 3);
  elements.studentFocusList.innerHTML = recommendations.map((item, index) => `
    <article>
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.action)}</small></div>
      <b>${item.level === "high" ? "优先" : item.level === "medium" ? "巩固" : "观察"}</b>
    </article>
  `).join("");
  const nextSaturday = new Date();
  nextSaturday.setDate(nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7));
  const scheduledType = Engine.examTypeForDate(nextSaturday);
  const weeklyExam = Engine.buildExam("weekly", bank, state.profiles, currentWeekSalt("weekly"));
  const monthlyExam = Engine.buildExam("monthly", bank, state.profiles, currentWeekSalt("monthly"));
  const weeklyCompleted = Boolean(findOfficialResult(weeklyExam.id));
  const monthlyCompleted = Boolean(findOfficialResult(monthlyExam.id));
  elements.startWeeklyButton.textContent = weeklyCompleted
    ? "查看本周成绩"
    : scheduledType === "monthly"
      ? "本周为月考周"
      : state.currentAttempt?.examId === weeklyExam.id
        ? "继续本周周测"
        : "开始本周周测";
  elements.startWeeklyButton.disabled = scheduledType === "monthly" && !weeklyCompleted;
  elements.startMonthlyButton.textContent = monthlyCompleted
    ? "查看月考成绩"
    : state.currentAttempt?.examId === monthlyExam.id
      ? "继续月考"
      : "模拟月考";
  const pendingCorrections = incompleteCorrectionResults();
  const latestPending = pendingCorrections[0];
  const totalPending = pendingCorrections.reduce((sum, item) => sum + item.pending, 0);
  elements.pendingCorrectionCard.classList.toggle("hidden", !latestPending);
  if (latestPending) {
    elements.pendingCorrectionTitle.textContent =
      latestPending.result.examType === "monthly" ? "上次月考订正还未完成" : "上次周测订正还未完成";
    elements.pendingCorrectionCount.textContent =
      pendingCorrections.length > 1
        ? `共有 ${totalPending} 题待订正`
        : `还有 ${latestPending.pending} 题待订正`;
    elements.pendingCorrectionCard.dataset.resultId = latestPending.result.id;
  } else {
    delete elements.pendingCorrectionCard.dataset.resultId;
  }
}

function startExam(type) {
  startExamWithOptions(type);
}

function startExamWithOptions(type, options = {}) {
  activeExam = Engine.buildExam(type, bank, state.profiles, currentWeekSalt(type));
  activeExam.practiceMode = Boolean(options.practice);
  const officialResult = findOfficialResult(activeExam.id);
  if (officialResult && !activeExam.practiceMode) {
    latestResult = officialResult;
    renderResult(officialResult);
    showScreen("reviewScreen");
    return;
  }
  const saved =
    state.currentAttempt?.examId === activeExam.id &&
    Boolean(state.currentAttempt.practiceMode) === activeExam.practiceMode
      ? state.currentAttempt
      : null;
  activeIndex = saved?.activeIndex || 0;
  answers = saved?.answers || {};
  elapsedSeconds = activeExam.practiceMode ? 0 : saved?.elapsedSeconds || 0;
  activeSince = Date.now();
  state.currentAttempt = {
    examId: activeExam.id,
    activeIndex,
    answers,
    elapsedSeconds,
    practiceMode: activeExam.practiceMode,
  };
  saveState();
  showScreen("examScreen");
  renderQuestion();
  startTimer();
}

function startTimer() {
  window.clearInterval(timerId);
  const update = () => {
    elements.examTimer.textContent = formatDuration(currentElapsedSeconds());
  };
  update();
  timerId = window.setInterval(update, 1000);
}

function currentElapsedSeconds() {
  const activeDelta = activeSince ? Math.floor((Date.now() - activeSince) / 1000) : 0;
  return elapsedSeconds + Math.max(0, activeDelta);
}

function pauseExamTimer() {
  if (!activeExam || !activeSince) return;
  elapsedSeconds = currentElapsedSeconds();
  activeSince = 0;
  window.clearInterval(timerId);
  if (state.currentAttempt?.examId === activeExam.id) {
    state.currentAttempt.elapsedSeconds = elapsedSeconds;
    saveState();
  }
}

function resumeExamTimer() {
  if (!activeExam || activeSince || !document.querySelector("#examScreen.active")) return;
  activeSince = Date.now();
  startTimer();
}

function persistCurrentAnswer() {
  const question = activeExam?.questions[activeIndex];
  if (!question) return;
  const choice = document.querySelector('input[name="examAnswer"]:checked');
  const input = document.querySelector("#textAnswer");
  answers[question.id] = choice?.value ?? input?.value.trim() ?? "";
  state.currentAttempt = {
    examId: activeExam.id,
    activeIndex,
    answers,
    elapsedSeconds: currentElapsedSeconds(),
    practiceMode: activeExam.practiceMode,
  };
  saveState();
}

function currentAnswerValue() {
  const choice = document.querySelector('input[name="examAnswer"]:checked');
  const input = document.querySelector("#textAnswer");
  return (choice?.value ?? input?.value ?? "").trim();
}

function clearRequiredMessage() {
  elements.answerRequiredMessage.classList.add("hidden");
  elements.questionPrompt.classList.remove("answer-missing");
  elements.answerArea.classList.remove("answer-missing");
}

function showRequiredMessage() {
  elements.answerRequiredMessage.classList.remove("hidden");
  elements.questionPrompt.classList.add("answer-missing");
  elements.answerArea.classList.add("answer-missing");
  const input = document.querySelector("#textAnswer");
  if (input) input.focus();
}

function scopeLabel(scope) {
  return {
    recent: "刚结束一周",
    previous: morningReadingData?.previousWeek ? "前一周巩固" : "本周补充巩固",
    mistake: "历史错题",
    "monthly-vocabulary": "本月重点词",
    "monthly-grammar": "本月重点语法",
  }[scope] || "综合复习";
}

function renderQuestion() {
  const question = activeExam.questions[activeIndex];
  const total = activeExam.questions.length;
  elements.examTypeLabel.textContent =
    activeExam.type === "monthly"
      ? "月考 · 40题"
      : `${morningReadingData?.latestLabel || legacyData.label} · 25题`;
  elements.questionCounter.textContent = `${activeIndex + 1} / ${total}`;
  elements.examProgressBar.style.width = `${((activeIndex + 1) / total) * 100}%`;
  elements.questionKind.textContent = question.kind;
  const sourceSuffix = question.sourceWeek
    ? ` · ${question.sourceWeek}${question.sourceDay ? ` D${question.sourceDay}` : ""}`
    : "";
  elements.questionScope.textContent = `${scopeLabel(question.scope)}${sourceSuffix}`;
  elements.questionInstruction.textContent = question.instruction;
  elements.questionPrompt.textContent = question.prompt;
  const saved = answers[question.id] || "";
  clearRequiredMessage();
  if (question.type === "choice") {
    elements.answerArea.innerHTML = `<div class="choice-list">${question.options.map((option, index) => `
      <label><input type="radio" name="examAnswer" value="${escapeHtml(option)}" ${saved === option ? "checked" : ""}>
      <span>${String.fromCharCode(65 + index)}</span><strong>${escapeHtml(option)}</strong></label>
    `).join("")}</div>`;
    elements.questionPrompt.innerHTML = escapeHtml(question.prompt);
    elements.answerArea.classList.remove("inline-answer-area");
  } else {
    const blankPattern = /[A-Za-z]_{3,}|_{3,}/;
    const promptParts = question.prompt.split(blankPattern);
    const blankMatch = question.prompt.match(blankPattern);
    const inputWidth = Math.max(7, Math.min(14, (question.answer?.length || 8) + 2));
    elements.questionPrompt.innerHTML = blankMatch
      ? `${escapeHtml(promptParts[0])}<label class="inline-blank" style="--answer-chars:${inputWidth}"><span class="sr-only">填写缺失单词</span><input id="textAnswer" type="text" value="${escapeHtml(saved)}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="填写缺失单词"></label>${escapeHtml(promptParts.slice(1).join(blankMatch[0]))}`
      : `${escapeHtml(question.prompt)} <label class="inline-blank" style="--answer-chars:${inputWidth}"><span class="sr-only">填写答案</span><input id="textAnswer" type="text" value="${escapeHtml(saved)}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="填写答案"></label>`;
    elements.answerArea.innerHTML = "";
    elements.answerArea.classList.add("inline-answer-area");
    window.setTimeout(() => document.querySelector("#textAnswer")?.focus(), 80);
  }
  elements.answerArea.querySelectorAll("input").forEach((input) => {
    const handleAnswerChange = () => {
      clearRequiredMessage();
      persistCurrentAnswer();
      renderQuestionNavigator();
    };
    input.addEventListener("input", handleAnswerChange);
    input.addEventListener("change", handleAnswerChange);
  });
  elements.previousQuestionButton.disabled = activeIndex === 0;
  elements.nextQuestionButton.textContent = activeIndex === total - 1 ? "检查并交卷" : "下一题";
  renderQuestionNavigator();
}

function renderQuestionNavigator() {
  const total = activeExam.questions.length;
  const answered = activeExam.questions.filter((question) => String(answers[question.id] || "").trim()).length;
  elements.answeredCount.textContent = `已答 ${answered} / ${total}`;
  elements.questionGrid.innerHTML = activeExam.questions.map((question, index) => {
    const hasAnswer = Boolean(String(answers[question.id] || "").trim());
    const current = index === activeIndex;
    const canVisit = current || hasAnswer;
    return `<button type="button" class="${current ? "current" : ""} ${hasAnswer ? "answered" : ""}" data-question-index="${index}" ${canVisit ? "" : "disabled"} aria-label="第 ${index + 1} 题${hasAnswer ? "，已作答" : "，未作答"}">${index + 1}</button>`;
  }).join("");
  elements.questionGrid.querySelectorAll("[data-question-index]:not(:disabled)").forEach((button) => {
    button.addEventListener("click", () => {
      persistCurrentAnswer();
      activeIndex = Number(button.dataset.questionIndex);
      state.currentAttempt.activeIndex = activeIndex;
      saveState();
      renderQuestion();
    });
  });
}

function goQuestion(delta) {
  if (delta > 0 && !currentAnswerValue()) {
    showRequiredMessage();
    return;
  }
  persistCurrentAnswer();
  if (delta > 0 && activeIndex === activeExam.questions.length - 1) {
    openSubmitModal();
    return;
  }
  activeIndex = Math.max(0, Math.min(activeExam.questions.length - 1, activeIndex + delta));
  state.currentAttempt.activeIndex = activeIndex;
  saveState();
  renderQuestion();
}

function openSubmitModal() {
  const unanswered = activeExam.questions.filter((question) => !answers[question.id]).length;
  elements.submitModalCopy.textContent = unanswered
    ? `还有 ${unanswered} 题未作答。正式提交后成绩不能修改。`
    : "所有题目都已作答。正式提交后成绩不能修改。";
  elements.submitModal.classList.remove("hidden");
}

function submitExam() {
  if (!activeExam.practiceMode && state.submittedExamIds.includes(activeExam.id)) return;
  pauseExamTimer();
  latestResult = Engine.scoreExam(activeExam, answers, 0, elapsedSeconds * 1000);
  latestResult.practice = activeExam.practiceMode;
  if (!activeExam.practiceMode) {
    state.results.push(latestResult);
    state.profiles = Engine.updateProfiles(state.profiles, latestResult);
    state.submittedExamIds.push(activeExam.id);
  }
  state.currentAttempt = null;
  saveState();
  window.clearInterval(timerId);
  elements.submitModal.classList.add("hidden");
  renderResult(latestResult);
  showScreen("reviewScreen");
}

function renderResult(result) {
  const incorrect = result.results.filter((item) => !item.correct);
  elements.resultTypeLabel.textContent = result.examType === "monthly" ? "MONTHLY RESULT" : "WEEKLY RESULT";
  elements.resultScore.textContent = result.score;
  elements.resultHeadline.textContent = result.practice
    ? "本次为不计分练习"
    : result.score >= 85
      ? "掌握得很扎实"
      : result.score >= 70
        ? "基础稳定，薄弱点已找到"
        : "这次结果会指导下一轮复习";
  elements.resultSummary.textContent = `用时 ${formatDuration(result.durationSeconds)}，答对 ${result.results.length - incorrect.length} / ${result.results.length} 题。`;
  const labels = { spelling: "词汇拼写", collocation: "固定搭配", grammar: "词形语法" };
  elements.resultBreakdown.innerHTML = Object.entries(result.breakdown).map(([key, value]) => `
    <article><span>${labels[key] || key}</span><strong>${value}</strong><small>/ 100</small></article>
  `).join("");
  elements.incorrectCount.textContent = `${incorrect.length} 处需要订正`;
  elements.correctionList.innerHTML = incorrect.length ? incorrect.map((item, index) => `
    <article data-correction-index="${index}">
      <div><span>${escapeHtml(item.question.kind)}</span><strong>${escapeHtml(item.question.knowledge)}</strong></div>
      <p>${escapeHtml(item.question.prompt)}</p>
      <p class="correction-translation">中文：${escapeHtml(questionTranslation(item.question))}</p>
      <div class="correction-reference ${item.corrected ? "hidden" : ""}">
        <small>你的答案</small><b class="wrong-answer">${escapeHtml(item.userAnswer || "未作答")}</b>
        <small>正确答案</small><b>${escapeHtml(item.question.answer)}</b>
        <em>${escapeHtml(item.question.explanation)}</em>
      </div>
      <div class="correction-retry ${item.corrected ? "" : "hidden"}">${item.corrected ? `<span class="correction-feedback correct">订正已完成，后续测试还会再次独立考查。</span>` : ""}</div>
      <button class="correction-start-button ${item.corrected ? "hidden" : ""}" data-start-correction="${index}">看懂了，隐藏答案再答一次</button>
    </article>
  `).join("") : `<p class="empty-copy">全部答对，这次没有需要订正的题目。</p>`;
  elements.correctionList.querySelectorAll("[data-start-correction]").forEach((button) => {
    button.addEventListener("click", () => startCorrectionRetry(incorrect[Number(button.dataset.startCorrection)], button));
  });
  elements.practiceRedoButton.classList.toggle("hidden", !activeExam);
  updateCorrectionCompletion();
}

function correctionInputMarkup(question) {
  if (question.type === "choice") {
    return `<div class="correction-choice-list">${question.options.map((option, index) => `
      <label><input type="radio" name="correction-${escapeHtml(question.id)}" value="${escapeHtml(option)}"><span>${String.fromCharCode(65 + index)}</span><strong>${escapeHtml(option)}</strong></label>
    `).join("")}</div>`;
  }
  return `<input class="correction-text-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="重新填写答案">`;
}

function startCorrectionRetry(item, button) {
  const card = button.closest("[data-correction-index]");
  card.querySelector(".correction-reference").classList.add("hidden");
  button.classList.add("hidden");
  const retry = card.querySelector(".correction-retry");
  retry.classList.remove("hidden");
  retry.innerHTML = `
    <p>答案已隐藏，请独立再答一次。</p>
    ${correctionInputMarkup(item.question)}
    <button class="correction-check-button">检查订正</button>
    <span class="correction-feedback" role="status"></span>`;
  retry.querySelector(".correction-check-button").addEventListener("click", () => {
    const choice = retry.querySelector("input[type='radio']:checked");
    const input = retry.querySelector(".correction-text-input");
    const value = choice?.value ?? input?.value.trim() ?? "";
    const feedback = retry.querySelector(".correction-feedback");
    if (!value) {
      feedback.textContent = "请先完成订正答案。";
      feedback.className = "correction-feedback incorrect";
      return;
    }
    const correct = (item.question.accepted || [item.question.answer]).some(
      (answer) => Engine.normalizeAnswer(value) === Engine.normalizeAnswer(answer),
    );
    feedback.textContent = correct ? "订正完成。后续测试还会再次独立考查。" : "还不正确，请再检查一次。";
    feedback.className = `correction-feedback ${correct ? "correct" : "incorrect"}`;
    if (correct) {
      retry.querySelectorAll("input, button").forEach((element) => { element.disabled = true; });
      item.corrected = true;
      saveState();
      updateCorrectionCompletion();
    }
  });
  retry.querySelector("input")?.focus();
}

function updateCorrectionCompletion() {
  const pending = elements.correctionList.querySelectorAll("[data-correction-index]").length -
    elements.correctionList.querySelectorAll(".correction-feedback.correct").length;
  elements.finishResultButton.disabled = pending > 0;
  elements.practiceRedoButton.disabled = pending > 0;
  elements.finishResultButton.textContent = pending > 0 ? `还需完成 ${pending} 题订正` : "完成订正";
}

function renderHistory() {
  const results = resultSeries(historyType);
  const latest = results.at(-1);
  const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) : 0;
  elements.historySummary.innerHTML = `
    <article><span>最近成绩</span><strong>${latest?.score ?? "--"}</strong></article>
    <article><span>平均分</span><strong>${average || "--"}</strong></article>
    <article><span>最高分</span><strong>${results.length ? Math.max(...results.map((item) => item.score)) : "--"}</strong></article>`;
  renderChart(elements.historyChart, results);
  elements.historyList.innerHTML = [...results].reverse().map((result) => `
    <article><time>${formatDate(result.submittedAt)}</time><div><strong>${result.examType === "monthly" ? "月考" : "周测"}</strong><small>用时 ${formatDuration(result.durationSeconds)}</small></div><b>${result.score}</b></article>
  `).join("");
}

function renderParent() {
  const results = resultSeries(dashboardType);
  const latest = results.at(-1);
  const previous = results.at(-2);
  const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) : 0;
  const change = latest && previous ? latest.score - previous.score : 0;
  elements.parentScoreCards.innerHTML = `
    <article><span>最近成绩</span><strong>${latest?.score ?? "--"}</strong><small>${dashboardType === "monthly" ? "月考" : "周测"}百分制</small></article>
    <article><span>较上次</span><strong class="${change < 0 ? "negative" : ""}">${change > 0 ? "+" : ""}${change || 0}</strong><small>分数变化</small></article>
    <article><span>平均分</span><strong>${average || "--"}</strong><small>${results.length} 次有效记录</small></article>
    <article><span>最高分</span><strong>${results.length ? Math.max(...results.map((item) => item.score)) : "--"}</strong><small>历史最佳</small></article>`;
  elements.parentTrendTitle.textContent = dashboardType === "monthly" ? "月考成绩变化" : "周测成绩变化";
  renderChart(elements.parentTrend, results);
  renderAbilities();
  renderRecommendations();
  renderChanges();
  renderDraft();
}

function renderAbilities() {
  const latest = state.results.at(-1);
  const labels = { spelling: "词汇拼写", collocation: "固定搭配", grammar: "词形与句法" };
  const values = latest?.breakdown || { spelling: 73, collocation: 80, grammar: 75 };
  elements.abilityList.innerHTML = Object.entries(labels).map(([key, label]) => `
    <div><span>${label}</span><strong>${values[key] ?? 0}</strong><i><b style="width:${values[key] ?? 0}%"></b></i></div>
  `).join("");
}

function levelLabel(level) {
  return level === "high" ? "高优先" : level === "medium" ? "中优先" : "需观察";
}

function renderRecommendations() {
  const recommendations = Engine.buildRecommendations(state.profiles, 8);
  elements.recommendationList.innerHTML = recommendations.map((item) => `
    <article data-level="${item.level}">
      <div class="recommendation-top">
        <span>${levelLabel(item.level)}</span>
        <strong>${escapeHtml(item.label)}</strong>
        <b>优先级 ${item.priority}</b>
      </div>
      <p>${escapeHtml(item.action)}</p>
      <small>${escapeHtml(item.evidence)}${item.typicalWrongAnswer ? `；典型错误：${escapeHtml(item.typicalWrongAnswer)}` : ""}</small>
      <div class="recommendation-actions">
        <button data-adjust="${escapeHtml(item.knowledgeId)}" data-delta="-10">降低</button>
        <button data-adjust="${escapeHtml(item.knowledgeId)}" data-delta="10">提高</button>
        <button class="add-draft" data-add-draft="${escapeHtml(item.knowledgeId)}">加入下周试卷</button>
      </div>
    </article>
  `).join("");
  elements.recommendationList.querySelectorAll("[data-adjust]").forEach((button) => {
    button.addEventListener("click", () => {
      state.profiles[button.dataset.adjust].manualAdjustment += Number(button.dataset.delta);
      saveState();
      renderParent();
    });
  });
  elements.recommendationList.querySelectorAll("[data-add-draft]").forEach((button) => {
    button.addEventListener("click", () => addToDraft(button.dataset.addDraft));
  });
}

function renderChanges() {
  const recommendations = Object.values(state.profiles).map((profile) => {
    const item = Engine.buildRecommendations({ [profile.knowledgeId]: profile }, 1)[0];
    return item || { ...profile, status: "stable" };
  });
  const groups = [
    ["persistent", "持续薄弱"], ["new", "本周新增"], ["improving", "正在改善"], ["stable", "已稳定掌握"],
  ];
  elements.changeGroups.innerHTML = groups.map(([key, label]) => {
    const items = recommendations.filter((item) => item.status === key);
    return `<article><span>${label}</span><strong>${items.length}</strong><small>${items.slice(0, 2).map((item) => item.label).join("、") || "暂无"}</small></article>`;
  }).join("");
}

function addToDraft(knowledgeId) {
  if (state.drafts.some((item) => item.knowledgeId === knowledgeId)) return;
  const source = bank.find((question) => question.knowledgeId === knowledgeId);
  const profile = state.profiles[knowledgeId];
  state.drafts.push({
    knowledgeId,
    label: profile?.label || source?.knowledge || knowledgeId,
    variantPrompt: source?.variantPrompt || `换新语境复习 ${profile?.label || knowledgeId}`,
  });
  saveState();
  renderParent();
}

function renderDraft() {
  elements.draftCount.textContent = `${state.drafts.length} / 5`;
  elements.draftList.innerHTML = state.drafts.length ? state.drafts.map((item) => `
    <article><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.variantPrompt)}</small></div><button data-remove-draft="${escapeHtml(item.knowledgeId)}">移除</button></article>
  `).join("") : `<p class="empty-copy">尚未手动加入知识点。系统仍会自动选择 5 道历史错题。</p>`;
  elements.draftList.querySelectorAll("[data-remove-draft]").forEach((button) => {
    button.addEventListener("click", () => {
      state.drafts = state.drafts.filter((item) => item.knowledgeId !== button.dataset.removeDraft);
      saveState();
      renderParent();
    });
  });
}

elements.startWeeklyButton.addEventListener("click", () => startExam("weekly"));
elements.startMonthlyButton.addEventListener("click", () => startExam("monthly"));
elements.previousQuestionButton.addEventListener("click", () => goQuestion(-1));
elements.nextQuestionButton.addEventListener("click", () => goQuestion(1));
elements.cancelSubmitButton.addEventListener("click", () => elements.submitModal.classList.add("hidden"));
elements.confirmSubmitButton.addEventListener("click", submitExam);
elements.finishResultButton.addEventListener("click", () => showScreen("studentHome"));
elements.practiceRedoButton.addEventListener("click", () => {
  const type = latestResult?.examType || activeExam?.type;
  if (type) startExamWithOptions(type, { practice: true });
});
elements.pendingCorrectionCard.addEventListener("click", () => {
  const result = state.results.find((item) => item.id === elements.pendingCorrectionCard.dataset.resultId);
  if (result) openStoredResult(result);
});
elements.viewAdviceButton.addEventListener("click", () => showScreen("parentScreen"));
elements.backButton.addEventListener("click", () => {
  if (document.querySelector("#examScreen.active")) {
    persistCurrentAnswer();
    pauseExamTimer();
  }
  showScreen("studentHome");
});
elements.roleButton.addEventListener("click", () => showScreen(document.querySelector("#parentScreen.active") ? "studentHome" : "parentScreen"));
document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screen)));
document.querySelectorAll("[data-history-type]").forEach((button) => button.addEventListener("click", () => {
  historyType = button.dataset.historyType;
  document.querySelectorAll("[data-history-type]").forEach((item) => item.classList.toggle("active", item === button));
  renderHistory();
}));
document.querySelectorAll("[data-dashboard-type]").forEach((button) => button.addEventListener("click", () => {
  dashboardType = button.dataset.dashboardType;
  document.querySelectorAll("[data-dashboard-type]").forEach((item) => item.classList.toggle("active", item === button));
  renderParent();
}));
elements.resetButton.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  state = clone(defaultState);
  renderParent();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    persistCurrentAnswer();
    pauseExamTimer();
  } else {
    resumeExamTimer();
  }
});
window.addEventListener("pagehide", () => {
  persistCurrentAnswer();
  pauseExamTimer();
});
window.addEventListener("beforeunload", () => {
  persistCurrentAnswer();
  pauseExamTimer();
});

showScreen("studentHome");
