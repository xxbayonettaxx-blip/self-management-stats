"use strict";
// 自己管理KPIの公開ページ。
//
// 設計:
//   - 書き込み機能を持たない。フォームが無いのでCSRFの攻撃面がゼロ。これが最大のセキュリティ設計。
//   - 数値と表はEJSでサーバー側レンダリングし、グラフはその上にChart.jsで重ねる。
//     JSが動かなくても・グラフが潰れても数字は読める。
//   - Chart.jsはCDNではなく自ホストする。HelmetのデフォルトCSPは script-src 'self' なので
//     外部スクリプトもインラインスクリプトも読み込めない。動かすためにCSPを緩めるのではなく構成で解く。

const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3458;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const FILES = { current: "current.json", recent: "recent-4w.json", all: "all-weekly.json" };

// ---------- データの読み込み ----------

// ビルド成果物は週1回しか変わらないので読み込みを使い回す。
// ローカルで再ビルドしたときに再起動が要らないよう、更新時刻だけ見て読み直す。
const cache = new Map();
function readData(key) {
  const file = path.join(DATA, FILES[key]);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(key);
  if (hit && hit.mtime === mtime) return hit.value;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.set(key, { mtime, value });
  return value;
}
const loadAll = () => ({ current: readData("current"), recent: readData("recent"), all: readData("all") });

// ---------- 表示用の整形 ----------

const CATEGORIES = ["制作", "基礎学習", "営業", "運用・管理", "回復・生活", "運動"];
const dash = v => (v === null || v === undefined || v === "" ? "—" : v);
const minutes = v => (v === null || v === undefined ? "—" : `${v.toLocaleString("ja-JP")}分`);
const hours = v => (v === null || v === undefined ? "—" : `${(v / 60).toFixed(1)}h`);
const ratio = (a, b) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : "—");
// カードの数値は1行に収める。分数と割合を並べると折り返して読みにくくなるので、割合だけを大きく出す。
const percent = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
// 未記録（null）は 0% ではなく「—」。0と表示すると「やっていない」と読まれる。
const share = (value, total) => (value === null || value === undefined ? "—" : total ? `${Math.round((value / total) * 100)}%` : "—");
// 未記録の分類を除いた合計。nullは0に潰さず、分母からも外す。
const sumCategories = source => CATEGORIES.reduce((s, c) => s + (source[c] ?? 0), 0);
const shortDate = iso => (iso ? iso.slice(5).replace("-", "/") : "—");
const recorded = week => week && week.recorded !== false;

function table(title, note, headers, rows) { return { title, note, headers, rows }; }

// 直近の完了週
function buildWeekView(current) {
  const w = current.week;
  const e = w.estimate;
  const cards = [
    { label: "記録日数", value: `${w.recordedWeekdays ?? w.recordedDays}/5`, note: `平日ベース　週末を含む記録は${w.recordedDays}日` },
    { label: "平均誤差", value: e.maeAll === null ? "—" : `${e.maeAll}分`, note: e.maeExcludingLargest === null ? `基準：${e.basis}` : `最大の外れ1件を除くと ${e.maeExcludingLargest}分` },
    { label: "見積もり実施率", value: percent(e.withEstimate, e.blocks), note: `${e.withEstimate}/${e.blocks}ブロック　基準：${e.basis}` },
    { label: "最優先の達成", value: `${dash(w.priority.topAchieved)}/${dash(w.priority.topPlanned)}`, note: `計画外 ${w.deviationMinutes}分` }
  ];
  const tables = [
    // 枠を書かないと、-18分のような行が「守れなかった記録」として読まれる。
    // 何を見ているのか、なぜ自主制作ばかり並ぶのかを表の直前で示す。
    table("見積もりと実績", `想定を立てた ${e.withEstimate}件を、外れたものも含めて全件載せています。内容に並ぶのは自主制作・学習・日課の記録です。案件の内容は守秘のため出していません。`,
      ["日付", "分類", "内容", "想定", "実績", "差", "記録"],
      w.estimates.map(r => [shortDate(r.date), r.category, r.label, minutes(r.planned), minutes(r.actual),
        `${r.actual - r.planned > 0 ? "+" : ""}${r.actual - r.planned}分`, r.punched ? "実測" : "推定"])),
    table("時間配分", `合計 ${minutes(w.totalMinutes)}（${hours(w.totalMinutes)}）。うち週末 ${minutes(w.weekendMinutes ?? 0)}。移動 ${minutes(w.travelMinutes)} は内訳から分離しています。`,
      ["分類", "時間", "割合"],
      CATEGORIES.map(c => [c, minutes(w.categories[c]), share(w.categories[c], sumCategories(w.categories))])),
    table("睡眠と計画への影響度", `計画への影響度は行動基準（0:予定通り／1:翌日に持ち越した／2:予定を削った）。体調そのものではなく、計画がどれだけ崩れたかを表します。`,
      ["日付", "睡眠", "計画への影響度", "最優先", "計画外"],
      w.daily.map(d => [shortDate(d.date), `${minutes(d.sleepMinutes)}（${hours(d.sleepMinutes)}）`, dash(d.planImpact), dash(d.topPriority), `${d.deviationMinutes}分`])),
    table("学習ノート", `「要復習」も隠していません。`,
      ["日付", "カテゴリ", "見出し", "理解度"],
      w.learning.map(l => [shortDate(l.date), l.category, l.title, l.understanding]))
  ];
  return { cards, tables };
}

