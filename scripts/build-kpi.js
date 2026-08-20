"use strict";
// 週次ログのMarkdownから公開用JSONを生成する。
//
// 設計上の原則（definitions.md §8）:
//   1. 差分を追記しない。毎回ゼロから全期間を再生成する。
//      定義を変えたらビルドし直すだけで過去も一斉に追従させるため。
//   2. 公開してよい項目だけを通すホワイトリスト方式にする。
//      「公開しない」を運用ルールではなくコードで担保し、事故で漏れる経路を構造的に塞ぐ。
//   3. 列は位置ではなく見出し名で読む。
//      ログの列構成は実際に週ごとに変わっており（移動列の追加、開始/終了/推定の追加）、
//      位置固定のパーサは必ず壊れる。

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOGS = argValue("--logs") || path.join(ROOT, "logs");
const OUT = argValue("--out") || path.join(ROOT, "data");

// 記録方式を変更した日。この日以降の週を新regimeとして扱う（definitions.md §0）。
const REGIME_START = "2026-08-08";
// 見積もりが「一致」したとみなす許容幅（分）。主指標は平均誤差、これは従指標（§4）。
const MATCH_TOLERANCE = 10;
const CATEGORIES = ["制作", "基礎学習", "営業", "運用・管理", "回復・生活", "運動"];

// 分類ごとの記録開始日。これより前の週は 0 ではなく null（未記録）にする。
// 運動は以前から行っていて、このログに含めていなかっただけ。0で埋めると
// 「やっていなかった」と読まれるため、欠測週と同じ扱いにする（definitions.md §5）。
const CATEGORY_SINCE = { "運動": "2026-08-02" };

// 分類定義のドリフトを最新の定義に揃えて遡及適用する（definitions.md §7）。
// 「写経」は11週目が基礎学習、12週目が回復・生活。揃えないと基礎学習が555分→210分に
// 激減したように見え、時系列グラフが嘘になる。
const CATEGORY_OVERRIDES = [
  { match: /写経/, category: "回復・生活", note: "写経を回復・生活に統一（読書と休息を兼ねた時間として扱う）" },
  // 同じ活動が週によって別分類になっていた。求職に関わる活動は営業に寄せる。
  { match: /履歴書|職務経歴書/, category: "営業", note: "履歴書・職務経歴書の作成を営業に統一" },
  { match: /ハローワーク/, category: "営業", note: "ハローワークを営業に統一" }
];
// 11週目は移動を作業ブロックとして記録し、12週目から移動列に分離された。
// 内容が「移動」だけの行は移動時間として扱い、分類別の内訳から外す。
// 「ハローワーク（移動込み）」のように分離できない行はそのまま残す。
const TRAVEL_SUBJECT = /^移動$/;

// 公開してはならない値を、入力側の除外対象フィールドから動的に集める。
// 固定の禁止語リストだと新しい症状名や業種名を取りこぼすが、
// 「入力で捨てたはずの値が出力に現れていないか」を照合すれば構造的に検出できる。
const EXCLUDED_FIELDS = ["ひとこと", "業種", "自己評価", "署名", "主軸維持コメント", "来週の改善アクション", "説明", "メモ", "理由", "見送り理由"];

