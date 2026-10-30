// ==========================================
// 1. Firebase インポート & 初期化
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// 環境変数/Firebase Hosting自動初期化の読み込み
async function loadFirebaseConfig() {
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.protocol === "file:";

  if (isLocal) {
    // 1. ローカル実行時は、まずローカルの firebase-config.json から取得して /__/firebase/init.json の 404 エラーを防止する
    try {
      const response = await fetch('./firebase-config.json');
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {}

    // 2. 失敗した場合のみ、Hosting エミュレータを考慮して /__/firebase/init.json を試す
    try {
      const response = await fetch('/__/firebase/init.json');
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {}
  } else {
    // 本番環境（Firebase Hosting）では予約済みURLから取得
    try {
      const response = await fetch('/__/firebase/init.json');
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {}

    // フォールバック
    try {
      const response = await fetch('./firebase-config.json');
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {}
  }

  console.error("Firebaseの設定を読み込めませんでした。ローカルのfirebase-config.jsonファイルまたはFirebase Hostingエミュレータを確認してください。");
  return null;
}

let app, auth, db;

// Firebaseが正常に初期化されているか確認するガード関数
const checkFirebaseInit = () => {
  if (!auth || !db) {
    console.log("Firebase is not initialized (running in offline mode).");
    return false;
  }
  return true;
};

// ==========================================
// 2. 安全なローカルストレージヘルパー & アプリ共通変数
// ==========================================
function safeGetLocalStorage(key, defaultValue) {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (e) {
    console.error(`localStorage key "${key}" の解析に失敗しました:`, e);
    return defaultValue;
  }
}

function updateLocalLastUpdated() {
  const now = Date.now();
  localStorage.setItem("lastUpdated", now.toString());
}

let tasks = safeGetLocalStorage("tasks", {});
let streak = safeGetLocalStorage("streak", { current: 0, best: 0, lastDate: null });
let currentUser = null;
let categories = safeGetLocalStorage("categories", ["資格", "スキル", "副業", "投資"]);
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDate = null;

let weekdayRoutine = safeGetLocalStorage("weekdayRoutine", [
  "6:00 起床・準備",
  "7:00 通学・インプット(両学長ライブ)",
  "9:30~15:30 学校・資格勉強",
  "18:00~23:30 プログラミング学習",
  "24:00 就寝"
]);

let weekendRoutine = safeGetLocalStorage("weekendRoutine", [
  "9:00 起床",
  "10:00~12:00 復習・資格勉強",
  "13:00~17:00 プログラミング・思考整理",
  "18:00~22:00 自由時間・読書",
  "24:00 就寝"
]);

let currentRoutine = "weekday";
let isEditing = false;

// ==========================================
// トーストメッセージ表示 (Could-priority)
// ==========================================
function showToast(message) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = "position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px;";
    document.body.appendChild(container);
  }

  if (!document.getElementById("toast-styles")) {
    const style = document.createElement("style");
    style.id = "toast-styles";
    style.textContent = `
      @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes fadeOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(20px); } }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement("div");
  toast.className = "toast-message";
  toast.style.cssText = "background: #333; color: #fff; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 14px; min-width: 200px; text-align: center; border-left: 4px solid #3a86ff; animation: fadeIn 0.3s ease-out;";
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "fadeOut 0.3s ease-out";
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 300);
  }, 4000);
}

// ==========================================
// 3. 認証ロジック (window登録でHTMLから呼べるようにする)
// ==========================================

// ユーザーのローカルデータをすべて消去する
function clearUserLocalStorage() {
  const keys = [
    "tasks",
    "streak",
    "categories",
    "userGoals",
    "roadmapGoals",
    "dailyRoutineStatus",
    "weekdayRoutine",
    "weekendRoutine",
    "monthlyGoal",
    "weeklyGoal",
    "lastUpdated",
    "lastRoutineResetDate",
    "routineType",
    "weekdayProgress",
    "weekendProgress"
  ];
  keys.forEach(key => localStorage.removeItem(key));
  console.log("ユーザーのローカルデータを消去しました。");
}

// ログイン
const login = async () => {
  const statusEl = document.getElementById("loginStatus");
  if (statusEl) statusEl.textContent = "";

  if (!checkFirebaseInit()) {
    if (statusEl) statusEl.textContent = "Firebaseの設定が見つかりません。オフラインモードでご利用ください。";
    return;
  }
  
  const emailInput = document.getElementById("loginEmail");
  const passInput = document.getElementById("loginPassword");

  if (!emailInput || !passInput) {
    console.error("HTML要素が見つかりません。IDが正しいか確認してください。");
    return;
  }

  const email = emailInput.value.trim(); // 余計な空白を消す
  const pass = passInput.value;

  if (!email || !pass) {
    if (statusEl) statusEl.textContent = "メールアドレスとパスワードを入力してください";
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    console.error("Firebaseエラー詳細:", e.code, e.message);
    if (statusEl) {
      let msg = "ログインに失敗しました";
      if (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found") {
        msg = "メールアドレスまたはパスワードが正しくありません";
      } else if (e.code === "auth/invalid-email") {
        msg = "有効なメールアドレスを入力してください";
      } else if (e.code === "auth/too-many-requests") {
        msg = "試行回数が多すぎます。しばらく待ってから再試行してください";
      }
      statusEl.textContent = msg;
    }
  }
};

// 新規登録
const signup = async () => {
  const statusEl = document.getElementById("loginStatus");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.style.color = "";
  }

  if (!checkFirebaseInit()) {
    if (statusEl) statusEl.textContent = "Firebaseの設定が見つかりません。オフラインモードでご利用ください。";
    return;
  }

  const emailInput = document.getElementById("loginEmail");
  const passInput = document.getElementById("loginPassword");
  if (!emailInput || !passInput) return;

  const email = emailInput.value.trim();
  const pass = passInput.value;

  if (!email || !pass) {
    if (statusEl) statusEl.textContent = "メールとパスワードを入力してください";
    return;
  }

  if (pass.length < 6) {
    if (statusEl) statusEl.textContent = "パスワードは6文字以上で設定してください";
    return;
  }

  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    if (statusEl) {
      statusEl.style.color = "#4ade80"; // 成功時は緑色
      statusEl.textContent = "登録が完了しました！そのままログインしてください。";
    }
  } catch (e) {
    if (statusEl) {
      statusEl.style.color = "";
      let msg = "登録に失敗しました";
      if (e.code === "auth/email-already-in-use") {
        msg = "このメールアドレスは既に登録されています";
      } else if (e.code === "auth/invalid-email") {
        msg = "有効なメールアドレスを入力してください";
      } else if (e.code === "auth/weak-password") {
        msg = "パスワードは6文字以上で入力してください";
      }
      statusEl.textContent = msg;
    }
  }
};

// ログアウト
const logout = async () => {
  if (auth) {
    try {
      await signOut(auth);
    } catch (e) {
      console.error("ログアウト失敗", e);
    }
  }
  clearUserLocalStorage();
  location.reload();
};

// ⭐最重要：HTMLの onclick から呼べるように窓口を開く
window.login = login;
window.signup = signup;
window.logout = logout;
window.initCalendar = initCalendar;

// ==========================================
// 4. データ同期 (Firestore)
// ==========================================

async function syncData() {
  if (!checkFirebaseInit()) return;
  if (!currentUser) return;
  
  const localLastUpdated = Number(localStorage.getItem("lastUpdated") || Date.now());
  const userGoals = safeGetLocalStorage("userGoals", {});
  const roadmapGoals = safeGetLocalStorage("roadmapGoals", {});
  const dailyRoutineStatus = safeGetLocalStorage("dailyRoutineStatus", {});
  const weekdayRoutineData = safeGetLocalStorage("weekdayRoutine", weekdayRoutine);
  const weekendRoutineData = safeGetLocalStorage("weekendRoutine", weekendRoutine);

  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      tasks,
      streak,
      categories,
      userGoals,
      roadmapGoals,
      dailyRoutineStatus,
      weekdayRoutine: weekdayRoutineData,
      weekendRoutine: weekendRoutineData,
      lastUpdated: localLastUpdated
    }, { merge: true });
    console.log("Firestore保存成功");
  } catch (e) { 
    console.error("保存失敗:", e);
    showToast("⚠️ 保存に失敗しました。オフライン保存されました。");
  }
}

function loadFromLocalStorage() {
  try {
    tasks = safeGetLocalStorage("tasks", {});
    streak = safeGetLocalStorage("streak", { current: 0, best: 0, lastDate: null });
    categories = safeGetLocalStorage("categories", ["資格", "スキル", "副業", "投資"]);
    weekdayRoutine = safeGetLocalStorage("weekdayRoutine", [
      "6:00 起床・準備",
      "7:00 通学・インプット(両学長ライブ)",
      "9:30~15:30 学校・資格勉強",
      "18:00~23:30 プログラミング学習",
      "24:00 就寝"
    ]);
    weekendRoutine = safeGetLocalStorage("weekendRoutine", [
      "9:00 起床",
      "10:00~12:00 復習・資格勉強",
      "13:00~17:00 プログラミング・思考整理",
      "18:00~22:00 自由時間・読書",
      "24:00 就寝"
    ]);
    console.log("ローカルストレージからデータを復元しました");
  } catch (err) {
    console.error("ローカルストレージの復元に失敗しました:", err);
  }
}

async function loadUserData() {
  if (!checkFirebaseInit()) {
    loadFromLocalStorage();
    initCalendar();
    renderCategories();
    return;
  }
  const docRef = doc(db, "users", currentUser.uid);
  try {
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      const serverLastUpdated = Number(data.lastUpdated || 0);
      const localLastUpdated = Number(localStorage.getItem("lastUpdated") || 0);

      // ロールフォワード: ローカルの更新がサーバーより新しい場合はサーバーに同期
      if (localLastUpdated > serverLastUpdated) {
        console.log("ローカルデータの方が新しいため、サーバーに同期（ロールフォワード）します。");
        await syncData();
      } else {
        // サーバーデータの方が新しい、または同等な場合は適用
        tasks = data.tasks || {};
        streak = data.streak || { current: 0, best: 0, lastDate: null };
        categories = data.categories || ["資格", "スキル", "副業", "投資"];
        
        const userGoals = data.userGoals || {};
        const roadmapGoals = data.roadmapGoals || {};
        const dailyRoutineStatus = data.dailyRoutineStatus || {};
        
        weekdayRoutine = data.weekdayRoutine || weekdayRoutine;
        weekendRoutine = data.weekendRoutine || weekendRoutine;

        console.log("Firestoreからデータを復元しました");
        
        localStorage.setItem("tasks", JSON.stringify(tasks));
        localStorage.setItem("streak", JSON.stringify(streak));
        localStorage.setItem("categories", JSON.stringify(categories));
        localStorage.setItem("userGoals", JSON.stringify(userGoals));
        localStorage.setItem("roadmapGoals", JSON.stringify(roadmapGoals));
        localStorage.setItem("dailyRoutineStatus", JSON.stringify(dailyRoutineStatus));
        localStorage.setItem("weekdayRoutine", JSON.stringify(weekdayRoutine));
        localStorage.setItem("weekendRoutine", JSON.stringify(weekendRoutine));
        
        if (userGoals.monthly !== undefined) localStorage.setItem("monthlyGoal", userGoals.monthly);
        if (userGoals.weekly !== undefined) localStorage.setItem("weeklyGoal", userGoals.weekly);
        
        localStorage.setItem("lastUpdated", serverLastUpdated.toString());
      }
    } else {
      // サーバーにデータがない場合は初期アップロード
      console.log("サーバーにデータがないため、初期アップロードを行います。");
      loadFromLocalStorage();
      await syncData();
    }
  } catch (e) {
    console.error("読み込みエラー:", e);
    loadFromLocalStorage();
    showToast("オフラインモード: ローカルデータを読み込みました。");
  }
  initCalendar();
  renderCategories();
  loadGoals();
  renderRoutine();
}

// 初期化非同期処理
(async () => {
  const config = await loadFirebaseConfig();
  if (config) {
    app = initializeApp(config);
    auth = getAuth(app);
    
    // Firestore初期化とオフラインキャッシュの同時設定（SDK v10+ 推奨方式）
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
    console.log("Firestore オフラインキャッシュ（新しい方式）が有効になりました。");

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        
        // 可用性向上のため、まずはローカルストレージからデータを即座にロードしてUI表示
        loadFromLocalStorage();
        
        const loginSect = document.getElementById("login-section");
        if (loginSect) loginSect.style.display = "none";
        const mainApp = document.getElementById("mainApp");
        if (mainApp) mainApp.style.display = "block";
        
        initCalendar(); 
        renderCategories();
        loadGoals();
        renderRoutine();
        updateProgressBar();
        renderTodaySummary(); 
        renderWeeklyTasks();  

        // バックグラウンドで同期を実行
        await loadUserData();
      } else {
        currentUser = null;
        const loginSect = document.getElementById("login-section");
        if (loginSect) loginSect.style.display = "block";
        const mainApp = document.getElementById("mainApp");
        if (mainApp) mainApp.style.display = "none";
      }
    });
  } else {
    // Firebaseの設定が読み込めない場合のオフラインフォールバック
    console.log("Firebase 設定の読み込みに失敗したか、オフラインです。オフライン（ローカル）モードで起動します。");
    currentUser = null;
    
    loadFromLocalStorage();
    
    const loginSect = document.getElementById("login-section");
    if (loginSect) loginSect.style.display = "none";
    const mainApp = document.getElementById("mainApp");
    if (mainApp) mainApp.style.display = "block";
    
    initCalendar(); 
    renderCategories();
    loadGoals();
    renderRoutine();
    updateProgressBar();
    renderTodaySummary(); 
    renderWeeklyTasks();  
  }
})();


// 例：タスクを保存するボタンの処理
window.saveTaskData = async () => {
  await syncData(); 
  initCalendar();
};


function formatDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth() + 1;
  const d = dateObj.getDate();
  return `${y}-${m}-${d}`;
}

function initCalendar() {
  const today = new Date();
  currentYear = today.getFullYear();
  currentMonth = today.getMonth();
  renderCalendar(currentYear, currentMonth);
  updateProgress();
  renderTodaySummary();
  renderWeeklyTasks();
  updateProgressBar();
}

let selectedGoalYear = new Date().getFullYear();

function scheduleYearAutoUpdate() {
  const now = new Date();
  const nextJan1 = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
  const msUntilNewYear = nextJan1 - now;

  setTimeout(() => {
    selectedGoalYear = new Date().getFullYear(); 
    updateGoalTexts();
    scheduleYearAutoUpdate(); 
  }, msUntilNewYear);
}
scheduleYearAutoUpdate(); 

function updateGoalTexts() {
  const savedGoals = safeGetLocalStorage("userGoals", {});
  const roadmap = safeGetLocalStorage("roadmapGoals", {});



  const monthlyText = savedGoals.monthly || "未設定";
  const weeklyText = savedGoals.weekly || "未設定";

  const monthlyTextEl = document.getElementById("monthlyGoalText");
  if (monthlyTextEl) monthlyTextEl.textContent = monthlyText;

  const weeklyTextEl = document.getElementById("weeklyGoalText");
  if (weeklyTextEl) weeklyTextEl.textContent = weeklyText;

  const monthlyInput = document.getElementById("monthlyGoalInput");
  if (monthlyInput) monthlyInput.value = savedGoals.monthly || "";

  const weeklyInput = document.getElementById("weeklyGoalInput");
  if (weeklyInput) weeklyInput.value = savedGoals.weekly || "";


  // --- 選択中の年度目標を表示 ---
  const yearKey = `y${selectedGoalYear}`;
  const yearGoalText = roadmap[yearKey] || "（目標未設定）";

  const contentEl = document.getElementById("currentYearGoalContent");
  if (contentEl) contentEl.textContent = yearGoalText;

  // 編集エリアの入力欄も同期
  const yearGoalInput = document.getElementById("yearGoalInput");
  if (yearGoalInput) yearGoalInput.value = roadmap[yearKey] || "";

  // 年度ラベルを更新
  ["displayYear", "editYearLabel", "editYearLabel2"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = selectedGoalYear;
  });

  // チェック状態の反映
  const monthlyCheck = document.getElementById("monthlyGoalCheck");
  const weeklyCheck = document.getElementById("weeklyGoalCheck");
  if (monthlyCheck) monthlyCheck.checked = savedGoals.monthlyDone || false;
  if (weeklyCheck) weeklyCheck.checked = savedGoals.weeklyDone || false;

  applyGoalStyle("monthlyGoalCheck", "monthlyGoalText");
  applyGoalStyle("weeklyGoalCheck", "weeklyGoalText");
}

function toggleGoalDone(type) {
  const goals = safeGetLocalStorage("userGoals", {});
  const checkEl = document.getElementById(`${type}GoalCheck`);
  if (!checkEl) return;

  goals[`${type}Done`] = checkEl.checked;
  localStorage.setItem("userGoals", JSON.stringify(goals));
  updateLocalLastUpdated();

  applyGoalStyle(`${type}GoalCheck`, `${type}GoalText`);
  syncData();
}

function applyGoalStyle(checkId, textId) {
  const check = document.getElementById(checkId);
  const text = document.getElementById(textId);

  if (!check || !text) return;
  const parent = text.closest("p");
  if (!parent) return;

  if (check.checked) {
    parent.classList.add("goal-done");
    text.style.textDecoration = "line-through";
    text.style.opacity = "0.6";
    text.style.color = "#aaa"
  } else {
    parent.classList.remove("goal-done");
    text.style.textDecoration = "none";
    text.style.opacity = "1";
    text.style.color = "#fff"
  }
}

function renderCalendar(year, month, filter = null) {
  const calendar = document.getElementById("calendar");
  if (!calendar) return;
  calendar.innerHTML = "";

  const searchInput = document.getElementById("search");
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : "";

  const dayLabels = ["日", "月", "火", "水", "木", "金", "土"];
  dayLabels.forEach((label, week) => {
  const labelDiv = document.createElement("div");  
  labelDiv.classList.add("day-header");
  labelDiv.textContent = label;
  if (week === 0) labelDiv.style.color = "#ff5252";
  if (week === 6) labelDiv.style.color = "#448aff";
  calendar.appendChild(labelDiv);
});

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDay = firstDay.getDay();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

  const monthDisplay = document.getElementById("monthDisplay");
  if (monthDisplay)
    monthDisplay.textContent = `${year}年${month + 1}月`;

  for (let i = 0; i < startDay; i++) {
    const empty = document.createElement("div");
    empty.classList.add("day", "empty");
    calendar.appendChild(empty);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateKey = `${year}-${month+ 1}-${d}`;

    const dayCell = document.createElement("div");
    dayCell.classList.add("day");
    dayCell.style.position = "relative";

    if (dateKey === todayStr) {
      dayCell.classList.add("today");
    }

    if (tasks[dateKey] && tasks[dateKey].length > 0) {
      const isAllDone = tasks[dateKey].every(t => t.done === true || t.title === "〇")
      if (isAllDone) {
        dayCell.classList.add("all-done-day");
      }else {
        dayCell.classList.add("has-task-day");
      }
    }

    const dayNum = document.createElement("div");
    dayNum.textContent = d;
    dayNum.classList.add("date-number");
    dayCell.appendChild(dayNum);

    const dailyStatus = safeGetLocalStorage("dailyRoutineStatus", {});
    if (dailyStatus[dateKey] === true) {
      const mark = document.createElement("div");
      mark.className = "day-mark";
      mark.textContent = "〇";
      mark.style.position = "absolute";
      mark.style.top = "13px";
      mark.style.color = "#4ade80";
      mark.style.fontWeight = "bold";
      mark.style.fontSize = "1.3rem"
      dayCell.appendChild(mark);
    }

    if (tasks[dateKey]) {
      tasks[dateKey].forEach((t, i) => {

        if (t.title ==="〇") return;

        // カテゴリーフィルターを適用
        if (filter && t.category !== filter) return;

        // 検索フィルターを適用
        if (searchQuery && !t.title.toLowerCase().includes(searchQuery)) return;

        const taskDiv = document.createElement("div");
        const safeCatClass = "cat-" + String(t.category || "").replace(/[^\w-]/g, "_");
        taskDiv.classList.add("task", safeCatClass);

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = t.done || false;
        checkbox.addEventListener("change", (e) => { e.stopPropagation(); toggleTaskDone(dateKey, i)});

        const taskText = document.createElement("span");
        taskText.textContent = `${t.title} (${t.progress || 0}%)`;

        if (t.done) {
          taskText.style.textDecoration = "line-through";
          taskText.style.opacity = "0.6";
          taskDiv.style.background = "#555";
        }

        taskDiv.appendChild(checkbox);
        taskDiv.appendChild(taskText);
        dayCell.appendChild(taskDiv);
      });
    }

    dayCell.addEventListener("click", () => openModal(year, month, d));
    calendar.appendChild(dayCell);
  }

  if (typeof updateProgressBar === "function") updateProgressBar();
  if (typeof updateStreak === "function") updateStreak();
  if (typeof renderTodaySummary === "function") renderTodaySummary();
}

async function toggleTaskComplete(date, index) {
  if (!tasks[date] || !tasks[date][index]) return;

  tasks[date][index].done = !tasks[date][index].done;
  localStorage.setItem("tasks", JSON.stringify(tasks));
  updateLocalLastUpdated();

  await syncData();
  initCalendar();        
  renderTaskList(date);   
}

function updateProgressBar() {
  const bar = document.querySelector(".progress");
  if (!bar) return;
  let total = 0, count = 0;
  Object.values(tasks).forEach(dayTasks => {

    if (!Array.isArray(dayTasks)) return;
    dayTasks.forEach(t => {
      total += Number(t.progress || 0);
      count++;
    });
  });
  const avg = count > 0 ? Math.round(total / count) : 0;
  bar.style.width = `${avg}%`;
  bar.textContent = `${avg}%`;
}


// ④ renderWeeklyTasks で完了済みタスクを除外
function renderWeeklyTasks() {
  const listEl = document.getElementById("weeklyTaskList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const today = new Date();
  const dayOfWeek = today.getDay();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - dayOfWeek);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  
  const weekTasks = [];

  for (let d = new Date(startOfWeek); d <= endOfWeek; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (tasks[key]) {
      tasks[key]
        .filter(t => !t.done) // ✅ 未完了タスクのみ
        .forEach(t => weekTasks.push({ date: key, title: t.title, priority: t.priority, category: t.category }));
    }
  }

  if (weekTasks.length === 0) {
    const li = document.createElement("li");
    li.textContent = "今週のタスクはありません。";
    listEl.appendChild(li);
    return;
  }

  weekTasks.sort((a, b) => (a.priority > b.priority ? -1 : 1));

  weekTasks.forEach(t => {
    const li = document.createElement("li");
    const spanTitle = document.createElement("span");
    spanTitle.textContent = `${t.date}｜${t.title}`;

    const spanPriority = document.createElement("span");
    spanPriority.className = "weekly-priority";
    spanPriority.textContent = ` [${t.priority}] ${t.category}`;

    li.appendChild(spanTitle);
    li.appendChild(spanPriority);
    listEl.appendChild(li);
  });
}

const modal = document.getElementById("taskModal");
const closeBtn = document.getElementById("closeModal");
const saveBtn = document.getElementById("saveTask");

function openModal(year, month, day) {
  selectedDate = `${year}-${month + 1}-${day}`;
  modal.classList.remove("hidden");

  document.getElementById("taskTitle").focus();
  
  const progEl = document.getElementById("taskProgress");
  if (progEl) {
    progEl.value = "0";
    if (progEl.nextElementSibling) {
      progEl.nextElementSibling.textContent = "0%";
    }
  }

  renderTaskList(selectedDate);
}

closeBtn.addEventListener("click", () => {
    modal.classList.add("hidden");
});

let editingIndex = null; 

saveBtn.addEventListener("click", async () => {
  const title = document.getElementById("taskTitle").value.trim();
  const category = document.getElementById("taskCategory").value;
  const priority = document.getElementById("taskPriority").value;
  const progress = document.getElementById("taskProgress").value;
  const memo = document.getElementById("taskMemo").value;

  if (!title) return alert("タイトルを入力してください");
  if (title.length > 200) return alert("タイトルは200文字以内で入力してください");
  if (memo && memo.length > 2000) return alert("メモは2000文字以内で入力してください");

  if (!tasks[selectedDate]) tasks[selectedDate] = [];

  const newTask = {
    title,
    category,
    priority,
    progress,
    memo,
    done: editingIndex !== null ? tasks[selectedDate][editingIndex].done : false,
    created: editingIndex !== null ? (tasks[selectedDate][editingIndex].created || new Date().toISOString()) : new Date().toISOString()
  };

  try {
    if (editingIndex !== null) {
      tasks[selectedDate][editingIndex] = newTask;
      editingIndex = null;
    } else {
      tasks[selectedDate].push(newTask);
    }

    localStorage.setItem("tasks", JSON.stringify(tasks));
    updateLocalLastUpdated();

    const taskModal = document.getElementById("taskModal");
    if (taskModal) taskModal.classList.add("hidden");

    renderCalendar(currentYear, currentMonth);
    renderTaskList(selectedDate);
    renderTodaySummary();
    renderWeeklyTasks();
    
    ["taskTitle", "taskProgress", "taskMemo"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.value = (id === "taskProgress" ? "0" : "");
        if (id === "taskProgress" && el.nextElementSibling) {
          el.nextElementSibling.textContent = "0%";
        }
      }
    });

    // ローカル保存が正常終了した場合のみFirebase同期を実行
    await syncData();

  } catch (err) {
    console.error("保存失敗:", err);
    alert("ローカル保存に失敗したため、同期を中止しました。");
  }
});

document.getElementById("prevMonth").addEventListener("click", () => {
  currentMonth--;
  if (currentMonth < 0) {
    currentMonth = 11;
    currentYear--;
  }
  renderCalendar(currentYear, currentMonth);
  renderWeeklyTasks();
});

document.getElementById("nextMonth").addEventListener("click", () => {
  currentMonth++;
  if (currentMonth > 11) {
    currentMonth = 0;
    currentYear++;
  }
  renderCalendar(currentYear, currentMonth);
  renderWeeklyTasks();
});

document.querySelectorAll("#filters li").forEach(li => {
  li.addEventListener("click", () => {
    document.querySelectorAll("#filters li").forEach(i => i.classList.remove("active"));
    li.classList.add("active");
    const cat = li.dataset.category;
    renderCalendar(currentYear, currentMonth, cat);
    renderWeeklyTasks();
    });
  });

function updateProgress() {
  const all = Object.values(tasks).flat();
  if (all.length === 0) return;
  const avg = all.reduce((a, b) => a + Number(b.progress || 0), 0) / all.length;
  const bar = document.getElementById("progressBar");
  const label = document.getElementById("progressLabel");
  if (bar) bar.style.width = `${avg}%`;
  if (label) label.textContent = `全体進歩: ${avg.toFixed(1)}%`;
}

function renderTaskList(date) {
  const section = document.getElementById("taskListSection");
  const list = document.getElementById("taskList");
  const title = document.getElementById("taskListTitle");

  if (title) title.textContent = `${date} のタスク`;
  if (list) list.innerHTML = "";
  if (section) section.classList.remove("hidden");

  if (!tasks[date] || tasks[date].length === 0) {
    if (list) {
      const emptyLi = document.createElement("li");
      emptyLi.textContent = "タスクはありません。";
      list.appendChild(emptyLi);
    }
  } else {
    tasks[date].forEach((t, index) => {
      const li = document.createElement("li");
      const contentDiv = document.createElement("div");
      if (t.done) {
        contentDiv.style.textDecoration = "line-through";
        contentDiv.style.opacity = "0.6";
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "task-check";
      checkbox.checked = !!t.done;
      checkbox.addEventListener("click", () => {
        window.toggleTaskComplete(date, index);
      });

      const titleStrong = document.createElement("strong");
      titleStrong.textContent = t.title;

      const metaSpan = document.createElement("span");
      metaSpan.textContent = ` (${t.category}, ${t.priority})`;

      const br = document.createElement("br");
      const small = document.createElement("small");
      small.textContent = `${t.progress}%｜${t.memo || "メモなし"}`;

      contentDiv.appendChild(checkbox);
      contentDiv.appendChild(titleStrong);
      contentDiv.appendChild(metaSpan);
      contentDiv.appendChild(br);
      contentDiv.appendChild(small);

      const btnsDiv = document.createElement("div");
      btnsDiv.className = "task-btns";

      const editBtn = document.createElement("button");
      editBtn.className = "edit";
      editBtn.textContent = "編集";
      editBtn.addEventListener("click", () => editTask(date, index));

      const delBtn = document.createElement("button");
      delBtn.className = "delete";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", () => deleteTask(date, index));

      btnsDiv.appendChild(editBtn);
      btnsDiv.appendChild(delBtn);

      li.appendChild(contentDiv);
      li.appendChild(btnsDiv);
      if (list) list.appendChild(li);
    });
  }
  
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "閉じる";
  closeBtn.className = "task-list-close-btn";
  closeBtn.onclick = () => { if (section) section.classList.add("hidden"); };
  if (list) list.appendChild(closeBtn);
}

window.renderTaskList = renderTaskList;

async function editTask(date, index) {
  const t = tasks[date][index];
  if (!t) return;

  const titleEl = document.getElementById("taskTitle");
  if (titleEl) titleEl.value = t.title;
  const catEl = document.getElementById("taskCategory");
  if (catEl) catEl.value = t.category;
  const prioEl = document.getElementById("taskPriority");
  if (prioEl) prioEl.value = t.priority;
  const progEl = document.getElementById("taskProgress");
  if (progEl) {
    progEl.value = t.progress;
    if (progEl.nextElementSibling) {
      progEl.nextElementSibling.textContent = `${t.progress}%`;
    }
  }
  const memoEl = document.getElementById("taskMemo");
  if (memoEl) memoEl.value = t.memo;

  const modal = document.getElementById("taskModal");
  if (modal) modal.classList.remove("hidden");

  editingIndex = index;
  selectedDate = date;
}

window.editTask = editTask;

async function deleteTask(date, index) {
  if (!confirm("このタスクを削除しますか？")) return;

  try {
    tasks[date].splice(index, 1);
    if (tasks[date].length === 0) delete tasks[date];

    localStorage.setItem("tasks", JSON.stringify(tasks));
    updateLocalLastUpdated();
    renderCalendar(currentYear, currentMonth);
    renderTaskList(date);
    renderWeeklyTasks();
    updateProgress();
    await syncData();
    if (typeof renderTodaySummary === "function") renderTodaySummary();
  } catch (err) {
    console.error("削除失敗:", err);
  }
}

const defaultSave = () => {
  const title = document.getElementById("taskTitle").value.trim();
  const category = document.getElementById("taskCategory").value;
  const priority = document.getElementById("taskPriority").value;
  const progress = document.getElementById("taskProgress").value;
  const memo = document.getElementById("taskMemo").value;

  if (!title) return alert("タイトルを入力してください");
  if (title.length > 200) return alert("タイトルは200文字以内で入力してください");
  if (memo && memo.length > 2000) return alert("メモは2000文字以内で入力してください");

  if (!tasks[selectedDate]) tasks[selectedDate] = [];
  tasks[selectedDate].push({
    title,
    category,
    priority,
    progress,
    memo,
    created: new Date().toISOString(),
  });
};
// ② toggleTaskDone 修正（date → dateKeyに）
async function toggleTaskDone(dateKey, index) {
  if (!tasks[dateKey]) return;
  try {
    tasks[dateKey][index].done = !tasks[dateKey][index].done;
    localStorage.setItem("tasks", JSON.stringify(tasks));
    updateLocalLastUpdated();
    renderCalendar(currentYear, currentMonth);
    renderTodaySummary();  
    renderWeeklyTasks();   
    renderTaskList(dateKey);
    if (selectedDate === dateKey) renderTaskList(dateKey);
    await syncData();
  } catch (err) {
    console.error("切り替え失敗:", err);
  }
}


// 目標データの初期化・読み込み
function loadGoals() {
  // 旧フォーマット（g2025/g2026/g2027）のデフォルト値が残っている場合はクリアする（1回のみ）
  if (!localStorage.getItem("roadmapGoals_migrated_v2")) {
    localStorage.removeItem("roadmapGoals");
    localStorage.setItem("roadmapGoals_migrated_v2", "1");
  }

  // 今月・今週の目標の読み込み
  const monthlyGoalText = document.getElementById("monthlyGoalText");
  if (monthlyGoalText) monthlyGoalText.textContent = localStorage.getItem("monthlyGoal") || "未設定";
  const weeklyGoalText = document.getElementById("weeklyGoalText");
  if (weeklyGoalText) weeklyGoalText.textContent = localStorage.getItem("weeklyGoal") || "未設定";
  const monthlyGoalInput = document.getElementById("monthlyGoalInput");
  if (monthlyGoalInput) monthlyGoalInput.value = localStorage.getItem("monthlyGoal") || "";
  const weeklyGoalInput = document.getElementById("weeklyGoalInput");
  if (weeklyGoalInput) weeklyGoalInput.value = localStorage.getItem("weeklyGoal") || "";

  // 年度表示を更新
  updateGoalTexts();
}

// 年度ナビゲーション初期化（DOMContentLoaded 時に1回だけ実行する）
function initYearNav() {
  const prevBtn = document.getElementById("prevYear");
  const nextBtn = document.getElementById("nextYear");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      selectedGoalYear--;
      updateGoalTexts();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      selectedGoalYear++;
      updateGoalTexts();
    });
  }
}

// 開閉ロジック
const toggleEditBtn = document.getElementById("toggleEditBtn");
if (toggleEditBtn) {
  toggleEditBtn.addEventListener("click", () => {
    const editArea = document.getElementById("editableGoals");
    if (!editArea) return;
    if (editArea.style.display === "none" || editArea.style.display === "") {
      editArea.style.display = "block";
      toggleEditBtn.textContent = "✖ 編集を閉じる";
    } else {
      editArea.style.display = "none";
      toggleEditBtn.textContent = "⚙️ 目標を編集する";
    }
  });
}

// 初期実行：loadGoals（目標読み込み）と initYearNav（ナビリスナー登遌）をそれぞれ1回だけ実行
window.addEventListener("DOMContentLoaded", () => {
  loadGoals();
  initYearNav();

  const saveBtn = document.getElementById("saveGoals");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveGoals);
  }

  const mCheck = document.getElementById("monthlyGoalCheck");
  const wCheck = document.getElementById("weeklyGoalCheck");
  if (mCheck) mCheck.addEventListener("change", () => toggleGoalDone("monthly"));
  if (wCheck) wCheck.addEventListener("change", () => toggleGoalDone("weekly"));

  const searchInput = document.getElementById("search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const activeFilterEl = document.querySelector("#filters li.active");
      const activeFilter = activeFilterEl ? activeFilterEl.getAttribute("data-category") : null;
      renderCalendar(currentYear, currentMonth, activeFilter);
    });
  }
});

// 保存ボタンの処理（統合版・年度動的対応）
async function saveGoals() {
  const monthlyEl = document.getElementById("monthlyGoalInput");
  const weeklyEl = document.getElementById("weeklyGoalInput");
  const monthly = monthlyEl ? monthlyEl.value.trim() : "";
  const weekly = weeklyEl ? weeklyEl.value.trim() : "";

  // 選択中の年度目標を保存
  const yearGoalEl = document.getElementById("yearGoalInput");
  const yearGoalValue = yearGoalEl ? yearGoalEl.value.trim() : "";

  const roadmap = safeGetLocalStorage("roadmapGoals", {});
  roadmap[`y${selectedGoalYear}`] = yearGoalValue;

  const savedGoals = safeGetLocalStorage("userGoals", {});
  if (monthly.length > 1000 || weekly.length > 1000 || yearGoalValue.length > 1000) {
    alert("目標は各1000文字以内で入力してください。");
    return;
  }
  savedGoals.monthly = monthly;
  savedGoals.weekly = weekly;

  try {
    localStorage.setItem("userGoals", JSON.stringify(savedGoals));
    localStorage.setItem("roadmapGoals", JSON.stringify(roadmap));
    localStorage.setItem("monthlyGoal", monthly);
    localStorage.setItem("weeklyGoal", weekly);
    updateLocalLastUpdated();

    updateGoalTexts();
    await syncData();

    alert("🎯 目標を保存しました！");

    const editArea = document.getElementById("editableGoals");
    if (editArea) editArea.style.display = "none";
    const toggleBtn = document.getElementById("toggleEditBtn");
    if (toggleBtn) toggleBtn.textContent = "⚙️ 目標を編集する";
  } catch (err) {
    console.error("目標保存失敗:", err);
    alert("ローカル保存に失敗したため、同期を中止しました。");
  }
}

// ストリークの統計情報を動的に計算する
function calculateStreakStats(dailyStatus) {
  if (!dailyStatus) return { current: 0, best: 0 };
  
  const completedKeys = Object.keys(dailyStatus).filter(key => dailyStatus[key] === true);
  if (completedKeys.length === 0) {
    return { current: 0, best: 0 };
  }

  const today = new Date();
  const todayKey = formatDateKey(today);
  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayKey = formatDateKey(yesterday);

  let current = 0;
  let startCheckDate = null;

  if (dailyStatus[todayKey] === true) {
    startCheckDate = today;
  } else if (dailyStatus[yesterdayKey] === true) {
    startCheckDate = yesterday;
  }

  if (startCheckDate) {
    let checkDate = new Date(startCheckDate);
    while (true) {
      const checkKey = formatDateKey(checkDate);
      if (dailyStatus[checkKey] === true) {
        current++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  const dates = completedKeys.map(key => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }).sort((a, b) => a - b);

  let best = 0;
  let tempStreak = 0;
  let prevTime = null;

  dates.forEach(date => {
    const time = date.getTime();
    if (prevTime === null) {
      tempStreak = 1;
    } else {
      const diffDays = Math.round((time - prevTime) / 86400000);
      if (diffDays === 1) {
        tempStreak++;
      } else if (diffDays > 1) {
        if (tempStreak > best) best = tempStreak;
        tempStreak = 1;
      }
    }
    prevTime = time;
  });
  if (tempStreak > best) best = tempStreak;

  const savedStreak = safeGetLocalStorage("streak", { current: 0, best: 0, lastDate: null });
  if (savedStreak && savedStreak.best > best) {
    best = savedStreak.best;
  }

  return { current, best };
}

// ストリークの更新（「〇」がついているかを基準にする）
function updateStreak() {
  const dailyStatus = safeGetLocalStorage("dailyRoutineStatus", {});
  const stats = calculateStreakStats(dailyStatus);

  streak.current = stats.current;
  streak.best = stats.best;

  const completedKeys = Object.keys(dailyStatus).filter(key => dailyStatus[key] === true);
  if (completedKeys.length > 0) {
    const dates = completedKeys.map(key => {
      const [y, m, d] = key.split("-").map(Number);
      return { key, time: new Date(y, m - 1, d, 12, 0, 0, 0).getTime() };
    }).sort((a, b) => b.time - a.time);
    streak.lastDate = dates[0].key;
  } else {
    streak.lastDate = null;
  }

  localStorage.setItem("streak", JSON.stringify(streak));
  updateLocalLastUpdated();
  
  // 画面表示の更新
  const streakEl = document.getElementById("streakDisplay");
  if (streakEl) {
    streakEl.textContent = `🔥 ${streak.current}日連続（最高：${streak.best}日）`;
  }
}

// 今日の予定の表示（日付フォーマットを修正）
function renderTodaySummary() {
  const todayKey = formatDateKey(new Date()); 
  const todayTasks = tasks[todayKey] || [];
  const done = todayTasks.filter(t => t.done).length;
  const total = todayTasks.length;

  const summary = document.getElementById("todaySummary");
  if (!summary) return;
  summary.innerHTML = "";

  const titleH3 = document.createElement("h3");

  if (total === 0) {
    titleH3.textContent = "📅 今日の予定";
    const p = document.createElement("p");
    p.style.padding = "10px";
    p.textContent = "予定はありません。";
    summary.appendChild(titleH3);
    summary.appendChild(p);
    return;
  }

  titleH3.textContent = `📅 今日の予定 (${done}/${total} 完了)`;
  summary.appendChild(titleH3);

  const ul = document.createElement("ul");
  ul.className = "today-task-list";

  todayTasks.forEach((t, i) => {
    const li = document.createElement("li");
    li.style.textDecoration = t.done ? "line-through" : "none";
    li.style.opacity = t.done ? "0.6" : "1";

    const label = document.createElement("label");
    label.style.cursor = "pointer";
    label.style.display = "flex";
    label.style.alignItems = "center";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!t.done;
    checkbox.style.marginRight = "10px";
    checkbox.addEventListener("click", () => {
      window.toggleTaskComplete(todayKey, i);
    });

    const textSpan = document.createElement("span");
    textSpan.textContent = t.title;

    label.appendChild(checkbox);
    label.appendChild(textSpan);
    li.appendChild(label);
    ul.appendChild(li);
  });

  summary.appendChild(ul);
}


function renderRoutine() {
  const list = document.getElementById("routineList");
  if (!list) return;
  list.innerHTML = "";
  const data = currentRoutine === "weekday" ? weekdayRoutine : weekendRoutine;
  const progressKey = currentRoutine === "weekday" ? "weekdayProgress" : "weekendProgress";
  let progressData = safeGetLocalStorage(progressKey, []);
  
  data.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "routine-item";

    const textSpan = document.createElement("span");
    textSpan.className = "routine-text";

    if (isEditing) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = item;
      input.className = "edit-routine-input";
      input.maxLength = 100;
      input.onchange = () => {
        data[i] = input.value;
        const storageKey = currentRoutine === "weekday" ? "weekdayRoutine" : "weekendRoutine";
        localStorage.setItem(storageKey, JSON.stringify(data));
        updateLocalLastUpdated();
      };
      textSpan.appendChild(input);
    } else {
      const timeMatch = item.match(/^([0-9:~〜-]+)\s*(.*)/);
      if (timeMatch) {
        const timeDiv = document.createElement("div");
        timeDiv.className = "routine-time";
        timeDiv.textContent = timeMatch[1];

        const contentDiv = document.createElement("div");
        contentDiv.className = "routine-content";
        contentDiv.textContent = timeMatch[2];

        textSpan.appendChild(timeDiv);
        textSpan.appendChild(contentDiv);
      } else {
        textSpan.textContent = item;
      }
    }
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "routine-check";
    check.checked = progressData[i] || false;
    check.disabled = isEditing;

    check.addEventListener("change", () => {
      progressData[i] = check.checked;
      localStorage.setItem(progressKey, JSON.stringify(progressData));
      updateLocalLastUpdated();
      const allDone = progressData.length === data.length && progressData.every(v => v === true)
      updateStreakLogic(allDone);
      renderRoutine();
    });

    li.appendChild(textSpan);
    li.appendChild(check);
    list.appendChild(li);
  });
  highlightCurrentTime();
}

async function updateStreakLogic(allDone) {
  const today = formatDateKey(new Date());
  let dailyStatus = safeGetLocalStorage("dailyRoutineStatus", {});

  dailyStatus[today] = allDone;
  localStorage.setItem("dailyRoutineStatus", JSON.stringify(dailyStatus));
  updateLocalLastUpdated();
  
  renderCalendar(currentYear, currentMonth);
  updateStreak();
  
  await syncData();
}
  
function removeCalendarRoutineDone(dateKey) {
  if (tasks[dateKey]) {
    tasks[dateKey] = tasks[dateKey].filter(t => t.title !== "〇");
    if (tasks[dateKey].length === 0) delete tasks[dateKey];
    localStorage.setItem("tasks", JSON.stringify(tasks));
    updateLocalLastUpdated();
    renderCalendar(currentYear, currentMonth);
  }
}

function highlightCurrentTime() {
  const listItems = document.querySelectorAll("#routineList li");
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinutes = now.getMinutes();

  let activeIndex = -1;

  listItems.forEach((li, i) => {
    const times = li.textContent.match(/(\d{1,2}):(\d{2})/g);
    if (times && times.length > 0) {
      const [startH, startM] = times[0].split(":").map(Number);
      let endH = 24, endM = 0;

      if (i + 1 < listItems.length) {
        const nextTimes = listItems[i + 1].textContent.match(/(\d{1,2}):(\d{2})/);
        if (nextTimes) {
          endH = parseInt(nextTimes[1]);
          endM = parseInt(nextTimes[2]);
        }
      }

      const nowMinutes = currentHour * 60 + currentMinutes;
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (nowMinutes >= startMinutes && nowMinutes < endMinutes) {
        activeIndex = i;
      }
    }
  });

  listItems.forEach((li, i) => {
    li.classList.toggle("current-time", i === activeIndex);
  });
}

highlightCurrentTime();
setInterval(highlightCurrentTime, 60000);


function updateRoutineClock() {
  const clock = document.getElementById("routineClock");
  if (!clock) return;

  const now = new Date();
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const day = days[now.getDay()];
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  clock.innerHTML = `
    <div class="clock-date">${year}/${month}/${date} (${day})</div>
    <div class="clock-time">${hours}:${minutes}:${seconds}</div>
  `;
}

updateRoutineClock();
setInterval(updateRoutineClock, 1000);

async function markCalendarRoutineDone() {
  const today = new Date();
  const key = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

  if (!tasks[key]) tasks[key] = [];

  const exists = tasks[key].some(t => t.title === "〇");
  if (!exists) {
    tasks[key].push({
      title: "〇",
      category: "ルーティン",
      done: true
    });
    localStorage.setItem("tasks", JSON.stringify(tasks));
    updateLocalLastUpdated();
  }

  renderCalendar(currentYear, currentMonth);
  await syncData();
}

document.getElementById("weekdayBtn").addEventListener("click", () => {
  currentRoutine = "weekday";
  localStorage.setItem("routineType", currentRoutine);
  renderRoutine();
});

document.getElementById("weekendBtn").addEventListener("click", () => {
  currentRoutine = "weekend";
  localStorage.setItem("routineType", currentRoutine);
  renderRoutine();
});

document.getElementById("editRoutine").addEventListener("click", () => {
  isEditing = !isEditing;
  const editBtn = document.getElementById("editRoutine");
  editBtn.textContent = isEditing ? "✅ 完了" : "✏️ 編集";
  renderRoutine();
});

document.getElementById("saveRoutine").addEventListener("click", () => {
  if (confirm("ルーティをデフォルト設定に戻しますか？")) {
    const defaultWeekday = ["6:00 起床・準備", "7:00 通学・インプット(両学長ライブ)", "9:30~15:30 学校・資格勉強", "18:00~23:30 プログラミング学習", "24:00 就寝"];
    const defaultWeekend = ["9:00 起床", "10:00~12:00 復習・資格勉強", "13:00~17:00 プログラミング・思考整理", "18:00~22:00 自由時間・読書", "24:00 就寝"];

    localStorage.setItem("weekdayRoutine", JSON.stringify(defaultWeekday));
    localStorage.setItem("weekendRoutine", JSON.stringify(defaultWeekend));
    updateLocalLastUpdated();

    weekdayRoutine = defaultWeekday;
    weekendRoutine = defaultWeekend;

    renderRoutine();
    alert("デフォルトに戻しました");
  }
});

document.getElementById("resetRoutine").addEventListener("click", () => {
  const progressKey = currentRoutine === "weekday" ? "weekdayProgress" : "weekendProgress";
  const data = currentRoutine === "weekday" ? weekdayRoutine : weekendRoutine;

  const resetProgress = new Array(data.length).fill(false);
  localStorage.setItem(progressKey, JSON.stringify(resetProgress));
  updateLocalLastUpdated();

  updateStreakLogic(false);
  renderRoutine();
});

window.addEventListener("load", () => {
  currentRoutine = localStorage.getItem("routineType") || "weekday";
  renderRoutine();
});

function resetRoutineChecksIfNewDay() {
  const lastResetDate = localStorage.getItem("lastRoutineResetDate");
  const today = new Date().toISOString().split("T")[0];

  if (lastResetDate === today) return;

  localStorage.setItem("weekdayProgress", JSON.stringify([]));
  localStorage.setItem("weekendProgress", JSON.stringify([]));
  updateLocalLastUpdated();

  localStorage.setItem("lastRoutineResetDate", today);

  renderRoutine();
}

window.addEventListener("load", resetRoutineChecksIfNewDay);

setInterval(resetRoutineChecksIfNewDay, 1000 * 60 * 60);

function isToday(dateString) {
  const today = new Date();
  const [year, month, day] = dateString.split("-").map(Number);
  return (
    today.getFullYear() === year &&
    today.getMonth() + 1 === month &&
    today.getDate() === day
  );
}

initCalendar();

function renderCategories() {
  const filterList = document.getElementById("filters");
  const categorySelect = document.getElementById("taskCategory"); // モーダル内の選択肢
  if (!filterList || !categorySelect) return;
  filterList.innerHTML = "";
  categorySelect.innerHTML = "";

  categories.forEach((cat) => {
    // 1. サイドバーのフィルター
    const li = document.createElement("li");
    li.setAttribute("data-category", cat);

    const span = document.createElement("span");
    span.style.cursor = "pointer";
    span.style.display = "inline-block";
    span.style.width = "80%";
    span.textContent = cat;
    span.addEventListener("click", () => window.filterByCategory(cat));

    const delBtn = document.createElement("button");
    delBtn.className = "delete-cat-btn";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCategory(cat);
    });

    li.appendChild(span);
    li.appendChild(delBtn);
    filterList.appendChild(li);

    // 2. タスク作成モーダルの選択肢も更新
    const option = document.createElement("option");
    option.value = cat;
    option.textContent = cat;
    categorySelect.appendChild(option);
  });
}

// カテゴリー追加
const addCategoryBtn = document.getElementById("addCategoryBtn");
if (addCategoryBtn) {
  addCategoryBtn.onclick = () => {
    const rawCat = prompt("新しいカテゴリー名を入力してください（30文字以内）");
    if (!rawCat) return;
    const newCat = rawCat.trim();
    if (newCat.length === 0) return;
    if (newCat.length > 30) {
      alert("カテゴリー名は30文字以内で入力してください。");
      return;
    }
    if (!categories.includes(newCat)) {
      categories.push(newCat);
      saveCategories();
    }
  };
}

// カテゴリー削除
async function deleteCategory(cat) {
  if (confirm(`カテゴリー「${cat}」を削除しますか？`)) {
    categories = categories.filter(c => c !== cat);
    saveCategories();
    await syncData();
  }
}

async function saveCategories() {
  localStorage.setItem("categories", JSON.stringify(categories));
  updateLocalLastUpdated();
  renderCategories();
  await syncData();
}

// 初期起動時に実行
renderCategories();

// --- HTMLから呼び出せるように window に登録 ---

// タスク操作系
window.deleteTask = deleteTask;
window.toggleTaskComplete = toggleTaskComplete;

// ルーティン・完了管理系
window.markCalendarRoutineDone = markCalendarRoutineDone;
window.removeCalendarRoutineDone = removeCalendarRoutineDone;

// カテゴリー管理系
window.deleteCategory = deleteCategory;
window.filterByCategory = (cat) => {
  const filterList = document.querySelectorAll("#filters li");
  let targetFilter = cat;

  filterList.forEach(li => {
    const liCat = li.getAttribute("data-category");
    if (liCat === cat) {
      if (li.classList.contains("active")) {
        li.classList.remove("active");
        targetFilter = null;
      } else {
        li.classList.add("active");
      }
    } else {
      li.classList.remove("active");
    }
  });

  renderCalendar(currentYear, currentMonth, targetFilter);
  renderWeeklyTasks();
};

// その他、初期化や保存系（必要に応じて）
if (typeof defaultSave === 'function') window.defaultSave = defaultSave; 