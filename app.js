const STORAGE_KEY = "nelson-weekly-assessment-v2";
const Engine = window.NelsonExamEngine;
const supabaseConfig = window.NELSON_SUPABASE_CONFIG;
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

const defaultState = {
  profiles: {},
  results: [],
  drafts: [],
  reviewTasks: {},
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
let latestResult = null;
let supabaseClient = null;
let currentUser = null;
let currentRole = null;
let selectedLoginRole = "student";
let cloudReady = false;
let cloudSaveTimer = null;
let correctionIndex = 0;
let cloudUpdatedAt = null;
let syncInProgress = false;
let pendingCloudSave = false;

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
  pendingCloudSave = true;
  setSyncStatus("pending", "等待同步");
  scheduleCloudSave();
}

function scheduleCloudSave() {
  if (!cloudReady || !currentUser || !supabaseClient) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(syncStateToCloud, 500);
}

function setSyncStatus(status, text) {
  if (!elements.syncStatus) return;
  elements.syncStatus.dataset.state = status;
  elements.syncStatus.textContent = text;
}

function resultCorrectionCount(result) {
  return result?.results?.filter((item) => item.corrected).length || 0;
}

function mergeResults(localResults = [], remoteResults = []) {
  const merged = new Map(remoteResults.map((result) => [result.id, result]));
  localResults.forEach((result) => {
    const remote = merged.get(result.id);
    if (!remote || resultCorrectionCount(result) >= resultCorrectionCount(remote)) {
      merged.set(result.id, result);
    }
  });
  return [...merged.values()].sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
}

function mergeReviewTasks(localTasks = {}, remoteTasks = {}) {
  const merged = clone(remoteTasks);
  Object.entries(localTasks).forEach(([resultId, tasks]) => {
    const tasksById = new Map((merged[resultId] || []).map((task) => [task.id, task]));
    tasks.forEach((task) => {
      const remote = tasksById.get(task.id);
      tasksById.set(task.id, {
        ...remote,
        ...task,
        completed: Boolean(remote?.completed || task.completed),
      });
    });
    merged[resultId] = [...tasksById.values()];
  });
  return merged;
}

function attemptProgress(attempt) {
  if (!attempt) return -1;
  const answered = Object.values(attempt.answers || {}).filter((value) => String(value).trim()).length;
  return answered * 100000 + (attempt.elapsedSeconds || 0);
}

function mergeStates(localValue, remoteValue) {
  const local = normalizeState(localValue);
  const remote = normalizeState(remoteValue);
  let currentAttempt = remote.currentAttempt || local.currentAttempt;
  if (
    local.currentAttempt &&
    remote.currentAttempt &&
    local.currentAttempt.examId === remote.currentAttempt.examId
  ) {
    currentAttempt = attemptProgress(local.currentAttempt) >= attemptProgress(remote.currentAttempt)
      ? local.currentAttempt
      : remote.currentAttempt;
  }
  return {
    ...remote,
    profiles: Object.keys(local.profiles).length >= Object.keys(remote.profiles).length
      ? local.profiles
      : remote.profiles,
    results: mergeResults(local.results, remote.results),
    drafts: [...new Map(
      [...remote.drafts, ...local.drafts].map((item) => [item.knowledgeId, item]),
    ).values()],
    reviewTasks: mergeReviewTasks(local.reviewTasks, remote.reviewTasks),
    currentAttempt,
    submittedExamIds: [...new Set([...remote.submittedExamIds, ...local.submittedExamIds])],
  };
}

async function syncStateToCloud(force = false) {
  if ((!cloudReady && !force) || !currentUser || !supabaseClient || syncInProgress) return;
  syncInProgress = true;
  setSyncStatus("syncing", "正在同步");
  try {
    const nextUpdatedAt = new Date().toISOString();
    let query = supabaseClient
      .from("nelson_family_state")
      .update({
        state,
        updated_at: nextUpdatedAt,
        updated_by: currentUser.id,
      })
      .eq("family_id", supabaseConfig.familyId);
    if (cloudUpdatedAt) query = query.eq("updated_at", cloudUpdatedAt);
    const { data, error } = await query.select("updated_at").maybeSingle();
    if (error) throw error;
    if (!data) {
      const { data: remote, error: readError } = await supabaseClient
        .from("nelson_family_state")
        .select("state, updated_at")
        .eq("family_id", supabaseConfig.familyId)
        .single();
      if (readError) throw readError;
      state = mergeStates(state, remote.state);
      cloudUpdatedAt = remote.updated_at;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      pendingCloudSave = true;
      setSyncStatus("conflict", "已合并新数据");
      const activeScreen = document.querySelector(".screen.active")?.id;
      if (["studentHome", "historyScreen", "parentScreen"].includes(activeScreen)) {
        showScreen(activeScreen);
      }
      window.setTimeout(scheduleCloudSave, 300);
      return;
    }
    cloudUpdatedAt = data.updated_at;
    pendingCloudSave = false;
    setSyncStatus("saved", "已同步");
  } catch (error) {
    pendingCloudSave = true;
    setSyncStatus("offline", "等待网络");
    console.warn("Cloud sync failed:", error.message);
  } finally {
    syncInProgress = false;
  }
}