function argValue(name) {
  const hit = process.argv.find(a => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : null;
}

// ---------- Markdownの読み取り ----------

// 表を見出し名でオブジェクト化する。セル内の <br> は改行に戻す。
function parseTable(lines) {
  if (lines.length < 2) return [];
  const cells = line => line.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const headers = cells(lines[0]);
  return lines.slice(2).map(line => {
    const values = cells(line);
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").replace(/<br>/g, "\n").trim()]));
  });
}

function parseLog(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const title = /^#\s*週次ログ（(\d{4}-\d{2}-\d{2})〜(\d{4}-\d{2}-\d{2})）/.exec(lines[0] || "");
  if (!title) throw new Error(`${path.basename(file)}: 先頭行から期間を読めません。`);

  const sections = {};
  const totals = {};
  let current = null;
  let buffer = [];
  const flush = () => { if (current && buffer.length > 0) sections[current] = (sections[current] || []).concat(buffer); buffer = []; };

  for (const line of lines.slice(1)) {
    const heading = /^#{2,3}\s*(.+?)\s*$/.exec(line);
    if (heading) { flush(); current = heading[1]; continue; }
    if (line.startsWith("|")) { buffer.push(line); continue; }
    // 集計セクションの「- 記録日数：7日」形式を控えておき、再計算値との照合に使う。
    const total = /^-\s*(.+?)：\s*([\d.]+)/.exec(line);
    if (current === "集計" && total) totals[total[1]] = Number(total[2]);
    flush();
  }
  flush();

  const table = name => parseTable(sections[name] || []);
  // 週次サマリーは横持ち（11週目）と縦持ち（12週目以降）の2形式がある。
  const summaryRows = table("週次サマリー");
  const summary = summaryRows.length === 0 ? {}
    : summaryRows[0]["項目"] !== undefined ? Object.fromEntries(summaryRows.map(r => [r["項目"], r["内容"]]))
      : summaryRows[0];

  return {
    file: path.basename(file),
    weekStart: title[1],
    weekEnd: title[2],
    totals,
    daily: table("日次状態"),
    // 計画セクションは2026-08-17の運用開始以降のログにだけ現れる。無い週は空配列のまま扱う。
    plans: table("計画"),
    work: sections["作業ブロック"] ? parseTable(sections["作業ブロック"]) : [],
    hearings: table("ヒアリング"),
    learning: table("学習ノート"),
    summary
  };
}

// ---------- 値の取り出し ----------

const num = v => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) && String(v ?? "").trim() !== "" && String(v).trim() !== "—" ? n : null; };
const addDays = (iso, days) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
// 月〜金かどうか。週の開始曜日に依存しないよう、実際の曜日で判定する。
const isWeekday = iso => { const day = new Date(iso + "T00:00:00Z").getUTCDay(); return day >= 1 && day <= 5; };

function normalizeCategory(row, notes) {
  const subject = row["内容"] || "";
  for (const rule of CATEGORY_OVERRIDES) {
    if (rule.match.test(subject)) { if (!notes.includes(rule.note)) notes.push(rule.note); return rule.category; }
  }
  return row["分類"];
}

// ---------- 週単位の集計 ----------

const mean = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

