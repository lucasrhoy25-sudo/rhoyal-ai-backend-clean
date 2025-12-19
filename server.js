// rhoyal-ai-backend/server.js
// ✅ TOP OF FILE (only once)
require("dotenv").config();

const os = require("os");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

// ---------------- Helpers ----------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// ---------------- Supabase (server-only) ----------------
const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

// ✅ Server-only Supabase client (service role)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Middleware: require a valid Supabase user (Bearer token from client)
async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid auth token" });
    }

    req.user = data.user; // req.user.id available
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------------- App bootstrap ----------------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;

// ---------------- OpenAI ----------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // optional; routes will fallback if missing
});

// ---------------- Plaid client setup ----------------
const plaidEnvName = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const plaidEnv = PlaidEnvironments[plaidEnvName];

if (!plaidEnv) {
  console.error("❌ Invalid PLAID_ENV:", process.env.PLAID_ENV);
  process.exit(1);
}

const plaidConfig = new Configuration({
  basePath: plaidEnv,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// In-memory access token (sandbox / single-user)
let lastAccessToken = null;

// Small helper to map Plaid accounts into a simple shape
function mapAccounts(accounts) {
  return accounts.map((a) => ({
    id: a.account_id,
    name: a.name || a.official_name || "Account",
    type: a.type || "other",
    subtype: a.subtype || "",
    balance: a.balances.current ?? a.balances.available ?? 0,
    currency: a.balances.iso_currency_code || "USD",
  }));
}

// Helper: given a public_token, exchange + fetch accounts
async function exchangeAndFetch(public_token) {
  const exchangeResp = await plaidClient.itemPublicTokenExchange({ public_token });
  const access_token = exchangeResp.data.access_token;

  lastAccessToken = access_token;

  const accountsResp = await plaidClient.accountsBalanceGet({ access_token });
  const accounts = mapAccounts(accountsResp.data.accounts);
  const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);

  return { accounts, totalBalance };
}

// ---- Helper: goal forecast ----
function computeGoalForecast(goal) {
  const target = Number(goal.targetAmount) || 0;
  const current = Number(goal.currentAmount) || 0;
  const contrib = Number(goal.monthlyContribution) || 0;

  const remaining = target - current;
  if (remaining <= 0 || contrib <= 0) {
    return { monthsToGoal: 0, projectedCompletionDate: null };
  }

  const months = Math.ceil(remaining / contrib);
  const projected = new Date();
  projected.setMonth(projected.getMonth() + months);

  return {
    monthsToGoal: months,
    projectedCompletionDate: projected.toISOString().slice(0, 10),
  };
}

// ---- Hybrid mapping: Plaid category -> core bucket ----
function mapPlaidCategoryToCore(primaryCategory, name) {
  const p = (primaryCategory || "").toLowerCase();
  const n = (name || "").toLowerCase();

  if (
    p.includes("rent") ||
    p.includes("mortgage") ||
    p.includes("housing") ||
    p.includes("utilities") ||
    p.includes("home")
  ) {
    return "Housing";
  }

  if (
    p.includes("food") ||
    p.includes("restaurant") ||
    p.includes("dining") ||
    p.includes("groceries") ||
    p.includes("fast food") ||
    n.includes("grill") ||
    n.includes("cafe")
  ) {
    return "Food & Dining";
  }

  if (
    p.includes("transportation") ||
    p.includes("gas") ||
    p.includes("fuel") ||
    p.includes("auto") ||
    p.includes("ride share") ||
    p.includes("rideshare") ||
    n.includes("uber") ||
    n.includes("lyft")
  ) {
    return "Transportation";
  }

  if (
    p.includes("health") ||
    p.includes("medical") ||
    p.includes("pharmacy") ||
    p.includes("gym") ||
    p.includes("fitness")
  ) {
    return "Health & Fitness";
  }

  if (
    p.includes("shopping") ||
    p.includes("entertainment") ||
    p.includes("subscription") ||
    p.includes("travel") ||
    p.includes("recreation") ||
    p.includes("hobby")
  ) {
    return "Lifestyle";
  }

  return "Other";
}

// ---- Build a Plaid snapshot (last ~30 days) ----
async function buildPlaidSnapshot() {
  if (!lastAccessToken) return null;

  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - 1);

  const endDate = end.toISOString().slice(0, 10);
  const startDate = start.toISOString().slice(0, 10);

  const txResp = await plaidClient.transactionsGet({
    access_token: lastAccessToken,
    start_date: startDate,
    end_date: endDate,
  });

  const txs = txResp.data.transactions || [];

  const categoryTotals = {
    Housing: 0,
    "Food & Dining": 0,
    Transportation: 0,
    Lifestyle: 0,
    "Health & Fitness": 0,
    Other: 0,
  };

  let totalIncome = 0;
  let totalSpending = 0;

  const sample = [];

  for (const tx of txs) {
    const rawAmount = Number(tx.amount) || 0;
    const primary =
      tx.personal_finance_category?.primary ||
      (Array.isArray(tx.category) ? tx.category[0] : "") ||
      "";
    const name = tx.name || "";

    const primaryLower = String(primary).toLowerCase();
    const nameLower = String(name).toLowerCase();

    const isIncome =
      primaryLower.includes("income") ||
      primaryLower.includes("payroll") ||
      nameLower.includes("payroll") ||
      nameLower.includes("salary") ||
      nameLower.includes("deposit");

    const amt = Math.abs(rawAmount);

    if (isIncome) {
      totalIncome += amt;
    } else {
      totalSpending += amt;
      const core = mapPlaidCategoryToCore(primary, name);
      categoryTotals[core] += amt;
    }

    if (sample.length < 10) {
      sample.push({
        name,
        amount: rawAmount,
        date: tx.date,
        primaryCategory: primary,
      });
    }
  }

  return {
    startDate,
    endDate,
    totalIncomeEstimate: totalIncome,
    totalSpendingEstimate: totalSpending,
    categoryTotals,
    sampleTransactions: sample,
  };
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "rhoyal-ai-backend" });
});

