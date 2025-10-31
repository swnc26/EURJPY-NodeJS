import express from "express";
import fetch from "node-fetch";
import yahooFinance from "yahoo-finance2";
import { setTimeout as wait } from "timers/promises";
import fs from "fs";

// ================= CONFIG =================
const CONFIG_FILE = "./config.json";
const PAIR = "EURJPY=X";
const INTERVAL = "1m";
const TIMEZONE_OFFSET = 7 * 60 * 60 * 1000; // UTC+7 (WIB)
const PORT = 5000;

// ================= GLOBAL DATA =================
let lastSignalData = {
  signal: "WAITING",
  confidence: 0,
  price: 0,
  timestamp: null,
  indicators: {},
};
let botStartTime = null;

// ================= KEEP ALIVE =================
function keepAlive() {
  const app = express();
  app.get("/", (req, res) => {
    res.send("<h3>📊 EURJPY Node.js Bot Running ✅</h3>");
  });

  app.get("/health", (req, res) => {
    const now = new Date(Date.now() + TIMEZONE_OFFSET)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    res.json({ status: "ok", time: `${now} WIB` });
  });

  app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
}
keepAlive();

// ================= TELEGRAM =================
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE));
  } catch (e) {
    console.error("❌ Gagal memuat config.json:", e);
    return null;
  }
}

async function sendTelegramMessage(token, chatId, text, parseMode = "HTML") {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: chatId, text, parse_mode: parseMode }),
    });
    const data = await res.json();
    if (data.ok) console.log("📨 Pesan Telegram terkirim.");
    else console.error("Gagal kirim pesan Telegram:", data);
  } catch (err) {
    console.error("Error kirim Telegram:", err);
  }
}

async function sendStatus(token, chatId, status) {
  const now = new Date(Date.now() + TIMEZONE_OFFSET);
  const timeStr = now.toISOString().replace("T", " ").slice(0, 19);
  const msg = `<b>Bot Status:</b> ${status}\n🕒 <code>${timeStr} WIB</code>`;
  await sendTelegramMessage(token, chatId, msg);
}

// ================= MARKET DATA =================
async function getPriceData() {
  try {
    const df = await yahooFinance.chart(PAIR, { interval: INTERVAL, range: "1d" });
    const { indicators } = df;
    if (!indicators?.quote?.[0]?.close) return null;

    const close = indicators.quote[0].close;
    const high = indicators.quote[0].high;
    const low = indicators.quote[0].low;
    return { close, high, low };
  } catch (err) {
    console.error("Gagal ambil data harga:", err);
    return null;
  }
}

// ================= ANALISA =================
function analyzeSignal(data) {
  const { close, high, low } = data;
  const n = close.length;

  const ema = (arr, span) => {
    const k = 2 / (span + 1);
    return arr.reduce((acc, val, i) => {
      if (i === 0) acc.push(val);
      else acc.push(val * k + acc[i - 1] * (1 - k));
      return acc;
    }, []);
  };

  const emaFast = ema(close, 9);
  const emaSlow = ema(close, 21);

  const delta = close.map((c, i) => (i === 0 ? 0 : c - close[i - 1]));
  const gain = delta.map(d => (d > 0 ? d : 0));
  const loss = delta.map(d => (d < 0 ? -d : 0));

  const avg = arr => arr.slice(-14).reduce((a, b) => a + b, 0) / 14 || 1;
  const rs = avg(gain) / avg(loss);
  const rsi = 100 - 100 / (1 + rs);

  const ema12 = ema(close, 12);
  const ema26 = ema(close, 26);
  const macd = ema12[n - 1] - ema26[n - 1];
  const macdSignal = ema([macd], 9);
  const macdHist = macd - macdSignal[macdSignal.length - 1];

  const trArr = high.map((h, i) => {
    const prevClose = i > 0 ? close[i - 1] : close[i];
    return Math.max(
      h - low[i],
      Math.abs(h - prevClose),
      Math.abs(low[i] - prevClose)
    );
  });
  const atr = avg(trArr);

  const lastClose = close[n - 1];
  const lastEmaFast = emaFast[n - 1];
  const lastEmaSlow = emaSlow[n - 1];

  let score = 0;
  score += lastEmaFast > lastEmaSlow ? 2 : -2;
  score += macdHist > 0 ? 1 : -1;
  score += rsi < 35 ? 1.5 : rsi > 65 ? -1.5 : 0;

  const signal = score > 0 ? "BUY" : "SELL";
  const confidence = Math.min(99, Math.abs(score * 15));

  const indicators = {
    ema_fast: lastEmaFast.toFixed(3),
    ema_slow: lastEmaSlow.toFixed(3),
    rsi: rsi.toFixed(2),
    macd: macdHist.toFixed(5),
    atr: atr.toFixed(5),
  };

  lastSignalData = {
    signal,
    confidence,
    price: lastClose.toFixed(3),
    timestamp: new Date(Date.now() + TIMEZONE_OFFSET)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " WIB",
    indicators,
  };

  return { signal, price: lastClose, confidence, indicators };
}