function summarizeWeek(log) {
  const notes = [];
  const regime = log.weekStart >= REGIME_START ? "new" : "old";

  const daily = log.daily.map(r => ({
    date: r["日付"],
    sleepMinutes: num(r["睡眠（分）"]),
    // 2026-08-10に「疲労度」から「計画への影響度」へ改称。数値の意味は変えていない。
    // 旧形式のログにも遡って対応するため、両方の見出しを受ける。
    planImpact: num(r["計画への影響度"] ?? r["疲労度"]),
    topPriority: r["最優先"] || null
  }));

  const blocks = log.work.map(r => {
    const category = normalizeCategory(r, notes);
    const isTravelRow = TRAVEL_SUBJECT.test(r["内容"] || "");
    if (isTravelRow && !notes.includes("移動のみの作業行を移動時間へ振替")) notes.push("移動のみの作業行を移動時間へ振替");
    return {
      date: r["日付"],
      category,
      label: r["内容"],
      planned: num(r["想定（分）"]),
      actual: num(r["分"]),
      travel: num(r["移動（分）"]),
      // 「推定」列が無い旧regimeは打刻を経ていないので、すべて推定として扱う（definitions.md §2）。
      punched: r["推定"] === undefined ? false : r["推定"] === "実測",
      inPlan: r["計画内"] === "Yes",
      isTravelRow
    };
  });

  const categories = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  let travelMinutes = 0;
  for (const b of blocks) {
    if (b.isTravelRow) { travelMinutes += b.actual ?? 0; continue; }
    travelMinutes += b.travel ?? 0;
    if (categories[b.category] === undefined) throw new Error(`${log.file}: 未知の分類「${b.category}」`);
    categories[b.category] += b.actual ?? 0;
  }
  // 記録開始前の週は未記録として null にする。ただし実データがある場合は消さない
  // （開始日の設定ミスで記録を握りつぶさないための保険）。
  for (const [category, since] of Object.entries(CATEGORY_SINCE)) {
    if (log.weekStart >= since || categories[category] > 0) continue;
    categories[category] = null;
  }

  // 指標は平日（月〜金）で測る。週末は打刻も想定もほとんど行われておらず、
  // 混ぜると質の低い記録が平日の数字を引き下げる。作業時間と分類の内訳には週末も含める。
  const estimateRows = blocks.filter(b => !b.isTravelRow && isWeekday(b.date));
  const withEstimate = estimateRows.filter(b => b.planned !== null);
  // 判定は日付ではなく行の打刻フラグで行う。境界日で切ると、運用を前倒し・後ろ倒し
  // したときに追従できない（実際に境界日より5日早く打刻を始めていた）。
  // 打刻が1件も無い週だけ、自己申告ベースとして全件を対象にする。
  const basis = estimateRows.some(b => b.punched) ? "実測" : "自己申告";
  const measurable = withEstimate.filter(b => b.actual !== null && (basis === "自己申告" || b.punched));
  const errors = measurable.map(b => Math.abs(b.actual - b.planned)).sort((a, b) => b - a);
  // 「予定変更を除いた値」はログに変更理由の列が無く自動判別できないため、
  // 意図を推測せず「最大の外れ1件を除いた値」として出す。両方出すことで恣意的な除外を防ぐ（§4）。
  const largest = measurable.length > 0
    ? measurable.reduce((a, b) => Math.abs(b.actual - b.planned) > Math.abs(a.actual - a.planned) ? b : a)
    : null;

  // 日別の計画外時間。週合計と同じくブロック側から数え、日次欄の手入力は使わない。
  // これを入れ忘れていたため、日次表の「計画外」列が undefined と表示されていた。
  const deviationByDate = {};
  for (const b of blocks) {
    if (b.isTravelRow || b.inPlan) continue;
    deviationByDate[b.date] = (deviationByDate[b.date] ?? 0) + (b.actual ?? 0);
  }
  for (const d of daily) d.deviationMinutes = deviationByDate[d.date] ?? 0;

  // 睡眠・疲労も平日で集計する。週末の休養日（15時間睡眠など）が混ざると
  // 平常時の水準として読めない数字になる。日次の明細には全曜日を残すのでグラフでは見える。
  const weekdayDaily = daily.filter(d => isWeekday(d.date));
  const sleeps = weekdayDaily.map(d => d.sleepMinutes).filter(v => v !== null);
  const impacts = weekdayDaily.map(d => d.planImpact).filter(v => v !== null);

  // 計画は平日で測る。週末に計画を立てる運用ではないので、混ぜると分母が歪む。
  const plans = log.plans.filter(r => isWeekday(r["日付"])).map(r => ({
    date: r["日付"],
    category: normalizeCategory(r, notes),
    label: r["内容"],
    estimated: num(r["想定（分）"]),
    actual: num(r["実績（分）"]) ?? 0,
    blocks: num(r["回数"]) ?? 0,
    priority: r["優先度"],
    status: r["状態"],
    skipReason: r["見送り理由"] === "—" ? null : r["見送り理由"] || null
  }));
  const done = plans.filter(p => p.status === "実施済");
  const topPlans = plans.filter(p => p.priority === "最優先");
  // 誤差は計画1件の想定と、その計画に紐づく打刻の合計で出す。1つの計画を40分ブロックに
  // 分けて打刻するため、ブロック単位で想定と比べると意味を持たない（definitions.md §4）。
  const planErrors = done.filter(p => p.estimated !== null).map(p => Math.abs(p.actual - p.estimated)).sort((a, b) => b - a);
  const planLargest = done.filter(p => p.estimated !== null).reduce((a, b) => a === null || Math.abs(b.actual - b.estimated) > Math.abs(a.actual - a.estimated) ? b : a, null);
  // 計画運用では「想定を立てたか」は常にYesになる（計画は想定を必須にしている）。
  // 代わりに「作業時間のうちどれだけが事前に決まっていたか」を見る。分母は平日の作業時間で、
  // 計画に入れなかった時間が丸ごと残るので、簡単な作業だけ計画に載せても率は上がらない。
  const weekdayMinutes = estimateRows.reduce((sum, b) => sum + (b.actual ?? 0), 0);
  const plannedMinutes = estimateRows.filter(b => b.inPlan).reduce((sum, b) => sum + (b.actual ?? 0), 0);
  const planExecution = plans.length === 0 ? null : {
    total: plans.length,
    done: done.length,
    skipped: plans.filter(p => p.status === "見送り").length,
    notStarted: plans.filter(p => p.status === "未着手").length,
    topTotal: topPlans.length,
    topDone: topPlans.filter(p => p.status === "実施済").length,
    mae: planErrors.length > 0 ? Number(mean(planErrors).toFixed(1)) : null,
    maeExcludingLargest: planErrors.length > 1 ? Number(mean(planErrors.slice(1)).toFixed(1)) : null,
    withinTolerance: done.filter(p => p.estimated !== null && Math.abs(p.actual - p.estimated) <= MATCH_TOLERANCE).length,
    measurable: planErrors.length,
    // 見送り理由は自由記述で、体調や症状に触れることがある（記録アプリ側では必須項目）。
    // 公開するのは「どの分類が何件見送られたか」までにし、本文は手元のログに留める。
    skipsByCategory: Object.fromEntries(CATEGORIES.map(c => [c, plans.filter(p => p.status === "見送り" && p.category === c).length]).filter(([, n]) => n > 0))
  };

  const hearingMinutes = log.hearings.reduce((s, r) => s + (num(r["ヒアリング（分）"]) ?? 0) + (num(r["振り返り（分）"]) ?? 0), 0);
  const workMinutes = blocks.reduce((s, b) => s + (b.actual ?? 0), 0);

  return {
    weekStart: log.weekStart,
    weekEnd: log.weekEnd,
    regime,
    // 記録の継続性は平日で測る。週末の記録は任意なので、無くても欠測にしない。
    recordedWeekdays: daily.filter(d => isWeekday(d.date)).length,
    recordedDays: daily.length,
    totalMinutes: workMinutes + hearingMinutes,
    // 週末の作業も合計と内訳には含めるが、別掲して混ざらないようにする。
    weekendMinutes: blocks.filter(b => !b.isTravelRow && !isWeekday(b.date)).reduce((sum, b) => sum + (b.actual ?? 0), 0),
    travelMinutes,
    categories,
    // 見積もりの単位は、計画を記録している週かどうかで切り替える。
    // 2026-08-17から1つの計画を40分ブロックに分けて打刻する運用に変えたため、
    // ブロック側は想定を持たない。ブロック単位のまま数えると、行動は変わっていないのに
    // 見積もり実施率だけが急落して見える。単位が変わったことは basis に出して隠さない（§4）。
    estimate: planExecution ? {
      basis: "計画単位",
      blocks: planExecution.total,
      withEstimate: planExecution.total,
      punched: planExecution.done,
      measurable: planExecution.measurable,
      maeAll: planExecution.mae,
      maeExcludingLargest: planExecution.maeExcludingLargest,
      withinTolerance: planExecution.withinTolerance,
      largestOutlier: planLargest ? { label: planLargest.label, planned: planLargest.estimated, actual: planLargest.actual } : null
    } : {
      basis,
      blocks: estimateRows.length,
      withEstimate: withEstimate.length,
      punched: estimateRows.filter(b => b.punched).length,
      measurable: measurable.length,
      maeAll: measurable.length > 0 ? Number(mean(errors).toFixed(1)) : null,
      maeExcludingLargest: errors.length > 1 ? Number(mean(errors.slice(1)).toFixed(1)) : null,
      withinTolerance: measurable.filter(b => Math.abs(b.actual - b.planned) <= MATCH_TOLERANCE).length,
      largestOutlier: largest ? { label: largest.label, planned: largest.planned, actual: largest.actual } : null
    },
    planExecution,
    // 網羅率は全期間で同じ問いに答えるので、計画の有無にかかわらず出す。
    // 判定の出所（自動/自己申告）だけが変わるため、それは基準として添える。
    coverage: { plannedMinutes, weekdayMinutes, basis: planExecution ? "自動判定" : "自己申告" },
    priority: {
      // 計画データがある週は打刻から導いた値を使う。週次サマリーの手入力は
      // 集計時の記憶に依存し、日をまたぐと実際の打刻とずれる。
      topAchieved: planExecution ? planExecution.topDone
        : num(log.summary["最優先 達成/計画"]?.split("/")[0]) ?? num(log.summary["最優先達成/計画"]?.split("/")[0]),
      topPlanned: planExecution ? planExecution.topTotal
        : num(log.summary["最優先 達成/計画"]?.split("/")[1]) ?? num(log.summary["最優先達成/計画"]?.split("/")[1]),
      basis: planExecution ? "打刻" : "自己申告",
      overallScore: num(log.summary["総合スコア"]) ?? num(log.summary["スコア"])
    },
    // 逸脱は日次の欄ではなく 計画内=No のブロックから数える。旧形式の出力では
    // 日次欄が手入力で取りこぼしがあり（11週目 記載90分／実際190分）、ブロック側が網羅的。
    deviationMinutes: estimateRows.filter(b => !b.inPlan).reduce((sum, b) => sum + (b.actual ?? 0), 0),
    sleep: {
      avgMinutes: sleeps.length > 0 ? Math.round(mean(sleeps)) : null,
      minMinutes: sleeps.length > 0 ? Math.min(...sleeps) : null,
      maxMinutes: sleeps.length > 0 ? Math.max(...sleeps) : null
    },
    planImpact: {
      avg: impacts.length > 0 ? Number(mean(impacts).toFixed(2)) : null,
      distribution: { 0: impacts.filter(v => v === 0).length, 1: impacts.filter(v => v === 1).length, 2: impacts.filter(v => v === 2).length }
    },
    normalizationNotes: notes,
    // 明細は公開する列だけを持つ。ひとこと・業種・自己評価などはここで落とす（definitions.md §6）。
    daily,
    estimates: planExecution
      ? plans.filter(p => p.status === "実施済").map(p => ({ date: p.date, category: p.category, label: p.label, planned: p.estimated, actual: p.actual, punched: true, blocks: p.blocks }))
      : withEstimate.map(b => ({ date: b.date, category: b.category, label: b.label, planned: b.planned, actual: b.actual, punched: b.punched })),
    // 逸脱は合計だけでは判断材料にならない。内容を並べれば性質（自分の道具作りか、
    // 主軸に沿う計画外か）が読み取れる。新しい判断もフィールドも要らない（definitions.md §4-2）。
    deviations: estimateRows.filter(b => !b.inPlan).map(b => ({ date: b.date, category: b.category, label: b.label, actual: b.actual })),
    learning: log.learning.map(r => ({ date: r["日付"], category: r["カテゴリ"], title: r["見出し"], understanding: r["理解度"], reviewed: r["復習"] === "○" }))
  };
}