function normalizeState(value) {
  return {
    ...clone(defaultState),
    ...(value || {}),
    profiles: value?.profiles || {},
    results: Array.isArray(value?.results) ? value.results : [],
    drafts: Array.isArray(value?.drafts) ? value.drafts : [],
    reviewTasks: value?.reviewTasks || {},
    submittedExamIds: Array.isArray(value?.submittedExamIds) ? value.submittedExamIds : [],
  };
}

async function loadStateFromCloud() {
  const { data, error } = await supabaseClient
    .from("nelson_family_state")
    .select("state, updated_at")
    .eq("family_id", supabaseConfig.familyId)
    .maybeSingle();
  if (error) throw error;
  if (data?.state) {
    state = normalizeState(data.state);
    cloudUpdatedAt = data.updated_at;
    pendingCloudSave = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSyncStatus("saved", "已同步");
  } else {
    const createdAt = new Date().toISOString();
    const { data: inserted, error: insertError } = await supabaseClient
      .from("nelson_family_state")
      .insert({
        family_id: supabaseConfig.familyId,
        state,
        updated_at: createdAt,
        updated_by: currentUser.id,
      })
      .select("updated_at")
      .single();
    if (insertError) throw insertError;
    cloudUpdatedAt = inserted.updated_at;
    pendingCloudSave = false;
    setSyncStatus("saved", "已同步");
  }
}

async function refreshStateFromCloud() {
  if (!cloudReady || !currentUser || activeExam || !supabaseClient || pendingCloudSave) return;
  try {
    await loadStateFromCloud();
    const activeScreen = document.querySelector(".screen.active")?.id;
    if (activeScreen) showScreen(activeScreen);
  } catch (error) {
    setSyncStatus("offline", "等待网络");
    console.warn("Cloud refresh failed:", error.message);
  }
}

function roleForUser(user) {
  const email = user?.email?.toLowerCase();
  if (email === supabaseConfig.accounts.parent) return "parent";
  if (email === supabaseConfig.accounts.student) return "student";
  return null;
}

function setLoginRole(role) {
  selectedLoginRole = role;
  elements.loginRoleSwitch.querySelectorAll("[data-login-role]").forEach((button) => {
    button.classList.toggle("active", button.dataset.loginRole === role);
  });
  elements.loginButton.textContent = role === "parent" ? "进入家长看板" : "进入测验";
  elements.loginPassword.value = "";
  elements.loginMessage.textContent = "";
}

function showLogin(role = "student", message = "") {
  setLoginRole(role);
  elements.loginMessage.textContent = message;
  elements.logoutButton.classList.toggle("hidden", !currentUser);
  elements.loginModal.classList.remove("hidden");
  window.setTimeout(() => elements.loginPassword.focus(), 50);
}

function applyRoleAccess() {
  const isParent = currentRole === "parent";
  elements.parentNavButton.classList.toggle("hidden", !isParent);
  elements.roleButton.textContent = isParent ? "切换" : "账号";
}

async function activateSession(session) {
  pauseExamTimer();
  activeExam = null;
  currentUser = session?.user || null;
  currentRole = roleForUser(currentUser);
  if (!currentRole) {
    await supabaseClient.auth.signOut();
    showLogin("student", "这个账号没有访问 Nelson 成长空间的权限。");
    return;
  }
  cloudReady = false;
  setSyncStatus("connecting", "正在连接");
  try {
    await loadStateFromCloud();
    cloudReady = true;
    elements.loginModal.classList.add("hidden");
    applyRoleAccess();
    showScreen(currentRole === "parent" ? "parentScreen" : "studentHome");
  } catch (error) {
    showLogin(
      currentRole,
      error.code === "42P01"
        ? "数据库尚未初始化，请家长先运行 supabase-setup.sql。"
        : `云端连接失败：${error.message}`,
    );
  }
}

