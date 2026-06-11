// ==========================================
// 1. Firebase インポート & 初期化
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// 環境変数/Firebase Hosting自動初期化の読み込み
async function loadFirebaseConfig() {
  // 1. Firebase Hosting予約済みURLから取得（本番環境・エミュレータ）
  try {
    const response = await fetch('/__/firebase/init.json');
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {}

  // 2. ローカルのfirebase-config.jsonファイルから取得（ローカル単体起動時）
  try {
    const response = await fetch('./firebase-config.json');
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {}

  console.error("Firebaseの設定を読み込めませんでした。ローカルのfirebase-config.jsonファイルまたはFirebase Hostingエミュレータを確認してください。");
  return null;
}

let app, auth, db;

// Firebaseが正常に初期化されているか確認するガード関数
const checkFirebaseInit = () => {
  if (!auth || !db) {
    showToast("⚠️ Firebaseの初期化に失敗しています。");
    alert("Firebaseの設定（firebase-config.json）が正しく読み込めなかったため、この機能は利用できません。");
    return false;
  }
  return true;
};

// ==========================================
// 2. アプリ共通変数
// ==========================================
let tasks = {};
let streak = { current: 0, best: 0, lastDate: null };
let currentUser = null;
let categories = ["資格", "スキル", "副業", "投資"];
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDate = null;

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

// ログイン
const login = async () => {
  if (!checkFirebaseInit()) return;
  const emailInput = document.getElementById("loginEmail");
  const passInput = document.getElementById("loginPassword");

  if (!emailInput || !passInput) {
    console.error("HTML要素が見つかりません。IDが正しいか確認してください。");
    return;
  }

  const email = emailInput.value.trim(); // 余計な空白を消す
  const pass = passInput.value;

  if (!email || !pass) {
    alert("メールアドレスとパスワードを入力してください");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    console.error("Firebaseエラー詳細:", e.code, e.message);
    alert("ログインに失敗しました: " + e.message);
  }
};

// 新規登録
const signup = async () => {
  if (!checkFirebaseInit()) return;
  const email = document.getElementById("loginEmail").value;
  const pass = document.getElementById("loginPassword").value;
  if (!email || !pass) return alert("メールとパスワードを入力してください");
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    alert("登録が完了しました！そのままログインしてください。");
  } catch (e) {
    alert("登録失敗: " + e.message);
  }
};

// ログアウト
const logout = async () => {
  if (!checkFirebaseInit()) return;
  try {
    await signOut(auth);
    location.reload();
  } catch (e) {
    console.error("ログアウト失敗", e);
  }
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
  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      tasks, streak, categories,
      lastUpdated: new Date()
    }, { merge: true });
    console.log("Firestore保存成功");
  } catch (e) { 
    console.error("保存失敗:", e);
    showToast("⚠️ 保存に失敗しました。オフライン保存されました。");
  }
}

function loadFromLocalStorage() {
  try {
    tasks = JSON.parse(localStorage.getItem("tasks")) || {};
    streak = JSON.parse(localStorage.getItem("streak")) || { current: 0, best: 0, lastDate: null };
    categories = JSON.parse(localStorage.getItem("categories")) || ["資格", "スキル", "副業", "投資"];
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
      // 取得したデータを変数に代入
      tasks = data.tasks || {};
      streak = data.streak || { current: 0, best: 0, lastDate: null };
      categories = data.categories || ["資格", "スキル", "副業", "投資"];
      console.log("Firestoreからデータを復元しました");
      
      // ローカルストレージ側も同期
      localStorage.setItem("tasks", JSON.stringify(tasks));
      localStorage.setItem("streak", JSON.stringify(streak));
      localStorage.setItem("categories", JSON.stringify(categories));
    } else {
      loadFromLocalStorage();
    }
  } catch (e) {
    console.error("読み込みエラー:", e);
    loadFromLocalStorage();
    showToast("オフラインモード: ローカルデータを読み込みました。");
  }
  initCalendar();
  renderCategories();
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
        await loadUserData(); 
        
        const loginSect = document.getElementById("login-section");
        if (loginSect) loginSect.style.display = "none";
        const mainApp = document.getElementById("mainApp");
        if (mainApp) mainApp.style.display = "block";
        
        initCalendar(); 
        renderCategories();
        updateProgressBar();
        updateRemainingDays();
        renderTodaySummary(); 
        renderWeeklyTasks();  
      } else {
        currentUser = null;
        const loginSect = document.getElementById("login-section");
        if (loginSect) loginSect.style.display = "block";
        const mainApp = document.getElementById("mainApp");
        if (mainApp) mainApp.style.display = "none";
      }
    });
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
setInterval(updateRemainingDays, 1000 * 60 * 60);