// ---------- 検証 ----------

function verify(logs, weeks, output) {
  const problems = [];

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i], week = weeks[i];
    // 恒等式: 作業時間合計 == 作業ブロックの分 + ヒアリング（実施+振り返り）
    const declared = log.totals["作業時間合計"];
    if (declared !== undefined && declared !== week.totalMinutes) {
      problems.push(`${log.file}: 作業時間合計が一致しません（記載 ${declared}分 / 再計算 ${week.totalMinutes}分）`);
    }
    const days = log.totals["記録日数"];
    if (days !== undefined && days !== week.recordedDays) {
      problems.push(`${log.file}: 記録日数が一致しません（記載 ${days}日 / 再計算 ${week.recordedDays}日）`);
    }
    const span = (new Date(log.weekEnd) - new Date(log.weekStart)) / 86400000;
    if (span !== 6) problems.push(`${log.file}: 期間が7日ではありません（${span + 1}日）。単日エクスポートが紛れていませんか。`);
  }

  const starts = logs.map(l => l.weekStart);
  const duplicated = starts.filter((s, i) => starts.indexOf(s) !== i);
  if (duplicated.length > 0) problems.push(`週の開始日が重複しています: ${[...new Set(duplicated)].join(", ")}`);

  // 入力で捨てたはずの値が出力に残っていないかを照合する。
  // 単純な部分一致だと、ひとこと「ダッシュボード」が公開対象の作業内容「ダッシュボード改修」に
  // 含まれるだけで誤検知する。値そのものが出力の項目として現れていないかを見る。
  const leafStrings = new Set();
  (function collect(value) {
    if (typeof value === "string") return void leafStrings.add(value.trim());
    if (Array.isArray(value)) return void value.forEach(collect);
    if (value && typeof value === "object") Object.values(value).forEach(collect);
  })(output);
  const serialized = JSON.stringify(output);
  const leaked = new Set();
  for (const log of logs) {
    const tables = [log.daily, log.work, log.hearings, log.learning, [log.summary]];
    for (const rows of tables) for (const row of rows) for (const [key, value] of Object.entries(row || {})) {
      if (!EXCLUDED_FIELDS.includes(key)) continue;
      const v = String(value || "").trim();
      if (v.length < 3 || v === "—") continue;
      // 値がそのまま出力の項目になっている場合（業種名などの短い値もここで捕まる）。
      if (leafStrings.has(v)) leaked.add(`${key}「${v.slice(0, 24)}」`);
      // 長い自由記述は他の文に紛れ込む形でも漏れうるので、部分一致でも見る。
      else if (v.length >= 16 && serialized.includes(v)) leaked.add(`${key}「${v.slice(0, 24)}…」`);
    }
  }
  for (const item of leaked) problems.push(`非公開項目が出力に混入しています: ${item}`);

  // 健康に関わる項目は名指しでも確認する。ホワイトリスト方式なので通らないはずだが、
  // 将来ここに列を足したときに気づけるようにしておく。値ではなく語そのものを見る。
  for (const word of ["服薬", "medication", "処方", "通院", "病院"]) {
    if (serialized.includes(word)) problems.push(`健康に関わる項目が出力に含まれています: 「${word}」`);
  }

  return problems;
}

