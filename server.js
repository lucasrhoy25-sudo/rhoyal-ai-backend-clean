// rhoyal-ai-backend/server.js

// --- Load environment variables -------------------------------------------
require("dotenv").config();

// --- Imports ---------------------------------------------------------------
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");

// --- Basic sanity check for the API key -----------------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error(
    "❌ OPENAI_API_KEY is missing. Set it in your .env or cloud env vars."
  );
} else {
  console.log(
    "✅ OpenAI key loaded (first 8 chars):",
    process.env.OPENAI_API_KEY.slice(0, 8) + "..."
  );
}

// --- OpenAI client ---------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Express app setup -----------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3001;

// CORS: allow everything by default, or lock down with ALLOWED_ORIGINS env
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : "*";

app.use(
  cors({
    origin: allowedOrigins === "*" ? true : allowedOrigins,
  })
);

app.use(express.json());
app.use(helmet());

// --- Rate limiter so people can’t spam the AI endpoint ---------------------
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // max 20 requests/minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Health check (for Render / monitoring) --------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "rhoyal-ai-coach" });
});

// --- AI Coach endpoint -----------------------------------------------------
app.post("/ai/coach", aiLimiter, async (req, res) => {
  try {
    const { message, context } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Field 'message' is required." });
    }

    // Optional extra context from the app (e.g., budgets, totals, etc.)
    const safeContext =
      context && typeof context === "object" ? JSON.stringify(context) : "";

    const systemPrompt = `
You are Rhoyal AI Coach, a friendly and professional financial guide.
- You speak clearly and concisely.
- You focus on budgeting, cash flow, savings, and debt payoff.
- You give practical, actionable advice, usually in 3–5 bullet points.
- You are NOT a tax attorney or investment advisor; avoid giving specific
  ticker recommendations or legal/tax advice.

If you’re given context from the app (income, needs/wants/savings, goals),
use it to personalize the answer.
Context (JSON): ${safeContext || "none provided"}.
    `.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // or another model you prefer
      messages,
      temperature: 0.4,
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn’t generate a response. Try asking in a different way.";

    return res.json({
      reply: aiText,
    });
  } catch (err) {
    // Log more detail on the server, but keep response generic for the client
    console.error("🔥 AI Coach backend error:", err?.response?.data || err);

    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({
      error: "AI Coach encountered an error. Try again later.",
    });
  }
});

// --- Start server ----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Rhoyal AI Coach backend listening on port ${PORT}`);
});