async function initializeCloud() {
  if (!window.supabase?.createClient || !supabaseConfig) {
    showLogin("student", "云端登录组件加载失败，请检查网络后刷新。");
    return;
  }
  supabaseClient = window.supabase.createClient(
    supabaseConfig.url,
    supabaseConfig.publishableKey,
    { auth: { persistSession: true, autoRefreshToken: true } },
  );
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    await activateSession(data.session);
  } else {
    showLogin("student");
  }
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

function resultPeriodLabel(result) {
  if (result.weekLabel) return result.weekLabel.replace("WEEK ", "W");
  if (result.examType === "monthly") {
    return `M${new Date(result.submittedAt).getMonth() + 1}`;
  }
  return "周测";
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
  if (id === "parentScreen" && currentRole !== "parent") {
    showLogin("parent", "请输入家长密码后查看家长看板。");
    return;
  }
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
    <div class="chart-labels">${results.map((item) => `<span>${escapeHtml(resultPeriodLabel(item))}</span>`).join("")}</div>
  `;
}

function renderHome() {
  elements.todayLabel.textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", weekday: "long",
  }).format(new Date());
  elements.currentWeekLabel.textContent = morningReadingData?.latestLabel || legacyData.label;
  const recommendations = Engine.buildRecommendations(state.profiles, 3);
  elements.studentFocusSection.classList.toggle("hidden", !recommendations.length);
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
  const isMonthlyWeek = scheduledType === "monthly";
  const scheduledExam = isMonthlyWeek ? monthlyExam : weeklyExam;
  const completedResult = findOfficialResult(scheduledExam.id);
  const pendingForScheduled = completedResult?.results?.filter(
    (item) => !item.correct && !item.corrected,
  ).length || 0;
  const taskLabel = isMonthlyWeek
    ? `${nextSaturday.getMonth() + 1} 月月考`
    : `${morningReadingData?.latestLabel?.replace("WEEK ", "W") || "本周"} 周测`;
  elements.todayTaskTitle.textContent = `今天要完成：${taskLabel}`;
  elements.todayTaskStatus.textContent = completedResult
    ? pendingForScheduled
      ? "待订正"
      : "已完成"
    : state.currentAttempt?.examId === scheduledExam.id
      ? "进行中"
      : "待完成";
  elements.todayTaskStatus.dataset.status = completedResult && !pendingForScheduled
    ? "done"
    : state.currentAttempt?.examId === scheduledExam.id
      ? "active"
      : pendingForScheduled
        ? "correction"
        : "pending";
  elements.todayTaskCopy.textContent = completedResult
    ? pendingForScheduled
      ? `测试已经提交，还有 ${pendingForScheduled} 题需要订正。订正完成才算完成本周任务。`
      : "本周任务已全部完成。可以查看成绩和复习任务。"
    : isMonthlyWeek
      ? "预计 30 分钟，本周月考替代周测，完成测试和订正才算结束。"
      : "预计 15 分钟，完成测试和订正才算完成本周任务。";
  elements.monthlyExamTitle.textContent = `${nextSaturday.getMonth() + 1} 月月考 · 40 题`;
  document.querySelector(".exam-hero").classList.toggle("hidden", isMonthlyWeek);
  elements.monthlyCard.classList.toggle("hidden", !isMonthlyWeek);
  elements.startWeeklyButton.textContent = weeklyCompleted
    ? "查看本周成绩"
    : state.currentAttempt?.examId === weeklyExam.id
        ? "继续本周周测"
        : "开始本周周测";
  elements.startMonthlyButton.textContent = monthlyCompleted
    ? "查看月考成绩"
    : state.currentAttempt?.examId === monthlyExam.id
      ? "继续月考"
      : "开始本月月考";
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
    : `已完成 ${activeExam.questions.length} 题。点击题号可返回修改，确认后再正式交卷。`;
  elements.submitOverview.innerHTML = activeExam.questions.map((question, index) => {
    const answered = Boolean(String(answers[question.id] || "").trim());
    return `<button type="button" class="${answered ? "answered" : "unanswered"}" data-submit-question="${index}" aria-label="返回第 ${index + 1} 题">${index + 1}</button>`;
  }).join("");
  elements.submitOverview.querySelectorAll("[data-submit-question]").forEach((button) => {
    button.addEventListener("click", () => {
      activeIndex = Number(button.dataset.submitQuestion);
      state.currentAttempt.activeIndex = activeIndex;
      saveState();
      elements.submitModal.classList.add("hidden");
      renderQuestion();
    });
  });
  elements.confirmSubmitButton.disabled = unanswered > 0;
  elements.submitModal.classList.remove("hidden");
}

function submitExam() {
  if (!activeExam.practiceMode && state.submittedExamIds.includes(activeExam.id)) return;
  pauseExamTimer();
  const submittedAt = Date.now();
  latestResult = Engine.scoreExam(
    activeExam,
    answers,
    submittedAt - elapsedSeconds * 1000,
    submittedAt,
  );
  latestResult.weekLabel = morningReadingData?.latestLabel || legacyData.label;
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
  renderStudentAdvice(result);
  const labels = { spelling: "词汇拼写", collocation: "固定搭配", grammar: "词形语法" };
  elements.resultBreakdown.innerHTML = Object.entries(result.breakdown).map(([key, value]) => `
    <article><span>${labels[key] || key}</span><strong>${value}</strong><small>/ 100</small></article>
  `).join("");
  elements.incorrectCount.textContent = `${incorrect.length} 处需要订正`;
  correctionIndex = Math.max(0, incorrect.findIndex((item) => !item.corrected));
  renderCorrectionStep(result);
  elements.practiceRedoButton.classList.toggle("hidden", !activeExam);
  updateCorrectionCompletion();
}

function renderStudentAdvice(result) {
  const incorrect = result.results.filter((item) => !item.correct);
  const correctCount = result.results.length - incorrect.length;
  const recommendations = Engine.buildRecommendations(state.profiles, 3);
  elements.studentAdviceTitle.textContent =
    result.score >= 90
      ? "非常扎实，继续保持这种认真"
      : result.score >= 75
        ? "大部分已经掌握，再补强几个点"
        : "已经找到进步方向，一项一项攻克";
  const actions = recommendations.length
    ? recommendations.map((item) => ({
        title: item.label,
        copy: item.action,
      }))
    : incorrect.slice(0, 3).map((item) => ({
        title: item.question.knowledge,
        copy: item.question.category === "spelling"
          ? "看中文拼写 2 次，再做 1 次句中补全"
          : "复习规则和例句，再独立完成 2 次变式练习",
      }));
  if (!state.reviewTasks[result.id]) {
    state.reviewTasks[result.id] = actions.map((item, index) => ({
      id: `${result.id}-task-${index + 1}`,
      title: item.title,
      copy: item.copy,
      completed: false,
    }));
    saveState();
  }
  const tasks = state.reviewTasks[result.id];
  const completed = tasks.filter((task) => task.completed).length;
  elements.studentAdviceList.innerHTML = `
    <p class="student-encouragement">你已经答对 ${correctCount} 题。${incorrect.length ? "订正不是惩罚，而是把不会的真正变成会的。" : "这次全部掌握，做得很棒。"} 复习任务 ${completed}/${tasks.length}。</p>
    ${tasks.map((task, index) => `
      <label class="${task.completed ? "completed" : ""}">
        <input type="checkbox" data-review-task="${escapeHtml(task.id)}" ${task.completed ? "checked" : ""}>
        <span>${task.completed ? "✓" : index + 1}</span>
        <div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.copy)}</small></div>
      </label>
    `).join("")}`;
  elements.studentAdviceList.querySelectorAll("[data-review-task]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const task = tasks.find((item) => item.id === checkbox.dataset.reviewTask);
      if (!task) return;
      task.completed = checkbox.checked;
      saveState();
      renderStudentAdvice(result);
    });
  });
}

function correctionInputMarkup(question) {
  if (question.type === "choice") {
    return `<div class="correction-choice-list">${question.options.map((option, index) => `
      <label><input type="radio" name="correction-${escapeHtml(question.id)}" value="${escapeHtml(option)}"><span>${String.fromCharCode(65 + index)}</span><strong>${escapeHtml(option)}</strong></label>
    `).join("")}</div>`;
  }
  return `<input class="correction-text-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="重新填写答案">`;
}