// ---------- 過去週の変化の検知 ----------

// 毎回全期間を作り直す方式では、分類マッピングを1つ変えるだけで半年前の週の数値も動く。
// それは意図した挙動だが、バグでも同じことが起きる。前回の出力と突き合わせて、
// 先週分の追加ではなく過去週の数値が変わっていたら知らせる（definitions.md §8の安全網）。
function flatten(value, prefix = "", out = {}) {
  for (const [key, v] of Object.entries(value || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, name, out);
    else out[name] = Array.isArray(v) ? `[${v.length}件]` : v;
  }
  return out;
}

function retroactiveChanges(previousPath, weeks) {
  if (!fs.existsSync(previousPath)) return [];
  let previous;
  try { previous = JSON.parse(fs.readFileSync(previousPath, "utf8")); } catch { return []; }
  const byStart = new Map((previous.weeks || []).map(w => [w.weekStart, w]));
  const changes = [];
  for (const week of weeks) {
    const before = byStart.get(week.weekStart);
    if (!before) continue; // 新しく増えた週は「変化」ではない
    const a = flatten(before), b = flatten(week);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== b[key]) changes.push(`${week.weekStart}  ${key}: ${a[key] ?? "—"} → ${b[key] ?? "—"}`);
    }
  }
  return changes;
}

