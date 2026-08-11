"use strict";
// グラフの描画。CSPが script-src 'self' のため、この処理はHTMLに直接書かず外部ファイルに置いている。
// 数値そのものはEJSがサーバー側で表に描いているので、ここが失敗してもページの内容は読める。

const PALETTE = {
  "制作": "#2563eb", "基礎学習": "#0891b2", "営業": "#7c3aed",
  "運用・管理": "#64748b", "回復・生活": "#059669", "運動": "#ea580c"
};
const CATEGORIES = Object.keys(PALETTE);
const ACCENT = "#2563eb";
const MUTED = "#94a3b8";
const GRID = "rgba(120,135,160,.22)";

Chart.defaults.font.family = "system-ui, 'Yu Gothic UI', sans-serif";
Chart.defaults.color = "#475569";
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.maintainAspectRatio = false;

const recorded = w => w && w.recorded !== false;
const weekLabel = w => w.weekStart.slice(5).replace("-", "/");
const built = new Set();
let data = null;

// ---------- グラフ定義 ----------

// 想定と実績の散布図。対角線に近いほど見積もり通り。
// 実測と推定を色で分け、どちらの記録に基づく点かを見た目で判別できるようにする。
function estimateScatter(points) {
  // 上限は60分単位に切り上げ、目盛りも60分刻みに揃える。時間の軸なので区切りが読みやすい。
  // 実データ×1.1をそのまま使うと 198.00000000000003 のように浮動小数点の誤差ごと表示される。
  const largest = Math.max(60, ...points.map(p => Math.max(p.x, p.y)));
  const max = Math.ceil((largest * 1.1) / 60) * 60;
  const axis = title => ({ title: { display: true, text: title }, min: 0, max, ticks: { stepSize: 60 }, grid: { color: GRID } });
  const group = punched => points.filter(p => p.punched === punched).map(p => ({ x: p.x, y: p.y, label: p.label }));
  return {
    type: "scatter",
    data: {
      datasets: [
        { label: "見積もり通りの線", data: [{ x: 0, y: 0 }, { x: max, y: max }], type: "line", borderColor: MUTED, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, fill: false },
        { label: "実測（打刻）", data: group(true), backgroundColor: ACCENT, pointRadius: 5 },
        { label: "推定（自己申告）", data: group(false), backgroundColor: MUTED, pointRadius: 5 }
      ].filter(d => d.data.length > 0)
    },
    options: {
      scales: { x: axis("想定（分）"), y: axis("実績（分）") },
      plugins: { tooltip: { callbacks: { label: c => `${c.raw.label ?? ""} 想定${c.parsed.x}分 → 実績${c.parsed.y}分` } } }
    }
  };
}

// 全期間は点が数百個になって読めないので、週ごとの平均誤差の推移に切り替える。
function estimateTrend(weeks) {
  const live = weeks.filter(recorded);
  return {
    type: "line",
    data: {
      labels: live.map(weekLabel),
      datasets: [
        { label: "平均誤差", data: live.map(w => w.estimate.maeAll), borderColor: ACCENT, backgroundColor: ACCENT, spanGaps: false, tension: .2 },
        { label: "最大の外れ1件を除く", data: live.map(w => w.estimate.maeExcludingLargest), borderColor: MUTED, backgroundColor: MUTED, borderDash: [5, 4], spanGaps: false, tension: .2 }
      ]
    },
    options: { scales: { y: { title: { display: true, text: "平均誤差（分）" }, beginAtZero: true, grid: { color: GRID } }, x: { grid: { display: false } } } }
  };
}