function renderCorrectionStep(result) {
  const incorrect = result.results.filter((item) => !item.correct);
  if (!incorrect.length) {
    elements.correctionProgress.innerHTML = "";
    elements.correctionList.innerHTML = `<p class="empty-copy">全部答对，这次没有需要订正的题目。</p>`;
    return;
  }
  const completed = incorrect.filter((item) => item.corrected).length;
  if (completed === incorrect.length) {
    elements.correctionProgress.innerHTML = `<strong>订正完成</strong><span>${completed} / ${incorrect.length}</span>`;
    elements.correctionList.innerHTML = `
      <div class="correction-complete">
        <strong>所有错题都已重新答对</strong>
        <p>很好。下周会用新的句子语境再次考查这些知识点。</p>
      </div>`;
    return;
  }
  if (correctionIndex < 0 || correctionIndex >= incorrect.length || incorrect[correctionIndex].corrected) {
    correctionIndex = incorrect.findIndex((item) => !item.corrected);
  }
  const item = incorrect[correctionIndex];
  elements.correctionProgress.innerHTML = `
    <strong>第 ${completed + 1} / ${incorrect.length} 题</strong>
    <span>已完成 ${completed} 题</span>`;
  elements.correctionList.innerHTML = `
    <article data-correction-step>
      <div class="correction-card-head"><span>${escapeHtml(item.question.kind)}</span><strong>${escapeHtml(item.question.knowledge)}</strong></div>
      <p>${escapeHtml(item.question.prompt)}</p>
      <p class="correction-translation">中文：${escapeHtml(questionTranslation(item.question))}</p>
      <div class="correction-reference">
        <small>你的答案</small><b class="wrong-answer">${escapeHtml(item.userAnswer || "未作答")}</b>
        <small>正确答案</small><b>${escapeHtml(item.question.answer)}</b>
        <em>${escapeHtml(item.question.explanation)}</em>
      </div>
      <div class="correction-retry hidden"></div>
      <button class="correction-start-button" data-start-current-correction>我明白了，隐藏答案再答一次</button>
    </article>`;
  const startButton = elements.correctionList.querySelector("[data-start-current-correction]");
  startButton.addEventListener("click", () => startCurrentCorrectionRetry(result, item, startButton));
}