// ---------- 出力 ----------

function build() {
  const files = fs.readdirSync(LOGS)
    .filter(f => /^weekly-log-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}-all\.md$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`${LOGS} に weekly-log-*-all.md がありません。`);

  const logs = files.map(f => parseLog(path.join(LOGS, f))).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const weeks = logs.map(summarizeWeek);

  // 欠測週は0で埋めずnullで残す。0にすると平均を引き下げ、グラフが谷になる（definitions.md §5）。
  // 週の起点を土曜から月曜へ変更したため、先頭から7日刻みで進めると以降の週を1つも拾えない。
  // 記録された週を順に並べ、あいだに7日分まるごと空くときだけ欠測週を挟む。
  const series = [];
  for (const [index, week] of weeks.entries()) {
    const previous = weeks[index - 1];
    if (previous) {
      let cursor = addDays(previous.weekEnd, 1);
      while (addDays(cursor, 6) <= week.weekStart) {
        series.push({ weekStart: cursor, weekEnd: addDays(cursor, 6), recorded: false });
        cursor = addDays(cursor, 7);
      }
    }
    series.push(week);
  }

  const generatedAt = new Date().toISOString();
  const meta = {
    schemaVersion: 1,
    generatedAt,
    regimeStart: REGIME_START,
    categorySince: CATEGORY_SINCE,
    matchToleranceMinutes: MATCH_TOLERANCE,
    weeksRecorded: weeks.length,
    weeksElapsed: series.length,
    // 正規化の注記は週ごとに該当有無が変わる。ページには全期間で適用した規則をまとめて出す。
    // 直近週の注記だけを出すと、その週に該当行が無い規則が読者に伝わらない。
    normalizationNotes: [...new Set(weeks.flatMap(w => w.normalizationNotes))],
    policy: { excluded: ["体調・症状の記述", "相手先の業種", "提案先の情報", "就寝起床の時刻", "氏名・署名"] }
  };

  const summaryOf = w => w.recorded === false ? w : {
    weekStart: w.weekStart, weekEnd: w.weekEnd, regime: w.regime,
    recordedWeekdays: w.recordedWeekdays, recordedDays: w.recordedDays, weekendMinutes: w.weekendMinutes,
    totalMinutes: w.totalMinutes, travelMinutes: w.travelMinutes, categories: w.categories,
    estimate: w.estimate, priority: w.priority, deviationMinutes: w.deviationMinutes,
    sleep: w.sleep, planImpact: w.planImpact, planExecution: w.planExecution, coverage: w.coverage
  };

  // 「今週」ではなく直近の完了週を出す。週の初日にアクセスされると1日分のグラフになるため（§8）。
  const current = weeks[weeks.length - 1];
  const outputs = {
    "current.json": { ...meta, week: current },
    "recent-4w.json": { ...meta, weeks: series.slice(-4) },
    "all-weekly.json": { ...meta, weeks: series.map(summaryOf) }
  };

  const problems = verify(logs, weeks, outputs);
  if (problems.length > 0) {
    console.error("ビルドを中止しました:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }

  const changes = retroactiveChanges(path.join(OUT, "all-weekly.json"), series.map(summaryOf));

  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, data] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`${name}  ${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(1)}KB`);
  }
  console.log(`\n${weeks.length}週を再生成（${series.length}週中、欠測 ${series.length - weeks.length}週）`);
  const allNotes = [...new Set(weeks.flatMap(w => w.normalizationNotes))];
  if (allNotes.length > 0) console.log("正規化:", allNotes.join(" / "));

  if (changes.length > 0) {
    console.log(`\n過去週の数値が ${changes.length}件 変わりました。意図した再解釈かバグかを確認してから公開してください:`);
    for (const c of changes.slice(0, 20)) console.log("  " + c);
    if (changes.length > 20) console.log(`  ...ほか ${changes.length - 20}件`);
  }
}

build();