function updateRemainingDays() {
  const targetDate = new Date(2028, 2, 31);
  const today = new Date();
  const diffTime = targetDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  const remainingText = diffDays > 0
  ? `📅 2028年3月31日まで 残り ${diffDays}日`
  : "🎉 目標達成期日を迎えました！";

  const remainingEl = document.getElementById("remainingDays");
  if (remainingEl) remainingEl.textContent = remainingText;
}

function updateGoalTexts() {
  const savedGoals = JSON.parse(localStorage.getItem("userGoals")) || {};
  const roadmap = JSON.parse(localStorage.getItem("roadmapGoals")) || {};

  // --- デフォルト目標の設定 ---
  const now = new Date();
  const month = now.getMonth() + 1;
  const weekNum = Math.ceil(now.getDate() / 7);
  
  const defaultMonthly = `${month}月：ITパスポート・プログラミング基礎を固める`;
  const defaultWeekly = `第${weekNum}週：学習時間の確保と習慣化`;

  // --- 表示の更新（入力があればそれを、なければデフォルトを） ---
  const monthlyText = savedGoals.monthly || defaultMonthly;
  const weeklyText = savedGoals.weekly || defaultWeekly;

  const monthlyTextEl = document.getElementById("monthlyGoalText");
  if (monthlyTextEl) monthlyTextEl.textContent = monthlyText;

  const weeklyTextEl = document.getElementById("weeklyGoalText");
  if (weeklyTextEl) weeklyTextEl.textContent = weeklyText;

  // --- 入力欄の同期（現在の値を保持） ---
  const monthlyInput = document.getElementById("monthlyGoalInput");
  if (monthlyInput) monthlyInput.value = savedGoals.monthly || "";

  const weeklyInput = document.getElementById("weeklyGoalInput");
  if (weeklyInput) weeklyInput.value = savedGoals.weekly || "";

  // 年度目標の表示更新
  const goal2025Text = document.getElementById("goal2025Text");
  if (goal2025Text) goal2025Text.innerHTML = `<strong>2025年度：</strong> ${roadmap.g2025 || "ITパスポート合格・習得"}`;

  const goal2026Text = document.getElementById("goal2026Text");
  if (goal2026Text) goal2026Text.innerHTML = `<strong>2026年度：</strong> ${roadmap.g2026 || "簿記3級・アプリ制作"}`;

  const goal2027Text = document.getElementById("goal2027Text");
  if (goal2027Text) goal2027Text.innerHTML = `<strong>2027年度：</strong> ${roadmap.g2027 || "基本情報・副業収益化"}`;

  // 年度目標入力欄の同期
  const goal2025Input = document.getElementById("goal2025Input");
  if (goal2025Input) goal2025Input.value = roadmap.g2025 || "ITパスポート合格・習得";

  const goal2026Input = document.getElementById("goal2026Input");
  if (goal2026Input) goal2026Input.value = roadmap.g2026 || "簿記3級・アプリ制作";

  const goal2027Input = document.getElementById("goal2027Input");
  if (goal2027Input) goal2027Input.value = roadmap.g2027 || "基本情報・副業収益化";

  // チェック状態の反映
  const monthlyCheck = document.getElementById("monthlyGoalCheck");
  const weeklyCheck = document.getElementById("weeklyGoalCheck");
  if (monthlyCheck) monthlyCheck.checked = savedGoals.monthlyDone || false;
  if (weeklyCheck) weeklyCheck.checked = savedGoals.weeklyDone || false;

  applyGoalStyle("monthlyGoalCheck", "monthlyGoalText");
  applyGoalStyle("weeklyGoalCheck", "weeklyGoalText");
}