function startCurrentCorrectionRetry(result, item, button) {
  const card = button.closest("[data-correction-step]");
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
    feedback.textContent = correct ? "答对了，正在进入下一题…" : "还不正确，请再检查一次。";
    feedback.className = `correction-feedback ${correct ? "correct" : "incorrect"}`;
    if (correct) {
      retry.querySelectorAll("input, button").forEach((element) => { element.disabled = true; });
      item.corrected = true;
      saveState();
      updateCorrectionCompletion();
      window.setTimeout(() => {
        correctionIndex += 1;
        renderCorrectionStep(result);
        updateCorrectionCompletion();
        elements.correctionList.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 650);
    }
  });
  retry.querySelector("input")?.focus();
}

function updateCorrectionCompletion() {
  const result = latestResult;
  const pending = result?.results?.filter((item) => !item.correct && !item.corrected).length || 0;
  elements.finishResultButton.disabled = pending > 0;
  elements.practiceRedoButton.disabled = pending > 0;
  elements.finishResultButton.textContent = pending > 0 ? `还需完成 ${pending} 题订正` : "完成订正";
}

function renderHistory() {
  const results = resultSeries(historyType).slice(-10);
  const latest = results.at(-1);
  const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) : 0;
  elements.historySummary.classList.toggle("hidden", !results.length);
  elements.historyChart.classList.toggle("hidden", !results.length);
  elements.historySummary.innerHTML = `
    <article><span>最近成绩</span><strong>${latest?.score ?? "--"}</strong></article>
    <article><span>平均分</span><strong>${average || "--"}</strong></article>
    <article><span>最高分</span><strong>${results.length ? Math.max(...results.map((item) => item.score)) : "--"}</strong></article>`;
  renderChart(elements.historyChart, results);
  elements.historyList.innerHTML = results.length ? [...results].reverse().map((result) => `
    <article><time>${formatDate(result.submittedAt)}</time><div><strong>${escapeHtml(resultPeriodLabel(result))} · ${result.examType === "monthly" ? "月考" : "周测"}</strong><small>用时 ${formatDuration(result.durationSeconds)}</small></div><b>${result.score}</b></article>
  `).join("") : `<p class="empty-copy history-empty">完成第一次${historyType === "monthly" ? "月考" : "周测"}后，成绩会从这里开始记录。</p>`;
}