// ================= BOT LOOP =================
async function botLoop(token, chatId) {
  await sendStatus(token, chatId, "Started (WebApp ✅)");
  console.log("🚀 Bot loop dimulai");

  const data = await getPriceData();
  if (!data) return;

  const { signal, price, confidence, indicators } = analyzeSignal(data);
  const now = new Date(Date.now() + TIMEZONE_OFFSET)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const msg = `\n🔔 <b>SINYAL AWAL</b>\n\n📊 Pair: EUR/JPY\n📈 Sinyal: <b>${signal}</b>\n💰 Harga: <code>${price.toFixed(3)}</code>\n🎯 Target: <code>${signal === "BUY" ? (price + 0.03).toFixed(3) : (price - 0.03).toFixed(3)}</code>\n✨ Confidence: ${confidence}%\n⏰ ${now} WIB`;
  await sendTelegramMessage(token, chatId, msg);
  console.log(`✅ Sinyal awal dikirim (${now})`);

  while (true) {
    try {
      const localNow = new Date(Date.now() + TIMEZONE_OFFSET);
      const nextMinute = Math.ceil((localNow.getMinutes() + 0.0001) / 5) * 5;
      let nextTime = new Date(localNow);
      if (nextMinute >= 60) {
        nextTime.setHours(nextTime.getHours() + 1, 0, 0, 0);
      } else {
        nextTime.setMinutes(nextMinute, 0, 0);
      }

      const sendTime = new Date(nextTime.getTime() - 10 * 1000);
      const waitMs = sendTime - localNow;
      if (waitMs > 0) {
        console.log(
          `🕒 Menunggu ${Math.round(waitMs / 1000)} detik hingga sinyal berikutnya (${sendTime.toTimeString().slice(0, 8)} WIB)`
        );
        await wait(waitMs);
      }

      const df = await getPriceData();
      if (!df) continue;
      const result = analyzeSignal(df);
      const t = new Date(Date.now() + TIMEZONE_OFFSET)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);

      const message = `\n🔔 <b>SINYAL TRADING BARU</b>\n\n📊 Pair: EUR/JPY\n📈 Sinyal: <b>${result.signal}</b>\n💰 Harga: <code>${result.price.toFixed(3)}</code>\n🎯 Target: <code>${result.signal === "BUY" ? (result.price + 0.03).toFixed(3) : (result.price - 0.03).toFixed(3)}</code>\n✨ Confidence: ${result.confidence}%\n⏰ ${t} WIB`;
      await sendTelegramMessage(token, chatId, message);
      console.log(`✅ Sinyal baru dikirim (${t})`);
    } catch (err) {
      console.error("Error di loop utama:", err);
      await wait(15000);
    }
  }
}

// ================= START BOT =================
const cfg = loadConfig();
if (cfg) {
  const token = cfg.token;
  const chatId = cfg.chat_id;
  botStartTime = new Date(Date.now() + TIMEZONE_OFFSET);
  botLoop(token, chatId);
} else {
  console.error("❌ config.json tidak valid. Bot tidak dijalankan.");
}