// 期間が長いと総作業時間の増減と比率の変化が混ざって読めなくなるため、全期間は100%積み上げにする。
function timeStack(weeks, percent) {
  const live = weeks.filter(recorded);
  const totals = live.map(w => CATEGORIES.reduce((s, c) => s + w.categories[c], 0));
  return {
    type: "bar",
    data: {
      labels: live.map(weekLabel),
      datasets: CATEGORIES.map(c => ({
        label: c,
        // 未記録（null）は0%に潰さずnullのまま渡す。0%で描くと「やっていない」ことになる。
        data: live.map((w, i) => {
          const value = w.categories[c];
          if (value === null || value === undefined) return null;
          return percent ? (totals[i] ? (value / totals[i]) * 100 : 0) : value;
        }),
        backgroundColor: PALETTE[c]
      }))
    },
    options: {
      indexAxis: "y",
      scales: {
        x: { stacked: true, max: percent ? 100 : undefined, title: { display: true, text: percent ? "割合（%）" : "分" }, grid: { color: GRID } },
        y: { stacked: true, grid: { display: false } }
      },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label} ${percent ? c.parsed.x.toFixed(1) + "%" : c.parsed.x + "分"}` } } }
    }
  };
}

// 睡眠は棒、疲労度は折れ線の複合。日次で見る用。
function sleepDaily(days) {
  return {
    type: "bar",
    data: {
      labels: days.map(d => d.date.slice(5).replace("-", "/")),
      datasets: [
        { label: "睡眠（分）", data: days.map(d => d.sleepMinutes), backgroundColor: "rgba(37,99,235,.55)", yAxisID: "y" },
        { label: "計画への影響度", data: days.map(d => d.planImpact), type: "line", borderColor: "#e11d48", backgroundColor: "#e11d48", yAxisID: "y1", tension: .2, spanGaps: false }
      ]
    },
    options: {
      scales: {
        y: { position: "left", title: { display: true, text: "睡眠（分）" }, beginAtZero: true, grid: { color: GRID } },
        y1: { position: "right", title: { display: true, text: "計画への影響度" }, min: 0, max: 2, ticks: { stepSize: 1 }, grid: { display: false } },
        x: { grid: { display: false } }
      }
    }
  };
}

// 主観スケールは基準が漂流するため、全期間では推移の折れ線にせず日数の分布で見せる。
function sleepWeekly(weeks) {
  const live = weeks.filter(recorded);
  const level = (w, n) => w.planImpact.distribution[n] ?? 0;
  return {
    type: "bar",
    data: {
      labels: live.map(weekLabel),
      datasets: [
        { label: "影響なし(0)の日数", data: live.map(w => level(w, 0)), backgroundColor: "#86efac", yAxisID: "y1", stack: "f" },
        { label: "持ち越し(1)の日数", data: live.map(w => level(w, 1)), backgroundColor: "#fbbf24", yAxisID: "y1", stack: "f" },
        { label: "計画を削った(2)の日数", data: live.map(w => level(w, 2)), backgroundColor: "#f87171", yAxisID: "y1", stack: "f" },
        { label: "平均睡眠（分）", data: live.map(w => w.sleep.avgMinutes), type: "line", borderColor: ACCENT, backgroundColor: ACCENT, yAxisID: "y", tension: .2, spanGaps: false }
      ]
    },
    options: {
      scales: {
        y: { position: "left", title: { display: true, text: "平均睡眠（分）" }, beginAtZero: true, grid: { color: GRID } },
        y1: { position: "right", stacked: true, title: { display: true, text: "日数" }, min: 0, max: 7, ticks: { stepSize: 1 }, grid: { display: false } },
        x: { stacked: true, grid: { display: false } }
      }
    }
  };
}

// ---------- 組み立て ----------

function specsFor(view) {
  if (view === "week") {
    const w = data.current.week;
    return {
      estimate: estimateScatter(w.estimates.map(e => ({ x: e.planned, y: e.actual, punched: e.punched, label: e.label }))),
      time: timeStack([w], false),
      sleep: sleepDaily(w.daily)
    };
  }
  if (view === "recent") {
    const weeks = data.recent.weeks;
    const points = weeks.filter(recorded).flatMap(w => w.estimates.map(e => ({ x: e.planned, y: e.actual, punched: e.punched, label: e.label })));
    return {
      estimate: estimateScatter(points),
      time: timeStack(weeks, false),
      sleep: sleepDaily(weeks.filter(recorded).flatMap(w => w.daily))
    };
  }
  const weeks = data.all.weeks;
  return { estimate: estimateTrend(weeks), time: timeStack(weeks, true), sleep: sleepWeekly(weeks) };
}

function render(view) {
  if (built.has(view) || !data) return;
  const specs = specsFor(view);
  for (const [name, spec] of Object.entries(specs)) {
    const canvas = document.getElementById(`chart-${name}-${view}`);
    if (!canvas) continue;
    // 表が同じ数値を持っているので、読み上げの対象からは外す。
    canvas.setAttribute("aria-hidden", "true");
    new Chart(canvas, spec);
  }
  built.add(view);
}

function switchTo(view) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("is-active", s.dataset.view === view));
  // 非表示のcanvasは幅が0になり描画が崩れるため、表示に切り替えてから作る。
  render(view);
}

document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => switchTo(button.dataset.view)));

fetch("/api/kpi")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(json => { data = json; render("week"); })
  .catch(() => {
    // グラフが出せなくても表に数値が残るので、その旨だけ伝えて終わる。
    document.querySelectorAll(".chart-wrap").forEach(el => { el.textContent = "グラフを読み込めませんでした。数値は下の表をご覧ください。"; el.classList.add("chart-failed"); });
  });