function renderParent() {
  const hasOfficialResult = state.results.some(
    (result) => !result.practice && !result.abnormal && Array.isArray(result.results),
  );
  const locked = Boolean(state.currentAttempt);
  [elements.abilityCard, elements.priorityCard, elements.changeCard, elements.draftCard]
    .forEach((card) => card.classList.toggle("hidden", !hasOfficialResult));
  elements.resetButton.classList.toggle(
    "hidden",
    !hasOfficialResult && !state.currentAttempt && !state.drafts.length,
  );
  elements.resetButton.disabled = locked;
  elements.resetButton.textContent = locked ? "Nelson 答题中，暂不可清除数据" : "清除本机测试数据";
  renderParentAnalysis();
  renderAbilities();
  renderRecommendations();
  renderChanges();
  renderDraft();
}

function renderParentAnalysis() {
  const lockNote = state.currentAttempt
    ? `<div class="parent-lock-note">Nelson 正在答题。当前可查看分析，但调整优先级、试卷草稿和清除数据已暂时锁定，交卷后自动恢复。</div>`
    : "";
  const latest = [...state.results]
    .filter((result) => !result.practice && !result.abnormal && Array.isArray(result.results))
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
    .at(-1);
  if (!latest) {
    elements.parentAnalysis.innerHTML = `
      ${lockNote}
      <p class="empty-copy">目前还没有正式测试记录。完成 WEEK 3 周测后，这里会优先显示未掌握内容、优势项目和具体复习动作。</p>`;
    return;
  }
  const incorrect = latest.results.filter((item) => !item.correct);
  const correct = latest.results.filter((item) => item.correct);
  const weakest = Object.entries(latest.breakdown).sort((a, b) => a[1] - b[1])[0];
  const strongest = Object.entries(latest.breakdown).sort((a, b) => b[1] - a[1])[0];
  const labels = { spelling: "词汇拼写", collocation: "固定搭配", grammar: "词形与句法" };
  const recommendations = Engine.buildRecommendations(state.profiles, 3);
  elements.parentAnalysis.innerHTML = `
    ${lockNote}
    <div class="analysis-summary">
      <span>${escapeHtml(resultPeriodLabel(latest))} · ${formatDate(latest.submittedAt)}</span>
      <strong>${incorrect.length ? `有 ${incorrect.length} 个知识点需要继续巩固` : "本次所有知识点均已掌握"}</strong>
    </div>
    <article><b>还没掌握</b><p>${incorrect.slice(0, 6).map((item) => escapeHtml(item.question.knowledge)).join("、") || "暂无错题"}</p></article>
    <article><b>掌握较好</b><p>${strongest ? `${labels[strongest[0]] || strongest[0]}表现最好（${strongest[1]}）` : ""}${correct.length ? `；已掌握 ${correct.slice(0, 4).map((item) => escapeHtml(item.question.knowledge)).join("、")}` : ""}</p></article>
    <article><b>复习重点</b><p>${weakest ? `优先加强${labels[weakest[0]] || weakest[0]}` : "保持本周复习节奏"}${recommendations.length ? `；${recommendations.map((item) => escapeHtml(`${item.label}：${item.action}`)).join("；")}` : ""}</p></article>`;
}

function renderAbilities() {
  const latest = [...state.results].filter((result) => !result.practice && !result.abnormal).at(-1);
  const labels = { spelling: "词汇拼写", collocation: "固定搭配", grammar: "词形与句法" };
  const values = latest?.breakdown || {};
  elements.abilityList.innerHTML = Object.entries(labels).map(([key, label]) => `
    <div><span>${label}</span><strong>${values[key] ?? "--"}</strong><i><b style="width:${values[key] ?? 0}%"></b></i></div>
  `).join("");
}

function levelLabel(level) {
  return level === "high" ? "高优先" : level === "medium" ? "中优先" : "需观察";
}