function toggleGoalDone(type) {
  const goals = JSON.parse(localStorage.getItem("userGoals")) || {};
  const checkEl = document.getElementById(`${type}GoalCheck`);
  if (!checkEl) return;

  goals[`${type}Done`] = checkEl.checked;
  localStorage.setItem("userGoals", JSON.stringify(goals));

  applyGoalStyle(`${type}GoalCheck`, `${type}GoalText`);
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

    const dailyStatus = JSON.parse(localStorage.getItem("dailyRoutineStatus")) || {};
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

        const taskDiv = document.createElement("div");
        taskDiv.classList.add("task", `cat-${t.category}`);

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
    listEl.innerHTML = "<li>今週のタスクはありません。</li>";
    return;
  }

  weekTasks.sort((a, b) => (a.priority > b.priority ? -1 : 1));

  weekTasks.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${t.date}｜${t.title}</span>
      <span class="weekly-priority">[${t.priority}] ${t.category}</span>
    `;
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

  if (editingIndex !== null) {
    tasks[selectedDate][editingIndex] = newTask;
    editingIndex = null;
  } else {
    tasks[selectedDate].push(newTask);
  }

  localStorage.setItem("tasks", JSON.stringify(tasks));
  const taskModal = document.getElementById("taskModal");
  if (taskModal) taskModal.classList.add("hidden");
  
  await syncData();

  renderCalendar(currentYear, currentMonth);
  renderTaskList(selectedDate);
  renderTodaySummary();
  renderWeeklyTasks();
  
  ["taskTitle", "taskProgress", "taskMemo"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = (id === "taskProgress" ? "0" : "");
  });
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

  if (title) title.innerHTML = `${date} のタスク`;
  if (list) list.innerHTML = "";
  if (section) section.classList.remove("hidden");

  if (!tasks[date] || tasks[date].length === 0) {
    if (list) list.innerHTML = "<li>タスクはありません。</li>";
  } else {
    tasks[date].forEach((t, index) => {
      const li = document.createElement("li");
      const checked = t.done ? "checked" : "";
      const style = t.done ? "text-decoration: line-through; opacity: 0.6;" : "";
      
      li.innerHTML = `
        <div style="${style}">
          <input type="checkbox" class="task-check" ${checked} 
                 onclick="window.toggleTaskComplete('${date}', ${index})">
          <strong>${t.title}</strong> (${t.category}, ${t.priority})
          <br><small>${t.progress}%｜${t.memo || "メモなし"}</small>
        </div>
        <div class="task-btns">
          <button class="edit" onclick="editTask('${date}', ${index})">編集</button>
          <button class="delete" onclick="deleteTask('${date}', ${index})">削除</button>
        </div>
      `;
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
  if (progEl) progEl.value = t.progress;
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

  tasks[date].splice(index, 1);
  if (tasks[date].length === 0) delete tasks[date];

  localStorage.setItem("tasks", JSON.stringify(tasks));
  renderCalendar(currentYear, currentMonth);
  renderTaskList(date);
  renderWeeklyTasks();
  updateProgress();
  await syncData();
  if (typeof renderTodaySummary === "function") renderTodaySummary();
}

const defaultSave = () => {
  const title = document.getElementById("taskTitle").value.trim();
  const category = document.getElementById("taskCategory").value;
  const priority = document.getElementById("taskPriority").value;
  const progress = document.getElementById("taskProgress").value;
  const memo = document.getElementById("taskMemo").value;

  if (!title) return alert("タイトルを入力してください");

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
  tasks[dateKey][index].done = !tasks[dateKey][index].done;
  localStorage.setItem("tasks", JSON.stringify(tasks));
  renderCalendar(currentYear, currentMonth);
  renderTodaySummary();  
  renderWeeklyTasks();   
  renderTaskList(dateKey);
  if (selectedDate === dateKey) renderTaskList(dateKey);
  await syncData();
}


// 目標データの初期化・読み込み
function loadGoals() {
  const roadmap = JSON.parse(localStorage.getItem("roadmapGoals")) || {
    g2025: "ITパスポート合格・習得",
    g2026: "簿記3級・アプリ制作",
    g2027: "基本情報・副業収益化"
  };

  // 表示に反映 (DOM Null Checks)
  const goal2025Text = document.getElementById("goal2025Text");
  if (goal2025Text) goal2025Text.innerHTML = `<strong>2025年度：</strong> ${roadmap.g2025}`;
  const goal2026Text = document.getElementById("goal2026Text");
  if (goal2026Text) goal2026Text.innerHTML = `<strong>2026年度：</strong> ${roadmap.g2026}`;
  const goal2027Text = document.getElementById("goal2027Text");
  if (goal2027Text) goal2027Text.innerHTML = `<strong>2027年度：</strong> ${roadmap.g2027}`;

  // 入力欄に反映
  const goal2025Input = document.getElementById("goal2025Input");
  if (goal2025Input) goal2025Input.value = roadmap.g2025;
  const goal2026Input = document.getElementById("goal2026Input");
  if (goal2026Input) goal2026Input.value = roadmap.g2026;
  const goal2027Input = document.getElementById("goal2027Input");
  if (goal2027Input) goal2027Input.value = roadmap.g2027;

  // 今月・今週の目標（既存の読み込み）
  const monthlyGoalText = document.getElementById("monthlyGoalText");
  if (monthlyGoalText) monthlyGoalText.textContent = localStorage.getItem("monthlyGoal") || "未設定";
  const weeklyGoalText = document.getElementById("weeklyGoalText");
  if (weeklyGoalText) weeklyGoalText.textContent = localStorage.getItem("weeklyGoal") || "未設定";
  const monthlyGoalInput = document.getElementById("monthlyGoalInput");
  if (monthlyGoalInput) monthlyGoalInput.value = localStorage.getItem("monthlyGoal") || "";
  const weeklyGoalInput = document.getElementById("weeklyGoalInput");
  if (weeklyGoalInput) weeklyGoalInput.value = localStorage.getItem("weeklyGoal") || "";
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

// 初期実行
window.addEventListener("DOMContentLoaded", loadGoals);

// 保存ボタンの処理（これ1つに統合）
async function saveGoals() {
  const monthlyEl = document.getElementById("monthlyGoalInput");
  const weeklyEl = document.getElementById("weeklyGoalInput");
  const monthly = monthlyEl ? monthlyEl.value.trim() : "";
  const weekly = weeklyEl ? weeklyEl.value.trim() : "";

  const g2025I = document.getElementById("goal2025Input");
  const g2026I = document.getElementById("goal2026Input");
  const g2027I = document.getElementById("goal2027Input");

  const roadmap = {
    g2025: g2025I ? g2025I.value : "",
    g2026: g2026I ? g2026I.value : "",
    g2027: g2027I ? g2027I.value : ""
  };

  const savedGoals = JSON.parse(localStorage.getItem("userGoals")) || {};
  savedGoals.monthly = monthly;
  savedGoals.weekly = weekly;

  localStorage.setItem("userGoals", JSON.stringify(savedGoals));
  localStorage.setItem("roadmapGoals", JSON.stringify(roadmap));
  localStorage.setItem("monthlyGoal", monthly);
  localStorage.setItem("weeklyGoal", weekly);

  updateGoalTexts();
  await syncData();

  alert("🎯 目標を保存しました！");

  const editArea = document.getElementById("editableGoals");
  if (editArea) editArea.style.display = "none";
  const toggleBtn = document.getElementById("toggleEditBtn");
  if (toggleBtn) toggleBtn.textContent = "⚙️ 目標を編集する";
}

// ストリークの更新（「〇」がついているかを基準にする）
function updateStreak() {
  const today = formatDateKey(new Date());
  const yesterday = formatDateKey(new Date(Date.now() - 86400000));
  
  // 〇印のデータを取得
  const dailyStatus = JSON.parse(localStorage.getItem("dailyRoutineStatus")) || {};

  // 今日の〇がついているか確認
  const isDoneToday = dailyStatus[today] === true;

  if (isDoneToday && streak.lastDate !== today) {
    if (streak.lastDate === yesterday) {
      streak.current++;
    } else {
      // 昨日が〇でなければ1からやり直し
      streak.current = 1;
    }
    streak.lastDate = today;
    if (streak.current > streak.best) streak.best = streak.current;
  } 
  // 今日チェックを外して「〇」が消えた場合、今日の分をリセット
  else if (!isDoneToday && streak.lastDate === today) {
    // 連続記録が途切れる設定にする場合
    streak.current = 0; 
    streak.lastDate = null;
  }

  localStorage.setItem("streak", JSON.stringify(streak));
  
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

  if (total === 0) {
    summary.innerHTML = `<h3>📅 今日の予定</h3><p style="padding:10px;">予定はありません。</p>`;
    return;
  }

  summary.innerHTML = `
    <h3>📅 今日の予定 (${done}/${total} 完了)</h3>
    <ul class="today-task-list">
      ${todayTasks.map((t, i) => `
        <li style="text-decoration:${t.done ? 'line-through' : 'none'}; opacity:${t.done ? 0.6 : 1}">
          <label style="cursor:pointer; display:flex; align-items:center;">
            <input type="checkbox" ${t.done ? 'checked' : ''} 
                   onclick="window.toggleTaskComplete('${todayKey}', ${i})" 
                   style="margin-right:10px;">
            ${t.title}
          </label>
        </li>
      `).join('')}
    </ul>
    `;
}

let weekdayRoutine = JSON.parse(localStorage.getItem("weekdayRoutine")) || [
  "6:00 起床・準備",
  "7:00 通学・インプット(両学長ライブ)",
  "9:30~15:30 学校・資格勉強",
  "18:00~23:30 プログラミング学習",
  "24:00 就寝"
];

let weekendRoutine = JSON.parse(localStorage.getItem("weekendRoutine")) || [
  "9:00 起床",
  "10:00~12:00 復習・資格勉強",
  "13:00~17:00 プログラミング・思考整理",
  "18:00~22:00 自由時間・読書",
  "24:00 就寝"
];

let currentRoutine = "weekday";
let isEditing = false;

function renderRoutine() {
  const list = document.getElementById("routineList");
  list.innerHTML = "";
  const data = currentRoutine === "weekday" ? weekdayRoutine : weekendRoutine;
  const progressKey = currentRoutine === "weekday" ? "weekdayProgress" : "weekendProgress";
  let progressData = JSON.parse(localStorage.getItem(progressKey)) || [];
  
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
      input.onchange = () => {
        data[i] = input.value;
        const storageKey = currentRoutine === "weekday" ? "weekdayRoutine" : "weekendRoutine";
        localStorage.setItem(storageKey, JSON.stringify(data));
      };
      textSpan.appendChild(input);
    } else {
      const timeMatch = item.match(/^([0-9:~〜-]+)\s*(.*)/);
      if (timeMatch) {
        textSpan.innerHTML = `<div class="routine-time">${timeMatch[1]}</div><div class="routine-content">${timeMatch[2]}</div>`;
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
  // 以前のタスク形式の〇を削除する関数（removeCalendarRoutineDone）は不要になります
  
  let dailyStatus = JSON.parse(localStorage.getItem("dailyRoutineStatus")) || {};

  if (allDone) {
    dailyStatus[today] = true; // 今日を「完了」にする
    const yesterday = formatDateKey(new Date(Date.now() - 86400000));
    
    // 継続日数の計算
    if (streak.lastDate === yesterday) {
      streak.current++;
    } else if (streak.lastDate !== today) {
      streak.current = 1;
    }
    streak.lastDate = today;
  } else {
    dailyStatus[today] = false; // これでカレンダーの〇が消える
    streak.current = 0; // ストリークもリセット
  }

  dailyStatus[today] = allDone;
  localStorage.setItem("dailyRoutineStatus", JSON.stringify(dailyStatus));
  localStorage.setItem("streak", JSON.stringify(streak));
  
  renderCalendar(currentYear, currentMonth);
  updateStreak();
  if (document.getElementById("streakDisplay")) {
    document.getElementById("streakDisplay").textContent = `🔥 ${streak.current}日連続（最高：${streak.best}日）`;
  }
  
  await syncData();
}
  
function removeCalendarRoutineDone(dateKey) {
  if (tasks[dateKey]) {
    tasks[dateKey] = tasks[dateKey].filter(t => t.title !== "〇");
    if (tasks[dateKey].length === 0) delete tasks[dateKey];
    localStorage.setItem("tasks", JSON.stringify(tasks));
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

  clock.textContent = `${year}/${month}/${date} (${day}) ${hours}:${minutes}:${seconds}`;
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

  updateStreakLogic(false);
  renderRoutine();
});

window.addEventListener("load", () => {
  currentRoutine = localStorage.getItem("routineType") || "weekday";
  renderRoutine();
});


window.addEventListener("DOMContentLoaded", () => {
  updateGoalTexts();

  const saveBtn = document.getElementById("saveGoals");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveGoals);
  }

  const mCheck = document.getElementById("monthlyGoalCheck");
  const wCheck = document.getElementById("weeklyGoalCheck");
  if (mCheck) mCheck.addEventListener("change", () => toggleGoalDone("monthly"));
  if (wCheck) wCheck.addEventListener("change", () => toggleGoalDone("weekly"));
})

function resetRoutineChecksIfNewDay() {
  const lastResetDate = localStorage.getItem("lastRoutineResetDate");
  const today = new Date().toISOString().split("T")[0];

  if (lastResetDate === today) return;

  localStorage.setItem("weekdayProgress", JSON.stringify([]));
  localStorage.setItem("weekendProgress", JSON.stringify([]));

  localStorage.setItem("lastRoutineResetDate", today);

  renderRoutine();
}

window.addEventListener("load", resetRoutineChecksIfNewDay);

setInterval(resetRoutineChecksIfNewDay, 1000 * 60 * 60);

function saveTasksAndUpdate(){
  const selectedDate = document.querySelector(".calendar-day.selected");
  if (!selectedDate) return;

  const date = selectedDate.dataset.date;
  const tasks = Array.from(document.querySelectorAll(".task-item inpur[type='text'"))
  .map((input) => input.value.trim())
  .filter((v) => v !== "");

  localStorage.setItem(`tasks-${date}`,JSON.stringify(tasks));

  renderCalender();
  if (isToday(date)) {
    renderTodayTasks();
  }
}

function isToday(dateString) {
  const today = new Date();
  const [year, month, day] = dateString.split("-").map(Number);
  return (
    today.getFullYear() === year &&
    today.getMonth() + 1 === month &&
    today.getDate() === day
  );
}

loadGoals();
updateRemainingDays();
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
    li.innerHTML = `
      <span onclick="filterByCategory('${cat}')" style="cursor: pointer; display: inline-block; width: 80%;">${cat}</span>
      <button class="delete-cat-btn" onclick="deleteCategory('${cat}')">×</button>
    `;
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
    const newCat = prompt("新しいカテゴリー名を入力してください");
    if (newCat && !categories.includes(newCat)) {
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
  renderCategories();
  await syncData();
}

// 初期起動時に実行
renderCategories();

// --- HTMLから呼び出せるように window に登録 ---

// タスク操作系
window.deleteTask = deleteTask;
window.toggleTaskComplete = toggleTaskComplete;
window.saveTasksAndUpdate = saveTasksAndUpdate;

// ルーティン・完了管理系
window.markCalendarRoutineDone = markCalendarRoutineDone;
window.removeCalendarRoutineDone = removeCalendarRoutineDone;

// カテゴリー管理系
window.deleteCategory = deleteCategory;
window.filterByCategory = (cat) => {
  const filterList = document.querySelectorAll("#filters li");
  filterList.forEach(li => {
    const liCat = li.getAttribute("data-category");
    if (liCat === cat) {
      li.classList.add("active");
    } else {
      li.classList.remove("active");
    }
  });

  renderCalendar(currentYear, currentMonth, cat);
  renderWeeklyTasks();
};

// その他、初期化や保存系（必要に応じて）
if (typeof defaultSave === 'function') window.defaultSave = defaultSave; 