// ✅ Transactions endpoint for your Cashflow chart
app.get("/api/plaid/transactions", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 14, 90));

    if (lastAccessToken) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));

      const end_date = end.toISOString().slice(0, 10);
      const start_date = start.toISOString().slice(0, 10);

      const txResp = await plaidClient.transactionsGet({
        access_token: lastAccessToken,
        start_date,
        end_date,
      });

      const txs = txResp.data.transactions || [];

      const normalized = txs.map((tx) => {
        const rawAmount = Number(tx.amount) || 0;
        const primary =
          tx.personal_finance_category?.primary ||
          (Array.isArray(tx.category) ? tx.category[0] : "") ||
          "";

        const name = tx.name || "Transaction";
        const primaryLower = String(primary).toLowerCase();
        const nameLower = String(name).toLowerCase();

        const isIncome =
          primaryLower.includes("income") ||
          primaryLower.includes("payroll") ||
          nameLower.includes("payroll") ||
          nameLower.includes("salary") ||
          nameLower.includes("deposit");

        const amount = isIncome ? Math.abs(rawAmount) : -Math.abs(rawAmount);

        return {
          id: tx.transaction_id,
          name,
          date: tx.date,
          amount,
          type: isIncome ? "income" : "spending",
        };
      });

      return res.json({ transactions: normalized });
    }

    // Demo fallback
    return res.json({
      transactions: [
        { id: "tx1", name: "Paycheck", amount: 3200, date: "2025-12-02", type: "income" },
        { id: "tx2", name: "Rent", amount: -1600, date: "2025-12-01", type: "bill" },
        { id: "tx3", name: "Groceries", amount: -120, date: "2025-12-02", type: "spending" },
      ],
    });
  } catch (err) {
    console.error("Error in GET /api/plaid/transactions:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// 1) Create a link_token
app.post("/api/plaid/create_link_token", async (req, res) => {
  try {
    const userId = "demo-user-1";

    const request = {
      user: { client_user_id: userId },
      client_name: "Rhoyal Budgeting",
      products: ["auth", "transactions"],
      language: "en",
      country_codes: ["US"],
    };

    const response = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Error creating link token:", err?.response?.data || err);
    res.status(500).json({ error: "Unable to create link token" });
  }
});

// 3) Expo-friendly sandbox route
app.post("/api/plaid/sandbox_connect", async (req, res) => {
  try {
    const sandboxResp = await plaidClient.sandboxPublicTokenCreate({
      institution_id: "ins_109508",
      initial_products: ["transactions"],
    });

    const public_token = sandboxResp.data.public_token;
    const { accounts, totalBalance } = await exchangeAndFetch(public_token);

    res.json({ accounts, totalBalance });
  } catch (err) {
    console.error("Error in /api/plaid/sandbox_connect:", err?.response?.data || err);
    res.status(500).json({ error: "Unable to connect sandbox accounts" });
  }
});

// 4) AI Orbit planning route
app.post("/api/orbit/plan", async (req, res) => {
  try {
    const state = req.body?.state;

    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Missing or invalid budget state in request body" });
    }

    const income = Number(state.income) || 0;
    const categories = Array.isArray(state.categories) ? state.categories : [];
    const baseGoals = Array.isArray(state.goals) ? state.goals : [];

    const basePlannedSpending = categories.reduce((sum, cat) => {
      const planned = Number(cat.planned) || 0;
      return sum + planned;
    }, 0);

    const baseSurplus = income - basePlannedSpending;

    let plaidSnapshot = null;
    try {
      plaidSnapshot = await buildPlaidSnapshot();
    } catch (err) {
      console.error("Error building Plaid snapshot:", err);
      plaidSnapshot = null;
    }

    if (!process.env.OPENAI_API_KEY) {
      const perGoalAmount =
        baseSurplus > 0 && baseGoals.length > 0
          ? Math.max(Math.round((baseSurplus * 0.2) / baseGoals.length), 0)
          : 0;

      const goalsWithContrib = baseGoals.map((goal) => {
        const monthlyContribution =
          typeof goal.monthlyContribution === "number"
            ? goal.monthlyContribution
            : perGoalAmount;

        const forecast = computeGoalForecast({ ...goal, monthlyContribution });
        return { ...goal, monthlyContribution, ...forecast };
      });

      return res.json({
        categories,
        goals: goalsWithContrib,
        surplus: baseSurplus,
        plannedSpending: basePlannedSpending,
        plaidSnapshot,
        orbitInsight: "Orbit used a simple rule-of-thumb plan (no AI key configured).",
      });
    }

    // (Keep your OpenAI logic here later if you want)
    return res.json({
      categories,
      goals: baseGoals,
      surplus: baseSurplus,
      plannedSpending: basePlannedSpending,
      plaidSnapshot,
      orbitInsight: "Orbit route is wired. (AI planning logic can be added next.)",
    });
  } catch (err) {
    console.error("Error in /api/orbit/plan:", err);
    return res.status(500).json({ error: "Failed to build Orbit plan" });
  }
});

// ---------------- Start server (LAN accessible) ----------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rhoyal AI backend listening on:`);
  console.log(`- http://localhost:${PORT}`);
  const ips = getLanIPs();
  if (!ips.length) {
    console.log(`- (No LAN IP detected)`);
  } else {
    ips.forEach((ip) => console.log(`- http://${ip}:${PORT}  (use this on your phone)`));
  }
});

// Export for future use if you split files later
module.exports = { supabaseAdmin, requireUser };