// 週ごとの集計行を作る。過去4週と全期間で共通。
function weeklyRows(weeks) {
  return weeks.map(w => recorded(w)
    ? [`${shortDate(w.weekStart)}〜${shortDate(w.weekEnd)}`, minutes(w.totalMinutes),
      ratio(w.estimate.withEstimate, w.estimate.blocks),
      w.estimate.maeAll === null ? "—" : `${w.estimate.maeAll}分`,
      w.estimate.maeExcludingLargest === null ? "—" : `${w.estimate.maeExcludingLargest}分`,
      ratio(w.estimate.withinTolerance, w.estimate.measurable), w.estimate.basis]
    : [`${shortDate(w.weekStart)}〜${shortDate(w.weekEnd)}`, "記録なし", "—", "—", "—", "—", "—"]);
}

const sum2 = (weeks, key) => weeks.reduce((s, w) => s + w.estimate[key], 0);

function buildRangeView(weeks, label) {
  const live = weeks.filter(recorded);
  const sum = key => live.reduce((s, w) => s + (w[key] ?? 0), 0);
  const measurable = live.reduce((s, w) => s + w.estimate.measurable, 0);
  const errorWeighted = live.reduce((s, w) => s + (w.estimate.maeAll ?? 0) * w.estimate.measurable, 0);
  const cards = [
    { label: "記録した週", value: `${live.length}/${weeks.length}`, note: `${label}　指標は平日ベース` },
    { label: "平均誤差", value: measurable ? `${(errorWeighted / measurable).toFixed(1)}分` : "—", note: `対象 ${measurable}件` },
    { label: "見積もり実施率", value: percent(sum2(live, "withEstimate"), sum2(live, "blocks")), note: `${sum2(live, "withEstimate")}/${sum2(live, "blocks")}ブロック` },
    { label: "作業時間", value: minutes(sum("totalMinutes")), note: hours(sum("totalMinutes")) }
  ];
  // その分類を記録していた週が1つも無ければ合計もnull（未記録）。0分と未記録は別物。
  const totals = Object.fromEntries(CATEGORIES.map(c => {
    const recordedWeeks = live.filter(w => w.categories[c] !== null && w.categories[c] !== undefined);
    return [c, recordedWeeks.length === 0 ? null : recordedWeeks.reduce((s, w) => s + w.categories[c], 0)];
  }));
  const grand = sumCategories(totals);
  const tables = [
    table("週ごとの見積もり精度", "平均誤差が主指標、±10分以内は従指標です。見積もり実施率を併記しないと、見積もりやすい作業だけ選ぶことで誤差をいくらでも小さくできます。",
      ["週", "作業時間", "見積もり実施率", "平均誤差", "最大の外れを除く", "±10分以内", "基準"],
      weeklyRows(weeks)),
    table("時間配分", "分類の定義は最新のものに統一し、過去にも遡って適用しています。",
      ["分類", "時間", "割合"],
      CATEGORIES.map(c => [c, minutes(totals[c]), share(totals[c], grand)])),
    table("睡眠と計画への影響度", "計画への影響度は主観判断を含むため、推移ではなく分布で見ています。",
      ["週", "平均睡眠", "最短", "最長", "影響度 平均", "0/1/2の日数"],
      weeks.map(w => recorded(w)
        ? [`${shortDate(w.weekStart)}〜`, `${minutes(w.sleep.avgMinutes)}（${hours(w.sleep.avgMinutes)}）`,
          minutes(w.sleep.minMinutes), minutes(w.sleep.maxMinutes), dash(w.planImpact.avg),
          `${w.planImpact.distribution[0]} / ${w.planImpact.distribution[1]} / ${w.planImpact.distribution[2]}`]
        : [`${shortDate(w.weekStart)}〜`, "記録なし", "—", "—", "—", "—"]))
  ];
  return { cards, tables };
}

// ---------- アプリ ----------

const app = express();
app.disable("x-powered-by");
// Helmetの既定より締める。すべて自ホストなので外部オリジンを許可する必要がなく、
// フォームを持たないので form-action も要らない。
// Chart.jsはcanvasに対してJSからスタイルを当てるが、CSPが止めるのはHTML中のstyle属性と
// <style>要素なので 'unsafe-inline' は不要（動作は検証済み）。
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  }
}));
app.use(compression());
app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.get("/", (req, res) => {
  const data = loadAll();
  res.render("index", {
    meta: data.current,
    views: {
      week: buildWeekView(data.current),
      recent: buildRangeView(data.recent.weeks, "過去4週"),
      all: buildRangeView(data.all.weeks, "全期間")
    },
    weekLabel: `${data.current.week.weekStart}〜${data.current.week.weekEnd}`,
    normalization: data.current.normalizationNotes,
    // 「記録に含めていなかった」ことを明示する。0分と書くと「やっていなかった」と読まれる。
    categorySince: Object.entries(data.current.categorySince || {})
      .map(([category, since]) => `${category}をこの記録に含め始めたのは ${since} です。それ以前の週を「—」としているのは、していなかったからではなく、この記録の対象外だったためです。`)
  });
});

app.get("/api/kpi", rateLimit({ windowMs: 60_000, limit: 60 }), (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json(loadAll());
});

// max-ageを長く取ると、更新後も古いJS/CSSが最大その時間だけ配信され続ける。
// 週次で更新するページなので、ETagによる再検証（変更なしなら304）に任せて常に最新を配る。
app.use(express.static(path.join(ROOT, "public"), { maxAge: 0, etag: true }));
app.use((req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => console.log(`自己管理KPI: http://localhost:${PORT}`));