function renderRecommendations() {
  const recommendations = Engine.buildRecommendations(state.profiles, 8);
  const locked = Boolean(state.currentAttempt);
  elements.recommendationList.innerHTML = recommendations.length ? recommendations.map((item) => `
    <article data-level="${item.level}">
      <div class="recommendation-top">
        <span>${levelLabel(item.level)}</span>
        <strong>${escapeHtml(item.label)}</strong>
        <b>优先级 ${item.priority}</b>
      </div>
      <p>${escapeHtml(item.action)}</p>
      <small>${escapeHtml(item.evidence)}${item.typicalWrongAnswer ? `；典型错误：${escapeHtml(item.typicalWrongAnswer)}` : ""}</small>
      <div class="recommendation-actions">
        <button data-adjust="${escapeHtml(item.knowledgeId)}" data-delta="-10" ${locked ? "disabled" : ""}>降低</button>
        <button data-adjust="${escapeHtml(item.knowledgeId)}" data-delta="10" ${locked ? "disabled" : ""}>提高</button>
        <button class="add-draft" data-add-draft="${escapeHtml(item.knowledgeId)}" ${locked ? "disabled" : ""}>加入下周试卷</button>
      </div>
    </article>
  `).join("") : `<p class="empty-copy">最近一次测试没有形成需要优先复习的高频错项。</p>`;
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
  if (state.currentAttempt) return;
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
  const locked = Boolean(state.currentAttempt);
  elements.draftCount.textContent = `${state.drafts.length} / 5`;
  elements.draftList.innerHTML = state.drafts.length ? state.drafts.map((item) => `
    <article><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.variantPrompt)}</small></div><button data-remove-draft="${escapeHtml(item.knowledgeId)}" ${locked ? "disabled" : ""}>移除</button></article>
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
elements.finishResultButton.addEventListener("click", () => {
  activeExam = null;
  showScreen("studentHome");
});
elements.practiceRedoButton.addEventListener("click", () => {
  const type = latestResult?.examType || activeExam?.type;
  if (type) startExamWithOptions(type, { practice: true });
});
elements.pendingCorrectionCard.addEventListener("click", () => {
  const result = state.results.find((item) => item.id === elements.pendingCorrectionCard.dataset.resultId);
  if (result) openStoredResult(result);
});
elements.backButton.addEventListener("click", () => {
  if (document.querySelector("#examScreen.active")) {
    persistCurrentAnswer();
    pauseExamTimer();
  }
  showScreen("studentHome");
});
elements.roleButton.addEventListener("click", () => {
  showLogin(currentRole === "parent" ? "student" : "parent");
});
document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screen)));
document.querySelectorAll("[data-history-type]").forEach((button) => button.addEventListener("click", () => {
  historyType = button.dataset.historyType;
  document.querySelectorAll("[data-history-type]").forEach((item) => item.classList.toggle("active", item === button));
  renderHistory();
}));
elements.resetButton.addEventListener("click", () => {
  if (state.currentAttempt) return;
  localStorage.removeItem(STORAGE_KEY);
  state = clone(defaultState);
  saveState();
  renderParent();
});
elements.logoutButton.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  cloudReady = false;
  currentUser = null;
  currentRole = null;
  cloudUpdatedAt = null;
  pendingCloudSave = false;
  elements.logoutButton.classList.add("hidden");
  showLogin("student", "已退出当前账号。");
});
elements.loginRoleSwitch.querySelectorAll("[data-login-role]").forEach((button) => {
  button.addEventListener("click", () => setLoginRole(button.dataset.loginRole));
});
elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = elements.loginPassword.value;
  if (!password) return;
  elements.loginButton.disabled = true;
  elements.loginMessage.textContent = "正在登录并同步数据…";
  try {
    if (currentUser) await supabaseClient.auth.signOut();
    cloudReady = false;
    currentUser = null;
    currentRole = null;
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: supabaseConfig.accounts[selectedLoginRole],
      password,
    });
    if (error) throw error;
    await activateSession(data.session);
  } catch (error) {
    elements.loginMessage.textContent =
      error.message === "Invalid login credentials"
        ? "密码不正确，请再试一次。"
        : `登录失败：${error.message}`;
  } finally {
    elements.loginButton.disabled = false;
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    persistCurrentAnswer();
    pauseExamTimer();
    syncStateToCloud();
  } else {
    resumeExamTimer();
    refreshStateFromCloud();
  }
});
window.addEventListener("pagehide", () => {
  persistCurrentAnswer();
  pauseExamTimer();
  syncStateToCloud();
});
window.addEventListener("beforeunload", () => {
  persistCurrentAnswer();
  pauseExamTimer();
});

initializeCloud();
window.setInterval(refreshStateFromCloud, 15000);
